import type { AutoApplyJob } from "../auto-apply/types";
import { job51JobIdOf } from "./job51-api";

/**
 * 前程无忧「社会申请」记录：批量投递没拿到页面回执时的最终核对来源。
 *
 * 51job 的投递成功页有时不弹 toast，按钮也不一定马上变成「已投递」，但个人中心的
 * 申请记录会稳定出现这条岗位（用户 11-04 截图：`i.51job.com/userset/my_apply.php?type=social`）。
 * 这里只读取已登录窗口里的公开页面，不做接口逆向，也不绕过登录。
 *
 * 安全边界：记录页只用来「确认已投递」。记录里找不到时不能反推「没投出去」——
 * 列表可能分页、刚投递还没同步；这种情况继续留在待确认，由本人核对。
 */

export const JOB51_APPLY_RECORDS_URL = "https://i.51job.com/userset/my_apply.php?type=social";

export type Job51RecordsProbeItem = {
  url: string;
  anchorText: string;
  lines: string[];
  text: string;
};

export type Job51RecordsProbe = {
  items: Job51RecordsProbeItem[];
  pageText: string;
  listFound: boolean;
  debug?: { anchors: number; records: number; url: string; title: string; docs: number };
};

export type Job51AppliedRecord = {
  jobId: string;
  url: string;
  title: string;
  company: string;
  appliedAt: number;
  text: string;
};

export type Job51ApplyRecordsReadResult = {
  ok: boolean;
  state: "ok" | "closed" | "blocked" | "failed";
  message: string;
  url: string;
  records: Job51AppliedRecord[];
  capturedAt: number;
  blocked: "login" | "verification" | "";
};

const DATE_PATTERN = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/;
const COMPANY_HINT = /公司|集团|银行|学院|大学|研究院|研究所|中心|工作室|事务所|医院|酒店|工厂|有限|股份|科技|信息|网络|软件|传媒|教育|咨询/;
const NOISE_LINE = /^(查看|删除|再次投递|再投递|收藏|取消收藏|立即投递|投递简历|申请职位|已投递|已申请|投递成功|申请成功|展开|收起)$/;

function text(value: unknown, max = 400) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactKey(value: unknown) {
  return text(value, 400).replace(/[\s·|,，。:：;；()（）【】\[\]-]+/g, "").toLowerCase();
}

function parseAppliedAt(value: unknown): number {
  const match = text(value, 900).match(DATE_PATTERN);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return 0;
  return new Date(year, month - 1, day).getTime();
}

function looksLikeTitleLine(line: string) {
  const value = text(line, 200);
  if (!value || NOISE_LINE.test(value)) return false;
  if (DATE_PATTERN.test(value)) return false;
  if (/^(社会申请|校园申请|申请记录|我的申请|投递记录|职位名称|公司名称|申请时间|状态)$/.test(value)) return false;
  if (/^[\d\s./-]+$/.test(value)) return false;
  return true;
}

/** 从一行行文本里猜岗位名和公司名；只在没有职位号、需要标题+公司兜底匹配时使用。 */
function guessIdentity(item: Job51RecordsProbeItem) {
  const lines = item.lines.map((line) => text(line, 200)).filter(Boolean);
  const anchor = text(item.anchorText, 200);
  const title = (anchor && looksLikeTitleLine(anchor) ? anchor : "") || lines.find(looksLikeTitleLine) || "";
  const company = lines.find((line) => (
    line !== title
    && line !== anchor
    && !NOISE_LINE.test(line)
    && !DATE_PATTERN.test(line)
    && COMPANY_HINT.test(line)
  )) || lines.find((line) => (
    line !== title
    && line !== anchor
    && looksLikeTitleLine(line)
  )) || "";
  return { title, company };
}

