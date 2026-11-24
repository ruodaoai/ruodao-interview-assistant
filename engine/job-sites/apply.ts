import type { AutoApplyJob } from "../auto-apply/types";
import { normalizeJob51DetailUrl } from "./job51-api";
import {
  zhaopinMessageProbeScript, zhaopinMessageRecord, zhaopinResumeSelectScript,
  type ZhaopinMessageProbe,
} from "./zhaopin-api";
import type { JobSiteApplyResult, JobSiteId } from "./types";

/**
 * 招聘平台「直接投递简历」执行器。
 *
 * 和 Boss 打招呼的区别：这三个平台的投递是「详情页按钮 → 确认弹窗 → 投递成功提示」，
 * 用的是平台里的在线简历（部分平台弹窗里还能加附件简历）。所以这里不复用聊天输入框逻辑，
 * 只做三件事：找到投递入口、把弹窗确认掉、拿到页面级成功证据。
 *
 * 硬性约束（与插件技能一致）：
 * - 没有看到「投递成功 / 已投递」证据就不算成功，返回 needs_user 交给本人核对。
 * - 遇到登录 / 人机验证立刻停下，不做任何绕过。
 * - 岗位已关闭、已投递过，不重复点，直接给出结论。
 */

// 只认明确的成功回执。裸的「已申请 / 已投递」不能算：51job 的岗位描述里就有
// 「公司已申请的各项专利有218项」，点投递失败时会被误判成投递成功（用户 11-04 实测）。
// 按钮文案变成「已申请 / 已投递」的情况由下面第 4 步的可见按钮检查单独覆盖。
// 智联的成功回执是弹窗标题「已向对方发送简历和打招呼语」，页面正文里没有「投递成功」。
export const APPLY_SUCCESS_PATTERN = /投递成功|申请成功|简历投递成功|简历已发送|发送简历成功|申请已提交|投递已提交|已成功投递|投递完成|简历投递完成|已成功申请|您的简历已投递|申请职位成功|投递简历成功|已向对方发送简历|简历和打招呼语已发送/;
export const APPLY_ALREADY_PATTERN = /(?:今日|已)投递过|已投递该职位|您已投递|已申请该职位|已应聘该职位|重复投递|已投递此职位|已申请过/;
export const APPLY_CLOSED_PATTERN = /职位已关闭|职位已下线|该职位已失效|停止招聘|已停止招聘|岗位已关闭|职位不存在|该职位已过期|已招满|暂无该职位|职位信息不存在|该职位不存在|哦哦！没有职位/;

/**
 * 前程无忧投递成功页。
 *
 * 51job 投递成功后不写「投递成功」字样，而是跳到 applysuccess.php，页面只显示
 * 「使用微信扫码与HR沟通，获取面试机会吧」；底部同时渲染通用空状态
 * 「哦哦！没有职位不要怕…」。只按正文判定会被 APPLY_CLOSED_PATTERN 误判成岗位已关闭
 * （用户 11-05 截图：社会申请里已显示投递成功，队列却记成跳过）。
 */
export function isJob51ApplySuccessUrl(url: string) {
  return /jobs\.51job\.com\/applysuccess\.php/i.test(String(url ?? ""));
}

export type ApplyDriver = {
  load(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  evaluate<T>(code: string): Promise<T | undefined>;
  /**
   * 优先按 class 选择器点，其次按可见文案（正则，已锚定）点。
   * labelSelectors 可以放宽文案扫描的范围（例如「去聊聊」是个 div，不在 button/a 里）。
   * scriptFallback 只在「找得到目标、但坐标被浮层整个盖住」时退化为元素点击，
   * 用于 51job 详情页的 APP 下载二维码正好压在「立即投递」上的情况。
   */
  click(selectors: string[], label?: string, options?: { labelSelectors?: string[]; scriptFallback?: boolean }): Promise<boolean>;
  /** 往可见输入框里写入文本；enter = true 时写完顺手按回车（聊天框常用回车发送）。 */
  type(selectors: string[], value: string, options?: { enter?: boolean }): Promise<boolean>;
  blocker(options?: { ignoreLoginText?: boolean }): Promise<"login" | "verification" | "">;
  /** 页面上是否真的弹着登录浮层（点投递按钮之后才出现的那种）。 */
  hasLoginDialog?(): Promise<boolean>;
  bodyText(): Promise<string>;
  currentUrl(): string;
  /** 等待流程用的时钟；默认 Date.now，测试里可以换成假时钟。 */
  now?(): number;
  /** 截图存证，返回文件路径（失败返回空字符串）。 */
  shot(label: string): Promise<string>;
  upload(selectors: string[], files: string[]): Promise<boolean>;
  log(message: string): void;
};

export type SiteApplyProfile = {
  site: JobSiteId;
  /** 平台里的投递入口（详情页按钮）。 */
  entrySelectors: string[];
  entryLabels: string;
  /** 弹窗里的最终确认按钮。 */
  confirmSelectors: string[];
  confirmLabels: string;
  fileInputSelectors: string[];
  supportsAttachment: boolean;
  /**
   * 没有投递按钮时改走「聊一聊」：点开聊天入口，把开场话术发过去。
   * 猎聘 / 智联 / 前程无忧 都有大量岗位只开放聊天、没有可点的投递按钮。
   */
  chatGreeting: {
    entrySelectors: string[];
    entryLabels: string;
    /** 放宽「聊一聊」文案扫描：51job 的入口是 div 而不是 button。 */
    entryLabelSelectors?: string[];
    inputSelectors: string[];
    sendSelectors: string[];
    sendLabels: string;
  };
  note: string;
};

const CONFIRM_SELECTORS = [
  '[class*="dialog"] button',
  '[class*="modal"] button',
  '[role="dialog"] button',
  '[class*="popup"] button',
];

/** 没有投递按钮时的「聊一聊」兜底：三个平台共用一套入口与输入框探测。 */
const CHAT_GREETING: SiteApplyProfile["chatGreeting"] = {
  entrySelectors: ['button[class*="chat"]', '[class*="chat-btn"]', '[class*="communicate"]', '[class*="contact"] button', 'a[class*="chat"]'],
  entryLabels: "^(去聊聊|聊一聊|立即沟通|和TA聊聊|跟TA聊聊|在线沟通)$",
  // 卡片上「去聊聊」是一个 div.chat，不在 button / a 里，必须放宽文案扫描范围。
  entryLabelSelectors: ['button', 'a', '[role="button"]', '[class*="btn"]', '[class*="chat"]', 'div', 'span'],
  inputSelectors: [
    '[class*="chat"] textarea',
    '[class*="chat"] [contenteditable="true"]',
    'textarea[placeholder*="消息"]',
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="说"]',
    '[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
    'textarea',
  ],
  sendSelectors: ['button[class*="send"]', '[class*="send"]'],
  sendLabels: "^(发送|发送消息)$",
};

