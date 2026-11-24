/**
 * 简历时间线事实。
 *
 * 大模型没有「今天」的概念，它的日期直觉停在训练截止那天。所以简历里 2026.09
 * 这种已经过去的结束时间，模型会判成「未来日期 / 尚未到期」，诊断报告就会凭空
 * 冒出一条假问题。这里按本机真实日期把每段经历的起止、距今间隔算好，作为既定
 * 事实写进 prompt，模型只做判断、不再自己推算日期。
 */

const ONGOING = /^(?:至今|今|现在|目前|在职中?|now|present|current)$/i;

export function localToday(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function monthIndex(value) {
  return value.year * 12 + (value.month - 1);
}

export function isOngoingText(value) {
  return ONGOING.test(String(value ?? "").replace(/[\s.。]/g, ""));
}

/** 「2022.10」/「2022-10」/「2022/10」/「2022年10月」/「2022」→ 年月；其他一律 null。 */
export function parseYearMonth(value) {
  const raw = String(value ?? "").trim();
  if (!raw || isOngoingText(raw)) return null;
  const match = /(\d{4})\s*(?:[.\-/年]\s*(\d{1,2}))?/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1950 || year > 2100) return null;
  const month = match[2] ? Math.min(Math.max(Number(match[2]), 1), 12) : 1;
  return { year, month };
}

export function formatYearMonth(value) {
  return `${value.year}.${String(value.month).padStart(2, "0")}`;
}

function formatDay(value) {
  return `${value.year}${String(value.month).padStart(2, "0")}`;
}

function monthsBetween(from, to) {
  return monthIndex(to) - monthIndex(from);
}

function describeDistance(months) {
  if (months <= 0) return "就在本月结束";
  if (months < 12) return `已结束 ${months} 个月`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `已结束 ${years} 年${rest ? ` ${rest} 个月` : ""}`;
}

function str(value, max = 80) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const LIST_LABELS = {
  experience: "工作经历",
  projects: "项目经历",
  education: "教育经历",
};

function entryTitle(kind, item) {
  if (kind === "experience") return str(item?.company) || str(item?.role) || "未命名经历";
  if (kind === "projects") return str(item?.name) || "未命名项目";
  return [str(item?.school), str(item?.degree)].filter(Boolean).join(" · ") || "未命名学历";
}

/** 按简历里的顺序收集所有带日期的条目（工作/项目/教育）。 */
export function collectTimeline(resume) {
  if (!resume || typeof resume !== "object") return [];
  const entries = [];
  for (const kind of Object.keys(LIST_LABELS)) {
    const list = resume?.[kind];
    if (!Array.isArray(list)) continue;
    list.forEach((item, at) => {
      const startText = str(item?.start, 40);
      const endText = str(item?.end, 40);
      if (!startText && !endText) return;
      entries.push({
        kind,
        index: at + 1,
        label: entryTitle(kind, item),
        start: parseYearMonth(startText),
        end: parseYearMonth(endText),
        ongoing: isOngoingText(endText),
        startText,
        endText,
      });
    });
  }
  return entries;
}

/** 结束时间晚于今天的条目：这才是真正的「未来日期」。 */
export function futureEndDates(resume, now = localToday()) {
  return collectTimeline(resume).filter((entry) => entry.end && monthIndex(entry.end) > monthIndex(now));
}

/** 开始晚于结束的条目（明显笔误）。 */
export function reversedRanges(resume) {
  return collectTimeline(resume).filter((entry) => entry.start && entry.end && monthIndex(entry.start) > monthIndex(entry.end));
}

function describeEntry(entry, now) {
  const head = `${LIST_LABELS[entry.kind]} ${entry.index} · ${entry.label}`;
  if (!entry.start && !entry.end) return `${head}：未填日期`;
  const range = `${entry.startText || "?"} → ${entry.ongoing ? "至今" : entry.endText || "?"}`;
  if (entry.ongoing) return `${head}：${range}（在职中，尚未结束）`;
  if (!entry.end) return `${head}：${range}（结束时间无法识别）`;
  return `${head}：${range}（${describeDistance(monthsBetween(entry.end, now))}）`;
}

/**
 * 给模型看的时间线事实。简历里完全没有可识别日期时返回空串，避免给
 * 「没填日期」的简历灌一段无用上下文。
 */
function toYearMonth(value = new Date()) {
  if (value instanceof Date) return localToday(value);
  if (typeof value === "string") return localToday(new Date(value));
  return value;
}

export function buildTimelineFacts(resume, now = new Date()) {
  const today = toYearMonth(now);
  const entries = collectTimeline(resume);
  if (!entries.length) return "";
  const lines = entries.map((entry) => `- ${describeEntry(entry, today)}`);
  const future = entries.filter((entry) => entry.end && monthIndex(entry.end) > monthIndex(today));
  const reversed = entries.filter((entry) => entry.start && entry.end && monthIndex(entry.start) > monthIndex(entry.end));
  const unknown = entries.filter((entry) => !entry.ongoing && !entry.end);
  const verdicts = [];
  verdicts.push(future.length
    ? `- 未来日期：${future.map((entry) => `${LIST_LABELS[entry.kind]} ${entry.index} 结束 ${entry.endText}`).join("；")}`
    : "- 未来日期：无（所有已填结束时间都不晚于今天）");
  if (reversed.length) {
    verdicts.push(`- 起止颠倒：${reversed.map((entry) => `${LIST_LABELS[entry.kind]} ${entry.index}（${entry.startText} → ${entry.endText}）`).join("；")}`);
  }
  if (unknown.length) {
    verdicts.push(`- 无法识别的结束时间：${unknown.map((entry) => `${LIST_LABELS[entry.kind]} ${entry.index}「${entry.endText || "空"}」`).join("；")}`);
  }
  return [
    `【时间线事实】（系统按今天 ${formatYearMonth(today)}（${formatDay(today)}）计算，属于既定事实，请直接采用，不要质疑或改写）`,
    `今天：${today.year} 年 ${today.month} 月`,
    ...lines,
    "系统核验结果：",
    ...verdicts,
    "日期判定规则：结束时间早于或等于今天 = 已经结束的过去经历；只有晚于今天才叫「未来日期 / 尚未到期 / 尚未结束」；「至今」表示仍在职。不要凭空发明简历里没有的日期。",
  ].join("\n");
}

const FUTURE_CLAIM = /未来日期|尚未到期|未到期|尚未结束|还未结束|未来时间|未来的日期|写成未来|写到未来/;
const REAL_DATE_CLAIM = /起止颠倒|开始时间晚于结束|结束早于开始/;

/**
 * 模型的时间错觉兜底：简历里根本没有任何未来日期时，说「结束时间是未来日期」
 * 的条目就是纯误报，直接丢掉，免得用户照着假问题去改本来正确的简历。
 * 只有命中句子提到真实存在的起止颠倒时才保留。
 */
export function isFalseFutureClaim(text, resume, now = localToday()) {
  if (!text || !FUTURE_CLAIM.test(text)) return false;
  if (futureEndDates(resume, now).length) return false;
  if (REAL_DATE_CLAIM.test(text) && reversedRanges(resume).length) return false;
  return true;
}
