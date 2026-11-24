import type { RawSiteJob } from "./types";

/**
 * Boss 的搜索列表 DOM 会对薪资做字体混淆，公司/城市选择器也随前端版本变化。
 * 页面自己请求的 joblist.json / detail.json 里是明文数据，这里只做结构兼容映射，
 * 不额外发请求，也不绕过登录或风控。
 */

function text(value: unknown, max = 400) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const result = text(value, 400);
    if (result) return result;
  }
  return "";
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dataOf(payload: any) {
  return payload?.zpData ?? payload?.data ?? payload ?? {};
}

export function bossJobListItems(payload: any): any[] {
  const data = dataOf(payload);
  const list = data?.jobList ?? data?.jobListData ?? data?.list ?? data?.jobs;
  return asList(list).filter((entry) => entry && typeof entry === "object");
}

function flag(value: unknown) {
  return value === true || Number(value) === 1 || value === "1";
}

function jobStatusOf(value: unknown): { jobStatus: "open" | "closed" | ""; jobStatusText: string } {
  if (value === undefined || value === null || value === "") return { jobStatus: "", jobStatusText: "" };
  if (Number(value) === 1 || value === "1" || value === true) return { jobStatus: "open", jobStatusText: "平台标记在招" };
  if (Number(value) === 0 || value === "0" || value === false) return { jobStatus: "closed", jobStatusText: "平台标记已关闭" };
  return { jobStatus: "", jobStatusText: "" };
}

function jobUrl(jobId: string) {
  return jobId ? `https://www.zhipin.com/job_detail/${encodeURIComponent(jobId)}.html` : "";
}

export const BOSS_PAGE_SIZE = 15;

/**
 * Boss 搜索列表接口的表单体。
 *
 * Boss 的搜索页是 SPA：URL 上的 `page` 参数不会传给接口（实测无论 page=N 都发 page=1），
 * 所以翻页必须在页面上下文里按同一套参数自己发。pageSize 平台固定截回 15。
 */
export function bossSearchForm(input: { keyword: string; cityCode?: string; page: number; scale?: string }) {
  return new URLSearchParams({
    page: String(Math.max(1, Math.round(Number(input.page) || 1))),
    pageSize: String(BOSS_PAGE_SIZE),
    city: String(input.cityCode ?? ""),
    expectInfo: "",
    query: String(input.keyword ?? ""),
    multiSubway: "",
    multiBusinessDistrict: "",
    position: "",
    jobType: "",
    salary: "",
    experience: "",
    degree: "",
    industry: "",
    scale: String(input.scale ?? ""),
    stage: "",
    scene: "1",
    encryptExpectId: "",
  }).toString();
}

export type BossPageInfo = {
  code: number;
  message: string;
  /** 平台报的命中总数；0 表示接口没给或确实没有岗位。 */
  total: number;
  /** 本页岗位数。 */
  count: number;
};

/** 解析列表接口的外层状态：翻页时要区分「没有更多」和「登录/风控拦截」。 */
export function bossPageInfo(payload: any): BossPageInfo {
  const data = dataOf(payload);
  const rawCode = payload && typeof payload === "object" ? Number(payload.code) : 0;
  return {
    code: Number.isFinite(rawCode) ? rawCode : 0,
    message: firstText(payload?.message, payload?.msg, data?.message, data?.msg),
    total: Math.max(0, Math.round(Number(data?.totalCount ?? data?.total ?? 0) || 0)),
    count: bossJobListItems(payload).length,
  };
}

export type BossPageFailure = {
  blocked: "login" | "verification" | "";
  /** 本批翻页应停下（已加载的岗位保留），但不属于平台阻断。 */
  stop: boolean;
  note: string;
};

/**
 * Boss 列表接口非 0 返回码的分类。
 *
 * code 37「您的环境存在异常」是连续翻页触发的临时频控（未登录时更容易出现）：
 * 搜索页本身完全正常，没有任何验证界面。以前按「异常」二字判成人机验证，
 * 用户会被指去一个不存在的验证页面。
 */
export function classifyBossPageFailure(code: number, message: string): BossPageFailure {
  const value = text(message, 200);
  if (code === 0) return { blocked: "", stop: false, note: "" };
  if (/登录|login/i.test(value)) return { blocked: "login", stop: false, note: "" };
  if (/人机验证|滑块验证|请完成验证|按住滑块|拖动到最右边|图形验证码|验证码|Security Verification|正在验证连接安全性|Protected by Tencent Cloud EdgeOne|verify you are human|checking your browser/i.test(value)) {
    return { blocked: "verification", stop: false, note: "" };
  }
  if (code === 37 || /环境存在异常|访问过于频繁|操作过于频繁|请求过于频繁|访问频繁|稍后再试/i.test(value)) {
    return {
      blocked: "",
      stop: true,
      note: `Boss 暂时限制了连续翻页${value ? `（平台提示：${value}）` : ""}；已加载的岗位都保留，等 1-2 分钟再点「继续加载」，或直接在 Boss 窗口里手动翻页。`,
    };
  }
  return {
    blocked: "",
    stop: true,
    note: `Boss 列表接口返回 code=${code}${value ? `：${value}` : ""}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`,
  };
}

