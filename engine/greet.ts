import {
  BOSS_CHAT_INPUT_SELECTORS,
  BOSS_IMAGE_INPUT_SELECTORS,
  BOSS_IMAGE_SELECTORS,
  BOSS_SEND_BUTTON_SELECTORS,
  bossChatInputPresentScript,
  bossChatStateScript,
  bossDirectGreetScript,
  bossDomGreetScript,
  bossFillInputScript,
  bossGreetProbeInstallScript,
  bossGreetProbeReadScript,
  bossInputTextScript,
  bossSentBubbleScript,
  type BossChatState,
} from "./boss-scripts";
import type { BrowserDriver } from "./driver";
import { blockedKindFromReason, classifyBlocked } from "./job-sites/blocker";
import { readBossChatSignal } from "./job-sites/boss-chat";
import { bossGreetHasActivity, interpretBossGreetProbe, type BossGreetProbeSnapshot } from "./job-sites/boss-greet";
import { detectBossAutoGreet } from "./job-sites/parse";
import { jobSiteLabel } from "./job-sites/sites";
import type { JobSiteGreetInput, JobSiteGreetResult } from "./job-sites/types";
import type { JobSiteSearchEngine } from "./search";

const ABORT_MESSAGE = "投递任务已停止，本次操作已中止";
/** 沟通入口的选择器：与主进程旧引擎一致，只认真正的「立即沟通 / 继续沟通」。 */
const BOSS_ENTRY_SELECTORS = ['a.btn-startchat', 'a.op-btn-chat', '[class*="btn-startchat"]', 'button[class*="startchat"]'];
const BOSS_ENTRY_LABELS = "^(立即沟通|继续沟通|打招呼)$";

