import type { AutoApplyJob } from "./auto-apply/types";
import type { BrowserDriver } from "./driver";
import { bossJobListItems, bossPageInfo, BOSS_PAGE_SIZE, bossSearchForm, classifyBossPageFailure, mapBossDetail, mapBossListItem } from "./job-sites/boss-api";
import { classifyBlocked } from "./job-sites/blocker";
import { extractPostedText, parsePostedAt, postedDays as postedDaysOf } from "./job-sites/dates";
import { job51JobIdOf, job51PageInfo, job51SearchApiUrl, job51SearchItems, mapJob51ListItem, normalizeJob51DetailUrl } from "./job-sites/job51-api";
import { dedupeSiteJobs, dedupeSiteJobsDetailed, isSalarySparse, mapRawSiteJob, matchesCity, salaryCoverage } from "./job-sites/parse";
import { deepPageWindow, expandSearchKeywords, job51SortLabel, keywordCycleLength, MAX_SEARCH_KEYWORDS, resolveSearchPlan, salaryRangeText, siteScaleLabel, zhaopinOrderLabel, type SearchPlan } from "./job-sites/search-plan";
import { JOB_SITES, JOB_SITE_IDS, jobSiteLabel, normalizeCityName, resolveCityCode, sitePageRange } from "./job-sites/sites";
import type { JobSiteId, JobSiteQuery, JobSiteSearchResult, JobSiteStatus, RawSiteJob } from "./job-sites/types";
import { mapZhaopinPosition, zhaopinEffectiveKeyword, zhaopinFetchSearchPageScript, zhaopinKeywordApplied, zhaopinKeywordRelevant, zhaopinLimitedByLogin, zhaopinLoadMoreScript, zhaopinPageState, zhaopinPageStateScript, zhaopinSliceNote, zhaopinSubmitSearchScript } from "./job-sites/zhaopin-api";
import { bossApiFetchScript, detailScript, extractionScript, job51ApiFetchScript, postedScript, probeScript } from "./scripts";

const RESULT_WAIT_MS = 30_000;
const EVAL_TIMEOUT_MS = 8_000;
const CONTENT_WAIT_MS = 12_000;
/** 与主进程保持一致：Boss 翻页接口之间的间隔，避免连续请求触发风控。 */
const BOSS_PAGE_PAUSE_MS = 1_600;
const DEEP_SEARCH_BUDGET_MS = 120_000;
const CLOSED_WINDOW_NOTE = "招聘窗口已关闭，已加载的岗位都保留；重新打开窗口后可以继续搜索";

type SearchOneResult = {
  items: AutoApplyJob[];
  rawCount: number;
  cards: number;
  blocked: "login" | "verification" | "";
  salaryNote?: string;
  total?: number;
  note?: string;
  stop?: boolean;
  hasMore?: boolean;
  limitedByLogin?: boolean;
  /** 平台按全文匹配返回、但岗位名/技能标签都不含关键词的岗位数。 */
  keywordFiltered?: number;
};

type ResultsProbe = {
  cards: number;
  body: string;
  url: string;
  title: string;
  blocked: "login" | "verification" | "";
};

type SiteRuntime = {
  site: JobSiteId;
  blocked: "login" | "verification" | "";
  loginState: "in" | "out" | "";
  message: string;
  lastSearchAt: number;
  lastCheckedAt: number;
  job51RequestId?: string;
  scale?: string;
};

export type SearchEngineDeps = {
  driver: BrowserDriver;
  log?: (line: string) => void;
};

function text(value: unknown, max = 1000) {
  return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeKeywords(input: JobSiteQuery) {
  const values = [
    ...(Array.isArray(input.keywords) ? input.keywords : []),
    input.keyword ?? "",
  ]
    .flatMap((entry) => text(entry, 80).split(/[|,，、;；\n]/))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, MAX_SEARCH_KEYWORDS);
}

/**
 * 招聘平台搜索 / 详情读取引擎。
 *
 * 业务逻辑（关键词扩展、公司规模轮换、逐站翻页方式、结果去重、薪资回补）
 * 全部在插件这一侧；宿主只执行页面脚本、导航和接口旁路监听。
 */
export class JobSiteSearchEngine {
  private runtimes = new Map<JobSiteId, SiteRuntime>();

  constructor(private readonly deps: SearchEngineDeps) {}

  private get driver() {
    return this.deps.driver;
  }

  private log(line: string) {
    this.deps.log?.(`[job-engine] ${line}`);
  }

  private runtime(site: JobSiteId): SiteRuntime {
    let runtime = this.runtimes.get(site);
    if (!runtime) {
      runtime = { site, blocked: "", loginState: "", message: JOB_SITES[site].note, lastSearchAt: 0, lastCheckedAt: 0 };
      this.runtimes.set(site, runtime);
    }
    return runtime;
  }

  /** 投递 / 打招呼流程也共用同一份窗口状态，登录墙与验证码要显示在同一个状态条里。 */
  markBlocked(site: JobSiteId, blocked: "login" | "verification" | "", message: string) {
    const runtime = this.runtime(site);
    runtime.blocked = blocked;
    runtime.lastCheckedAt = Date.now();
    if (message) runtime.message = message;
  }

  runtimeMessage(site: JobSiteId) {
    return this.runtime(site).message;
  }

  /** 打招呼流程自己判出登录态（Boss 匿名页没有登录墙文案，只能看登录入口）时同步给状态条。 */
  markLoginState(site: JobSiteId, loginState: "in" | "out" | "") {
    const runtime = this.runtime(site);
    runtime.loginState = loginState;
    runtime.lastCheckedAt = Date.now();
  }

  async statuses(): Promise<JobSiteStatus[]> {
    const base = await this.driver.statusAll().catch(() => [] as any[]);
    const bySite = new Map<string, any>((Array.isArray(base) ? base : []).map((entry) => [String(entry?.site ?? ""), entry]));
    return JOB_SITE_IDS.map((site) => {
      const open = Boolean(bySite.get(site)?.open);
      const runtime = this.runtimes.get(site);
      if (!runtime) {
        return bySite.get(site) ?? {
          site,
          label: jobSiteLabel(site),
          open: false,
          loginState: "",
          blocked: "",
          message: JOB_SITES[site].note,
          lastSearchAt: 0,
          lastCheckedAt: 0,
        };
      }
      return {
        site,
        label: jobSiteLabel(site),
        open,
        loginState: open ? runtime.loginState : "",
        blocked: open ? runtime.blocked : "",
        message: open ? runtime.message : JOB_SITES[site].note,
        lastSearchAt: open ? runtime.lastSearchAt : 0,
        lastCheckedAt: open ? runtime.lastCheckedAt : 0,
      } satisfies JobSiteStatus;
    });
  }