export const SITE_APPLY_PROFILES: Record<Exclude<JobSiteId, "boss">, SiteApplyProfile> = {
  liepin: {
    site: "liepin",
    entrySelectors: ['[class*="apply"] button', '[class*="job-apply"]', 'button[class*="resume"]', '[class*="btn-apply"]'],
    // 猎聘详情页底部是「立即投递」，旧版是「应聘职位」，弹窗里是「确认投递」。
    entryLabels: "^(立即投递|投递简历|应聘职位|申请职位|一键投递|立即应聘)$",
    confirmSelectors: CONFIRM_SELECTORS,
    confirmLabels: "^(确认投递|确认申请|立即投递|立即应聘|确定投递|投递|确定)$",
    fileInputSelectors: ['input[type="file"][accept*="pdf"]', 'input[type="file"][accept*="doc"]', 'input[type="file"]'],
    supportsAttachment: true,
    chatGreeting: CHAT_GREETING,
    note: "猎聘详情页有「立即投递」就直接投递（弹窗可补附件简历）；只有「聊一聊」的岗位发送开场话术打招呼。",
  },
  zhaopin: {
    site: "zhaopin",
    // 新版详情页把「立即投递」做成 a.job-detail-summary__apply（不是 button），
    // 旧的 [class*="apply"] button 匹配不到，必须把类名和 a 标签都放进候选。
    entrySelectors: ['[class*="job-detail-summary__apply"]', 'a[class*="apply"]', '[class*="apply"] button', 'button[class*="apply"]', '[class*="btn-apply"]'],
    // 智联详情页右下角是「立即申请」，弹窗里选简历后「立即投递」。
    entryLabels: "^(立即申请|投递简历|申请职位|立即投递)$",
    confirmSelectors: CONFIRM_SELECTORS,
    confirmLabels: "^(立即投递|确认投递|确认申请|确定投递|投递|申请|确定|下一步)$",
    fileInputSelectors: ['input[type="file"][accept*="pdf"]', 'input[type="file"]'],
    supportsAttachment: true,
    chatGreeting: CHAT_GREETING,
    note: "智联详情页有「立即申请」就直接投递（首次选简历 →「立即投递」，成功弹窗是「已向对方发送简历和打招呼语」；没抓到弹窗时重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递，按钮还在会自动再投一次）；只有「聊一聊」的岗位发送开场话术打招呼。可能先要过腾讯云人机验证。",
  },
  job51: {
    site: "job51",
    // 51job 详情页按钮是「投递 / 立即申请该职位」，发送确认页的按钮是「申请」。
    // 搜索结果卡片的按钮类名是 button.btn.apply，详情页沿用同一套按钮样式。
    entrySelectors: [
      'button.btn.apply',
      '.btn.apply',
      '[class*="apply"] button',
      'button[class*="apply"]',
      '[class*="btn-apply"]',
      '[class*="apply-btn"]',
      '.job-apply',
    ],
    entryLabels: "^(投递|投递简历|立即投递|在线投递|申请该职位|申请职位|立即申请|立即申请该职位|一键投递)$",
    confirmSelectors: [...CONFIRM_SELECTORS, '[class*="send"] button', '[class*="dialog"] [class*="btn"]'],
    confirmLabels: "^(发送求职申请|确认投递|立即投递|申请|投递|确定|确认)$",
    chatGreeting: CHAT_GREETING,
    fileInputSelectors: ['input[type="file"][accept*="pdf"]', 'input[type="file"]'],
    supportsAttachment: true,
    note: "前程无忧有「投递」按钮就直接投递（确认页选简历 →「申请」）；没有投递按钮的岗位点「聊一聊」把开场话术发过去。投递后重新打开岗位页，投递按钮消失并出现「继续沟通」才算成功；按钮还在会自动再投一次。",
  },
};

/** 空白页 / 失败说明页的探针：窗口里贴了「页面没有加载出来」时带这个标记。 */
const NOTICE_PROBE = `(() => {
  const body = document.body;
  if (!body) return "blank";
  if (body.getAttribute("data-ruodao-notice") === "load-failed") return "load-failed";
  // 真正空白的 SPA 壳里只有 #app 和几个 script：正文为 0、节点数极少。
  // 正常页面（哪怕是「该职位已关闭」这种短提示页）都有一整套布局节点，不会命中。
  const text = String(body.innerText || "").replace(/\\s+/g, "");
  const nodes = body.querySelectorAll("*").length;
  return text.length < 20 && nodes <= 6 ? "blank" : "";
})()`;

function pageNotReadyResult(
  driver: ApplyDriver,
  screenshots: string[],
  blockedReason: string,
): JobSiteApplyResult {
  return {
    state: "needs_user",
    message: blockedReason === "页面没有加载出来"
      ? "岗位页没有加载出来，窗口里已经写明原因并给了「重新加载」按钮。可能是网络、登录态失效或平台风控拦住了，也可以直接在窗口里手投"
      : "岗位页是空白的，页面上什么都没有。请在窗口里刷新后手动确认，别把这个岗位当成已投递",
    screenshots,
    blockedReason,
    successText: "",
    finalUrl: driver.currentUrl(),
    entryText: "",
  };
}


/**
 * 真正要打开的岗位详情页地址。
 *
 * 51job 只有 `jobs.51job.com/{city}/{jobId}.html` 是服务端渲染的岗位详情页，
 * 「立即投递」按钮就在这一页。卡片里的 a.comp 是**公司主页**（jobs.51job.com/all/coXXXX.html），
 * 早前拼的 `we.51job.com/pc/jobdetail?jobId=` 是前端路由：未登录会被踢到登录页，
 * 登录后也经常整页空白，投递必然失败。
 *
 * 这条详情页地址只有平台接口（search-pc 的 jobHref）知道，所以这里只做「是否已经是详情页」的判定；
 * 拿不到详情页地址时返回空字符串，由 job-sites service 在投递前用职位号换一次，
 * 换不到就明确告诉本人重新搜索，绝不拿公司页或前端路由去点按钮。
 *
 * 不要再兜底到 `we.51job.com/pc/jobdetail?jobId=`：未登录会跳登录页，
 * 登录后整页空白（用户 11-04 截图），投递链路会在空白页上白等。
 */