export function mapBossListItem(item: any): RawSiteJob | null {
  if (!item || typeof item !== "object") return null;
  const title = firstText(item.jobName, item.jobTitle, item.title);
  if (!title) return null;
  const jobId = firstText(item.encryptJobId, item.encryptJobID, item.jobId);
  const salary = firstText(item.salaryDesc, item.salary, item.salaryName);
  const city = [firstText(item.cityName, item.city), firstText(item.areaDistrict, item.area)].filter(Boolean).join("·");
  const recruiter = firstText(item.bossName, item.bossNickName, item.recruiterName);
  const recruiterTitle = firstText(item.bossTitle, item.bossPosition, item.recruiterTitle);
  const recruiterActive = firstText(item.bossActiveTimeDesc, item.activeTimeDesc, item.bossActiveDesc)
    || (flag(item.bossOnline) ? "当前在线" : "");
  const status = jobStatusOf(item.jobValidStatus);
  const companyIndustry = firstText(item.brandIndustry, item.industryName, item.companyIndustry);
  const companyStage = firstText(item.brandStageName, item.stageName);
  const companyScale = firstText(item.brandScaleName, item.scaleName);
  const tags = [
    ...asList(item.jobLabels),
    ...asList(item.skills),
    ...asList(item.welfareList),
    flag(item.goldHunter) ? "猎头职位" : "",
    flag(item.proxyJob) ? "代招" : "",
  ].map((entry) => text(entry, 40)).filter(Boolean);

  return {
    title,
    company: firstText(item.brandName, item.brandShortName, item.companyName),
    city,
    salary,
    url: jobUrl(jobId),
    tags,
    recruiter,
    recruiterActive,
    recruiterTitle,
    jobId,
    jobStatus: status.jobStatus,
    jobStatusText: status.jobStatusText,
    companyIndustry,
    companyStage,
    companyScale,
    anonymous: flag(item.anonymous),
    headhunter: flag(item.goldHunter),
    proxy: flag(item.proxyJob),
    extra: [companyIndustry, companyStage, companyScale, firstText(item.brandLabels?.join?.(" "))].filter(Boolean).join(" ").slice(0, 500),
  };
}

function stripHtml(value: unknown) {
  return String(value ?? "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
    .trim();
}

export type BossDetail = {
  description: string;
  recruiter: string;
  recruiterTitle: string;
  recruiterActive: string;
  company: string;
  companyIndustry: string;
  companyStage: string;
  companyScale: string;
  city: string;
  salaryLabel: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryUnit: string;
  jobStatus: "open" | "closed" | "";
  jobStatusText: string;
  jobId: string;
};

export function mapBossDetail(payload: any): BossDetail | null {
  const data = dataOf(payload);
  const info = data?.jobInfo ?? data?.job ?? {};
  const boss = data?.bossInfo ?? data?.boss ?? {};
  const brand = data?.brandComInfo ?? data?.brand ?? {};
  const description = stripHtml(info.postDescription ?? info.description ?? data?.jobDetail?.description ?? data?.description);
  if (!info.jobName && !description) return null;

  const statusText = firstText(info.jobStatusDesc, info.jobStatusText, data?.jobStatusDesc);
  const status = jobStatusOf(info.jobValidStatus ?? data?.jobValidStatus);
  const inferredStatus = status.jobStatus || (/停止招聘|已关闭|已下线|暂停招聘|职位已失效/.test(statusText) ? "closed" : /在招|招聘中|热招/.test(statusText) ? "open" : "");
  const locationName = firstText(info.locationName);
  const city = locationName || [firstText(info.cityName, info.city), firstText(info.areaDistrict, info.area)].filter(Boolean).join("·");
  const salaryLabel = firstText(info.salaryDesc, info.salary);
  const salary = /^\d/.test(salaryLabel) ? parseSalary(salaryLabel) : { min: null, max: null, unit: "" };

  return {
    description,
    recruiter: firstText(boss.name, boss.bossName, boss.recruiterName),
    recruiterTitle: firstText(boss.title, boss.bossTitle, boss.position),
    recruiterActive: firstText(boss.activeTimeDesc, boss.bossActiveTimeDesc, boss.activeDesc),
    company: firstText(brand.brandName, brand.companyName, data?.brandName),
    companyIndustry: firstText(brand.industryName, brand.industry, data?.industryName),
    companyStage: firstText(brand.stageName, data?.stageName),
    companyScale: firstText(brand.scaleName, data?.scaleName),
    city,
    salaryLabel,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryUnit: salary.unit,
    jobStatus: inferredStatus,
    jobStatusText: statusText || status.jobStatusText,
    jobId: firstText(info.encryptJobId, info.encryptId, info.jobId, data?.encryptJobId),
  };
}

function parseSalary(label: string) {
  const range = label.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)/);
  const numbers = range ? [Number(range[1]), Number(range[2])] : [];
  if (!numbers.length) return { min: null, max: null, unit: "" };
  const unit = /元\s*\/\s*(天|日)/.test(label) ? "元/天"
    : /(万|w)\s*\/?\s*年|年薪/.test(label) ? "万/年"
      : /[kK]|千/.test(label) ? "K/月"
        : /万|w/i.test(label) ? "万/月"
          : Math.max(...numbers) >= 1000 ? "元/月" : "K/月";
  return { min: Math.min(...numbers), max: Math.max(...numbers), unit };
}