  async open(site: JobSiteId) {
    const status = await this.driver.open(site);
    const runtime = this.runtime(site);
    runtime.loginState = status?.loginState ?? runtime.loginState;
    runtime.blocked = status?.blocked ?? "";
    runtime.message = status?.message ?? JOB_SITES[site].note;
    runtime.lastCheckedAt = Date.now();
    return status;
  }

  async close(site: JobSiteId) {
    await this.driver.close(site);
    const runtime = this.runtime(site);
    runtime.blocked = "";
    runtime.message = JOB_SITES[site].note;
    return { closed: true };
  }

  async refresh() {
    const items = await this.driver.refresh().catch(() => [] as any[]);
    for (const entry of Array.isArray(items) ? items : []) {
      const site = entry?.site;
      if (!JOB_SITE_IDS.includes(site)) continue;
      const runtime = this.runtime(site);
      if (!entry.open) continue;
      runtime.loginState = entry.loginState ?? runtime.loginState;
      runtime.blocked = entry.blocked ?? "";
      runtime.message = String(entry.message ?? runtime.message);
      runtime.lastCheckedAt = Number(entry.lastCheckedAt) || Date.now();
    }
    return this.statuses();
  }

  private async waitForResults(site: JobSiteId, timeoutMs = RESULT_WAIT_MS): Promise<ResultsProbe> {
    const deadline = Date.now() + timeoutMs;
    let last: ResultsProbe = { cards: 0, body: "", url: "", title: "", blocked: "" };
    while (Date.now() < deadline) {
      if (await this.driver.isClosed(site).catch(() => true)) break;
      const probe = await this.driver.evaluate<{ cards: number; body: string; url: string; title: string }>(site, probeScript(site), EVAL_TIMEOUT_MS).catch(() => undefined);
      if (probe) last = { ...probe, blocked: "" };
      // Boss 搜索页匿名访问也带「登录/注册 / 立即登录」（匿名照样能搜），
      // 不能把这种软文案当登录墙；真正的墙只认登录页地址或可见登录浮层。
      const blocked = classifyBlocked(last.url, last.body, { ignoreLoginText: site === "boss" });
      if (blocked === "verification") return { ...last, blocked };
      if (last.cards > 0) {
        await sleep(800);
        return { ...last, blocked: "" };
      }
      if (blocked === "login") {
        this.log(`${site} blocked=login url=${text(last.url, 160)}`);
        return { ...last, blocked };
      }
      await sleep(1200);
    }
    return { ...last, blocked: classifyBlocked(last.url, last.body, { ignoreLoginText: site === "boss" }) };
  }

  private async searchOne(site: JobSiteId, keyword: string, city: string, code: string, pageNumber: number, expectedTotal = 0, plan: SearchPlan): Promise<SearchOneResult> {
    const first = await this.searchOnePage(site, keyword, city, code, pageNumber, expectedTotal, plan);
    if (first.blocked || (site === "boss" && pageNumber > 1) || !isSalarySparse(first.items)) return first;
    const firstCoverage = salaryCoverage(first.items);
    this.log(`${site} "${keyword}" salary sparse (${firstCoverage.unknown}/${firstCoverage.total}), retrying once`);
    await sleep(site === "job51" ? 5000 : 1500);
    const retry = await this.searchOnePage(site, keyword, city, code, pageNumber, expectedTotal, plan);
    if (retry.blocked) {
      return {
        ...first,
        salaryNote: `本页薪资几乎全是「面议」，自动重搜时平台要求${retry.blocked === "verification" ? "人机验证" : "先登录"}；这里先展示重搜前的结果，处理好后可以再搜一次。`,
      };
    }
    const retryCoverage = salaryCoverage(retry.items);
    if (retryCoverage.known > firstCoverage.known) {
      this.log(`${site} "${keyword}" salary retry recovered ${retryCoverage.known}/${retryCoverage.total}`);
      return {
        ...retry,
        salaryNote: `第一次搜索的薪资几乎全是「面议」，已自动重搜，恢复了 ${retryCoverage.known} 个带薪资的岗位${retryCoverage.unknown ? `，另有 ${retryCoverage.unknown} 个仍为面议` : ""}。`,
      };
    }
    return {
      ...first,
      salaryNote: `本页 ${first.items.length} 个岗位里有 ${firstCoverage.unknown} 个薪资显示「面议」，可能是平台没把薪资带出来；已自动重搜一次仍未改善，建议重新搜索或换关键词。`,
    };
  }

