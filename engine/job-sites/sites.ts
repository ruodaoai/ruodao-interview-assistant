import type { JobSiteId } from "./types";
import { JOB51_CITY_CODES } from "./job51-cities";

export type JobSiteSearchUrlVariant = {
  /** 智联列表排序：4 最新发布 / 11 综合排序 / 2 薪资最高。 */
  order?: number;
  /** 前程无忧排序：0 综合排序 / 1 最新优先。 */
  sortType?: number;
  /** 智联薪资区间（salaryType），形如 "15001,25000"。 */
  salary?: string;
  /** 公司规模筛选码：深挖每批换一个，翻页时沿用同一个（Boss scale / 智联 cs / 51job companySize）。 */
  scale?: string;
};

export type JobSiteDefinition = {
  id: JobSiteId;
  label: string;
  short: string;
  homeUrl: string;
  /** 真正的登录页（工具条「登录」按钮与登录墙都直接打开这里）。 */
  loginUrl: string;
  searchUrl: (keyword: string, cityCode: string, page: number, variant?: JobSiteSearchUrlVariant) => string;
  supportsGreet: boolean;
  /** 详情页能直接投递简历（平台在线简历），可以批量自动投。 */
  supportsApply: boolean;
  /** 未登录时点「打开」直接落到登录入口（智联首页的登录卡比 passport 页快得多）。 */
  loginOnOpen?: boolean;
  supportsImageResume: boolean;
  note: string;
  applyNote: string;
  cityCodes: Record<string, string>;
};

const BOSS_CITIES: Record<string, string> = {
  全国: "100010000",
  北京: "101010100",
  上海: "101020100",
  天津: "101030100",
  重庆: "101040100",
  广州: "101280100",
  深圳: "101280600",
  杭州: "101210100",
  成都: "101270100",
  南京: "101190100",
  武汉: "101200100",
  苏州: "101190400",
  西安: "101110100",
  长沙: "101250100",
  郑州: "101180100",
  东莞: "101281600",
  佛山: "101280800",
  合肥: "101220100",
  宁波: "101210400",
  青岛: "101120200",
  厦门: "101230200",
  福州: "101230100",
  济南: "101120100",
  大连: "101070200",
  沈阳: "101070100",
  无锡: "101190200",
  珠海: "101280700",
  昆明: "101290100",
};

const LIEPIN_CITIES: Record<string, string> = {
  全国: "410",
  北京: "010",
  上海: "020",
  天津: "030",
  重庆: "040",
  广州: "050020",
  深圳: "050090",
  苏州: "060080",
  南京: "060020",
  杭州: "070020",
  大连: "210040",
  成都: "280020",
  武汉: "170020",
  西安: "270020",
};

const ZHAOPIN_CITIES: Record<string, string> = {
  全国: "0",
  北京: "530",
  上海: "538",
  广州: "763",
  深圳: "765",
  杭州: "653",
  成都: "801",
  南京: "635",
  武汉: "736",
  西安: "854",
  苏州: "639",
  天津: "531",
  重庆: "551",
  长沙: "749",
  郑州: "719",
  东莞: "768",
  佛山: "764",
  合肥: "664",
  宁波: "654",
  青岛: "702",
  厦门: "682",
  福州: "681",
  济南: "701",
  大连: "600",
  沈阳: "599",
  无锡: "636",
  珠海: "766",
  昆明: "831",
};

const CITY_SUFFIX = /(市|地区|自治州|特别行政区)$/;

export function normalizeCityName(value: unknown) {
  return String(value ?? "").trim().replace(CITY_SUFFIX, "").trim();
}

