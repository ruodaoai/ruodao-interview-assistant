import type { AutoApplyJob, AutoApplyJobSource, AutoApplyProfile, AutoApplyRules } from "../auto-apply/types";
import { isOutsourceJob } from "../auto-apply/outsource";
import { extractPostedText, parsePostedAt, postedDays as postedDaysOf } from "./dates";
import { normalizeCityName } from "./sites";
import type { RawSiteJob } from "./types";

const BENEFIT_PATTERN = /五险一金|六险一金|年终奖|节日福利|带薪年假|带薪休假|弹性工作|周末双休|补充医疗|定期体检|员工旅游|餐补|交通补助|通讯补贴|零食|下午茶|绩效奖金|股票期权|免费班车|包吃|包住|住房补贴|生日福利|团建|晋升空间|岗位晋升|技能培训|扁平管理|领导好|氛围好|不加班|双休/i;
const HEADHUNTER_PATTERN = /猎头|人力资源服务|人才服务|招聘服务/i;

function text(value: unknown, max = 400) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseSalaryText(raw: unknown): { min: number | null; max: number | null; unit: string; label: string } {
  const original = text(raw, 60);
  // Boss 搜索列表会用自定义字体混淆薪资，DOM 里可能只剩私有区字符或「00-00K」占位。
  const label = original.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
  const garbled = original !== label || /(?:^|\D)0{2,}\s*[-~—至到]\s*0{2,}|0\s*[-~—至到]\s*0\s*[kK]/.test(label);
  const empty = { min: null, max: null, unit: "", label: garbled ? "" : label };
  if (!label || /面议|保密|不限/.test(label)) return empty;
  // 只取薪资区间本身，避免把「·16薪」的 16 当成上限。
  const range = label.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)/);
  const single = label.match(/\d+(?:\.\d+)?/)?.[0];
  const numbers = range ? [Number(range[1]), Number(range[2])] : single ? [Number(single)] : [];
  if (!numbers.length) return empty;
  if (numbers.every((value) => value === 0)) return { min: null, max: null, unit: "", label: "" };
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  let unit = "";
  if (/元\s*\/\s*(天|日)/.test(label)) unit = "元/天";
  else if (/(万|w)\s*\/?\s*年|年薪/.test(label)) unit = "万/年";
  else if (/[kK]|千/.test(label)) unit = "K/月";
  else if (/万|w/i.test(label)) unit = "万/月";
  else if (max >= 1000) unit = "元/月";
  else unit = "K/月";
  return { min, max, unit, label };
}

export function parseActiveDays(raw: unknown): number | null {
  const value = text(raw, 40);
  if (!value) return null;
  const hour = value.match(/(\d+)\s*小时/);
  if (hour) return Number(hour[1]) / 24;
  if (/在线|刚刚|今日活跃|刚刚活跃/.test(value)) return 0;
  const day = value.match(/(\d+)\s*天/);
  if (day) return Number(day[1]);
  const week = value.match(/(\d+)\s*周/);
  if (week) return Number(week[1]) * 7;
  const month = value.match(/(\d+)\s*个?月/);
  if (month) return Number(month[1]) * 30;
  const year = value.match(/(\d+)\s*年/);
  if (year) return Number(year[1]) * 365;
  if (/本周活跃/.test(value)) return 3;
  if (/本月活跃/.test(value)) return 15;
  if (/半年前/.test(value)) return 180;
  if (/年前/.test(value)) return 365;
  return null;
}

export function isInactiveHr(raw: unknown) {
  const days = parseActiveDays(raw);
  return days !== null && days > 30;
}

export function isHeadhunterJob(raw: { company?: string; recruiter?: string; tags?: string[] }) {
  return [raw.company, raw.recruiter, ...(raw.tags ?? [])].filter(Boolean).some((entry) => HEADHUNTER_PATTERN.test(String(entry)));
}

function looksLikeSkill(tag: string) {
  if (!tag || BENEFIT_PATTERN.test(tag)) return false;
  const latin = /[a-zA-Z][a-zA-Z0-9+#.-]*/.test(tag);
  if (latin) return tag.length <= 30;
  return /数据分析|产品设计|交互设计|视觉设计|算法|前端|后端|全栈|架构|测试|运维|运营|增长|项目管理|英语|日语|销售|财务|法务|招聘|品牌|市场|文案|剪辑|摄影|采购|供应链|风控|信贷|量化|投资|会计|审计/.test(tag);
}

export function skillTags(tags: string[]) {
  return tags.filter(looksLikeSkill).slice(0, 12);
}

export function inferRemoteType(value: unknown) {
  const source = text(value, 200);
  if (/远程|居家办公|在家办公/.test(source)) return "remote";
  if (/混合|弹性办公|hybrid/i.test(source)) return "hybrid";
  if (/现场|坐班|onsite/i.test(source)) return "onsite";
  return "";
}

function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return Math.abs(result).toString(36);
}