  /** Boss 第 2 页起：在页面上下文里请求列表接口（与页面自己的翻页参数一致）。 */
  private async searchBossApiPage(keyword: string, city: string, code: string, pageNumber: number, expectedTotal = 0, scale = ""): Promise<SearchOneResult> {
    const site: JobSiteId = "boss";
    if (await this.driver.isClosed(site).catch(() => true)) {
      return { items: [], rawCount: 0, cards: 0, blocked: "", stop: true, note: CLOSED_WINDOW_NOTE };
    }
    const currentUrl = await this.driver.url(site).catch(() => "");
    if (!/(^|\.)zhipin\.com$/i.test(hostOf(currentUrl))) {
      return { items: [], rawCount: 0, cards: 0, blocked: "", stop: true, note: CLOSED_WINDOW_NOTE };
    }
    await this.driver.title(site, `${jobSiteLabel(site)} · 正在加载第 ${pageNumber} 页`).catch(() => undefined);
    this.log(`boss api page ${pageNumber} "${keyword}" city=${city || "全国"}`);
    const form = bossSearchForm({ keyword, cityCode: code, page: pageNumber, scale });
    const response = await this.driver.evaluate<{ ok: boolean; status: number; json: any; raw: string }>(site, bossApiFetchScript(form), 15_000).catch(() => undefined);
    if (!response) {
      return {
        items: [], rawCount: 0, cards: 0, blocked: "",
        note: `Boss 第 ${pageNumber} 页在预期时间内没有返回，可能是网络波动；稍后可以再点一次继续加载。`,
      };
    }
    const info = bossPageInfo(response.json);
    if (!response.ok || !response.json) {
      const failure = classifyBossPageFailure(info.code || response.status, info.message);
      const pageBlocked = failure.blocked ? "" : await this.driver.blocker(site).catch(() => "" as const);
      const blocked = failure.blocked
        || (pageBlocked === "verification" || (pageBlocked === "login" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl)) ? pageBlocked : "")
        || (response.status === 401 || response.status === 403 ? "login" : "");
      if (blocked) {
        this.log(`boss api page ${pageNumber} blocked=${blocked} status=${response.status}`);
        return { items: [], rawCount: 0, cards: 0, blocked };
      }
      this.log(`boss api page ${pageNumber} failed status=${response.status} ${text(info.message || response.raw, 120)}`);
      return {
        items: [], rawCount: 0, cards: 0, blocked: "", stop: true,
        note: `「${keyword}」第 ${pageNumber} 页：${failure.note || `Boss 列表接口返回 HTTP ${response.status}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`}`,
      };
    }
    if (info.code !== 0) {
      const failure = classifyBossPageFailure(info.code, info.message);
      const pageBlocked = failure.blocked ? "" : await this.driver.blocker(site).catch(() => "" as const);
      if (pageBlocked === "verification" || (pageBlocked === "login" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl))) {
        this.log(`boss api page ${pageNumber} code=${info.code} pageBlocked=${pageBlocked}`);
        return { items: [], rawCount: 0, cards: 0, blocked: pageBlocked };
      }
      this.log(`boss api page ${pageNumber} code=${info.code} message=${text(info.message, 120)} blocked=${failure.blocked || "-"} stop=${failure.stop}`);
      return {
        items: [], rawCount: 0, cards: 0,
        blocked: failure.blocked,
        stop: failure.stop,
        note: failure.note ? `「${keyword}」第 ${pageNumber} 页：${failure.note}` : "",
      };
    }
    const rawItems = bossJobListItems(response.json)
      .map((entry) => mapBossListItem(entry))
      .filter((entry): entry is RawSiteJob => Boolean(entry));
    if (!rawItems.length) {
      const loginState = await this.driver.loginState(site).catch(() => "" as const);
      const runtime = this.runtime(site);
      if (loginState === "out") runtime.loginState = "out";
      if (loginState === "out" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl)) {
        return { items: [], rawCount: 0, cards: 0, blocked: "login" };
      }
      return {
        items: [], rawCount: 0, cards: 0, blocked: "", hasMore: false, total: info.total,
        limitedByLogin: loginState === "out",
        note: loginState === "out"
          ? `Boss 第 ${pageNumber} 页起需要登录后才能继续加载；已加载的岗位都保留，登录后可以再点「继续加载」。`
          : expectedTotal > pageNumber * BOSS_PAGE_SIZE
            ? `Boss 显示还有更多岗位，但第 ${pageNumber} 页没有返回数据；可能是平台限制，建议在窗口里确认登录状态后再试。`
            : "",
      };
    }
    const jobs = dedupeSiteJobs(rawItems
      .map((entry) => mapRawSiteJob("boss", entry))
      .filter((entry): entry is AutoApplyJob => Boolean(entry)));
    return {
      items: !resolveCityCode("boss", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs,
      rawCount: rawItems.length,
      cards: rawItems.length,
      blocked: "",
      total: info.total,
    };
  }

  /** 前程无忧第 2 页起：在页面上下文里请求列表接口。 */
  private async searchJob51ApiPage(keyword: string, city: string, code: string, pageNumber: number, plan: SearchPlan): Promise<SearchOneResult> {
    const site: JobSiteId = "job51";
    if (await this.driver.isClosed(site).catch(() => true)) {
      return { items: [], rawCount: 0, cards: 0, blocked: "", stop: true, note: CLOSED_WINDOW_NOTE };
    }
    const currentUrl = await this.driver.url(site).catch(() => "");
    if (!/(^|\.)51job\.com$/i.test(hostOf(currentUrl))) {
      return {
        items: [], rawCount: 0, cards: 0, blocked: "", stop: true,
        note: `「${keyword}」第 ${pageNumber} 页：招聘窗口已经离开前程无忧搜索页，请回到岗位池重新搜索。`,
      };
    }
    await this.driver.title(site, `${jobSiteLabel(site)} · 正在加载第 ${pageNumber} 页`).catch(() => undefined);
    this.log(`job51 api page ${pageNumber} "${keyword}" city=${city || "全国"}`);
    const url = job51SearchApiUrl({
      keyword,
      areaCode: code,
      page: pageNumber,
      sortType: plan.sortType,
      requestId: this.runtime(site).job51RequestId,
      companySize: plan.scale,
    });
    const response = await this.driver.evaluate<{ status: number; ok: boolean; json: any; raw: string }>(site, job51ApiFetchScript(url), 15_000).catch(() => undefined);
    if (!response) {
      return {
        items: [], rawCount: 0, cards: 0, blocked: "",
        note: `「${keyword}」第 ${pageNumber} 页在预期时间内没有返回，可能是网络波动；稍后可以再点一次「继续加载」。`,
      };
    }
    const info = job51PageInfo(response.json);
    if (!response.ok || !response.json) {
      const pageBlocked = await this.driver.blocker(site).catch(() => "" as const);
      const blocked = pageBlocked || (response.status === 401 || response.status === 403 ? "login" : "");
      if (blocked) {
        this.log(`job51 api page ${pageNumber} blocked=${blocked} status=${response.status}`);
        return { items: [], rawCount: 0, cards: 0, blocked };
      }
      this.log(`job51 api page ${pageNumber} failed status=${response.status} ${text(response.raw, 120)}`);
      return {
        items: [], rawCount: 0, cards: 0, blocked: "", stop: true,
        note: `「${keyword}」第 ${pageNumber} 页：前程无忧列表接口返回 HTTP ${response.status}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`,
      };
    }
    if (info.status && info.status !== "1") {
      if (/登录|login/i.test(info.message)) {
        return { items: [], rawCount: 0, cards: 0, blocked: "login" };
      }
      return {
        items: [], rawCount: 0, cards: 0, blocked: "", stop: true,
        note: `「${keyword}」第 ${pageNumber} 页：前程无忧返回「${info.message || info.status}」，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`,
      };
    }
    const rawItems = job51SearchItems(response.json)
      .map((entry) => mapJob51ListItem(entry))
      .filter((entry): entry is RawSiteJob => Boolean(entry));
    const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob("job51", entry)).filter((entry): entry is AutoApplyJob => Boolean(entry)));
    const items = !resolveCityCode("job51", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs;
    return {
      items,
      rawCount: rawItems.length,
      cards: rawItems.length,
      blocked: "",
      total: info.total || undefined,
    };
  }

  /**
   * 智联新版搜索：翻页交给页面自己的 loadMoreJobList / fetchSearchList。
   * SSR 首屏的 hasMore 可能停在水合前的旧值，不能当成「没有下一页」；
   * 登录态下先用页面自己的 fetchSearchList 重算，只有列表真的不再增长才判定结束。
   */
  private async searchZhaopinPage(keyword: string, city: string, code: string, pageNumber: number, plan: SearchPlan): Promise<SearchOneResult> {
    const site: JobSiteId = "zhaopin";
    if (await this.driver.isClosed(site).catch(() => true)) {
      return { items: [], rawCount: 0, cards: 0, blocked: "", stop: true, note: CLOSED_WINDOW_NOTE };
    }
    const url = JOB_SITES.zhaopin.searchUrl(keyword, code, pageNumber, plan);
    await this.driver.title(site, `${jobSiteLabel(site)} · 正在搜索 ${keyword}`).catch(() => undefined);
    this.log(`search zhaopin "${keyword}" city=${city || "全国"} page=${pageNumber} variant=${plan.label || "-"}`);
    const currentUrl = await this.driver.url(site).catch(() => "");
    const sameQuery = (() => {
      try {
        const current = new URL(currentUrl);
        const target = new URL(url);
        return /(^|\.)zhaopin\.com$/i.test(current.hostname)
          && current.pathname.startsWith("/jobs")
          && current.searchParams.get("kw") === target.searchParams.get("kw")
          && (current.searchParams.get("jl") ?? "") === (target.searchParams.get("jl") ?? "")
          && (current.searchParams.get("order") ?? "") === (target.searchParams.get("order") ?? "")
          && (current.searchParams.get("sl") ?? "") === (target.searchParams.get("sl") ?? "")
          && (current.searchParams.get("cs") ?? "") === (target.searchParams.get("cs") ?? "");
      } catch {
        return false;
      }
    })();
    if (pageNumber <= 1 || !sameQuery) {
      await this.driver.goto(site, url, { attempts: 1 }).catch((error: any) => {
        this.log(`zhaopin search slow: ${text(error?.message ?? error, 120)}`);
      });
      const waited = await this.waitForResults("zhaopin", pageNumber > 1 ? 15_000 : RESULT_WAIT_MS);
      if (waited.blocked) return { items: [], rawCount: 0, cards: waited.cards, blocked: waited.blocked };
    }
    let state = zhaopinPageState(await this.driver.evaluate<unknown>(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
    const cookieLoggedIn = (await this.driver.tokenState(site).catch(() => "" as const)) === "in";
    const pageLoggedIn = state.loggedIn || cookieLoggedIn;
    const runtime = this.runtime(site);
    if (pageLoggedIn && (runtime.loginState !== "in" || runtime.blocked === "login")) {
      runtime.loginState = "in";
      runtime.blocked = "";
      runtime.lastCheckedAt = Date.now();
      runtime.message = `${jobSiteLabel(site)}已登录，浏览器窗口可以继续搜索或投递`;
    }
    // 地址栏里的 kw 不等于列表真的按它搜过：智联会沿用账号里的期望岗位或上一批推荐结果，
    // 标题全是 Java/销售，跟关键词毫无关系。发现搜索条件没生效就用页面自己的搜索框重新提交，
    // 走平台的登录、人机验证和风控，不做任何绕过。
    if (!zhaopinKeywordApplied(state, keyword)) {
      this.log(`zhaopin keyword mismatch want="${text(keyword, 40)}" got="${text(zhaopinEffectiveKeyword(state), 40)}" loaded=${state.loaded}`);
      const submitted = await this.driver.evaluate<{ ok?: boolean; reason?: string }>(site, zhaopinSubmitSearchScript(keyword), EVAL_TIMEOUT_MS).catch(() => undefined);
      if (submitted?.ok) {
        const waited = await this.waitForResults("zhaopin", RESULT_WAIT_MS);
        if (waited.blocked) return { items: [], rawCount: 0, cards: waited.cards, blocked: waited.blocked };
        const keywordDeadline = Date.now() + 12_000;
        while (Date.now() < keywordDeadline) {
          state = zhaopinPageState(await this.driver.evaluate<unknown>(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
          if (zhaopinKeywordApplied(state, keyword)) break;
          await sleep(600);
        }
      }
      this.log(`zhaopin keyword submit ok=${zhaopinKeywordApplied(state, keyword) ? 1 : 0} got="${text(zhaopinEffectiveKeyword(state), 40)}" loaded=${state.loaded}${submitted?.ok ? "" : ` reason=${text(submitted?.reason, 60) || "eval-error"}`}`);
    }
    let primed = false;
    if (pageLoggedIn && state.hasMore !== true && state.pageIndex <= 1) {
      const refreshed = await this.driver.evaluate<{ ok?: boolean; length?: number; reason?: string }>(site, zhaopinFetchSearchPageScript(1), 25_000).catch(() => undefined);
      primed = refreshed?.ok === true;
      this.log(`zhaopin prime hasMore ok=${primed ? 1 : 0} length=${refreshed?.length ?? 0} loaded=${state.loaded} count=${state.positionCount || "-"} page=${pageNumber}${refreshed?.reason ? ` reason=${text(refreshed.reason, 80)}` : ""}`);
      if (primed) {
        await sleep(600);
        state = zhaopinPageState(await this.driver.evaluate<unknown>(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
      }
    }
    const remainingPages = Math.max(0, pageNumber - state.pageIndex);
    const deadline = Date.now() + Math.min(180_000, 30_000 + remainingPages * 10_000);
    let grewAny = false;
    while (state.pageIndex < pageNumber && pageLoggedIn && Date.now() < deadline) {
      const previous = state.loaded;
      const dispatched = await this.driver.evaluate<{ ok: boolean; reason?: string }>(site, zhaopinLoadMoreScript(), 20_000).catch(() => undefined);
      let via = "loadMore";
      if (!dispatched?.ok) {
        if (dispatched?.reason === "loading") {
          state = await this.waitForZhaopinState(pageNumber, previous);
          continue;
        }
        const nextPage = Math.max(1, Math.min(pageNumber, state.pageIndex + 1));
        via = "fetch";
        const fetched = await this.driver.evaluate<{ ok?: boolean; length?: number; reason?: string }>(site, zhaopinFetchSearchPageScript(nextPage), 25_000).catch(() => undefined);
        if (!fetched?.ok) {
          this.log(`zhaopin paging stopped page=${nextPage} loadMore=${dispatched?.reason || "error"} fetch=${fetched?.reason || "empty"}`);
          break;
        }
      }
      state = await this.waitForZhaopinState(pageNumber, previous);
      if (state.loaded <= previous) {
        this.log(`zhaopin paging no growth page=${pageNumber} via=${via} loaded=${state.loaded} index=${state.pageIndex} hasMore=${state.hasMore ? 1 : 0}`);
        break;
      }
      grewAny = true;
    }
    const parsedItems = state.positions
      .map((entry) => mapZhaopinPosition(entry))
      .filter((entry): entry is RawSiteJob => Boolean(entry));
    // 智联是全文匹配，匿名时还会混入推荐岗位；岗位名/技能标签都对不上关键词的，
    // 不是用户要搜的方向，先滤掉，数量交给上层汇总成一条提示。
    const rawItems = parsedItems.filter((entry) => zhaopinKeywordRelevant(keyword, { title: entry.title, tags: entry.tags }));
    const keywordFiltered = parsedItems.length - rawItems.length;
    const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob("zhaopin", entry)).filter((entry): entry is AutoApplyJob => Boolean(entry)));
    const items = !resolveCityCode("zhaopin", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs;
    const reached = state.pageIndex >= pageNumber;
    const hasMore = reached && (state.hasMore === true || grewAny);
    this.log(`zhaopin state page=${pageNumber} loaded=${state.loaded} index=${state.pageIndex} size=${state.pageSize} count=${state.positionCount || "-"} hasMore=${state.hasMore ? 1 : 0} prime=${primed ? 1 : 0} grew=${grewAny ? 1 : 0} login=${pageLoggedIn ? 1 : 0}`);
    let note = "";
    const limitedByLogin = zhaopinLimitedByLogin({ ...state, loggedIn: pageLoggedIn });
    if (!reached && pageNumber > 1) {
      note = limitedByLogin
        ? `「${keyword}」第 ${pageNumber} 页：智联新版列表需要登录后才能继续加载；已加载的前 ${state.loaded} 个岗位都保留，登录后可以再点「继续加载」。`
        : hasMore
          ? `「${keyword}」第 ${pageNumber} 页：智联没有返回更多岗位，稍后可以再点「继续加载」。`
          : `「${keyword}」第 ${pageNumber} 页：平台没有更多岗位了。`;
    } else if (!pageLoggedIn && state.loaded) {
      note = zhaopinSliceNote({ keyword, loaded: state.loaded || state.pageSize, anonymous: true });
    }
    return {
      items,
      rawCount: parsedItems.length,
      cards: state.loaded,
      blocked: "",
      hasMore,
      limitedByLogin,
      keywordFiltered,
      note,
    };
  }

  private async waitForZhaopinState(pageNumber: number, previousLoaded: number) {
    const deadline = Date.now() + 15_000;
    let state = zhaopinPageState(await this.driver.evaluate<unknown>("zhaopin", zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
    while (Date.now() < deadline) {
      if (await this.driver.isClosed("zhaopin").catch(() => true)) return state;
      if (state.pageIndex >= pageNumber || state.loaded >= pageNumber * state.pageSize) return state;
      if (state.loaded > previousLoaded && !state.loadingMore) return state;
      if (!state.loadingMore && !state.hasMore) return state;
      await sleep(400);
      state = zhaopinPageState(await this.driver.evaluate<unknown>("zhaopin", zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
    }
    return state;
  }

  private async searchOnePage(site: JobSiteId, keyword: string, city: string, code: string, pageNumber: number, expectedTotal = 0, plan: SearchPlan): Promise<SearchOneResult> {
    if (site === "zhaopin") return this.searchZhaopinPage(keyword, city, code, pageNumber, plan);
    if (site === "boss" && pageNumber > 1) return this.searchBossApiPage(keyword, city, code, pageNumber, expectedTotal, plan.scale);
    if (site === "job51" && pageNumber > 1) return this.searchJob51ApiPage(keyword, city, code, pageNumber, plan);
    if (await this.driver.isClosed(site).catch(() => true)) {
      return { items: [], rawCount: 0, cards: 0, blocked: "", stop: true, note: CLOSED_WINDOW_NOTE };
    }
    const url = JOB_SITES[site].searchUrl(keyword, code, pageNumber, plan);
    await this.driver.title(site, `${jobSiteLabel(site)} · 正在搜索 ${keyword}`).catch(() => undefined);
    this.log(`search ${site} "${keyword}" city=${city || "全国"}`);
    let waited: ResultsProbe = { cards: 0, body: "", url: "", title: "", blocked: "" };
    let bossPayloads: any[] = [];
    let job51Payloads: any[] = [];
    if (site === "boss" || site === "job51") {
      // 旁路读取列表接口（不额外发请求）：Boss 拿未被字体混淆的薪资与在招状态；
      // 前程无忧拿岗位详情页地址——卡片里只有公司主页链接。
      if (site === "job51") this.runtime(site).job51RequestId = "";
      const token = await this.driver.captureStart(site, site === "boss"
        ? "/\\/wapi\\/zpgeek\\/search\\/joblist\\.json/i"
        : "/\\/api\\/job\\/search-pc/i").catch(() => "");
      try {
        await this.driver.goto(site, url, { attempts: 1 }).catch((error: any) => {
          this.log(`${site} search slow: ${text(error?.message ?? error, 120)}`);
        });
        waited = await this.waitForResults(site, pageNumber > 1 ? 15_000 : RESULT_WAIT_MS);
        await sleep(site === "job51" ? 5000 : 1000);
      } finally {
        const payloads = token ? await this.driver.captureStop(token, 2500).catch(() => []) : [];
        if (site === "boss") bossPayloads = payloads;
        else job51Payloads = payloads;
      }
    } else {
      await this.driver.goto(site, url, { attempts: 1 }).catch((error: any) => {
        this.log(`${site} search slow: ${text(error?.message ?? error, 120)}`);
      });
      waited = await this.waitForResults(site, pageNumber > 1 ? 15_000 : RESULT_WAIT_MS);
    }
    if (waited.blocked) return { items: [], rawCount: 0, cards: waited.cards, blocked: waited.blocked };
    if (site === "boss" && !waited.cards && await this.driver.hasLoginDialog(site).catch(() => false)) {
      this.log("boss search page shows a login dialog");
      return { items: [], rawCount: 0, cards: 0, blocked: "login" };
    }
    const apiItems = bossPayloads
      .flatMap((payload) => bossJobListItems(payload))
      .map((entry) => mapBossListItem(entry))
      .filter((entry): entry is RawSiteJob => Boolean(entry));
    const job51Items = job51Payloads.flatMap((payload) => job51SearchItems(payload));
    if (site === "job51") {
      const requestId = job51Payloads.map((payload) => job51PageInfo(payload).requestId).find(Boolean);
      if (requestId) this.runtime(site).job51RequestId = requestId;
    }
    let rawItems = apiItems.length ? apiItems : await (async () => {
      for (let round = 0; round < 2; round += 1) {
        await this.driver.evaluate(site, `(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()`, EVAL_TIMEOUT_MS).catch(() => undefined);
        await sleep(1200);
      }
      return await this.driver.evaluate<RawSiteJob[]>(site, extractionScript(site), EVAL_TIMEOUT_MS).catch(() => []) ?? [];
    })();
    if (site === "job51") {
      const hrefById = new Map<string, string>();
      for (const item of job51Items) {
        const id = job51JobIdOf(item?.jobId);
        const href = normalizeJob51DetailUrl(item?.jobHref);
        if (id && href) hrefById.set(id, href);
      }
      if (!rawItems.length && job51Items.length) {
        rawItems = job51Items
          .map((item) => mapJob51ListItem(item))
          .filter((entry): entry is RawSiteJob => Boolean(entry));
      } else if (hrefById.size) {
        rawItems = rawItems.map((entry) => {
          const id = job51JobIdOf(entry.jobId) || job51JobIdOf(entry.url);
          const href = id ? hrefById.get(id) ?? "" : "";
          return href ? { ...entry, url: href, jobId: id } : entry;
        });
      }
    }
    const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob(site, entry)).filter((entry): entry is AutoApplyJob => Boolean(entry)));
    const bossTotal = site === "boss" && apiItems.length
      ? Math.max(0, ...bossPayloads.map((payload) => bossPageInfo(payload).total))
      : 0;
    return {
      items: !resolveCityCode(site, city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs,
      rawCount: rawItems.length,
      cards: waited.cards,
      blocked: "",
      total: bossTotal || undefined,
    };
  }

  async search(raw: JobSiteQuery): Promise<JobSiteSearchResult> {
    if (!JOB_SITE_IDS.includes(raw?.site)) throw new Error("不支持的招聘平台");
    const site = raw.site;
    const baseKeywords = normalizeKeywords(raw);
    if (!baseKeywords.length) throw new Error("请输入搜索关键词，例如：前端 / Java / 产品经理");
    const round = Math.max(0, Math.round(Number(raw.round) || 0));
    const plan = resolveSearchPlan(site, round, Number(raw.salaryMin) || 0, Number(raw.salaryMax) || 0);
    const keywords = raw.extend ? expandSearchKeywords(baseKeywords, raw.skills ?? [], round) : baseKeywords;
    const city = normalizeCityName(raw.city);
    const baseRange = sitePageRange(raw.page, raw.pages);
    // Boss 列表接口没有排序参数：关键词池轮完一圈后，把同一批关键词往更深的页翻。
    const deepRange = raw.extend && site === "boss" && round > 0 && baseRange.start === 1
      ? deepPageWindow(round, baseRange.count, keywordCycleLength(baseKeywords, raw.skills ?? []))
      : null;
    const range = deepRange
      ? { start: deepRange.start, end: deepRange.end, count: deepRange.end - deepRange.start + 1 }
      : baseRange;
    const { code, mapped } = resolveCityCode(site, city);
    const runtime = this.runtime(site);
    if (await this.driver.isClosed(site).catch(() => true)) await this.driver.open(site).catch(() => undefined);
    else await this.driver.reveal(site, "visible").catch(() => undefined);
    // 用户在公司规模下拉里的选择：只有 fixed 才带规模参数，默认 / none 完全不带。
    // 继续加载必须沿用上一页实际用的规模，否则第 2 页会换回另一批公司。
    let scale = "";
    const requestedScale = siteScaleLabel(site, text(raw.scale, 12)) ? text(raw.scale, 12) : "";
    const scaleContinuation = range.start > 1 && raw.extend !== true;
    if (scaleContinuation) {
      scale = requestedScale;
      if (scale) {
        plan.scale = scale;
        plan.label = [plan.label, `公司规模 ${siteScaleLabel(site, scale)}`].filter(Boolean).join(" · ");
      }
    } else if (raw.scaleMode === "fixed" && requestedScale) {
      scale = requestedScale;
      plan.scale = scale;
      plan.label = [plan.label, `公司规模 ${siteScaleLabel(site, scale)}`].filter(Boolean).join(" · ");
    }
    // 排序：用户显式选择（fixed / default）优先于按轮次轮换；继续加载回传的
    // order / sortType / salary 也按显式参数处理，保证翻页仍用同一套排序。
    let sortMode: "auto" | "default" | "fixed" = "auto";
    if (site !== "boss") {
      if (raw.sortMode === "default") {
        sortMode = "default";
        plan.order = undefined;
        plan.sortType = undefined;
        plan.salary = undefined;
        plan.label = "平台默认排序";
      } else {
        const order = site === "zhaopin" && typeof raw.order === "number" && Number.isFinite(raw.order)
          ? Math.round(raw.order)
          : undefined;
        const sortType = site === "job51" && typeof raw.sortType === "number" && Number.isFinite(raw.sortType)
          ? Math.round(raw.sortType)
          : undefined;
        if (order !== undefined || sortType !== undefined) {
          sortMode = "fixed";
          plan.order = order;
          plan.sortType = sortType;
          plan.salary = text(raw.salary, 32) || undefined;
          plan.label = [
            site === "zhaopin" ? zhaopinOrderLabel(order) : job51SortLabel(sortType),
            salaryRangeText(plan.salary),
          ].filter(Boolean).join(" · ");
        }
      }
    }
    const variant = plan.label || (raw.extend ? "扩展关键词" : "");
    const collected: AutoApplyJob[] = [];
    const keywordCounts: JobSiteSearchResult["keywordCounts"] = [];
    const salaryNotes: string[] = [];
    const pagingNotes: string[] = [];
    const keywordTotals = new Map<string, number>();
    let blocked: "login" | "verification" | "" = "";
    let rawTotal = 0;
    let cards = 0;
    let fetchCount = 0;
    let lastPageLoaded = 0;
    let exhaustedKeywords = 0;
    let stopPaging = false;
    let stopPage = 0;
    let budgetStop = false;
    let keywordFilteredTotal = 0;
    const deepBudgetMs = raw.extend ? DEEP_SEARCH_BUDGET_MS : 0;
    const deepStartedAt = Date.now();
    const overBudget = () => deepBudgetMs > 0 && Date.now() - deepStartedAt >= deepBudgetMs;
    const budgetNote = `本次深挖已到 ${Math.round(DEEP_SEARCH_BUDGET_MS / 1000)} 秒上限，先返回已加载的岗位；再点一次「深挖一批」会换下一批关键词继续。`;
    for (const [index, keyword] of keywords.entries()) {
      if (index > 0 && overBudget()) {
        budgetStop = true;
        pagingNotes.push(budgetNote);
        break;
      }
      let keywordTotal = 0;
      let keywordBlocked = false;
      let keywordExhausted = false;
      let keywordLimitedByLogin = false;
      const seenPageSignatures = new Set<string>();
      for (let page = range.start; page <= range.end; page += 1) {
        if (page > range.start && overBudget()) {
          budgetStop = true;
          pagingNotes.push(budgetNote);
          break;
        }
        const one = await this.searchOne(site, keyword, city, code, page, keywordTotals.get(keyword) ?? 0, plan);
        fetchCount += 1;
        rawTotal += one.rawCount;
        cards += one.cards;
        if (one.keywordFiltered) keywordFilteredTotal += one.keywordFiltered;
        if (one.note) pagingNotes.push(one.note);
        if (one.total) keywordTotals.set(keyword, Math.max(keywordTotals.get(keyword) ?? 0, one.total));
        if (one.blocked) {
          blocked = one.blocked;
          keywordBlocked = true;
          break;
        }
        if (one.stop) {
          stopPaging = true;
          stopPage = page;
          break;
        }
        if (one.salaryNote) salaryNotes.push(one.salaryNote);
        const pageSignature = one.items.map((job) => job.sourceUrl || job.id).sort().join("\n");
        if (pageSignature && seenPageSignatures.has(pageSignature)) {
          keywordExhausted = true;
          pagingNotes.push(`「${keyword}」从第 ${page} 页起重复返回已加载过的岗位，已自动停止翻页；可以换关键词或城市继续搜。`);
          break;
        }
        if (pageSignature) seenPageSignatures.add(pageSignature);
        collected.push(...one.items);
        keywordTotal += one.items.length;
        if (one.items.length || one.rawCount) lastPageLoaded = Math.max(lastPageLoaded, page);
        if (!one.items.length && !one.rawCount) {
          keywordExhausted = true;
          keywordLimitedByLogin = one.limitedByLogin === true;
          break;
        }
        if (one.hasMore === false) {
          keywordExhausted = true;
          keywordLimitedByLogin = one.limitedByLogin === true;
          break;
        }
        const total = keywordTotals.get(keyword) ?? 0;
        if (total > 0 && total <= page * BOSS_PAGE_SIZE) {
          keywordExhausted = true;
          break;
        }
        if (page < range.end) await sleep(site === "boss" ? BOSS_PAGE_PAUSE_MS : site === "job51" ? 6_000 : 1_800);
      }
      if (keywordExhausted && !keywordLimitedByLogin) exhaustedKeywords += 1;
      keywordCounts.push({ keyword, total: keywordTotal });
      if (keywordBlocked || stopPaging || budgetStop) break;
      if (index < keywords.length - 1) await sleep(site === "job51" ? 6000 : 1800);
    }
    const exhaustedAll = !blocked && !stopPaging && !budgetStop && keywords.length > 0 && exhaustedKeywords === keywords.length;
    const pageLoaded = exhaustedAll
      ? range.end
      : budgetStop
        ? Math.max(range.start, lastPageLoaded)
        : stopPaging
          ? Math.max(0, stopPage - 1)
          : lastPageLoaded || range.start;
    if (keywordFilteredTotal > 0) {
      pagingNotes.push(`智联按全文匹配返回的岗位里有 ${keywordFilteredTotal} 个岗位名和技能标签都不含搜索词，已过滤；想放宽时可以换更宽的关键词再搜。`);
    }
    const deduped = dedupeSiteJobsDetailed(collected);
    const jobs = deduped.items;
    if (exhaustedAll) {
      // 智联是按条件分片返回的：这个分片翻到底，不代表深圳 Java 岗位只有这么多。
      if (site === "zhaopin") {
        pagingNotes.push(zhaopinSliceNote({ keyword: baseKeywords.join(" / "), variant, city, loaded: jobs.length }));
      } else if (pageLoaded > lastPageLoaded) {
        pagingNotes.push(`第 ${Math.max(range.start, lastPageLoaded + 1)} 页起没有更多岗位了，可以换个关键词或城市继续搜。`);
      }
    }
    const filteredJobs = !mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs;
    const cityKeys = new Set(filteredJobs.map((job) => job.sourceUrl || `${job.company}|${job.title}`));
    const duplicateCount = Math.max(0, rawTotal - jobs.length);
    const cityCount = Math.max(0, jobs.length - filteredJobs.length);
    const salaryNote = [...new Set(salaryNotes)].join(" ") || undefined;
    const duplicateItems = deduped.duplicates.map((job) => ({
      job,
      reason: "与前面岗位重复（多个关键词搜到同一岗位）",
      category: "duplicate" as const,
    }));
    const cityItems = city && !mapped
      ? jobs.filter((job) => !cityKeys.has(job.sourceUrl || `${job.company}|${job.title}`)).map((job) => ({
        job,
        reason: `城市不匹配（搜索城市：${city}）`,
        category: "city" as const,
      }))
      : [];
    const filteredItems = [...duplicateItems, ...cityItems].slice(0, 80);
    const pagingNote = [...new Set(pagingNotes)].join(" ") || undefined;
    const keptItems = filteredJobs;
    const keptNote = keptItems.length ? `（已保留本次加载的 ${keptItems.length} 个岗位）` : "";
    const blockedDetail = { duplicate: duplicateCount, city: cityCount, safety: 0, outsource: 0, salary: 0, score: 0 };
    if (blocked === "verification") {
      runtime.blocked = "verification";
      runtime.lastCheckedAt = Date.now();
      runtime.message = `${jobSiteLabel(site)}要求人机验证，请在打开的浏览器窗口里完成验证，然后回到这里重新搜索${keptNote}`;
      return { site, items: keptItems, total: keptItems.length, message: runtime.message, blocked, pagesScanned: fetchCount, filtered: Math.max(0, rawTotal - filteredJobs.length), filteredDetail: blockedDetail, filteredItems, page: pageLoaded, city, searchedAt: Date.now(), keywords, keywordCounts, salaryNote, pagingNote, round, variant, scale: scale || undefined, sortMode, order: plan.order, sortType: plan.sortType, salary: plan.salary };
    }
    if (blocked === "login") {
      runtime.blocked = "login";
      runtime.lastCheckedAt = Date.now();
      runtime.message = `${jobSiteLabel(site)}需要先登录，请在打开的浏览器窗口里完成登录，然后回到这里重新搜索${keptNote}`;
      return { site, items: keptItems, total: keptItems.length, message: runtime.message, blocked, pagesScanned: fetchCount, filtered: Math.max(0, rawTotal - filteredJobs.length), filteredDetail: blockedDetail, filteredItems, page: pageLoaded, city, searchedAt: Date.now(), keywords, keywordCounts, salaryNote, pagingNote, round, variant, scale: scale || undefined, sortMode, order: plan.order, sortType: plan.sortType, salary: plan.salary };
    }
    runtime.blocked = "";
    runtime.lastSearchAt = Date.now();
    runtime.lastCheckedAt = Date.now();
    const countText = keywordCounts.length > 1
      ? keywordCounts.map((entry) => `${entry.keyword} ${entry.total}`).join(" · ")
      : "";
    runtime.message = filteredJobs.length
      ? `${jobSiteLabel(site)}返回 ${filteredJobs.length} 个岗位${stopPaging ? "（平台暂时限制了继续翻页）" : ""}`
      : pagingNotes[pagingNotes.length - 1]
        || `没有在${jobSiteLabel(site)}解析到岗位。如果页面正常但列表为空，请尝试更换关键词，或在该窗口中登录后再搜索`;
    this.log(`${site} keywords=${keywords.length} round=${round} extend=${raw.extend ? 1 : 0} skills=${(raw.skills ?? []).length} variant=${variant || "-"} scale=${scale || "-"} pages=${range.start}-${pageLoaded} cards=${cards} parsed=${rawTotal} kept=${filteredJobs.length}${stopPaging ? " stopped-by-rate-limit" : ""}`);
    return {
      site,
      items: filteredJobs,
      total: filteredJobs.length,
      message: filteredJobs.length
        ? `${jobSiteLabel(site)}搜索到 ${filteredJobs.length} 个岗位${keywordCounts.length > 1 ? `（${countText}）` : ""}${!mapped && city ? `，已按「${city}」筛选` : ""}`
        : runtime.message,
      blocked: "",
      pagesScanned: fetchCount,
      filtered: Math.max(0, rawTotal - filteredJobs.length),
      filteredDetail: { duplicate: duplicateCount, city: cityCount, safety: 0, outsource: 0, salary: 0, score: 0 },
      filteredItems,
      page: pageLoaded,
      city,
      searchedAt: Date.now(),
      keywords,
      keywordCounts,
      salaryNote,
      pagingNote,
      exhausted: exhaustedAll || undefined,
      round,
      variant,
      scale: scale || undefined,
      sortMode,
      order: plan.order,
      sortType: plan.sortType,
      salary: plan.salary,
    };
  }

  /** 单岗核实：另开隐藏窗口读详情页（不打扰用户的搜索窗口），接口旁路补全薪资/在招状态。 */
  async enrich(job: AutoApplyJob): Promise<Partial<AutoApplyJob> | null> {
    if (!JOB_SITE_IDS.includes(job.source as JobSiteId)) return null;
    if (!job.sourceUrl || !isHttpUrl(job.sourceUrl)) return null;
    const site = job.source as JobSiteId;
    const token = site === "boss"
      ? await this.driver.captureStart(site, "/\\/wapi\\/zpgeek\\/job\\/detail\\.json/i", "aux").catch(() => "")
      : "";
    try {
      await this.driver.openAux(site);
      await this.driver.goto(site, job.sourceUrl, { tab: "aux", attempts: 1 }).catch((error: any) => {
        this.log(`${site} enrich slow: ${text(error?.message ?? error, 120)}`);
      });
      await sleep(800);
      if (await this.driver.blocker(site).catch(() => "" as const)) return null;
      const postedText = extractPostedText(await this.driver.evaluate<string>(site, postedScript(), EVAL_TIMEOUT_MS, "aux").catch(() => "") ?? "");
      const posted = parsePostedAt(postedText);
      if (token) {
        const payloads = await this.driver.captureStop(token, 5000).catch(() => []);
        const details = payloads.map((payload) => mapBossDetail(payload)).filter((entry) => entry !== null);
        const detail = details.find((entry) => entry.description) ?? details[0];
        if (detail) {
          let description = detail.description;
          let domRecruiter = "";
          let domActive = "";
          if (!description) {
            const dom = await this.driver.evaluate<{ text: string; recruiter: string; active: string }>(site, detailScript(site), EVAL_TIMEOUT_MS, "aux").catch(() => null);
            if (dom?.text && dom.text.length >= 30) description = dom.text;
            domRecruiter = dom?.recruiter ?? "";
            domActive = dom?.active ?? "";
          }
          return {
            description: description || job.description,
            postedAt: posted.at ?? job.postedAt ?? null,
            postedLabel: posted.at ? posted.label : job.postedLabel ?? "",
            postedDays: posted.at ? postedDaysOf(posted.at) : job.postedDays ?? null,
            recruiter: detail.recruiter || domRecruiter || job.recruiter,
            recruiterTitle: detail.recruiterTitle || job.recruiterTitle || "",
            recruiterActive: detail.recruiterActive || domActive || job.recruiterActive,
            company: detail.company || job.company,
            companyIndustry: detail.companyIndustry || job.companyIndustry,
            companyStage: detail.companyStage || job.companyStage || "",
            companyScale: detail.companyScale || job.companyScale || "",
            city: detail.city || job.city,
            salaryLabel: detail.salaryLabel || job.salaryLabel,
            salaryMin: detail.salaryMin ?? job.salaryMin ?? null,
            salaryMax: detail.salaryMax ?? job.salaryMax ?? null,
            salaryUnit: detail.salaryUnit || job.salaryUnit,
            jobStatus: detail.jobStatus || job.jobStatus || "",
            jobStatusText: detail.jobStatusText || job.jobStatusText || "",
            jobId: detail.jobId || job.jobId || "",
            companyAnonymous: detail.company ? false : job.companyAnonymous === true,
          } satisfies Partial<AutoApplyJob>;
        }
      }
      const detail = await this.driver.evaluate<{ text: string; recruiter: string; active: string }>(site, detailScript(site), EVAL_TIMEOUT_MS, "aux").catch(() => null);
      if (!detail?.text || detail.text.length < 30) return null;
      return {
        description: detail.text,
        postedAt: posted.at ?? job.postedAt ?? null,
        postedLabel: posted.at ? posted.label : job.postedLabel ?? "",
        postedDays: posted.at ? postedDaysOf(posted.at) : job.postedDays ?? null,
        recruiter: detail.recruiter || job.recruiter,
        recruiterActive: detail.active || job.recruiterActive,
      };
    } catch (error: any) {
      this.log(`${site} enrich failed: ${text(error?.message ?? error, 160)}`);
      return null;
    } finally {
      if (token) await this.driver.captureStop(token, 0).catch(() => []);
      await this.driver.closeAux(site).catch(() => undefined);
    }
  }
}

