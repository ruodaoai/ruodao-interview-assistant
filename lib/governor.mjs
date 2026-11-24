/**
 * 批量投递 / 单条投递的节奏与额度判定。
 * 与宿主 electron/auto-apply/governor.ts 保持同一套规则；
 * 插件自己执行投递时也必须走这些安全限制，否则改动插件就绕开了防封策略。
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** 每个招聘网站独立计数，官网 / 手动岗位共用「网申」额度。 */
export function dailyQuotaKey(source) {
  return source === "boss" || source === "liepin" || source === "zhaopin" || source === "job51" ? source : "web";
}

export function parseWindow(window) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(window ?? "").trim());
  if (!match) return null;
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(match[3]) * 60 + Number(match[4]);
  if (startMinute < 0 || startMinute >= 24 * 60 || endMinute < 0 || endMinute >= 24 * 60) return null;
  if (startMinute === endMinute) return null;
  return { startMinute, endMinute };
}

export function isWindowOpen(window, now = Date.now()) {
  const parsed = parseWindow(window);
  if (!parsed) return true;
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  if (parsed.startMinute < parsed.endMinute) return minute >= parsed.startMinute && minute < parsed.endMinute;
  return minute >= parsed.startMinute || minute < parsed.endMinute;
}

export function msUntilWindowOpen(window, now = Date.now()) {
  const parsed = parseWindow(window);
  if (!parsed || isWindowOpen(window, now)) return 0;
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const next = new Date(now);
  next.setSeconds(0, 0);
  if (parsed.startMinute < parsed.endMinute) {
    if (minute < parsed.startMinute) next.setHours(Math.floor(parsed.startMinute / 60), parsed.startMinute % 60, 0, 0);
    else {
      next.setDate(next.getDate() + 1);
      next.setHours(Math.floor(parsed.startMinute / 60), parsed.startMinute % 60, 0, 0);
    }
  } else if (minute >= parsed.endMinute && minute < parsed.startMinute) {
    next.setHours(Math.floor(parsed.startMinute / 60), parsed.startMinute % 60, 0, 0);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(Math.floor(parsed.startMinute / 60), parsed.startMinute % 60, 0, 0);
  }
  return Math.max(0, next.getTime() - now);
}

/** 两条招呼之间的随机间隔，避免固定节奏被平台识别为脚本。 */
export function nextIntervalMs(config, random = Math.random) {
  const min = Math.max(10, Math.round(config.intervalMinSeconds || 45));
  const max = Math.max(min, Math.round(config.intervalMaxSeconds || 150));
  const span = max - min;
  return Math.round((min + span * random()) * 1000);
}

export function evaluateGovernor(input) {
  const now = input.now ?? Date.now();
  const { config } = input;
  const siteHint = input.siteLabel ? `${input.siteLabel} ` : "";
  if (input.cooldownUntil > now) {
    return { allowed: false, code: "platform-cooldown", reason: `${siteHint}平台验证冷却中，还需等待 ${Math.ceil((input.cooldownUntil - now) / MINUTE)} 分钟`, waitMs: input.cooldownUntil - now };
  }
  if (input.companyOutcome === "blocked") {
    return { allowed: false, code: "company-rejected", reason: "这家公司已被你屏蔽", waitMs: 0 };
  }
  if (input.companyOutcome === "rejected") {
    return { allowed: false, code: "company-rejected", reason: "这家公司已回复不合适，已自动跳过", waitMs: 0 };
  }
  const cooldownDays = Math.max(0, Math.round(config.companyCooldownDays || 0));
  if (cooldownDays > 0 && input.companyLastAt > 0 && now - input.companyLastAt < cooldownDays * DAY) {
    const days = Math.max(1, Math.ceil((cooldownDays * DAY - (now - input.companyLastAt)) / DAY));
    return { allowed: false, code: "company-cooling", reason: `这家公司在冷却期内（还需 ${days} 天）`, waitMs: 0 };
  }
  if (input.consecutiveFailures >= 3) {
    // 熔断计数按平台独立传入：这里说清是哪个平台，用户才知道去检查哪个窗口。
    return { allowed: false, code: "risk-pause", reason: `${siteHint}连续 3 次投递未确认成功，已暂停，请先人工检查${input.siteLabel || "平台"}页面状态`, waitMs: 0 };
  }
  if (!isWindowOpen(config.window, now)) {
    return { allowed: false, code: "window", reason: `当前不在投递时段（${config.window}）`, waitMs: msUntilWindowOpen(config.window, now) };
  }
  const dailyLimit = Math.max(1, Math.round(config.dailyLimit || 1));
  if (input.todayCount >= dailyLimit) {
    return { allowed: false, code: "daily-limit", reason: `${siteHint}今天的投递已达上限（${dailyLimit} 个）`, waitMs: 0 };
  }
  const companyLimit = Math.max(1, Math.round(config.dailyCompanyLimit || 1));
  const uniqueCompanies = new Set(input.todayCompanies.filter(Boolean));
  if (!uniqueCompanies.has(input.company) && uniqueCompanies.size >= companyLimit) {
    return { allowed: false, code: "daily-company-limit", reason: `${siteHint}今天已投递 ${uniqueCompanies.size} 家公司，达到每日公司数上限`, waitMs: 0 };
  }
  if (input.lastActionAt > 0) {
    const gap = input.gapMs && input.gapMs > 0 ? input.gapMs : nextIntervalMs(config, input.random ?? Math.random);
    const waited = now - input.lastActionAt;
    if (waited < gap) {
      return { allowed: false, code: "interval", reason: "正在按随机间隔等待，避免触发平台风控", waitMs: gap - waited };
    }
  }
  return { allowed: true, code: "ok", reason: "", waitMs: 0 };
}

/** 给用户看的预计耗时，用于批量投递确认弹窗。 */
export function estimateBatchMinutes(count, config) {
  const avg = (Math.max(10, config.intervalMinSeconds || 45) + Math.max(10, config.intervalMaxSeconds || 150)) / 2;
  return Math.max(1, Math.round((Math.max(0, count) * avg) / 60));
}