function text(value: unknown, max = 1000) {
  return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeName(value: string) {
  return String(value ?? "shot")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "shot";
}

const EMPTY_CHAT_STATE: BossChatState = {
  label: "",
  point: null,
  hasInput: false,
  text: "",
  ready: false,
  entry: null,
  hitEntry: false,
  startchatOpen: false,
  sentText: "",
  remindText: "",
};

async function readBossChatState(driver: BrowserDriver): Promise<BossChatState> {
  const state = await driver.evaluate<BossChatState>("boss", bossChatStateScript()).catch(() => undefined);
  return state ?? EMPTY_CHAT_STATE;
}

async function readBossGreetProbe(driver: BrowserDriver): Promise<BossGreetProbeSnapshot | null> {
  return (await driver.evaluate<BossGreetProbeSnapshot>("boss", bossGreetProbeReadScript(), 4_000).catch(() => null)) ?? null;
}

type OpenChatOutcome = {
  /** 聊天输入框已经出现，可以填字发送。 */
  opened: boolean;
  /** 平台已经自动用预设招呼语发出（确认框或入口文案变化）。 */
  autoSent: boolean;
  /** 确认框里平台实际发出的招呼正文。 */
  greeting: string;
  /** 点击前就已经是「继续沟通」。 */
  alreadyChatted: boolean;
  /** 没找到入口 / 点了没反应的说明。 */
  reason: string;
  /** 页面明确被登录 / 验证拦住。 */
  blocked: "" | "login" | "verification";
  /** Boss 明确给出的拒绝 / 限制原因，直接写进 blockedReason。 */
  blockedReason: string;
};

/**
 * 打开 Boss 聊天，并识别平台「自动打招呼」行为。
 *
 * 按「等脚本就位 → 可信点击 → 页面内点击 → 直接调用 Detail.startChat」逐级兜底，
 * 并用页面请求探针读出平台回包（已发送 / 登录 / 次数上限 / 职位不可投 / 需本人处理）。
 */
async function openChat(
  driver: BrowserDriver,
  log: (message: string) => void,
  signal?: AbortSignal,
  options: { repeat?: boolean } = {},
): Promise<OpenChatOutcome> {
  const empty = (reason = "", extra: Partial<OpenChatOutcome> = {}): OpenChatOutcome => ({
    opened: false, autoSent: false, greeting: "", alreadyChatted: false, reason, blocked: "", blockedReason: "", ...extra,
  });
  let state = await readBossChatState(driver);
  if (state.hasInput) return { ...empty(), opened: true };
  const initial = readBossChatSignal({ beforeLabel: "", currentLabel: state.label, body: state.text, hasInput: state.hasInput });
  if (initial.autoSent) return { ...empty(), autoSent: true, greeting: initial.greeting };
  // 岗位页是 SPA，沟通按钮可能比正文晚一两秒才挂上来。
  for (let index = 0; index < 15 && !state.label && !state.hasInput; index += 1) {
    if (signal?.aborted) return empty();
    await sleep(400);
    state = await readBossChatState(driver);
  }
  if (signal?.aborted) return empty();
  if (state.hasInput) return { ...empty(), opened: true };
  const before = state.label;
  if (!before) return empty("没有找到「立即沟通」入口。岗位可能已下线，或页面还没加载完，请在浏览器窗口中确认");
  if (/继续沟通/.test(before) && options.repeat !== true) {
    return { ...empty(), alreadyChatted: true };
  }
  // 按钮和页面脚本不是同时就位的：脚本没挂上时点击不会触发任何请求。
  if (!state.ready) {
    for (let index = 0; index < 20 && !state.ready; index += 1) {
      if (signal?.aborted) return empty();
      await sleep(400);
      state = await readBossChatState(driver);
    }
  }
  if (!state.label) return empty("没有找到「立即沟通」入口，岗位可能已下线");
  const scriptReady = state.ready;
  await driver.evaluate<boolean>("boss", bossGreetProbeInstallScript(), 4_000).catch(() => false);
  if (!state.hitEntry) log("「立即沟通」入口被页面浮层遮挡，改用页面内点击");
  // 可信坐标点击：入口被浮层盖住时驱动会返回 false，下面再退化为页面内点击。
  const trusted = await driver.click("boss", BOSS_ENTRY_SELECTORS, BOSS_ENTRY_LABELS).catch(() => false);
  if (trusted) log("正在打开与招聘者的聊天窗口");
  let domClicked = false;
  let directCalled = false;
  for (let index = 0; index < 32; index += 1) {
    await sleep(500);
    if (signal?.aborted) return empty();
    const current = await readBossChatState(driver);
    const probe = await readBossGreetProbe(driver);
    const verdict = interpretBossGreetProbe(probe);
    if (verdict.kind === "sent") {
      return { ...empty(), autoSent: true, greeting: verdict.greeting };
    }
    if (verdict.kind === "login") {
      return empty("Boss 需要重新登录，请在浏览器窗口里扫码登录后重试", {
        blocked: "login", blockedReason: "需要登录 Boss 直聘",
      });
    }
    if (verdict.kind === "limit" || verdict.kind === "user" || verdict.kind === "refused") {
      return empty(verdict.message, { blockedReason: verdict.blockedReason });
    }
    if (verdict.kind === "chat" && current.hasInput) {
      // 新版开聊弹窗会先画输入框、再把招呼状态从「发送中」改成「已发送」；
      // 多等一拍，避免把平台已经自动发出的招呼又打一遍。
      if (current.startchatOpen) {
        await sleep(700);
        const late = interpretBossGreetProbe(await readBossGreetProbe(driver));
        if (late.kind === "sent") return { ...empty(), autoSent: true, greeting: late.greeting };
      }
      return { ...empty(), opened: true };
    }
    const signalState = readBossChatSignal({
      beforeLabel: before,
      currentLabel: current.label,
      body: current.text,
      hasInput: current.hasInput,
    });
    if (signalState.autoSent) {
      return { ...empty(), opened: signalState.chatOpen, autoSent: true, greeting: signalState.greeting };
    }
    if (signalState.chatOpen) return { ...empty(), opened: true };
    if (signalState.labelConfirmed) {
      return { ...empty(), autoSent: true, greeting: signalState.greeting };
    }
    const url = await driver.url("boss").catch(() => "");
    const blocked = classifyBlocked(url, current.text);
    if (blocked) return { ...empty(), blocked };
    const activity = bossGreetHasActivity(probe);
    // 点击后 3 秒仍没有任何请求/弹窗：多半是处理器没绑上，改用页面内原生点击。
    if (!domClicked && !activity && index >= 5) {
      domClicked = (await driver.evaluate<boolean>("boss", bossDomGreetScript()).catch(() => false)) === true;
      if (domClicked) log("「立即沟通」没有触发平台响应，已直接用页面按钮重新触发");
      continue;
    }
    // 页面内点击也没有请求：直接调用 Boss 自己的开聊接口（同样走页面 jQuery，带齐风控头）。
    if (domClicked && !directCalled && !activity && index >= 11) {
      directCalled = (await driver.evaluate<boolean>("boss", bossDirectGreetScript()).catch(() => false)) === true;
      if (directCalled) log("页面按钮仍未响应，已改用 Boss 页面自己的开聊接口");
    }
  }
  const last = interpretBossGreetProbe(await readBossGreetProbe(driver));
  if (last.kind === "sent") return { ...empty(), autoSent: true, greeting: last.greeting };
  if (last.kind === "limit" || last.kind === "user" || last.kind === "refused") {
    return empty(last.message, { blockedReason: last.blockedReason });
  }
  if (directCalled) {
    return empty("已直接调用 Boss 开聊接口，但平台没有返回结果。请到 Boss 消息页核对是否已发出");
  }
  if (!scriptReady) {
    return empty("Boss 岗位页脚本没有加载完成（可能被网络或平台风控拦住），本次没有发出。请在浏览器窗口中刷新后重试");
  }
  return empty("点击「立即沟通」后页面没有出现聊天窗口或发送提示");
}

async function fillGreeting(driver: BrowserDriver, greeting: string) {
  // 通用驱动没有剪贴板权限，直接写输入框；写不进去时再用页面脚本兜底一次。
  await driver.fill("boss", BOSS_CHAT_INPUT_SELECTORS, greeting).catch(() => false);
  const probe = greeting.replace(/\s+/g, "").slice(0, 24);
  const pasted = String((await driver.evaluate<string>("boss", bossInputTextScript()).catch(() => "")) ?? "");
  if (pasted.replace(/\s+/g, "").includes(probe)) return true;
  await driver.evaluate<boolean>("boss", bossFillInputScript(greeting)).catch(() => false);
  await sleep(300);
  const filled = String((await driver.evaluate<string>("boss", bossInputTextScript()).catch(() => "")) ?? "");
  return filled.replace(/\s+/g, "").includes(probe);
}

async function clickSend(driver: BrowserDriver, log: (message: string) => void) {
  for (const selector of BOSS_SEND_BUTTON_SELECTORS) {
    if (await driver.click("boss", [selector]).catch(() => false)) return true;
  }
  if (await driver.click("boss", [], "^发送$").catch(() => false)) return true;
  log("未找到发送按钮，使用回车发送");
  await driver.pressKey("boss", "Enter");
  return true;
}

async function sendImageResume(driver: BrowserDriver, imagePath: string, log: (message: string) => void) {
  let attached = await driver.upload("boss", BOSS_IMAGE_INPUT_SELECTORS, [imagePath]).catch(() => false);
  if (!attached) {
    attached = await driver.chooseFile("boss", BOSS_IMAGE_SELECTORS, imagePath).catch(() => false);
  }
  if (!attached) {
    log("没有找到可用的图片上传入口，图片简历未自动发送");
    return false;
  }
  await sleep(1200);
  log("已选择图片简历，正在确认发送");
  await driver.click("boss", ['[class*="dialog"] button', '[class*="modal"] button'], "^发送$").catch(() => false);
  await sleep(1200);
  return true;
}

/**
 * Boss 打招呼：打开岗位页 → 立即沟通 → 填入话术发送 → 确认消息出现在聊天里。
 *
 * 平台会自动用账号预设招呼语发出并弹「已向BOSS发送消息」，这已经是成功发送；
 * 只有确认页面出现了刚发送的话术才算 sent，其余情况交回本人处理。
 */
export async function greetBoss(
  engine: JobSiteSearchEngine,
  driver: BrowserDriver,
  input: JobSiteGreetInput,
): Promise<JobSiteGreetResult> {
  const screenshots: string[] = [];
  const evidenceDir = input.evidenceDir;
  const signal = input.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new Error(ABORT_MESSAGE);
  };
  const closed = await driver.isClosed("boss").catch(() => true);
  if (closed) {
    return {
      state: "failed",
      message: "Boss 窗口已关闭，无法继续投递。重新打开窗口后可重试",
      screenshots,
      blockedReason: "窗口已关闭",
      successText: "",
      finalUrl: "",
    };
  }
  const abortedResult = (): JobSiteGreetResult => ({
    state: "failed",
    message: "投递已中止（批量任务被停止，或 Boss 窗口被关闭）",
    screenshots,
    blockedReason: "已中止",
    successText: "",
    finalUrl: "",
  });
  // 批量投递默认显示窗口但不抢焦点；只有用户关了「显示浏览器窗口」才完全藏起来。
  await driver.reveal("boss", input.reveal ?? "focus").catch(() => undefined);
  const shot = async (label: string) => {
    const file = `${String(evidenceDir).replace(/[\\/]+$/, "")}/${Date.now()}-${safeName(label)}.png`;
    const saved = await driver.screenshot("boss", file).catch(() => "");
    if (saved) screenshots.push(saved);
  };
  const finalUrl = () => driver.url("boss").catch(() => "");
  const fail = async (state: JobSiteGreetResult["state"], message: string, blockedReason = ""): Promise<JobSiteGreetResult> => {
    // 只有「页面确实被登录墙 / 验证码拦住」才标记平台 blocked。
    // `needs_user` 绝大多数是「点了发送但没看到回执」——消息可能已经发出去了，
    // 这不是登录失效，把它标成「需要登录」会让状态栏一直误导用户。
    const wall = state === "failed" ? "" : blockedKindFromReason(blockedReason);
    engine.markBlocked("boss", wall || (state === "blocked" ? "verification" : ""), message);
    // 撞上登录墙 / 人机验证时必须把窗口摆到前台：用户要直接扫码或点验证。
    if (wall) {
      await driver.reveal("boss", "focus").catch(() => undefined);
      input.log(`${wall === "verification" ? "需要人机验证" : "需要登录"}，已把 ${jobSiteLabel("boss")} 窗口显示到前台`);
    }
    await shot(state);
    return {
      state,
      message,
      screenshots,
      blockedReason,
      successText: "",
      finalUrl: await finalUrl(),
    };
  };

  try {
    if (!isHttpUrl(input.job.sourceUrl)) return await fail("failed", "岗位链接无效，无法打开 Boss 岗位页");
    checkAbort();
    await driver.goto("boss", input.job.sourceUrl, { attempts: 1 }).catch((error: any) => {
      input.log(`页面加载较慢或超时：${text(error?.message ?? error, 120)}`);
    });
    await sleep(1200);
    checkAbort();
    const blocked = await driver.blocker("boss").catch(() => "" as const);
    if (blocked) {
      return await fail(
        "needs_user",
        blocked === "verification"
          ? "Boss直聘要求人机验证，请在浏览器窗口里完成验证后回到工作台重试"
          : "Boss直聘需要先登录，请在浏览器窗口里扫码登录后回到工作台重试",
        blocked === "verification" ? "需要人机验证" : "需要登录 Boss 直聘",
      );
    }
    // Boss 未登录时详情页不会跳转，只在页头挂一个「登录」入口，正文里没有登录墙文案。
    // 没登录就暂停整批，并把登录入口直接摆到用户面前，避免整批被误记成「可能已投出」。
    if ((await driver.loginState("boss").catch(() => "" as const)) === "out") {
      engine.markLoginState("boss", "out");
      await driver.openLogin("boss").catch((error: any) => {
        input.log(`打开 Boss 登录入口失败：${text(error?.message ?? error, 120)}`);
      });
      return await fail(
        "needs_user",
        "Boss 直聘当前未登录，请在浏览器窗口里扫码登录后回到工作台点「继续」，登录态会保存在这个窗口里",
        "需要登录 Boss 直聘",
      );
    }
    checkAbort();
    const autoGreetSent = async () => detectBossAutoGreet(await driver.body("boss").catch(() => ""));
    const recordAutoGreet = async (greetingText = ""): Promise<JobSiteGreetResult> => {
      const sentText = text(greetingText, 300);
      input.log(sentText
        ? `Boss 已自动发出预设招呼语：${sentText}`
        : "Boss 已自动发出预设招呼语（页面提示「已向BOSS发送消息」）");
      await shot("greet-auto-sent");
      engine.markBlocked("boss", "", "Boss 已自动发送招呼");
      return {
        state: "sent",
        message: sentText
          ? `Boss 已自动发出预设招呼语：「${sentText}」，已记录为已投递`
          : "Boss 已自动发出预设招呼语（页面提示「已向BOSS发送消息」），已记录为已投递",
        screenshots,
        blockedReason: "",
        successText: "页面提示「已向BOSS发送消息」",
        greeting: sentText,
        greetingSource: "auto",
        finalUrl: await finalUrl(),
      };
    };
    const chat = await openChat(driver, input.log, signal, { repeat: input.allowRepeatChat === true });
    checkAbort();
    if (chat.autoSent) return await recordAutoGreet(chat.greeting);
    if (chat.alreadyChatted) {
      // Boss 入口写着「继续沟通」：这个岗位之前已经沟通过。没有开启重复沟通时不再打扰对方，
      // 但要把这条补记进名单，否则用户在 Boss 消息里看得到、工作台里却没有。
      await shot("greet-already");
      engine.markBlocked("boss", "", "Boss 显示这个岗位已经沟通过");
      return {
        state: "sent",
        message: "Boss 聊天入口显示「继续沟通」，说明这个岗位之前已经打过招呼；本次没有重复发送，已补记到已投递名单",
        screenshots,
        blockedReason: "",
        successText: "Boss 入口显示「继续沟通」",
        greeting: "",
        greetingSource: "already",
        finalUrl: await finalUrl(),
      };
    }
    if (!chat.opened) {
      checkAbort();
      if (await autoGreetSent()) return await recordAutoGreet();
      const lateBlock = chat.blocked || await driver.blocker("boss").catch(() => "" as const);
      if (lateBlock) {
        return await fail(
          "needs_user",
          lateBlock === "login"
            ? "需要先登录 Boss 直聘，请在浏览器窗口里完成登录后重试"
            : "Boss直聘要求人机验证，请在浏览器窗口里完成验证后重试",
          lateBlock === "login" ? "需要登录 Boss 直聘" : "需要人机验证",
        );
      }
      const pageBody = await driver.body("boss").catch(() => "");
      if (/职位已关闭|已下线|停止招聘|职位已失效|该职位不存在/.test(pageBody)) {
        return await fail("failed", "岗位已关闭或已下线，本次没有发出", "岗位已关闭");
      }
      if (/点击「立即沟通」后页面没有出现/.test(chat.reason)) {
        // 页面既没有确认框、入口也没变成「继续沟通」、更没有聊天框。
        // 这不等于没发出去，交给批量结束后的消息记录核对。
        return await fail(
          "needs_user",
          "点击了「立即沟通」，但页面没有出现发送回执。消息可能已经发出；批量结束后会自动核对 Boss 消息记录",
          "沟通入口无响应（待消息记录核对）",
        );
      }
      return await fail(
        "needs_user",
        chat.reason || "没有找到「立即沟通」入口，本次没有发出，请在浏览器窗口中确认",
        chat.blockedReason || "未找到沟通入口",
      );
    }
    checkAbort();
    // 聊天窗口打开的同时平台已经自动发了招呼：此时再填再发会变成连发两条。
    if (await autoGreetSent()) return await recordAutoGreet();
    const greeting = text(input.greeting, 500);
    if (!greeting) return await fail("failed", "打招呼内容为空");
    checkAbort();
    if (!await fillGreeting(driver, greeting)) {
      return await fail("needs_user", "聊天窗口已打开，但没有成功填入招呼语。请在浏览器中手动发送这段文字", "输入框未能写入");
    }
    input.log("已填入打招呼内容，正在发送");
    checkAbort();
    await clickSend(driver, input.log);
    let seen = false;
    let toast = false;
    for (let index = 0; index < 12; index += 1) {
      await sleep(500);
      checkAbort();
      const rawBody = await driver.body("boss").catch(() => "");
      const body = rawBody.replace(/\s+/g, "");
      const currentInput = String((await driver.evaluate<string>("boss", bossInputTextScript()).catch(() => "")) ?? "").replace(/\s+/g, "");
      const probe = greeting.replace(/\s+/g, "").slice(0, 10);
      const inputEmpty = !currentInput.trim();
      // 气泡里出现招呼（不要求输入框已清空）也算发出；正文匹配只在输入框清空时才算，
      // 否则输入框里还没发出去的文字也会让 body 命中。
      seen = (probe.length >= 4 && (await driver.evaluate<boolean>("boss", bossSentBubbleScript(probe)).catch(() => false)) === true)
        || (inputEmpty && probe.length >= 4 && body.includes(probe));
      toast = detectBossAutoGreet(rawBody) || (inputEmpty && /发送成功|消息已发送|已发送/.test(body));
      if (seen || toast) break;
    }
    let imageNote = "";
    if (input.imagePath) {
      checkAbort();
      const sentImage = await sendImageResume(driver, input.imagePath, input.log).catch(() => false);
      imageNote = sentImage ? "图片简历已提交到聊天窗口" : "图片简历未自动发送，可在聊天窗口补发";
      if (!sentImage) input.log("图片简历没有自动发送，可稍后在聊天窗口补发");
    }
    await sleep(600);
    await shot(seen || toast ? "greet-sent" : "greet-unconfirmed");
    engine.markBlocked("boss", "", "Boss 打招呼已执行");
    if (seen || toast) {
      return {
        state: "sent",
        message: imageNote ? `已发送打招呼消息（${imageNote}）` : "已发送打招呼消息",
        screenshots,
        blockedReason: "",
        successText: "打招呼消息已出现在聊天窗口",
        greeting,
        greetingSource: "typed",
        finalUrl: await finalUrl(),
      };
    }
    return {
      state: "needs_user",
      message: "已尝试发送，但没有在页面上确认到消息记录。请在浏览器窗口中核对是否已发出，再回工作台标记",
      screenshots,
      blockedReason: "未检测到发送成功提示",
      successText: "",
      greeting,
      greetingSource: "typed",
      finalUrl: await finalUrl(),
    };
  } catch (error: any) {
    // 中止不是失败：不要再去截图或改写平台状态，直接告诉上层这次没投成。
    if (signal?.aborted) return abortedResult();
    return await fail("failed", `Boss 打招呼失败：${text(error?.message ?? error, 300)}`);
  }
}

export { bossChatInputPresentScript };