function safeUrl(raw: unknown, base: string) {
  const value = text(raw, 1000);
  if (!value) return "";
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function mapRawSiteJob(site: Exclude<AutoApplyJobSource, "template" | "manual">, raw: RawSiteJob): AutoApplyJob | null {
  const title = text(raw.title, 160);
  const company = text(raw.company, 120);
  // 51job 的岗位详情页在 jobs.51job.com（we.51job.com 只是前端门户），相对地址按详情页补全。
  const sourceUrl = safeUrl(raw.url, site === "job51" ? "https://jobs.51job.com/" : `https://www.${site === "boss" ? "zhipin" : site === "liepin" ? "liepin" : "zhaopin"}.com/`);
  if (!title || !sourceUrl) return null;
  const salary = parseSalaryText(raw.salary);
  const tags = [...new Set((raw.tags ?? []).map((entry) => text(entry, 40)).filter(Boolean))].slice(0, 16);
  const city = text(raw.city, 60).replace(/^【|】$/g, "");
  const recruiterActive = text(raw.recruiterActive, 40);
  const jobStatus = raw.jobStatus === "open" || raw.jobStatus === "closed" ? raw.jobStatus : "";
  // 平台自己写的「发布时间 / 更新时间」只有在页面真的展示时才有；拿不到就留空，
  // 交给本地首见时间（job-history）判断，绝不编一个日期出来。
  const postedText = text(raw.postedText, 40) || extractPostedText(raw.extra, title, tags.join(" "));
  const posted = parsePostedAt(postedText);
  return {
    id: `site-${site}-${hash(`${sourceUrl}|${title}`)}`,
    source: site,
    companyId: "",
    company: company || "企业名称未公开",
    companyIndustry: text(raw.companyIndustry, 80),
    careersUrl: "",
    title,
    roleFamily: "",
    seniority: "",
    city,
    remoteType: inferRemoteType(`${title} ${city} ${tags.join(" ")} ${raw.extra ?? ""}`),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryUnit: salary.unit,
    salaryLabel: salary.label,
    description: "",
    requirements: "",
    responsibilities: "",
    skills: skillTags(tags),
    tags,
    recruiter: text(raw.recruiter, 60),
    recruiterActive,
    sourceUrl,
    matchScore: null,
    reasons: [],
    gaps: [],
    verdict: "",
    jobId: text(raw.jobId, 80),
    companyStage: text(raw.companyStage, 40),
    companyScale: text(raw.companyScale, 40),
    recruiterTitle: text(raw.recruiterTitle, 60),
    jobStatus,
    jobStatusText: text(raw.jobStatusText, 60),
    companyAnonymous: raw.anonymous === true || !company,
    activeDays: parseActiveDays(recruiterActive),
    listingDays: null,
    seenCount: 0,
    longTerm: false,
    postedAt: posted.at,
    postedLabel: posted.label || postedText,
    postedDays: postedDaysOf(posted.at),
    refreshCount: 0,
    ageDays: postedDaysOf(posted.at),
    trustScore: null,
    trustLevel: "",
    trustReasons: [],
    trustRisks: [],
  };
}

/** 本地长期在招识别使用的稳定键：优先平台职位号，其次来源 + 标题 + 链接。 */
export function jobHistoryKey(job: Pick<AutoApplyJob, "source" | "jobId" | "sourceUrl" | "title">) {
  const id = text(job.jobId, 80) || hash(`${job.sourceUrl}|${job.title}`);
  return `${job.source}:${id}`;
}

export function dedupeSiteJobs(jobs: AutoApplyJob[]) {
  return dedupeSiteJobsDetailed(jobs).items;
}

/** 去重时同时保留被丢弃的重复岗位，UI 可以看到「已过滤」里具体是哪些岗位。 */
export function dedupeSiteJobsDetailed(jobs: AutoApplyJob[]) {
  const seen = new Set<string>();
  const items: AutoApplyJob[] = [];
  const duplicates: AutoApplyJob[] = [];
  for (const job of jobs) {
    const key = job.sourceUrl || `${job.company}|${job.title}`;
    if (seen.has(key)) {
      duplicates.push(job);
      continue;
    }
    seen.add(key);
    items.push(job);
  }
  return { items, duplicates };
}

export function matchesCity(job: AutoApplyJob, city: string) {
  const needle = normalizeCityName(city);
  if (!needle) return true;
  return `${job.city} ${job.sourceUrl}`.includes(needle);
}

export type SiteFilterRejection = { job: AutoApplyJob; reason: string; category: "salary" | "safety" | "outsource" };

/** 挂岗天数：平台发布时间与本地首见时间取较大值，两个都没有返回 null。 */
export function jobAgeDays(job: Pick<AutoApplyJob, "ageDays" | "postedDays" | "listingDays">): number | null {
  const values = [job.ageDays, job.postedDays, job.listingDays]
    .map((value) => (value === null || value === undefined ? null : Number(value)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return null;
  return Math.max(...values);
}

function staleDaysLimit(rules: AutoApplyRules) {
  const configured = Number(rules.staleJobDays);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 90;
}

export function filterSiteJobs(jobs: AutoApplyJob[], rules: AutoApplyRules, profile?: AutoApplyProfile) {
  let filtered = 0;
  const rejected: SiteFilterRejection[] = [];
  const reject = (job: AutoApplyJob, reason: string, category: SiteFilterRejection["category"] = "safety") => {
    filtered += 1;
    rejected.push({ job, reason, category });
    return false;
  };
  const salaries = salaryBounds(rules);
  const myYears = profile ? parseYears(profile.years) : null;
  const myDegree = profile ? degreeRank(profile.degree) : null;
  const items = jobs.filter((job) => {
    if (rules.filterHeadhunter && isHeadhunterJob(job)) {
      return reject(job, "猎头 / 代招职位");
    }
    if (rules.filterInactiveHr && isInactiveHr(job.recruiterActive)) {
      return reject(job, `招聘者长期不活跃${job.recruiterActive ? `（${job.recruiterActive}）` : ""}`);
    }
    if (rules.filterOutsource && isOutsourceJob(job)) {
      return reject(job, "标题 / 公司 / 行业 / JD 命中外包或驻场字样", "outsource");
    }
    if (rules.filterStaleJob) {
      const age = jobAgeDays(job);
      if (age !== null && age >= staleDaysLimit(rules)) {
        return reject(job, `岗位已挂出 ${age} 天（超过 ${staleDaysLimit(rules)} 天）`);
      }
    }
    if (salaries) {
      const range = monthlySalaryRange(job);
      // 薪资不明时保留：宁可让本人判断，也不误删真实岗位。
      if (range && (range.max < salaries.min || (salaries.max > 0 && range.min > salaries.max))) {
        return reject(job, `薪资 ${range.min}-${range.max}K/月 不在期望范围`, "salary");
      }
    }
    if (rules.filterExperience && myYears !== null) {
      const required = jobExperienceMin(job);
      if (required !== null && required > myYears + 2) {
        return reject(job, `经验要求 ${required} 年，高于你的 ${myYears} 年`);
      }
    }
    if (rules.filterDegree && myDegree !== null) {
      const required = jobDegreeRank(job);
      if (required !== null && required > myDegree) {
        return reject(job, "学历要求高于你的学历");
      }
    }
    return true;
  });
  return { items, filtered, rejected };
}

export function monthlySalaryRange(job: Pick<AutoApplyJob, "salaryMin" | "salaryMax" | "salaryUnit">): { min: number; max: number } | null {
  const rawMin = job.salaryMin === null || job.salaryMin === undefined ? null : Number(job.salaryMin);
  const rawMax = job.salaryMax === null || job.salaryMax === undefined ? null : Number(job.salaryMax);
  if ((rawMin === null || !Number.isFinite(rawMin)) && (rawMax === null || !Number.isFinite(rawMax))) return null;
  const min = rawMin !== null && Number.isFinite(rawMin) ? rawMin : rawMax as number;
  const max = rawMax !== null && Number.isFinite(rawMax) ? rawMax : rawMin as number;
  const unit = text(job.salaryUnit, 20);
  let factor = 1;
  if (unit === "万/年") factor = 10 / 12;
  else if (unit === "万/月") factor = 10;
  else if (unit === "元/月") factor = 1 / 1000;
  else if (unit === "元/天") factor = 21.75 / 1000;
  else if (!unit && max >= 1000) factor = 1 / 1000;
  const round = (value: number) => Math.round(value * factor * 10) / 10;
  return { min: round(min), max: round(max) };
}

function salaryBounds(rules: AutoApplyRules) {
  const min = Math.max(0, Number(rules.salaryMin) || 0);
  const max = Math.max(0, Number(rules.salaryMax) || 0);
  return min > 0 || max > 0 ? { min, max } : null;
}

export type SalaryCoverage = { total: number; known: number; unknown: number; unknownRatio: number };

type SalaryJob = Pick<AutoApplyJob, "salaryMin" | "salaryMax" | "salaryUnit" | "salaryLabel">;

function hasKnownSalary(job: SalaryJob) {
  if (monthlySalaryRange(job) !== null) return true;
  const label = text(job.salaryLabel, 60);
  return Boolean(label) && !/面议|保密|不限/.test(label);
}

/** 搜索结果里的薪资覆盖度：unknown 包含「面议」和平台没解析出来的薪资。 */
export function salaryCoverage(jobs: SalaryJob[]): SalaryCoverage {
  const total = jobs.length;
  const known = jobs.filter(hasKnownSalary).length;
  const unknown = total - known;
  return { total, known, unknown, unknownRatio: total ? unknown / total : 0 };
}

/**
 * 一页里至少 3 个、且一半以上的岗位都没有薪资时，通常是平台列表没把薪资带出来
 * （反爬字体 / 页面没渲染完），需要重新搜索；一两个「面议」是正常情况，不触发重搜。
 */
export function isSalarySparse(jobs: SalaryJob[]) {
  const coverage = salaryCoverage(jobs);
  return coverage.total >= 3 && coverage.unknown >= 3 && coverage.unknown >= coverage.known;
}

export function parseYears(raw: unknown): number | null {
  const value = text(raw, 40);
  if (!value) return null;
  if (/应届|在校|无经验/.test(value)) return 0;
  const range = value.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)\s*年/);
  if (range) return Math.min(Number(range[1]), Number(range[2]));
  const single = value.match(/(\d+(?:\.\d+)?)\s*年/);
  return single ? Number(single[1]) : null;
}

export function degreeRank(raw: unknown): number | null {
  const value = text(raw, 60);
  if (!value) return null;
  if (/不限|无要求/.test(value)) return 0;
  if (/博士/.test(value)) return 4;
  if (/硕士|研究生/.test(value)) return 3;
  if (/本科/.test(value)) return 2;
  if (/大专|专科/.test(value)) return 1;
  return null;
}

export function jobDegreeRank(job: Pick<AutoApplyJob, "title" | "tags" | "requirements">): number | null {
  const source = `${job.title} ${(job.tags ?? []).join(" ")} ${text(job.requirements, 400)}`
    .replace(/(硕士|本科|博士|大专|专科|研究生)\s*(优先|加分|以上优先)/g, "");
  if (!/学历|本科|硕士|博士|大专|专科|研究生/.test(source)) return null;
  if (/学历不限|不限学历/.test(source)) return 0;
  return degreeRank(source);
}

export function jobExperienceMin(job: Pick<AutoApplyJob, "title" | "tags" | "requirements">): number | null {
  const source = `${job.title} ${(job.tags ?? []).join(" ")} ${text(job.requirements, 400)}`;
  const range = source.match(/(\d+)\s*[-~—至到]\s*\d+\s*年(?:以上)?/);
  if (range) return Number(range[1]);
  const above = source.match(/(\d+)\s*年(?:以上|及以上)/);
  if (above) return Number(above[1]);
  if (/经验不限|应届|在校/.test(source)) return 0;
  return null;
}

export function parseSensorsPayload(raw: unknown): Record<string, any> | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function firstText(...values: unknown[]) {
  for (const value of values) {
    const result = text(value, 200);
    if (result) return result;
  }
  return "";
}

export function splitTags(raw: unknown) {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((entry) => text(entry, 80).split(/[|,，、/]/))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Boss 点「继续沟通 / 立即沟通」时会用账号里预设的招呼语直接发出，再弹「已向BOSS发送消息」。
 * 这种情况下页面上不会再出现输入框，旧逻辑会误判成「没有沟通入口 → 需要本人处理」，
 * 结果明明已经打过招呼却没有记录。这个提示本身就是平台给出的发送成功证据。
 */
export function detectBossAutoGreet(body: string) {
  const value = String(body ?? "").replace(/\s+/g, "");
  if (/已向BOSS发送消息|已向BOSS打招呼|已发送职位邀请/i.test(value)) return true;
  return /留在此页/.test(value) && /继续沟通/.test(value);
}
