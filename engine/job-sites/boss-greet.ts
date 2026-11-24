/**
 * Boss「立即沟通」接口响应的纯判定逻辑。
 *
 * 2026-11-04 从线上 Boss 详情页脚本还原出点击后的真实链路：
 *   1. 页面委托处理器先 GET `/wapi/zpchat/config/get`，命中 unreadBubble 时走 `Detail.openChatDialog`，
 *      否则走 `Detail.startChat`；
 *   2. 两者最终都 POST `/wapi/zpgeek/friend/add.json`；
 *   3. code 0 + greeting → 弹「已向BOSS发送消息/startchat-dialog」；code 0 无 greeting → 跳会话页；
 *      code 7/1011 登录；code 1 + bizCode 1 次数/风控提示；bizCode 2 职位不可投；
 *      code 24 需切牛人身份；code 25 需补资料。
 *
 * 浏览器窗口没有焦点、或 SSR 按钮先于脚本挂载时，点击会是纯 no-op：
 * 既没有请求也没有 UI 变化。以前只能等 12 秒再记「没有回执」，用户看到的就是「根本没发出去」。
 * 这里把接口回包翻译成明确结论，供 Electron 侧决定继续等、补点击还是直接报平台原因。
 */

export type BossGreetProbeCall = {
  /** 接口路径（不含 query）。 */
  api: string;
  method: string;
  startedAt: number;
  /** 0 表示请求还没结束。 */
  endedAt: number;
  /** HTTP 状态；0 表示网络失败或尚未结束。 */
  status: number;
  code: number | null;
  message: string;
  bizCode: number | null;
  greeting: string;
  remindTitle: string;
  remindContent: string;
};

export type BossGreetProbeSnapshot = {
  installed: boolean;
  calls: BossGreetProbeCall[];
  /** 打开了「沟通提醒 / 次数上限」类对话框。 */
  chatRemind: boolean;
  remindText: string;
  /** `startchat-dialog`（新版开聊弹窗）已经出现。 */
  startchatOpen: boolean;
  /** 弹窗里状态已经是「已发送」的招呼正文。 */
  sentText: string;
};

export type BossGreetVerdictKind =
  /** 还没拿到可判定结果：请求在途或页面脚本没反应。 */
  | "pending"
  /** 平台确认招呼已发出。 */
  | "sent"
  /** 平台接受了沟通请求，正在进入聊天（可能还需要填招呼语）。 */
  | "chat"
  /** 登录态失效。 */
  | "login"
  /** 次数上限 / 太频繁，应暂停整批。 */
  | "limit"
  /** 需要本人到 Boss App/页面处理（切身份、补资料）。 */
  | "user"
  /** 平台明确拒绝，换岗位继续即可。 */
  | "refused";

export type BossGreetVerdict = {
  kind: BossGreetVerdictKind;
  /** 可直接展示给用户的说明。 */
  message: string;
  /** 平台确认发出的招呼正文。 */
  greeting: string;
  /** 写进 blockedReason 的分类文案，供暂停策略识别。 */
  blockedReason: string;
};

const EMPTY_VERDICT: BossGreetVerdict = { kind: "pending", message: "", greeting: "", blockedReason: "" };
const GREET_API = /\/wapi\/zpgeek\/friend\/(add|continuechat)\.json/i;
const CONFIG_API = /\/wapi\/zpchat\/config\/get/i;

function normalize(value: string) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(value: string, max = 120) {
  const text = normalize(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function callDetail(call: BossGreetProbeCall) {
  return normalize(call.remindContent) || normalize(call.message);
}

function verdict(
  kind: BossGreetVerdictKind,
  message: string,
  extra: Partial<Pick<BossGreetVerdict, "greeting" | "blockedReason">> = {},
): BossGreetVerdict {
  return { kind, message, greeting: extra.greeting ?? "", blockedReason: extra.blockedReason ?? "" };
}

/**
 * 把一次点击后的接口回包 / 页面提示翻译成结论。
 *
 * `config/get` 只作为「页面处理器确实被点到了」的证据，不参与成功判定。
 */
export function interpretBossGreetProbe(snapshot: BossGreetProbeSnapshot | null | undefined): BossGreetVerdict {
  if (!snapshot) return EMPTY_VERDICT;
  const sentText = normalize(snapshot.sentText);
  const remindText = normalize(snapshot.remindText);
  const calls = Array.isArray(snapshot.calls) ? snapshot.calls : [];
  const greetCalls = calls.filter((call) => GREET_API.test(call.api));
  const call = greetCalls[greetCalls.length - 1];

  if (call) {
    if (!call.endedAt) return verdict("pending", "Boss 已收到招呼请求，正在等待平台返回");
    if (!call.status) {
      return verdict("refused", "Boss 接口没有返回，可能被网络或平台拦截", { blockedReason: "Boss 接口无响应" });
    }
    const code = typeof call.code === "number" ? call.code : null;
    if (code === 0) {
      const greeting = normalize(call.greeting) || sentText;
      if (greeting) return verdict("sent", "Boss 已确认发出招呼", { greeting });
      return verdict("chat", "Boss 已接受沟通请求，正在进入聊天窗口");
    }
    if (code === 7 || code === 1011) {
      return verdict("login", "需要登录 Boss 直聘", { blockedReason: "需要登录 Boss 直聘" });
    }
    if (code === 24) {
      return verdict("user", "Boss 要求先到 App 切换到牛人身份后再试", { blockedReason: "Boss 要求切换牛人身份" });
    }
    if (code === 25) {
      return verdict("user", "Boss 要求先补充在线简历，请在 Boss 页面按提示处理", { blockedReason: "Boss 要求补充资料" });
    }
    if (code === 1) {
      if (call.bizCode === 1) {
        const detail = clamp(callDetail(call)) || remindText || "Boss 提示当前沟通次数受限";
        return verdict("limit", `Boss 限制本次沟通：${detail}`, { blockedReason: "沟通次数已达上限" });
      }
      if (call.bizCode === 2) {
        return verdict("refused", "Boss 提示该职位当前无法投递", { blockedReason: "Boss 提示职位无法投递" });
      }
      const detail = clamp(callDetail(call)) || remindText || "Boss 拒绝了这个岗位的沟通请求";
      return verdict("refused", detail, { blockedReason: "Boss 拒绝沟通" });
    }
    const detail = clamp(call.message) || `Boss 返回错误码 ${code ?? "未知"}`;
    return verdict("refused", detail, { blockedReason: "Boss 拒绝沟通" });
  }

  if (sentText) return verdict("sent", "Boss 弹窗里已经显示招呼发送成功", { greeting: sentText });
  if (snapshot.chatRemind) {
    return verdict("limit", `Boss 提示沟通受限：${clamp(remindText) || "请按页面提示处理"}`, {
      blockedReason: "沟通次数已达上限",
    });
  }
  if (snapshot.startchatOpen) return verdict("chat", "Boss 已打开开聊弹窗，正在等待发送结果");
  // 页面处理器已经开始请求配置，说明点击生效了，只差接口回包。
  if (calls.some((entry) => CONFIG_API.test(entry.api))) {
    return verdict("pending", "Boss 已响应点击，正在打开沟通入口");
  }
  return EMPTY_VERDICT;
}

/** 点击后是否已经有「平台在处理」的迹象（用于判断要不要补一次点击）。 */
export function bossGreetHasActivity(snapshot: BossGreetProbeSnapshot | null | undefined) {
  if (!snapshot) return false;
  return snapshot.calls.length > 0 || snapshot.chatRemind || snapshot.startchatOpen || Boolean(normalize(snapshot.sentText));
}