export function parseJob51AppliedRecords(rawItems: Job51RecordsProbeItem[], _now = Date.now()): Job51AppliedRecord[] {
  const records: Job51AppliedRecord[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    if (!item || typeof item !== "object") continue;
    const url = text(item.url, 320);
    const body = text(item.text || (Array.isArray(item.lines) ? item.lines.join(" | ") : ""), 900);
    if (!body) continue;
    const jobId = job51JobIdOf(url);
    const identity = guessIdentity(item);
    const appliedAt = parseAppliedAt(body);
    const key = jobId ? `id:${jobId}` : `text:${compactKey(`${identity.company}|${identity.title}|${body}`)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    records.push({
      jobId,
      url,
      title: text(identity.title, 160),
      company: text(identity.company, 160),
      appliedAt,
      text: body,
    });
    if (records.length >= 120) break;
  }
  return records;
}

export type Job51RecordMatch = {
  matched: boolean;
  index: number;
  reason: string;
};

/**
 * 把岗位和申请记录对上：优先职位号，其次「岗位名 + 公司名」同时命中。
 * 只有岗位名相同、公司对不上（或岗位匿名）时不确认，避免同名岗位误判。
 */
export function matchJob51AppliedRecord(
  job: Pick<AutoApplyJob, "title" | "company" | "sourceUrl" | "jobId">,
  records: Job51AppliedRecord[],
): Job51RecordMatch {
  const list = Array.isArray(records) ? records : [];
  const jobId = job51JobIdOf(job.jobId) || job51JobIdOf(job.sourceUrl);
  if (jobId) {
    const index = list.findIndex((record) => record.jobId === jobId);
    if (index >= 0) {
      return {
        matched: true,
        index,
        reason: `前程无忧申请记录里有同一岗位（职位号 ${jobId}${list[index].appliedAt ? `，投递于 ${formatClock(list[index].appliedAt)}` : ""}）`,
      };
    }
  }
  const title = compactKey(job.title);
  const company = compactKey(job.company);
  if (!title) return { matched: false, index: -1, reason: "岗位标题为空，无法匹配申请记录" };
  let titleOnly = -1;
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    const recordTitle = compactKey(record.title);
    const titleHit = recordTitle
      ? recordTitle.includes(title) || title.includes(recordTitle)
      : compactKey(record.text).includes(title);
    if (!titleHit) continue;
    if (!company) {
      if (titleOnly < 0) titleOnly = index;
      continue;
    }
    const recordCompany = compactKey(record.company);
    const companyHit = recordCompany
      ? recordCompany.includes(company) || company.includes(recordCompany)
      : compactKey(record.text).includes(company);
    if (!companyHit) continue;
    return {
      matched: true,
      index,
      reason: `前程无忧申请记录里有「${text(job.title, 60)}」（${text(job.company, 60)}${record.appliedAt ? `，投递于 ${formatClock(record.appliedAt)}` : ""}）`,
    };
  }
  return {
    matched: false,
    index: -1,
    reason: titleOnly >= 0 ? "申请记录里只有同名岗位，公司名对不上" : "申请记录里没有找到这家公司的这个岗位",
  };
}

function formatClock(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 在申请记录页里抓列表项。
 *
 * 个人中心不是标准 SPA，也没保证 DOM class：优先顺着岗位详情链接向上找「一条记录」，
 * 找不到链接时再按「表格行 / 列表项 + 日期」兜底。只读 innerText，不点任何按钮。
 */
export function job51RecordsScript(): string {
  return `(() => {
    const clean = (value) => String(value ?? "").replace(/\\r/g, "").trim();
    const normalize = (value) => clean(value).replace(/\\s+/g, " ").trim();
    const docs = [];
    const collectDocs = (doc, depth) => {
      if (!doc || depth > 2) return;
      docs.push(doc);
      for (const frame of doc.querySelectorAll("iframe")) {
        try {
          const inner = frame.contentDocument;
          if (inner) collectDocs(inner, depth + 1);
        } catch { /* 跨域 iframe 读不到，跳过 */ }
      }
    };
    collectDocs(document, 0);
    const jobUrlRe = /jobs\\.51job\\.com\\/[a-z0-9-]+\\/\\d{5,}\\.html|[?&]jobId=\\d{5,}/i;
    const dateRe = /(20\\d{2})[-/.年](\\d{1,2})[-/.月](\\d{1,2})/;
    const items = [];
    const seen = new Set();
    const linesOf = (element) => {
      const raw = String(element?.innerText || element?.textContent || "");
      const direct = raw.split(/\\n+/).map(normalize).filter(Boolean);
      if (direct.length >= 2) return direct;
      // 行内 span / a 不会在 innerText 里产生换行：按直接子元素拆开，
      // 否则「岗位名 + 公司 + 日期」会粘成一行，既认不出公司也容易把整块列表当成一条。
      const parts = [];
      for (const child of element?.children || []) {
        const value = normalize(child.innerText || child.textContent || "");
        if (value) parts.push(value);
      }
      return parts.length >= 2 ? parts : direct;
    };
    const push = (lines, url, anchorText) => {
      const list = lines.map(normalize).filter(Boolean).slice(0, 20);
      if (list.length < 2) return;
      const body = list.join(" | ").slice(0, 900);
      if (body.length < 8) return;
      const key = body.replace(/\\s+/g, "");
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        url: String(url || "").slice(0, 320),
        anchorText: normalize(anchorText).slice(0, 160),
        lines: list,
        text: body,
      });
    };
    const anchors = [];
    for (const doc of docs) {
      for (const anchor of doc.querySelectorAll("a[href]")) {
        const href = String(anchor.href || anchor.getAttribute("href") || "");
        if (jobUrlRe.test(href)) anchors.push(anchor);
      }
    }
    for (const anchor of anchors) {
      const href = String(anchor.href || anchor.getAttribute("href") || "");
      let node = anchor.parentElement;
      let best = null;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const lines = linesOf(node);
        const joined = lines.join(" ");
        if (joined.length >= 6 && joined.length <= 900 && lines.length >= 2) {
          best = { lines, url: href };
          if (joined.length <= 320) break;
        }
        node = node.parentElement;
      }
      if (best) push(best.lines, best.url, anchor.innerText || anchor.textContent || "");
    }
    if (!items.length) {
      const selectors = ['table tbody tr', '.e', 'ul li', 'ol li', '[class*="list"] li', '[class*="item"]', '[class*="record"]'];
      for (const doc of docs) {
        for (const element of doc.querySelectorAll(selectors.join(","))) {
          const lines = linesOf(element);
          if (lines.length < 2 || lines.length > 20) continue;
          const joined = lines.join(" ");
          if (joined.length < 8 || joined.length > 900) continue;
          if (!dateRe.test(joined) && !/申请|投递|应聘/.test(joined)) continue;
          const link = element.querySelector("a[href]");
          const href = link ? String(link.href || link.getAttribute("href") || "") : "";
          push(lines, href, link ? (link.innerText || link.textContent || "") : "");
        }
      }
    }
    const bodyText = docs.map((doc) => String(doc.body?.innerText || "")).join("\\n");
    return {
      items: items.slice(0, 120),
      pageText: normalize(bodyText).slice(0, 1600),
      listFound: items.length > 0,
      debug: { anchors: anchors.length, records: items.length, url: location.href, title: document.title, docs: docs.length },
    };
  })()`;
}
