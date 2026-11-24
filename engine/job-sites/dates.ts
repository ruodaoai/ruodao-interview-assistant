/**
 * 平台「发布时间 / 更新时间」解析。
 *
 * 这一层只做纯字符串换算，不发请求、不猜岗位状态：招聘平台的发布时间本身也可能是
 * 「刷新续命」的结果，所以置信度由调用方（trust.ts）和本地首见时间交叉判断。
 */

const DAY = 86_400_000;

export type PostedInfo = { at: number | null; label: string };

const EMPTY: PostedInfo = { at: null, label: "" };

function startOfDay(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function clamp(value: number, now: number) {
  // 未来时间一律视为今天（平台时区/时钟偏差会出现「明天」）。
  return value > now ? startOfDay(now) : value;
}

/**
 * 从「发布于 2026-09-12」「3 天前更新」「今天 10:23 刷新」「昨天」这类文案里取时间戳。
 * 取不到就返回 at=null，绝不猜一个近似值。
 */
export function parsePostedAt(raw: unknown, now = Date.now()): PostedInfo {
  const value = String(raw ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!value) return EMPTY;
  // 只保留「发布 / 更新 / 刷新」之后的那段，避免把「3-5 年经验」「2026 届」当成日期。
  const scoped = value.match(/(?:发布|更新|刷新)(?:时间|日期|于)?\s*[：:]?\s*([^|，,；;]{1,24})/)?.[1]?.trim() ?? "";
  // 注意不要把「3-5 年经验」开头的数字当成「3 月 5 日」：只有带年份、或明确的
  // 今天 / 昨天 / 前天 / 刚刚才允许直接取整段。
  const head = /^(?:\d{4}\s*[-/年.]\s*\d{1,2}|今天|今日|昨天|昨日|前天|刚刚)/.test(value)
    ? value
    : "";
  // 「3 天前发布」是平台最常见的写法：时间在前、动作在后，也要能认。
  const tail = value.match(/\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)(?:发布|更新|刷新)?/)?.[0] ?? "";
  const source = scoped || head || tail;
  if (!source) return EMPTY;

  if (/刚刚|秒前/.test(source)) return { at: now, label: value };
  if (/今天|今日/.test(source)) {
    const hm = source.match(/(\d{1,2})\s*[:点时]\s*(\d{1,2})/);
    if (hm) {
      const date = new Date(now);
      date.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      return { at: clamp(date.getTime(), now), label: value };
    }
    return { at: startOfDay(now), label: value };
  }
  if (/昨天|昨日/.test(source)) return { at: startOfDay(now) - DAY, label: value };
  if (/前天/.test(source)) return { at: startOfDay(now) - 2 * DAY, label: value };

  const relative = source.match(/(\d{1,4})\s*(分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const factor = unit === "分钟" ? 60_000
      : unit === "小时" ? 3_600_000
        : unit === "天" ? DAY
          : unit === "周" ? 7 * DAY
            : unit === "年" ? 365 * DAY
              : 30 * DAY;
    return { at: clamp(now - amount * factor, now), label: value };
  }

  const absolute = source.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (absolute) {
    const date = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]));
    if (!Number.isNaN(date.getTime())) return { at: clamp(date.getTime(), now), label: value };
  }

  const monthDay = source.match(/^(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(now);
      date.setMonth(month - 1, day);
      date.setHours(0, 0, 0, 0);
      if (Number.isNaN(date.getTime())) return EMPTY;
      // 没有年份时，跨年（12 月发布、现在 1 月）要回退一年。
      if (date.getTime() > now + DAY) date.setFullYear(date.getFullYear() - 1);
      return { at: clamp(date.getTime(), now), label: value };
    }
  }

  return EMPTY;
}

/** 挂出天数：取整到天，未来时间归零。 */
export function postedDays(at: number | null | undefined, now = Date.now()) {
  if (!at || !Number.isFinite(Number(at))) return null;
  return Math.max(0, Math.floor((now - Number(at)) / DAY));
}

/**
 * 列表卡片文本里找「发布时间 / 更新时间」片段。
 * 平台卡片结构经常变，用文案特征比用 class 更稳；找不到就返回空字符串。
 */
export function extractPostedText(...values: unknown[]) {
  for (const value of values) {
    const body = String(value ?? "").replace(/\s+/g, " ");
    if (!body) continue;
    // 「更新于 2026-09-12 / 今天 / 3 天前」：动作在前。
    const after = body.match(/(?:发布|更新|刷新)(?:时间|日期|于)?\s*[：:]?\s*(?:\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日|今天|今日|昨天|昨日|前天|刚刚|\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前))/);
    if (after) return after[0].slice(0, 40);
    // 「3 天前发布」：动作在后，这是 51job / 智联卡片最常见的写法。
    const before = body.match(/\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)(?:发布|更新|刷新)/);
    if (before) return before[0].slice(0, 40);
  }
  return "";
}