export function resolveApplyUrl(job: Pick<AutoApplyJob, "source" | "sourceUrl" | "jobId">): string {
  const raw = String(job.sourceUrl ?? "").trim();
  if (job.source !== "job51") return raw;
  return normalizeJob51DetailUrl(raw);
}

/** 公司主页 / 站点导航页的特征：出现在这里说明打开的页面不是岗位详情页。 */
export function isCompanyPageUrl(url: string) {
  return /\/all\/co|\/pc\/comp|jobs\.51job\.com\/all\//i.test(String(url ?? ""));
}

async function waitFor<T>(driver: ApplyDriver, probe: () => Promise<T | null>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const now = () => driver.now?.() ?? Date.now();
  const deadline = now() + timeoutMs;
  let last: T | null = null;
  while (now() < deadline) {
    last = await probe();
    if (last !== null) return last;
    await driver.sleep(intervalMs);
  }
  return last;
}

function normalizeBody(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "");
}

/**
 * 登录墙的提示语。
 *
 * 前程无忧搜索页（we.51job.com）和岗位详情页（jobs.51job.com）是两套登录态，
 * 第一次投递要在详情页单独登录一次；51job 登录后会带着原岗位地址跳回来，
 * 所以这里要告诉用户「登录后回到这个岗位页再点投递」，而不是让他去重新搜岗位。
 */
function loginWallMessage(site: JobSiteId, siteLabel: string) {
  if (site === "job51") {
    return "前程无忧的岗位详情页要单独登录一次（搜索页和详情页的登录态不通用），这次没有提交简历。在这个窗口登录后会自动回到这个岗位页，再点「投递」即可，之后不用重复登录";
  }
  return `${siteLabel}岗位页没有登录态，点了「投递」只弹出了登录框，这次没有提交简历。请在窗口里登录后再投递`;
}

function visibleButtonsScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labels = [];
    for (const element of document.querySelectorAll("button, a, [role='button'], [class*='btn']")) {
      if (!visible(element)) continue;
      const label = String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
      if (label && label.length <= 16) labels.push(label);
    }
    return [...new Set(labels)].slice(0, 24);
  })()`;
}

export type SiteDetailState = {
  /** 详情页上还能看到可点的投递按钮。 */
  applyVisible?: boolean;
  /** 按钮文案已经变成「已投递 / 已申请」。 */
  doneVisible?: boolean;
  /** 投递成功后平台把入口换成了「继续沟通」。 */
  continueVisible?: boolean;
  buttons?: string[];
};

/** 已投递 / 已沟通的按钮文案：类名不变、只换文案时不能再算成投递入口。 */
const APPLIED_LABEL_PATTERN = /^(继续沟通|已投递|已申请|已投递该职位|已申请该职位)$/;

/**
 * 非 Boss 平台详情页的投递状态探针（只看页面，不点按钮）。
 *
 * 用户 11-04 实测（前程无忧）、11-05 实测（智联）：投递成功后重新打开岗位页，
 * 投递按钮会消失并出现「继续沟通」；按钮还在就说明没投出去。
 * 推荐位 / 相似职位卡片里也有同名按钮，这些不属于当前岗位，必须排除，
 * 否则成功页会被误判成「还没投」。
 */
export function siteDetailStateScript(profile: SiteApplyProfile) {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "").trim();
    const labelOf = (element) => clean(element) || String(element.getAttribute("aria-label") || element.getAttribute("title") || "").replace(/\\s+/g, "").trim();
    const applyPattern = new RegExp(${JSON.stringify(profile.entryLabels)});
    const applySelectors = ${JSON.stringify(profile.entrySelectors)};
    const extra = (element) => Boolean(element.closest('[class*="recommend"], [class*="similar"], [class*="related"], [class*="hotjob"], [class*="guess"], [class*="job-list"]'));
    const controls = [...document.querySelectorAll("button, a, [role='button'], [class*='btn'], [class*='apply'], [class*='chat'], [class*='communicate'], [class*='contact']")].filter(visible);
    const labels = controls.map(clean);
    // 智联 / 前程无忧的入口常常是「外层 div 里包一个纯文字节点」，控件扫描漏掉时再看叶子节点；
    // 这只认正文恰好是「继续沟通」的节点，不会把岗位描述里的文字当成按钮。
    let continueVisible = controls.some((element) => !extra(element) && labelOf(element) === "继续沟通");
    if (!continueVisible) {
      continueVisible = [...document.querySelectorAll("span, div, p, strong")]
        .filter((element) => element.children.length === 0 && visible(element))
        .some((element) => !extra(element) && clean(element) === "继续沟通");
    }
    const doneVisible = controls.some((element) => !extra(element) && /^(已投递|已申请|已投递该职位|已申请该职位)$/.test(labelOf(element)));
    let applyVisible = controls.some((element) => {
      const label = labelOf(element);
      return !extra(element) && label.length <= 16 && applyPattern.test(label);
    });
    if (!applyVisible) {
      const appliedLabel = ${JSON.stringify(APPLIED_LABEL_PATTERN.source)};
      for (const selector of applySelectors) {
        try {
          if ([...document.querySelectorAll(selector)].some((element) => {
            if (!visible(element) || extra(element)) return false;
            // 平台可能把同一个「立即申请」元素直接改成「继续沟通」：类名还在，但已经不是投递入口。
            return !new RegExp(appliedLabel).test(labelOf(element));
          })) {
            applyVisible = true;
            break;
          }
        } catch {}
      }
    }
    return { applyVisible, doneVisible, continueVisible, buttons: [...new Set(labels.filter(Boolean))].slice(0, 24) };
  })()`;
}

/** 等页面把「投递 / 继续沟通 / 已投递」任一状态画出来再下结论，避免慢网下把未渲染当成未投递。 */
async function readSiteDetailState(driver: ApplyDriver, profile: SiteApplyProfile, timeoutMs = 5_000): Promise<SiteDetailState> {
  try {
    const state = await waitFor<SiteDetailState>(driver, async () => {
      const next = (await driver.evaluate<SiteDetailState>(siteDetailStateScript(profile))) ?? {};
      return next.applyVisible === true || next.continueVisible === true || next.doneVisible === true ? next : null;
    }, timeoutMs, 700);
    return state ?? {};
  } catch {
    // 页面还在跳转时脚本可能取不到 DOM：按「状态未知」处理，让调用方继续正常点击流程。
    return {};
  }
}