export const JOB_SITES: Record<JobSiteId, JobSiteDefinition> = {
  boss: {
    id: "boss",
    label: "Boss直聘",
    short: "Boss",
    homeUrl: "https://www.zhipin.com/",
    loginUrl: "https://www.zhipin.com/web/user/?ka=header-login",
    searchUrl: (keyword, cityCode, page, variant) =>
      `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${encodeURIComponent(cityCode || BOSS_CITIES.全国)}${variant?.scale ? `&scale=${encodeURIComponent(variant.scale)}` : ""}${page > 1 ? `&page=${page}` : ""}`,
    supportsGreet: true,
    supportsApply: false,
    supportsImageResume: true,
    note: "需要在打开的浏览器里扫码登录；登录状态会按网站要求保留在本机。",
    applyNote: "Boss 用「打招呼」把简历和一句话发给 HR，投递在聊天窗口完成。",
    cityCodes: BOSS_CITIES,
  },
  liepin: {
    id: "liepin",
    label: "猎聘",
    short: "猎聘",
    homeUrl: "https://www.liepin.com/",
    loginUrl: "https://passport.liepin.com/",
    searchUrl: (keyword, cityCode, page) =>
      `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&city=${encodeURIComponent(cityCode || LIEPIN_CITIES.全国)}&dq=${encodeURIComponent(cityCode || LIEPIN_CITIES.全国)}&currentPage=${Math.max(0, page - 1)}`,
    supportsGreet: false,
    supportsApply: true,
    supportsImageResume: false,
    note: "匿名即可搜索；投递简历和「聊一聊」需要先登录猎聘。",
    applyNote: "详情页有「立即投递」就直接投递（弹窗可补附件简历）；只有「聊一聊」的岗位发送开场话术打招呼。",
    cityCodes: LIEPIN_CITIES,
  },
  zhaopin: {
    id: "zhaopin",
    label: "智联招聘",
    short: "智联",
    homeUrl: "https://www.zhaopin.com/",
    // 首页带 ?login=1 会直接弹出登录卡（手机号/验证码 + 微信扫码），实测 3 秒内可用；
    // passport.zhaopin.com/login 要等约 20 秒才画完，用户会以为「没有登录」。
    // /org/login 是企业版入口，别用。
    loginUrl: "https://www.zhaopin.com/?login=1",
    loginOnOpen: true,
    // 2026-11 改版：旧 /sou/jl<code>/p<n>?kw= 会重定向到 /jobs/?jl=<code>&kw=<keyword>，
    // 新版列表是 SPA，页码不再走 URL，翻页由页面自己的 loadMoreJobList 追加。
    // order / sl / cs 实测有效：换排序、薪资区间或公司规模会返回完全不同的前 20 条，
    // 是突破匿名截断的关键。
    searchUrl: (keyword, cityCode, _page, variant) => {
      const code = cityCode || ZHAOPIN_CITIES.全国;
      // pageMode=search 是页面自己点「搜索」后写进地址栏的模式；不带它时智联可能沿用
      // 账号里的期望岗位/推荐列表，出现「搜区块链却全是 Java」的情况。
      const params = new URLSearchParams({ kw: keyword, pageMode: "search" });
      if (code && code !== "0") params.set("jl", code);
      if (variant?.order) params.set("order", String(variant.order));
      if (variant?.salary) params.set("sl", variant.salary);
      if (variant?.scale) params.set("cs", variant.scale);
      return `https://www.zhaopin.com/jobs/?${params.toString()}`;
    },
    supportsGreet: false,
    supportsApply: true,
    supportsImageResume: false,
    note: "智联会触发腾讯云人机验证，需要在打开的窗口里手动完成验证后再搜索。",
    applyNote: "详情页有「立即申请」就直接投递（首次选简历 →「立即投递」，成功弹窗是「已向对方发送简历和打招呼语」；没抓到弹窗时重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递，按钮还在会自动再投一次）；只有「聊一聊」的岗位发送开场话术打招呼。部分账号会先要求人机验证。",
    cityCodes: ZHAOPIN_CITIES,
  },
  job51: {
    id: "job51",
    label: "前程无忧",
    short: "51job",
    homeUrl: "https://we.51job.com/",
    loginUrl: "https://login.51job.com/login.php",
    // sortType=0 是页面上的「综合排序」；「最新优先」(sortType=1) 会把大量刚发布岗位筛到前面，
    // 命中量明显偏少，用户实测更希望按综合排序取岗位。
    // 默认仍用综合排序；深度搜索会按轮次切到「最新优先」，两套结果的交集很小，能多翻出一批没投过的岗位。
    // pageNum 只用于第 1 页（搜索页是 SPA，重新打开带 pageNum 的地址仍渲染第 1 页）；
    // 第 2 页起由 service.ts#searchJob51ApiPage 调用同一列表接口翻页，companySize 必须一起带上。
    searchUrl: (keyword, cityCode, page, variant) =>
      `https://we.51job.com/pc/search?${cityCode ? `jobArea=${encodeURIComponent(cityCode)}&` : ""}keyword=${encodeURIComponent(keyword)}&searchType=2&sortType=${variant?.sortType ?? 0}${variant?.scale ? `&companySize=${encodeURIComponent(variant.scale)}` : ""}&pageNum=${Math.max(1, page)}`,
    supportsGreet: false,
    supportsApply: true,
    supportsImageResume: false,
    note: "匿名即可搜索；未填城市时按当前网络城市返回。投递需要先登录 51job。",
    applyNote: "打开岗位详情页（不是公司主页）：有「投递」按钮就投递（确认页选简历 →「申请」）；没有投递按钮就点「聊一聊」，把开场话术发过去。投递后重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递；按钮还在会自动再投一次。",
    cityCodes: JOB51_CITY_CODES,
  },
};

