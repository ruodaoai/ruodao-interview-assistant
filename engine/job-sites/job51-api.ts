import type { RawSiteJob } from "./types";

/**
 * 前程无忧（51job）列表旁路数据。
 *
 * 搜索卡片 DOM 里唯一带 href 的链接是**公司主页**（a.comp → jobs.51job.com/all/coXXXX.html），
 * 岗位标题只是 span.jname。早先按「we.51job.com/pc/jobdetail?jobId=」去还原岗位页，
 * 但那条是未登录会被踢到登录页、登录后也常常空白的前端路由，投递必然失败。
 *
 * 页面自己请求的 `/api/job/search-pc` 里每个岗位都带 `jobHref`
 * （形如 https://jobs.51job.com/shenzhen-lgq/173482791.html），
 * 这才是平台真正的服务端渲染详情页，也是「立即投递」按钮所在的页面。
 * 这里只做结构兼容映射，不额外发请求，也不绕过登录或风控。
 */

function text(value: unknown, max = 400) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const result = text(value, 400);
    if (result) return result;
  }
  return "";
}

function itemsOf(payload: any): any[] {
  const job = payload?.resultbody?.job ?? payload?.result?.job ?? payload?.data?.job ?? payload?.job;
  const list = job?.items ?? payload?.resultbody?.items ?? payload?.items;
  return asList(list).filter((entry) => entry && typeof entry === "object");
}

export function job51SearchItems(payload: any): any[] {
  return itemsOf(payload);
}

export type Job51PageInfo = {
  /** 平台状态码：1 是成功，其余按错误处理。 */
  status: string;
  message: string;
  total: number;
  count: number;
  /** 第 1 页返回的 requestId；平台要求后续翻页带上它。 */
  requestId: string;
};

export function job51PageInfo(payload: any): Job51PageInfo {
  const body = payload?.resultbody ?? payload?.result ?? payload?.data ?? payload ?? {};
  const job = body?.job ?? {};
  return {
    status: text(payload?.status ?? body?.status, 40),
    message: firstText(payload?.message, body?.message, payload?.msg),
    total: Math.max(0, Math.round(Number(job?.totalcount ?? job?.totalCount ?? 0) || 0)),
    count: job51SearchItems(payload).length,
    requestId: firstText(body?.requestId, payload?.requestId),
  };
}

/**
 * 前程无忧第 2 页起的列表接口地址。
 *
 * 搜索页是 SPA，URL 里的 `pageNum` 只影响页面初始状态（前端固定从第 1 页开始），
 * 直接重新打开 `we.51job.com/pc/search?...&pageNum=N` 永远返回第 1 页。
 * 页面自己翻页时请求的是 `/api/job/search-pc`，这里用同一组分页参数在
 * 已打开的前程无忧页面里请求；登录、验证码仍由页面自己上报。
 */
export function job51SearchApiUrl(input: {
  keyword: string;
  areaCode?: string;
  page: number;
  sortType?: number;
  requestId?: string;
  /** 公司规模筛选码（1 少于50人 … 7 10000人以上）：深挖整批共用，翻页不能丢。 */
  companySize?: string;
}) {
  const params = new URLSearchParams({
    api_key: "51job",
    // 与页面自身请求一致：时间戳是 10 位秒级（抓包实测 1793173528），不是毫秒。
    timestamp: String(Math.floor(Date.now() / 1000)),
    keyword: String(input.keyword ?? ""),
    searchType: "2",
    // 页面把筛选面板的当前值全部带上，未筛选时是空字符串；这里照抄抓包里的同一组参数。
    function: "",
    industry: "",
    jobArea: input.areaCode || "000000",
    jobArea2: "",
    landmark: "",
    metro: "",
    salary: "",
    workYear: "",
    degree: "",
    companyType: "",
    companySize: text(input.companySize, 10),
    jobType: "",
    issueDate: "",
    sortType: String(input.sortType ?? 0),
    pageNum: String(Math.max(1, Math.round(Number(input.page) || 1))),
    pageSize: "20",
    source: "1",
    pageCode: "sou|sou|soulb",
    scene: "7",
    accountId: "",
    // 页面每次请求都带这个参数：第 1 页为空串，第 2 页起用第 1 页返回的令牌。
    requestId: text(input.requestId, 120),
  });
  return `https://we.51job.com/api/job/search-pc?${params.toString()}`;
}

/** 平台职位号：优先接口字段，其次从详情页地址里取。 */
export function job51JobIdOf(value: unknown): string {
  const raw = text(value, 300);
  if (/^\d{5,20}$/.test(raw)) return raw;
  const fromPath = raw.match(/\/(\d{5,20})\.html/i)?.[1] ?? "";
  if (fromPath) return fromPath;
  const fromQuery = raw.match(/[?&]jobId=(\d{5,20})/i)?.[1] ?? "";
  return fromQuery;
}

/**
 * 是否已经是 jobs.51job.com 的岗位详情页（服务端渲染、带「立即投递」按钮）。
 * 公司主页（/all/coXXXX.html）、we.51job.com 前端路由都不算。
 */