function inputValueScript(selectors: string[]) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        return "value" in element ? String(element.value ?? "") : String(element.innerText ?? element.textContent ?? "");
      }
    }
    return "";
  })()`;
}

type ChatGreetingProfile = NonNullable<SiteApplyProfile["chatGreeting"]>;

/**
 * 没有投递按钮时的兜底：点「去聊聊 / 聊一聊」→ 把开场话术填进聊天框 → 发送 → 确认消息真的出现。
 *
 * 只有确认页面里出现了刚发送的话术才当成功；输入框遇到登录 / 手机端沟通的情况不硬闯，
 * 直接交回本人处理并说明卡在哪一步。
 */
async function greetThroughChat(
  driver: ApplyDriver,
  chat: ChatGreetingProfile,
  options: { greeting?: () => Promise<string> },
  shot: (label: string) => Promise<void>,
  screenshots: string[],
): Promise<JobSiteApplyResult | null> {
  const opened = await driver.click(chat.entrySelectors, chat.entryLabels, { labelSelectors: chat.entryLabelSelectors });
  if (!opened) return null;
  driver.log("没有投递按钮，已点「聊一聊」，准备把开场话术发过去");
  await driver.sleep(2200);
  const fail = async (label: string, state: JobSiteApplyResult["state"], message: string, blockedReason: string): Promise<JobSiteApplyResult> => {
    await shot(label);
    return { state, message, screenshots, blockedReason, successText: "", finalUrl: driver.currentUrl(), entryText: "" };
  };

  let greeting = "";
  try {
    greeting = String((await options.greeting?.()) ?? "").trim();
  } catch {
    greeting = "";
  }
  if (!greeting) {
    return fail("chat-no-greeting", "needs_user", "这个岗位没有投递按钮，聊一聊已经打开，但没有可发送的开场话术。请在窗口里手动把话术发过去", "没有可用话术");
  }

  const typed = await driver.type(chat.inputSelectors, greeting);
  if (!typed) {
    return fail(
      "chat-no-input",
      "needs_user",
      "这个岗位没有投递按钮，已点「聊一聊」，但聊天输入框没有出现（可能需要先登录，或平台要求在手机端沟通）。请在窗口里手动发送话术",
      "聊天输入框未出现",
    );
  }
  driver.log("已把开场话术填入聊天框，正在发送");
  await driver.sleep(500);
  const sent = await driver.click(chat.sendSelectors, chat.sendLabels);
  if (!sent) {
    // 有的聊天框没有独立的发送按钮，只能回车发送。
    await driver.type(chat.inputSelectors, greeting, { enter: true });
  }

  const probe = greeting.replace(/\s+/g, "").slice(0, 10);
  const seen = await waitFor(driver, async () => {
    const body = normalizeBody(await driver.bodyText());
    const left = String((await driver.evaluate<string>(inputValueScript(chat.inputSelectors))) ?? "").replace(/\s+/g, "");
    return probe.length >= 4 && body.includes(probe) && !left.trim() ? "sent" : null;
  }, 12_000, 700);

  if (seen) {
    await shot("chat-sent");
    return {
      state: "submitted",
      message: "这个岗位没有投递按钮，已点「聊一聊」把开场话术发给了招聘者",
      screenshots,
      blockedReason: "",
      successText: "聊天窗口已出现刚发送的话术",
      finalUrl: driver.currentUrl(),
      entryText: "聊一聊 + 开场话术",
    };
  }
  return fail(
    "chat-unconfirmed",
    "needs_user",
    "已点「聊一聊」并填好话术，但页面上没有确认到消息记录。请在浏览器窗口里核对是否已发出，再回工作台标记",
    "未检测到消息发送成功",
  );
}

/**
 * 智联投递后的第二重核对：打开消息列表，找这个岗位的投递会话。
 *
 * 智联的成功弹窗有时几秒就消失，光等页面正文会漏掉；而消息列表会长期保留
 * 「您已投递的 <岗位名>」/「已发送附件简历」这条记录。只有岗位名（和公司名）
 * 与投递回执出现在同一条会话里才算成功，避免被别的岗位历史记录误导。
 *
 * 页头的「消息」是 SPA 路由，anchor 的 href 常常就是首页（实测打开 /message/ 会回首页），
 * 所以这里直接点入口，不再按地址打开。
 */
async function verifyZhaopinMessageRecord(
  driver: ApplyDriver,
  job: AutoApplyJob,
  shot: (label: string) => Promise<void>,
  screenshots: string[],
): Promise<JobSiteApplyResult | null> {
  driver.log("页面没有出现投递回执，正在打开智联消息列表核对投递记录");
  const opened = await driver.click([], "^消息\\d*\\+?$", {
    labelSelectors: ["a", "button", "[role='button']", "div", "span"],
  });
  if (!opened) return null;
  await driver.sleep(2200);
  if (await driver.blocker()) return null;
  const matched = await waitFor(driver, async () => {
    const probe = await driver.evaluate<ZhaopinMessageProbe>(zhaopinMessageProbeScript());
    if (!probe) return null;
    return zhaopinMessageRecord(probe, job) || null;
  }, 10_000, 800);
  await shot(matched ? "apply-message-record" : "apply-message-unconfirmed");
  if (!matched) return null;
  return {
    state: "submitted",
    message: `页面没有抓到投递成功弹窗，但在智联消息列表里找到了这个岗位的投递记录（${matched}）`,
    screenshots,
    blockedReason: "",
    successText: "消息列表显示已投递",
    finalUrl: driver.currentUrl(),
    entryText: "详情页投递按钮",
  };
}

/**
 * 投递一个岗位。返回值里的 state 与 Boss 打招呼保持一致，便于上层复用投递记录与批量队列。
 */
export async function submitResume(
  driver: ApplyDriver,
  job: AutoApplyJob,
  options: {
    resumeFilePath?: string;
    greeting?: () => Promise<string>;
  } = {},
): Promise<JobSiteApplyResult> {
  const site = job.source as Exclude<JobSiteId, "boss">;
  const profile = SITE_APPLY_PROFILES[site];
  const screenshots: string[] = [];
  const base = {
    state: "failed" as JobSiteApplyResult["state"],
    message: "",
    screenshots,
    blockedReason: "",
    successText: "",
    finalUrl: "",
    entryText: "",
  };
  if (!profile) return { ...base, message: `${job.source} 暂不支持自动投递简历` };
  if (!/^https?:/i.test(String(job.sourceUrl || ""))) {
    return { ...base, message: "岗位链接无效，无法打开详情页" };
  }

  const shot = async (label: string) => {
    const file = await driver.shot(label).catch(() => "");
    if (file) screenshots.push(file);
  };

  const targetUrl = resolveApplyUrl(job);
  if (!targetUrl) {
    await shot("apply-bad-url");
    return {
      ...base,
      state: "needs_user",
      message: site === "job51"
        ? "这条岗位记录里没有前程无忧的岗位详情页地址（只有公司主页或搜索页链接），打开也点不到「立即投递」。请在招聘窗口里重新搜索一次这个岗位再投递"
        : "这条岗位记录里的链接不是岗位详情页，打开也点不到投递按钮。请在平台上重新搜索一次这个岗位再投递",
      blockedReason: "岗位链接不是详情页",
      finalUrl: driver.currentUrl(),
    };
  }

  await driver.load(targetUrl);
  await driver.sleep(1200);
  const siteLabel = site === "zhaopin" ? "智联招聘" : site === "liepin" ? "猎聘" : "前程无忧";
  // 51job 详情页匿名时页头和侧栏常驻登录组件，正文的「登录/注册」不是登录墙；
  // 真正的登录墙是点「立即投递」后被踢到 login.51job.com（下面点击后复检）。
  const softLogin = site === "job51";
  const blocked = await driver.blocker({ ignoreLoginText: softLogin });
  if (blocked) {
    await shot(`apply-${blocked}`);
    return {
      ...base,
      // 登录和验证都需要本人处理，一律交给用户：绝不当成已投递，也不继续点按钮。
      state: "blocked",
      message: blocked === "verification"
        ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试`
        : loginWallMessage(site, siteLabel),
      blockedReason: blocked === "verification" ? "需要人机验证" : "需要登录",
      finalUrl: driver.currentUrl(),
    };
  }

  // 51job 的岗位卡片上唯一的 href 是公司主页（a.comp），跳转后如果还是公司页 / 站点导航页，
  // 断言到投递按钮也没有意义，直接说明原因交给本人处理。
  if (site === "job51" && isCompanyPageUrl(driver.currentUrl())) {
    await shot("apply-company-page");
    return {
      ...base,
      state: "needs_user",
      message: "打开的页面是公司主页而不是岗位详情页，找不到投递按钮。请在平台上重新搜索这个岗位再投递",
      blockedReason: "打开的是公司主页",
      finalUrl: driver.currentUrl(),
    };
  }

  // 51job 投递成功后会停在 applysuccess.php；重新打开岗位页时如果平台直接带到这里，
  // 只能按成功处理，绝不能因为底部的通用空状态把它记成「岗位已关闭」。
  if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) {
    await shot("apply-success");
    return {
      ...base,
      state: "submitted",
      message: "已提交简历（前程无忧跳转到投递成功页，可用微信扫码与 HR 沟通）",
      successText: "前程无忧投递成功页",
      finalUrl: driver.currentUrl(),
    };
  }

  const before = normalizeBody(await driver.bodyText());
  // 页面根本没画出来时，下面所有「找不到按钮」的判断都是瞎猜：先明确告诉本人是白屏，
  // 别让「岗位已下线 / 需要登录」这种结论误导人去删岗位记录。
  const notReady = await driver.evaluate<string>(NOTICE_PROBE);
  if (notReady === "load-failed" || notReady === "blank") {
    await shot(notReady === "load-failed" ? "apply-load-failed" : "apply-blank");
    return pageNotReadyResult(driver, screenshots, notReady === "load-failed" ? "页面没有加载出来" : "页面空白");
  }
  // 成功证据优先于「职位不存在」：51job 投递成功后会在同一页同时显示
  // 「投递成功！」和通用空状态「哦哦！没有职位不要怕…」，先判空状态会把成功记成岗位已关闭。
  if (APPLY_SUCCESS_PATTERN.test(before)) {
    return { ...base, state: "submitted", message: "页面显示投递成功，没有重复投递", successText: before.match(APPLY_SUCCESS_PATTERN)?.[0] ?? "投递成功", finalUrl: driver.currentUrl() };
  }
  if (APPLY_ALREADY_PATTERN.test(before)) {
    await shot("apply-already");
    return { ...base, state: "already", message: "页面上已经显示投递过这个岗位，没有重复投递", successText: "页面显示已投递", finalUrl: driver.currentUrl() };
  }
  if (APPLY_CLOSED_PATTERN.test(before)) {
    await shot("apply-closed");
    return { ...base, state: "failed", message: "这个岗位在平台上已关闭 / 停止招聘，没有投递", blockedReason: "岗位已关闭", finalUrl: driver.currentUrl() };
  }

  // 前程无忧 / 智联：重新打开之前投过的岗位时，投递按钮会消失并换成「继续沟通」，
  // 按钮还在就说明没投出去（用户 11-04 / 11-05 给出的可靠判据）。
  // 先看页面状态，避免对已投岗位重复点击。
  let continueVisibleBefore = false;
  if (site === "job51" || site === "zhaopin") {
    const detail = await readSiteDetailState(driver, profile, 2_500);
    continueVisibleBefore = detail.continueVisible === true;
    if (detail.applyVisible !== true && (detail.continueVisible === true || detail.doneVisible === true)) {
      await shot("apply-already");
      return {
        ...base,
        state: "already",
        message: `岗位页的投递按钮已经消失（页面显示「继续沟通」或「已投递」），说明之前已经投递过，没有重复投递`,
        successText: detail.continueVisible === true ? "投递按钮已消失，页面显示「继续沟通」" : "页面显示已投递",
        finalUrl: driver.currentUrl(),
      };
    }
  }

  // 1) 详情页投递入口。
  // 「点入口 → 确认弹窗 → 等回执」是一次完整尝试：51job 页面没回执时会重开详情页，
  // 确认按钮还在就直接再投一次，所以把这套动作收成可复用的函数（用户 11-04 要求）。
  driver.log(`正在查找${profile.site === "liepin" ? "猎聘" : profile.site === "zhaopin" ? "智联" : "51job"}的投递入口`);
  /**
   * 智联 / 前程无忧投递后最可靠的信号：入口从「立即申请 / 立即投递」变成「继续沟通」。
   * 成功弹窗经常被平台自动关掉，页面里根本没有文字回执；读按钮状态反而更快更稳。
   * 连续确认两次，避免选简历弹窗弹开的瞬间按钮暂时消失被误判成已投递。
   */
  const appliedLabelNow = async (): Promise<string> => {
    if (site !== "zhaopin" && site !== "job51") return "";
    const read = async () => (await driver.evaluate<SiteDetailState>(siteDetailStateScript(profile))) ?? {};
    const state = await read();
    if (state.applyVisible === true) return "";
    if (state.continueVisible !== true && state.doneVisible !== true) return "";
    await driver.sleep(500);
    const again = await read();
    if (again.applyVisible === true) return "";
    // 点击前就有「继续沟通」的岗位不能拿它当这次投递的证据，否则投递弹窗一遮住入口就会误判成功。
    if (!continueVisibleBefore && again.continueVisible === true) return "继续沟通";
    if (again.doneVisible === true) return "已投递";
    return "";
  };
  type ApplyOutcome = { kind: "success" | "applied" | "closed" | "success-page"; text: string };
  type ApplyAttempt = {
    entryHit: boolean;
    wall: "login" | "verification" | "";
    wallAfter: "entry" | "confirm";
    confirmed: boolean;
    outcome: ApplyOutcome | null;
  };
  const attemptApply = async (): Promise<ApplyAttempt> => {
    const loginDialogBefore = (await driver.hasLoginDialog?.()) === true;
    // 51job 详情页右上角的 APP 下载二维码会完整盖住「立即投递」，坐标点击只会点到二维码上。
    // 入口点击允许在「目标存在但被浮层遮挡」时退化为元素点击，否则投递流程一步都走不动。
    const entryHit = await driver.click(profile.entrySelectors, profile.entryLabels, { scriptFallback: true });
    if (!entryHit) return { entryHit, wall: "", wallAfter: "entry", confirmed: false, outcome: null };
    // 很多平台把登录校验放在「立即投递」上：匿名点击会跳到登录页，或在原地弹出登录框。
    // 要等跳转/弹层稳定后再判定；只等 900ms 会在慢网下把还在跳转的页面当成「没回执」，
    // 白等后误报「需本人确认」。智联的登录校验基本都是点完立刻出现，3 秒就够。
    await driver.sleep(900);
    const wall = await waitFor<"login" | "verification">(driver, async () => {
      const kind = await driver.blocker({ ignoreLoginText: softLogin });
      if (kind) return kind;
      const dialog = (await driver.hasLoginDialog?.()) === true;
      return dialog && !loginDialogBefore ? "login" : null;
    }, site === "zhaopin" ? 3_000 : 6_000, 700);
    if (wall) return { entryHit, wall, wallAfter: "entry", confirmed: false, outcome: null };

    // 3) 弹窗确认（可能有「选择简历 → 确认投递」两步）
    let rounds = 0;
    let confirmed = false;
    let attached = false;
    let waitedDialog = false;
    while (rounds < 4) {
      rounds += 1;
      await driver.sleep(rounds === 1 ? 900 : 700);
      // 弹窗里能补附件简历时补一次；没有文件输入就静默跳过，不用「完善简历」挡路。
      if (!attached && options.resumeFilePath && profile.supportsAttachment) {
        attached = await driver.upload(profile.fileInputSelectors, [options.resumeFilePath]).catch(() => false);
        if (attached) {
          driver.log("已选择附件简历");
          await driver.sleep(800);
        }
      }
      // 智联第一次投递会弹「选择简历」，不选中就点「立即投递」没有任何反应；
      // 选过一次之后平台会记住，脚本会返回 found=true / selected=false，不会重复点。
      if (site === "zhaopin") {
        const selection = await driver.evaluate<{ found?: boolean; selected?: boolean }>(zhaopinResumeSelectScript());
        if (selection?.selected === true) driver.log("已在投递弹窗里选中简历");
      }
      if (await driver.click(profile.confirmSelectors, profile.confirmLabels)) {
        confirmed = true;
        await driver.sleep(1200);
        // 已经出现「继续沟通」就不用再补点确认，直接进入结果判定。
        if (await appliedLabelNow()) break;
        continue;
      }
      // 智联的选择简历弹窗可能比入口点击晚一两秒才画出来，没点成确认时多等一轮，
      // 否则会在弹窗出现之前就放弃，最后把「其实能投」记成「没有投递入口」。
      if (site === "zhaopin" && !confirmed && !waitedDialog) {
        waitedDialog = true;
        if (await appliedLabelNow()) break;
        await waitFor(driver, async () => {
          const probe = await driver.evaluate<{ found?: boolean }>(zhaopinResumeSelectScript());
          return probe?.found === true ? true : null;
        }, 4_000, 400);
        continue;
      }
      break;
    }

    // 确认过程中也可能被要求登录（平台把登录校验放在最后一步）：这一步同样必须交回本人。
    // 只认点击后新出现的登录框：51job 详情页匿名时本来就常驻登录组件，不能拿它当新证据。
    if ((await driver.hasLoginDialog?.()) && !loginDialogBefore) {
      return { entryHit, wall: "login", wallAfter: "confirm", confirmed, outcome: null };
    }

    // 4) 成功证据：页面出现「投递成功 / 已投递」、投递按钮变成「已投递」，
    // 或智联 / 前程无忧的入口直接变成「继续沟通」（平台经常把成功弹窗自动关掉）。
    // 智联按钮状态通常两三秒就更新，6 秒等不到就重开岗位页核对；51job 的 toast 偶尔慢，保留 20 秒。
    //
    // 同时必须盯住「职位不存在」：51job 的岗位下线后，点投递会跳到一个写满
    // 「哦哦！没有职位不要怕…」的空状态页。以前这里只是 `return ""` 继续等，
    // 白等满 20 秒再报「没拿到成功回执，请人工核对」，用户既看不懂也不知道岗位已经没了，
    // 而且这种假 need_user 连撞三次就会把整批熔断（用户 10-31 反馈）。
    const outcome = await waitFor<ApplyOutcome>(driver, async () => {
      // 51job 的 applysuccess.php 是最明确的成功回执：页面没有「投递成功」字样，
      // 底部还有通用空状态，只按正文判会把成功页记成岗位已关闭（用户 11-05 截图）。
      if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) {
        return { kind: "success-page", text: "前程无忧投递成功页" };
      }
      const body = normalizeBody(await driver.bodyText());
      // 51job 投递成功页同时带着「哦哦！没有职位不要怕…」的通用空状态，
      // 必须先认成功横幅，再判岗位关闭，否则每次成功都会被记成「岗位已下线」。
      const success = body.match(APPLY_SUCCESS_PATTERN)?.[0] ?? "";
      if (success) return { kind: "success", text: success };
      if (APPLY_ALREADY_PATTERN.test(body)) return { kind: "success", text: "已投递" };
      const buttons = await driver.evaluate<string[]>(visibleButtonsScript()) ?? [];
      const done = buttons.find((label) => /^(已投递|已申请|已投递该职位|已申请该职位)$/.test(String(label).replace(/\s+/g, "")));
      if (done) return { kind: "success", text: done };
      const applied = await appliedLabelNow();
      if (applied) return { kind: "applied", text: applied };
      if (APPLY_CLOSED_PATTERN.test(body)) return { kind: "closed", text: "职位不存在" };
      return null;
    }, site === "zhaopin" ? 6_000 : 20_000, 700);
    return { entryHit, wall: "", wallAfter: "confirm", confirmed, outcome };
  };

  const attempt = await attemptApply();
  const entryText = attempt.entryHit ? "详情页投递按钮" : "";
  if (attempt.wall) {
    await shot("apply-login-dialog");
    return {
      ...base,
      state: "blocked",
      message: attempt.wall === "verification"
        ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试`
        : attempt.wallAfter === "confirm"
          ? `${siteLabel}要求先登录才能提交简历，这次没有提交成功。请在窗口里登录后重新投递`
          : loginWallMessage(site, siteLabel),
      blockedReason: attempt.wall === "verification" ? "需要人机验证" : "需要登录",
      entryText,
      finalUrl: driver.currentUrl(),
    };
  }
  // 2) 没有投递按钮：平台允许就走「聊一聊」发开场话术（三个平台大量岗位只有聊一聊）。
  if (!attempt.entryHit) {
    const greeted = await greetThroughChat(driver, profile.chatGreeting, options, shot, screenshots);
    if (greeted) return greeted;
    const buttons = await driver.evaluate<string[]>(visibleButtonsScript()) ?? [];
    await shot("apply-no-entry");
    return {
      ...base,
      state: "needs_user",
      message: profile.chatGreeting
        ? `这个岗位页既没有投递按钮，也没有「聊一聊」入口${buttons.length ? `（页面可见按钮：${buttons.slice(0, 8).join(" / ")}）` : ""}。可能是岗位已下线、需要登录，或平台还没把页面渲染完，请在窗口里刷新后手动处理`
        : buttons.length
          ? `没有找到投递按钮（页面可见按钮：${buttons.slice(0, 10).join(" / ")}）。可能是岗位已下线、需要登录，或平台改了按钮文案，请在窗口里手动投递`
          : "没有找到投递按钮，岗位可能已下线或页面还没渲染完，请在窗口里刷新后手动确认",
      blockedReason: "未找到投递入口",
      finalUrl: driver.currentUrl(),
    };
  }

  await shot(attempt.outcome ? (attempt.outcome.kind === "closed" ? "apply-closed" : "apply-success") : "apply-unconfirmed");
  const finalUrl = driver.currentUrl();
  if (attempt.outcome?.kind === "closed") {
    return {
      ...base,
      state: "failed",
      message: "点了投递之后，页面变成「职位不存在 / 已下线」的空状态，这个岗位已经投不了了。请回到岗位池重新搜索一个新岗位",
      blockedReason: "岗位已关闭",
      entryText,
      finalUrl,
    };
  }
  if (attempt.outcome?.kind === "success-page") {
    return {
      ...base,
      state: "submitted",
      message: `已提交简历（前程无忧跳转到投递成功页，可用微信扫码与 HR 沟通${attempt.confirmed ? "，弹窗已确认" : ""}）`,
      successText: attempt.outcome.text,
      entryText,
      finalUrl,
    };
  }
  if (attempt.outcome?.kind === "applied") {
    return {
      ...base,
      state: "submitted",
      message: `已提交简历（投递后页面按钮变成「${attempt.outcome.text}」${attempt.confirmed ? "，弹窗已确认" : ""}）`,
      successText: `投递后页面显示「${attempt.outcome.text}」`,
      entryText,
      finalUrl,
    };
  }
  if (attempt.outcome?.kind === "success") {
    return {
      ...base,
      state: "submitted",
      message: `已提交简历（页面提示「${attempt.outcome.text}」${attempt.confirmed ? "，弹窗已确认" : ""}）`,
      successText: attempt.outcome.text,
      entryText,
      finalUrl,
    };
  }

  /**
   * 前程无忧 / 智联点了投递却没有任何回执时，用「重新打开岗位页后的按钮状态」下结论：
   * - 投递按钮消失、出现「继续沟通」→ 已经投递成功（用户 11-05 对智联的明确要求）；
   * - 投递按钮还在 → 上次没投成，直接自动再点一次（不再让用户确认）；
   * - 两次都没有回执且按钮仍在 → 明确记为失败，批量结束时会再读平台记录核对/补投。
   * 智联重开页面后既没有投递按钮也没有「继续沟通」时，再读一次消息记录，仍找不到才交给本人。
   */
  const recheckAfterAttempt = async (options: { unknownOutcome: "failed" | "needs_user" }): Promise<JobSiteApplyResult> => {
    type PageRead =
      | { kind: "blocked"; wall: "login" | "verification" }
      | { kind: "not-ready"; notReady: "load-failed" | "blank" }
      | { kind: "load-error" }
      | { kind: "success-page" }
      | { kind: "state"; state: SiteDetailState };
    const readPage = async (): Promise<PageRead> => {
      try {
        await driver.load(targetUrl);
      } catch {
        return { kind: "load-error" };
      }
      await driver.sleep(900);
      const wall = await driver.blocker({ ignoreLoginText: softLogin });
      if (wall) return { kind: "blocked", wall };
      if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) return { kind: "success-page" };
      const notReady = String((await driver.evaluate<string>(NOTICE_PROBE)) ?? "");
      if (notReady === "load-failed" || notReady === "blank") return { kind: "not-ready", notReady };
      return { kind: "state", state: await readSiteDetailState(driver, profile, 3_500) };
    };
    const blockedResult = async (wall: "login" | "verification"): Promise<JobSiteApplyResult> => {
      await shot("apply-login-dialog");
      return {
        ...base,
        state: "blocked",
        message: wall === "verification"
          ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试`
          : loginWallMessage(site, siteLabel),
        blockedReason: wall === "verification" ? "需要人机验证" : "需要登录",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    };
    const appliedResult = (message: string, state: SiteDetailState): JobSiteApplyResult => ({
      ...base,
      state: "already",
      message,
      successText: state.continueVisible === true ? "投递按钮已消失，页面显示「继续沟通」" : "页面显示已投递",
      entryText,
      finalUrl: driver.currentUrl(),
    });
    const isApplied = (state: SiteDetailState) =>
      state.applyVisible !== true && (state.continueVisible === true || state.doneVisible === true);

    driver.log(`页面没有出现投递成功提示，正在重新打开${siteLabel}岗位页核对投递状态`);
    // 弹窗消失后当前页往往已经换成「继续沟通」，先就地把状态读出来，省掉一次重新加载。
    // 点击前页面本来就有「继续沟通」时不能这样判断，必须重开页面拿到干净状态。
    const currentState = await readSiteDetailState(driver, profile, 800);
    if (!continueVisibleBefore && isApplied(currentState)) {
      await shot("apply-already");
      return appliedResult("页面没有出现文字回执，但投递按钮已经消失、出现「继续沟通」，确认这个岗位已经投递成功，没有重复投递", currentState);
    }
    let page = await readPage();
    if (page.kind === "blocked") return blockedResult(page.wall);
    if (page.kind === "load-error") {
      return {
        ...base,
        state: "failed",
        message: `第一次点击后没有回执，重新打开${siteLabel}岗位页也失败了；这个岗位没有确认投出去，可以稍后重新投递`,
        blockedReason: "重新打开详情页失败",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (page.kind === "not-ready") {
      await shot(page.notReady === "load-failed" ? "apply-load-failed" : "apply-blank");
      return {
        ...base,
        state: "failed",
        message: page.notReady === "load-failed"
          ? `第一次点击后没有回执，重新打开${siteLabel}岗位页时页面没有加载出来，无法确认这次投递；可以稍后重新投递这个岗位`
          : `第一次点击后没有回执，重新打开${siteLabel}岗位页只看到空白页，无法确认这次投递；可以稍后重新投递这个岗位`,
        blockedReason: page.notReady === "load-failed" ? "页面没有加载出来" : "页面空白",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (page.kind === "success-page") {
      await shot("apply-success");
      return {
        ...base,
        state: "submitted",
        message: "第一次点击后没有文字回执；重新打开时页面停在投递成功页，确认这个岗位已经投递成功，没有重复投递",
        successText: "前程无忧投递成功页",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (isApplied(page.state)) {
      await shot("apply-already");
      return appliedResult("第一次点击后页面没有回执；重新打开岗位页时投递按钮已经消失、出现「继续沟通」，确认这个岗位已经投递成功，没有重复投递", page.state);
    }
    if (page.state.applyVisible !== true) {
      await shot("apply-unconfirmed");
      return {
        ...base,
        state: options.unknownOutcome,
        message: "第一次点击后没有回执；重新打开岗位页既没有找到投递按钮，也没有出现「继续沟通」，无法确认这次投递",
        blockedReason: "未检测到投递按钮或继续沟通",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    // 投递按钮还在 = 上一次没投成：按用户要求直接再投一次，不再人工确认。
    driver.log("重新打开岗位页后投递按钮仍在，说明上一次没有投递成功，正在自动补投一次");
    await shot("apply-retry");
    const retry = await attemptApply();
    if (retry.wall) return blockedResult(retry.wall);
    if (retry.outcome?.kind === "applied") {
      await shot("apply-success");
      return {
        ...base,
        state: "submitted",
        message: `第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（投递后页面按钮变成「${retry.outcome.text}」）`,
        successText: `投递后页面显示「${retry.outcome.text}」`,
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (retry.outcome?.kind === "success") {
      await shot("apply-success");
      return {
        ...base,
        state: "submitted",
        message: `第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（页面提示「${retry.outcome.text}」）`,
        successText: retry.outcome.text,
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (retry.outcome?.kind === "success-page") {
      await shot("apply-success");
      return {
        ...base,
        state: "submitted",
        message: "第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（前程无忧跳转到投递成功页）",
        successText: retry.outcome.text,
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (retry.outcome?.kind === "closed") {
      await shot("apply-closed");
      return {
        ...base,
        state: "failed",
        message: "自动补投时页面变成「职位不存在 / 已下线」的空状态，这个岗位已经投不了了。请回到岗位池重新搜索一个新岗位",
        blockedReason: "岗位已关闭",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    // 补投后仍然没有回执：再重开一次岗位页，按按钮状态给出最终结论。
    driver.log("自动补投后仍没有成功提示，再次重新打开岗位页核对");
    page = await readPage();
    if (page.kind === "blocked") return blockedResult(page.wall);
    if (page.kind === "load-error" || page.kind === "not-ready") {
      await shot(page.kind === "not-ready" && page.notReady === "blank" ? "apply-blank" : "apply-load-failed");
      return {
        ...base,
        state: "failed",
        message: `自动补投后重新打开${siteLabel}岗位页失败，无法确认这次投递是否成功；可以稍后重新投递这个岗位`,
        blockedReason: "重新核对页面失败",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (page.kind === "success-page") {
      await shot("apply-success");
      return {
        ...base,
        state: "submitted",
        message: "自动补投后重新打开页面停在投递成功页，确认这个岗位已经投递成功",
        successText: "前程无忧投递成功页",
        entryText,
        finalUrl: driver.currentUrl(),
      };
    }
    if (isApplied(page.state)) {
      await shot("apply-already");
      return appliedResult("自动补投后重新打开岗位页，投递按钮已经消失并出现「继续沟通」，确认这个岗位已经投递成功", page.state);
    }
    await shot("apply-unconfirmed");
    return {
      ...base,
      state: page.state.applyVisible === true ? "failed" : options.unknownOutcome,
      message: page.state.applyVisible === true
        ? "自动补投两次后，重新打开岗位页仍能看到投递按钮，说明这次没有投递成功；可以稍后在工作台重新投递这个岗位"
        : "自动补投后重新打开岗位页，既没有投递按钮也没有「继续沟通」，无法确认这次投递",
      blockedReason: page.state.applyVisible === true ? "未检测到投递成功提示" : "未检测到投递按钮或继续沟通",
      entryText,
      finalUrl: driver.currentUrl(),
    };
  };

  if (site === "job51") return recheckAfterAttempt({ unknownOutcome: "failed" });

  if (site === "zhaopin") {
    const rechecked = await recheckAfterAttempt({ unknownOutcome: "needs_user" });
    if (rechecked.state !== "needs_user" || rechecked.blockedReason !== "未检测到投递按钮或继续沟通") return rechecked;
    // 页面按钮判断不出来（例如平台把入口整个换掉了）时，再用消息列表的投递记录兜底；
    // 仍然找不到只说明无法确认，绝不反推没投出去。
    const verified = await verifyZhaopinMessageRecord(driver, job, shot, screenshots);
    if (verified) return verified;
    return {
      ...rechecked,
      message: `${rechecked.message}；智联消息列表里也暂时没有核对到这条记录，请打开智联消息页核对是否已投递`,
      finalUrl: driver.currentUrl(),
    };
  }

  return {
    ...base,
    state: "needs_user",
    message: attempt.confirmed || entryText
      ? "已点击投递并确认，但页面没有出现投递成功提示。请在浏览器窗口里核对是否已投递，再回工作台标记"
      : "没有点成投递，请在浏览器窗口里手动投递",
    blockedReason: "未检测到投递成功提示",
    entryText,
    finalUrl,
  };
}