/** 可搜索 / 可开窗的平台。猎聘已下线，只在历史投递记录里保留展示。 */
export const JOB_SITE_IDS: JobSiteId[] = ["boss", "zhaopin", "job51"];

/** 能直接投递简历的平台（Boss 走聊天打招呼，不在其列）。 */
export const APPLY_SITE_IDS: Exclude<JobSiteId, "boss">[] = ["liepin", "zhaopin", "job51"];

export function supportsSiteApply(site: string): site is Exclude<JobSiteId, "boss"> {
  return (APPLY_SITE_IDS as string[]).includes(site);
}

export function isJobSiteId(value: unknown): value is JobSiteId {
  return typeof value === "string" && (JOB_SITE_IDS as string[]).includes(value);
}

export function resolveCityCode(site: JobSiteId, city: string) {
  const name = normalizeCityName(city);
  if (!name) return { code: "", mapped: true as const };
  const code = JOB_SITES[site].cityCodes[name];
  return code ? { code, mapped: true as const } : { code: "", mapped: false as const };
}

export function jobSiteLabel(site: JobSiteId) {
  return JOB_SITES[site]?.label ?? site;
}

/**
 * 招聘窗口的 UA 只能包含 ASCII。
 *
 * Electron 默认把 `app.getName()` 拼进 UA，本应用名是中文（若道 Agent），UA 里就成了
 * `若道Agent/0.0.26`。智联登录组件会把 navigator.userAgent 原样写进 `x-zp-user-agent`
 * 请求头，而 `setRequestHeader` 只接受 ISO-8859-1，中文直接抛 TypeError —— 首页登录卡
 * 只剩一个空壳、永远不渲染（实测异常来自 passport.zhaopin.com/widgets/zp-passport-cust-v2）。
 * 只去掉含非 ASCII 的片段，Chrome / Electron 版本保持真实。
 */
export function asciiUserAgent(raw: string) {
  return raw.split(/\s+/).filter((token) => /^[\x20-\x7e]+$/.test(token)).join(" ");
}

/**
 * UA 归一化只对智联开放。
 *
 * 改 UA 等于换浏览器指纹，已登录的平台会把会话判成异常并登出。11-04 的批量事故就是
 * 全局改 UA 后 Boss 掉登录：61 条岗位全被记成「没有回执」，实际一条也没发出去。
 * 其它平台保持 Electron 默认 UA。
 */
export function needsAsciiUserAgent(site: JobSiteId) {
  return site === "zhaopin";
}

/** 单个关键词最多翻到第 100 页；一次连续加载最多 20 页（各平台每页约 15-20 条）。 */
export const JOB_SITE_MAX_PAGE = 100;
export const JOB_SITE_MAX_PAGES_PER_LOAD = 20;

/** 把界面传来的「从第几页开始 + 连续加载几页」收敛成合法区间。 */
export function sitePageRange(start: unknown, pages: unknown) {
  const first = Math.max(1, Math.min(JOB_SITE_MAX_PAGE, Math.round(Number(start) || 1)));
  const requested = Math.max(1, Math.min(JOB_SITE_MAX_PAGES_PER_LOAD, Math.round(Number(pages) || 1)));
  const end = Math.min(JOB_SITE_MAX_PAGE, first + requested - 1);
  return { start: first, end, count: end - first + 1 };
}