export function isJob51DetailUrl(value: unknown): boolean {
  const raw = text(value, 500);
  if (!/^https?:\/\/jobs\.51job\.com\//i.test(raw)) return false;
  return /^https?:\/\/jobs\.51job\.com\/(?!all\/)[a-z0-9-]+\/\d{5,}\.html/i.test(raw);
}

/** 统一去掉跟踪参数，只留可长期复用的岗位地址；不是详情页时返回空字符串。 */
export function normalizeJob51DetailUrl(value: unknown): string {
  const raw = text(value, 500);
  if (!isJob51DetailUrl(raw)) return "";
  const match = raw.match(/^https?:\/\/jobs\.51job\.com\/([a-z0-9-]+)\/(\d{5,})\.html/i);
  return match ? `https://jobs.51job.com/${match[1].toLowerCase()}/${match[2]}.html` : raw;
}

/**
 * 只有职位号、没有平台给的详情页地址时的兜底：用接口里的 hrefAreaPinYin 拼城市段。
 * 城市段只影响面包屑，但 `/all/` 路径会被 51job 的访问验证拦住，所以宁可拼不出来
 * 也不要用 all 去撞风控。
 */
export function job51DetailUrl(jobId: unknown, areaPinYin?: unknown): string {
  const id = job51JobIdOf(jobId);
  const area = text(areaPinYin, 40).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!id || !area || area === "all") return "";
  return `https://jobs.51job.com/${area}/${id}.html`;
}

export function mapJob51ListItem(item: any): RawSiteJob | null {
  if (!item || typeof item !== "object") return null;
  const title = firstText(item.jobName, item.jobTitle, item.title);
  const jobId = firstText(item.jobId, item.jobid);
  if (!title) return null;
  const href = normalizeJob51DetailUrl(item.jobHref) || job51DetailUrl(jobId, item.hrefAreaPinYin);
  if (!href) return null;
  const areaPinYin = text(item.hrefAreaPinYin, 40);
  const city = firstText(item.jobAreaString, item.jobArea, item.jobAreaLevelDetail?.cityString);
  const salary = firstText(item.provideSalaryString, item.jobSalaryString, item.jobSalary);
  const industry = firstText(item.industryType1Str, item.coIndustryText, item.companyIndustryType1Str);
  const tags = [
    ...asList(item.jobTags),
    ...asList(item.jobTagsForOrder),
    text(item.workYearString, 40),
    text(item.degreeString, 40),
  ].map((entry) => text(entry, 40)).filter(Boolean);
  const online = item.hrIsOnline === true || item.isOnline === true || text(item.hrOnlineLabelStatus, 40);
  return {
    title,
    company: firstText(item.fullCompanyName, item.companyName, item.customerName),
    city: city || "",
    salary,
    url: href,
    tags: [...new Set(tags)].slice(0, 16),
    recruiter: firstText(item.hrName),
    recruiterTitle: firstText(item.hrPosition),
    recruiterActive: online ? firstText(item.hrOnlineLabelStatus) || "当前在线" : "",
    jobId: job51JobIdOf(jobId),
    jobStatus: item.isExpire === true || Number(item.isExpire) === 1 ? "closed" : "",
    jobStatusText: item.isExpire === true || Number(item.isExpire) === 1 ? "平台标记已关闭" : "",
    companyIndustry: industry,
    companyScale: firstText(item.companySizeString),
    companyStage: firstText(item.companyTypeString),
    postedText: firstText(item.issueDateString, item.updateDateTime),
    extra: [industry, text(item.companySizeString, 40), text(item.companyTypeString, 40), text(item.jobDescribe, 300), areaPinYin]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500),
  };
}

/** 在接口返回的岗位里按职位号取详情页地址（投递前校正历史记录用）。 */
export function job51HrefFromItems(items: any[], jobId: unknown): string {
  const id = job51JobIdOf(jobId);
  if (!id) return "";
  const hit = (asList(items) as any[]).find((entry) => job51JobIdOf(entry?.jobId) === id);
  if (!hit) return "";
  return normalizeJob51DetailUrl(hit.jobHref) || job51DetailUrl(id, hit.hrefAreaPinYin);
}

/** 按职位号反查详情页地址的接口（在已登录的 we.51job.com 搜索页里同源执行）。 */
export function job51LookupScript(jobId: string) {
  return `(async () => {
    const jobId = ${JSON.stringify(String(jobId).replace(/\D/g, ""))};
    if (!jobId) return "";
    const url = "https://we.51job.com/api/job/search-pc?api_key=51job&timestamp=" + Date.now()
      + "&jobId=" + encodeURIComponent(jobId) + "&pageNum=1&pageSize=20&searchType=2&source=1";
    const read = async () => {
      try {
        const response = await fetch(url, { credentials: "include" });
        const body = await response.text();
        // 风控把接口拦成 HTML 验证页时不带任何岗位数据，直接当没拿到。
        if (!body.trimStart().startsWith("{")) return "";
        const payload = JSON.parse(body);
        const items = payload?.resultbody?.job?.items ?? [];
        const hit = items.find((entry) => String(entry?.jobId ?? "") === jobId) ?? items[0];
        return String(hit?.jobHref ?? "");
      } catch {
        return "";
      }
    };
    const first = await read();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return await read();
  })()`;
}
