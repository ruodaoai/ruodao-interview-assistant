/**
 * Boss 沟通入口的纯判定逻辑。
 *
 * 2026-11-02 从真实岗位页采集：点「立即沟通」后 Boss 会直接用账号里预设的招呼语发出消息，
 * 再弹 `.greet-boss-pop`（标题「已向BOSS发送消息」+ 招呼正文 + 「留在此页 / 继续沟通」）。
 * 页面不会出现聊天输入框，所以「只等输入框」必然超时，把已经发出的招呼记成「没有找到入口」，
 * 用户看到的就是「处理中 / 实际上没打招呼」。
 *
 * 这套判定必须能被单元测试直接覆盖，不能埋在 Electron 窗口代码里。
 */
import { detectBossAutoGreet } from "./parse";

export type BossChatSignal = {
  /** 页面出现「已向BOSS发送消息」确认框；平台已经自动发出招呼。 */
  autoSent: boolean;
  /** 入口文案从「立即沟通」变成「继续沟通」，同样说明招呼已经发出。 */
  labelConfirmed: boolean;
  /** 点击前就已经是「继续沟通」：这个岗位之前沟通过。 */
  alreadyChatted: boolean;
  /** 聊天输入框已出现。 */
  chatOpen: boolean;
  /** 确认框里平台实际发出的招呼正文，取不到时为空。 */
  greeting: string;
};

export function normalizeBossChatLabel(value: string) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

/** 从「已向BOSS发送消息」确认框里取出平台实际发出的招呼正文。 */
export function extractBossAutoGreeting(body: string) {
  const value = String(body ?? "").replace(/\r/g, "");
  const marker = "已向BOSS发送消息";
  const start = value.indexOf(marker);
  if (start < 0) return "";
  let rest = value.slice(start + marker.length);
  const end = rest.search(/如需修改打招呼内容|留在此页|继续沟通/);
  if (end >= 0) rest = rest.slice(0, end);
  return rest.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function readBossChatSignal(input: {
  beforeLabel: string;
  currentLabel: string;
  body: string;
  hasInput: boolean;
}): BossChatSignal {
  const before = normalizeBossChatLabel(input.beforeLabel);
  const current = normalizeBossChatLabel(input.currentLabel);
  const body = String(input.body ?? "");
  const autoSent = detectBossAutoGreet(body);
  const alreadyChatted = /继续沟通/.test(before);
  // 点击前是「立即沟通」、点击后变成「继续沟通」：平台已经用预设招呼语发出。
  const labelConfirmed = !alreadyChatted && /立即沟通/.test(before) && /继续沟通/.test(current);
  return {
    autoSent,
    labelConfirmed,
    alreadyChatted,
    chatOpen: input.hasInput === true,
    greeting: autoSent || labelConfirmed ? extractBossAutoGreeting(body) : "",
  };
}
