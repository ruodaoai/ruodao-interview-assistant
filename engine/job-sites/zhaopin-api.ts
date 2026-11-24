import type { RawSiteJob } from "./types";

/**
 * 智联招聘新版列表（/jobs/）旁路数据。
 *
 * 智联在 2026-11 改版：旧地址 `/sou/jl<code>/p<n>?kw=` 会重定向到
 * `/jobs/?jl=<code>&kw=<keyword>`，旧的 `.joblist-box__item` / `.jobinfo__*` 全部消失。
 * 新版卡片是 `.job-card`，薪资 DOM 仍是 `**-**元` 掩码，岗位链接也不在 DOM 里——
 * 标题、明文薪资、详情页地址、HR 信息都只在页面自己的 Vuex store（positionList）里。
 *
 * 这里只读取页面已经加载的数据，不额外请求接口，也不绕过登录或风控。
 * 未登录时页面自己的 loadMoreJobList 会被 canLoadMoreJobList 拦住，每个关键词只给前 20 条，
 * 这里如实反映 hasMore=false，由上层提示用户登录后再继续加载。
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

/** 智联职位号形如 CC258672210J40854377816（companyNumber + J + jobId）。 */
export function zhaopinJobIdOf(value: unknown): string {
  const raw = text(value, 300);
  if (/^[A-Za-z0-9]{8,40}$/.test(raw)) return raw;
  return raw.match(/\/jobdetail\/([A-Za-z0-9]{6,40})\.htm/i)?.[1] ?? "";
}

/** 只认 www.zhaopin.com/jobdetail/<number>.htm；公司主页、列表页都不算详情页。 */
export function normalizeZhaopinDetailUrl(value: unknown): string {
  const raw = text(value, 500);
  const matched = raw.match(/^https?:\/\/(?:[\w-]+\.)*zhaopin\.com\/jobdetail\/([A-Za-z0-9]{6,40})\.htm/i);
  return matched ? `https://www.zhaopin.com/jobdetail/${matched[1]}.htm` : "";
}

export function zhaopinDetailUrl(value: unknown, jobId?: unknown): string {
  const normalized = normalizeZhaopinDetailUrl(value);
  if (normalized) return normalized;
  const id = zhaopinJobIdOf(jobId) || zhaopinJobIdOf(value);
  return id ? `https://www.zhaopin.com/jobdetail/${id}.htm` : "";
}

/** 页面脚本从 Vuex positionList 里挑出的精简岗位（只保留列表/投递需要的字段）。 */
export type ZhaopinPositionBrief = {
  number: string;
  name: string;
  url: string;
  salary: string;
  city: string;
  education: string;
  experience: string;
  company: string;
  industry: string;
  scale: string;
  stage: string;
  recruiter: string;
  recruiterTitle: string;
  recruiterActive: string;
  online: boolean;
  skills: string[];
  labels: string[];
  welfare: string[];
  publishText: string;
  publishTime: string;
  description: string;
  proxy: boolean;
};

export type ZhaopinPageState = {
  positions: ZhaopinPositionBrief[];
  loaded: number;
  pageIndex: number;
  pageSize: number;
  hasMore: boolean;
  loadingMore: boolean;
  positionCount: number;
  loggedIn: boolean;
  url: string;
  /** 页面当前生效的搜索词：queryParams.kw 是请求参数，searchKeyword 是实际提交给搜索引擎的条件。 */
  queryKeyword: string;
  searchKeyword: string;
  pageMode: string;
};

export function mapZhaopinPosition(position: ZhaopinPositionBrief): RawSiteJob | null {
  if (!position || typeof position !== "object") return null;
  const title = text(position.name, 160);
  const url = zhaopinDetailUrl(position.url, position.number);
  if (!title || !url) return null;
  const tags = [...new Set([
    ...asList(position.labels).map((entry) => text(entry, 40)),
    ...asList(position.skills).map((entry) => text(entry, 40)),
    ...asList(position.welfare).map((entry) => text(entry, 40)),
    text(position.education, 40),
    text(position.experience, 40),
  ].filter(Boolean))].slice(0, 16);
  const industry = text(position.industry, 80);
  const scale = text(position.scale, 40);
  const stage = text(position.stage, 40);
  const description = text(position.description, 1500);
  return {
    title,
    company: text(position.company, 120),
    city: text(position.city, 60),
    salary: firstText(position.salary),
    url,
    tags,
    recruiter: text(position.recruiter, 60),
    recruiterActive: text(position.recruiterActive, 40) || (position.online ? "当前在线" : ""),
    recruiterTitle: text(position.recruiterTitle, 60),
    companyIndustry: industry,
    companyScale: scale,
    companyStage: stage,
    jobId: zhaopinJobIdOf(position.number) || zhaopinJobIdOf(url),
    // 列表只会展示在招岗位，没有单独的「已关闭」标记；不拿它去猜别的状态。
    jobStatus: "open",
    jobStatusText: "平台在招列表",
    proxy: position.proxy === true,
    postedText: firstText(position.publishText, position.publishTime),
    extra: [industry, scale, stage, description].filter(Boolean).join(" ").slice(0, 600),
  };
}

export function zhaopinPageState(payload: any): ZhaopinPageState {
  const source = payload && typeof payload === "object" ? payload : {};
  const positions = asList(source.positions)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => entry as ZhaopinPositionBrief);
  return {
    positions,
    loaded: Math.max(0, Math.round(Number(source.loaded) || 0)) || positions.length,
    pageIndex: Math.max(0, Math.round(Number(source.pageIndex) || 0)),
    pageSize: Math.max(1, Math.round(Number(source.pageSize) || 20)),
    hasMore: source.hasMore === true,
    loadingMore: source.loadingMore === true,
    positionCount: Math.max(0, Math.round(Number(source.positionCount) || 0)),
    loggedIn: source.loggedIn === true,
    url: text(source.url, 500),
    queryKeyword: text(source.queryKeyword, 80),
    searchKeyword: text(source.searchKeyword, 80),
    pageMode: text(source.pageMode, 20),
  };
}

/**
 * 未登录时智联把每个关键词截在前 20 条（store.hasMore=false）。
 * 这不是关键词真的没有岗位：登录后还能从下一页继续，分页游标不能推到本批末尾。
 */
export function zhaopinLimitedByLogin(state: Pick<ZhaopinPageState, "loggedIn" | "loaded" | "hasMore">) {
  return !state.loggedIn && state.loaded > 0 && state.hasMore !== true;
}

/**
 * 智联分页结束 / 未登录截断时的说明。
 *
 * 智联把岗位按「关键词 + 排序 + 薪资区间 + 公司规模」拆成多个分片返回：
 * 一个分片翻到底只有一两百个岗位，不代表该城市该关键词没有更多岗位。
 * 不解释清楚，用户会以为「智联只有这么多岗位」，反复搜同一个词只能拿回同一批。
 */
export function zhaopinSliceNote(input: {
  keyword: string;
  variant?: string;
  city?: string;
  loaded: number;
  anonymous?: boolean;
}): string {
  const loaded = Math.max(0, Math.round(Number(input.loaded) || 0));
  if (input.anonymous) {
    return `智联未登录时每个关键词只展示前 ${Math.max(1, loaded)} 个岗位（平台限制，不是全部在招岗位）；登录智联后可以继续加载，勾选「深挖更多岗位」还能换关键词、排序、薪资区间和公司规模各取一批。`;
  }
  const keyword = text(input.keyword, 60);
  const city = text(input.city, 40);
  const variant = text(input.variant, 80);
  const scope = [variant, city ? `城市 ${city}` : ""].filter(Boolean).join(" · ");
  const target = [city, keyword].filter(Boolean).join(" / ");
  return `智联按「关键词 + 排序 + 薪资区间 + 公司规模」分片返回岗位：本批${scope ? `「${scope}」` : ""}已经翻到平台末尾（本批去重后 ${loaded} 个岗位）。这不是${target ? `「${target}」` : "该关键词"}的全部在招岗位；勾选「深挖更多岗位」再搜一批会自动换关键词、排序、薪资区间和公司规模，继续挖其他分片。`;
}

/** 页面当前生效的搜索词（小写）：优先取搜索引擎条件，其次取 queryParams.kw。 */
export function zhaopinEffectiveKeyword(state: Pick<ZhaopinPageState, "searchKeyword" | "queryKeyword">): string {
  const applied = text(state.searchKeyword, 80);
  return (applied || text(state.queryKeyword, 80)).toLowerCase();
}

function compactKeyword(value: unknown) {
  return String(value ?? "").replace(/[\s·・]+/g, "").toLowerCase();
}

function containsKeyword(haystack: string, needle: string) {
  if (!needle) return false;
  if (/^[a-z0-9+#.]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
  }
  return haystack.includes(needle);
}

/**
 * 列表是否真的按这个关键词搜过。
 *
 * 地址栏 kw 只是请求参数：用户改了搜索框但没点搜索、或页面沿用了账号里的期望岗位，
 * 列表会停在上一批结果，和地址栏完全对不上。这里只做口径判断，不绕过平台登录。
 */
export function zhaopinKeywordApplied(state: Pick<ZhaopinPageState, "searchKeyword" | "queryKeyword">, keyword: string): boolean {
  const requested = compactKeyword(keyword);
  if (!requested) return true;
  const effective = compactKeyword(zhaopinEffectiveKeyword(state));
  if (!effective) return false;
  return effective === requested || containsKeyword(requested, effective) || containsKeyword(effective, requested);
}

/** 岗位名里的职级/岗位后缀，去掉后才是核心技能词：「区块链开发」→「区块链」。 */
const KEYWORD_SUFFIX = /(?:开发工程师|开发|工程师|架构师|经理|主管|专员|总监|顾问|岗位|方向|应用|专家|助理|实习)$/;

function keywordTerms(keyword: string): string[] {
  const raw = String(keyword ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const terms = new Set<string>();
  const push = (value: string) => {
    const term = value.trim().toLowerCase();
    if (term.length >= 2) terms.add(term);
  };
  push(raw);
  const compact = raw.replace(/[\s·・]+/g, "");
  push(compact);
  for (const token of raw.match(/[a-z][a-z0-9+#.]{1,}/gi) ?? []) push(token);
  // 「区块链开发」「Java 开发工程师」去掉岗位后缀后再补一个核心词，
  // 岗位名写成「区块链工程师」「Java 后端」时也要能命中。
  push(compact.replace(KEYWORD_SUFFIX, ""));
  return [...terms];
}

function keywordHit(haystack: string, term: string) {
  if (!term) return false;
  if (/^[a-z0-9+#.]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
  }
  return haystack.includes(term);
}

/**
 * 智联搜索是全文匹配：JD / 公司介绍里出现过关键词的岗位都会返回，匿名时还会混入推荐岗位。
 * 用户搜「区块链开发」要的是区块链岗位，不是 JD 里偶然提到一次的其他岗位，
 * 所以只在岗位名和技能标签里核对关键词；命不中的由上层过滤并提示。
 */
export function zhaopinKeywordRelevant(keyword: string, job: { title?: unknown; tags?: unknown }): boolean {
  const terms = keywordTerms(keyword);
  if (!terms.length) return true;
  const title = String(job?.title ?? "").toLowerCase();
  const tags = asList(job?.tags).map((tag) => String(tag ?? "")).join(" ").toLowerCase();
  return terms.some((term) => keywordHit(title, term) || keywordHit(tags, term));
}

/**
 * 用页面自己的搜索框提交关键词。
 *
 * 只填输入框不会触发搜索：智联把关键词放在 Vue 的 queryParams 里，
 * 必须走页面自己的搜索按钮（它内部会校验登录、人机验证和风控）。
 */
export function zhaopinSubmitSearchScript(keyword: string) {
  return `(() => {
    const value = ${JSON.stringify(String(keyword ?? "").trim().slice(0, 60))};
    if (!value) return { ok: false, reason: "empty-keyword" };
    const input = document.querySelector("input.query-sug__input")
      || [...document.querySelectorAll("input")].find((element) => /搜索职位|搜索公司/.test(element.placeholder || ""));
    if (!input) return { ok: false, reason: "input-missing" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const button = document.querySelector("button.query-sug__button")
      || [...document.querySelectorAll("button")].find((element) => /^搜索$/.test(String(element.innerText || "").trim()));
    if (!button) return { ok: false, reason: "button-missing" };
    button.click();
    return { ok: true };
  })()`;
}

/**
 * 在页面上下文里读新版列表状态。
 *
 * store 不存在时退回卡片上的 `__vue__.$props.job`（同一个数据源），
 * 保证页面脚本版本变化时至少还能拿到第 1 页。
 */
export function zhaopinPageStateScript(pageNumber: number) {
  return `(() => {
    const requested = Math.max(1, Math.round(Number(${JSON.stringify(pageNumber)}) || 1));
    const clean = (value, max = 400) => String(value ?? "").replace(/\\u0000/g, "").replace(/\\s+/g, " ").trim().slice(0, max);
    const asList = (value) => Array.isArray(value) ? value : [];
    const tagList = (value, max = 40) => asList(value).map((entry) => clean(
      entry && typeof entry === "object" ? (entry.name || entry.label || entry.tagName || "") : entry,
      max,
    )).filter(Boolean);
    const firstText = (...values) => {
      for (const value of values) {
        const result = clean(value, 400);
        if (result) return result;
      }
      return "";
    };
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    const state = (store && store.state) || window.__INITIAL_STATE__ || {};
    const cards = [...document.querySelectorAll(".job-card")];
    const cardJobs = cards
      .map((card) => card && card.__vue__ && card.__vue__.$props && card.__vue__.$props.job)
      .filter(Boolean);
    const source = asList(state.positionList).length ? asList(state.positionList) : cardJobs;
    const pageSize = Math.max(1, Number(state.pageSize) || 20);
    const start = (requested - 1) * pageSize;
    const pick = (position) => {
      const detail = position && position.jobDetailData && position.jobDetailData.position || {};
      const desc = detail.desc || {};
      const staff = position && position.staffCard || {};
      const date = detail.date || {};
      return {
        number: clean(position && position.number, 80),
        name: clean(position && position.name, 160),
        url: firstText(position && position.positionURL, position && position.positionUrl),
        salary: firstText(position && position.salary60, position && position.salaryReal, detail && detail.base && detail.base.salary),
        city: [
          clean(position && position.workCity, 40),
          clean(position && position.cityDistrict, 40),
          clean(position && position.tradingArea, 40),
        ].filter(Boolean).join("·"),
        education: clean(position && position.education, 40),
        experience: clean(position && position.workingExp, 40),
        company: clean(position && position.companyName, 120),
        industry: clean(position && position.industryName, 80),
        scale: clean(position && position.companySize, 40),
        stage: clean(position && position.financingStage, 40),
        recruiter: clean(staff.staffName, 60),
        recruiterTitle: clean(staff.hrJob, 60),
        recruiterActive: firstText(staff.hrStateInfo, staff.lastOnlineTimeText),
        online: Number(staff.hrOnlineIocState) === 1,
        skills: tagList(asList(position && position.jobSkillTags).map((skill) => skill && skill.name || skill)),
        labels: tagList(desc.labels),
        welfare: [...tagList(position && position.welfareLabel), ...tagList(desc.welfareLabel), ...tagList(desc.welfareTags)],
        publishText: clean(date.positionUpdateTimeText, 40),
        publishTime: firstText(position && position.publishTime, date.positionPublishTime, date.positionUpdateTime),
        description: clean(firstText(desc.description, position && position.jobDescription), 1500),
        proxy: Boolean(position && (position.rpoProxy === true || position.rpoProxied === true)),
      };
    };
    const user = state.user || {};
    const cookies = state.cookiesData || {};
    // 真正决定列表内容的搜索条件在 statBaseData.search_condition 里（JSON 字符串，
    // S_SOU_FULL_INDEX 就是提交给搜索引擎的词）；queryParams.kw 只是地址栏参数，
    // 改输入框不点搜索时两者会不一致，必须分开读。
    const conditionKeyword = (() => {
      const raw = state.statBaseData && state.statBaseData.search_condition;
      if (!raw) return "";
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return clean(parsed && (parsed.S_SOU_FULL_INDEX || parsed.kw || parsed.keyword), 80);
      } catch (error) {
        return clean(String(raw).replace(/^S_SOU_[A-Z_]*[:_]?/i, ""), 80);
      }
    })();
    return {
      positions: source.slice(start, start + pageSize).map(pick),
      loaded: source.length,
      pageIndex: Math.max(0, Number(state.pageIndex) || (source.length ? Math.ceil(source.length / pageSize) : 0)),
      pageSize,
      hasMore: state.hasMore === true,
      loadingMore: state.loadingMore === true,
      positionCount: Math.max(0, Number(state.positionCount) || 0),
      loggedIn: Boolean(user.userId && cookies.at && cookies.rt),
      url: location.href,
      queryKeyword: clean(state.queryParams && state.queryParams.kw, 80),
      searchKeyword: conditionKeyword,
      pageMode: clean(state.pageMode, 20),
    };
  })()`;
}

/**
 * 智联详情页头部的「消息」入口。
 *
 * 页头是 SPA 路由，anchor 的 href 常常直接指向首页（打开 /message/ 也会回首页），
 * 所以这里只在 href 真的指向消息路由时才返回；否则由调用方直接点这个入口。
 */
export function zhaopinMessageUrlScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (!visible(anchor)) continue;
      const label = String(anchor.innerText || anchor.textContent || "").replace(/\\s+/g, "").trim();
      // 页头入口是「消息」或「消息13」（未读角标拼在同一个节点里）。
      if (!/^消息\\d*\\+?$/.test(label)) continue;
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!/^https:\\/\\/(?:[\\w-]+\\.)*zhaopin\\.com\\//i.test(href)) continue;
      if (!/\\/message(?:[/?#]|$)/i.test(href)) continue;
      return href;
    }
    return "";
  })()`;
}

/**
 * 智联投递弹窗里的简历选择。
 *
 * 第一次投递时平台会弹「选择简历」，不选中就点「立即投递」不会有任何反应；
 * 选过一次之后平台会记住默认简历，这个脚本会直接返回 selected=false，不做多余点击。
 * 只处理弹窗内部，且跳过成功弹窗和登录弹窗，避免把结果提示当成简历选项点掉。
 */
export function zhaopinResumeSelectScript() {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "");
    const areaOf = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const dialogs = [...document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"], [class*="popup"], [class*="pop"], [class*="drawer"], [class*="layer"]')]
      .filter(visible)
      .filter((element) => {
        const value = clean(element);
        if (!value || value.length > 600) return false;
        if (!/简历|投递|申请/.test(value)) return false;
        // 成功回执和登录浮层不是简历选择弹窗。
        if (/已向对方发送简历|投递成功|申请成功|已投递过|登录|手机号|验证码/.test(value)) return false;
        return true;
      })
      .sort((left, right) => areaOf(left) - areaOf(right));
    const dialog = dialogs[0];
    if (!dialog) return { found: false, selected: false };
    const checked = [...dialog.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"]')]
      .some((element) => element.checked === true
        || element.getAttribute("aria-checked") === "true"
        || /checked|selected|active/i.test(String(element.className || "")));
    if (checked) return { found: true, selected: false };
    const options = [...dialog.querySelectorAll('label, li, [class*="resume"], [class*="radio"], [class*="select"], [class*="option"], [class*="check"], [role="radio"]')]
      .filter(visible)
      .filter((element) => /简历|在线简历|附件/.test(clean(element)))
      .sort((left, right) => areaOf(left) - areaOf(right));
    let target = options[0];
    if (!target) {
      // 实在找不到带类名的选项时，退回「弹窗里写着简历的最小节点」，点它最近的选项容器。
      const leaf = [...dialog.querySelectorAll("div, span, p, strong")]
        .filter(visible)
        .filter((element) => {
          const value = clean(element);
          return value.length > 0 && value.length <= 30 && /在线简历|附件简历|简历/.test(value);
        })
        .sort((left, right) => areaOf(left) - areaOf(right))[0];
      target = leaf?.closest('label, li, [role="radio"], [class*="item"], [class*="option"]') || leaf?.parentElement || leaf;
    }
    if (!target) return { found: true, selected: false };
    target.click();
    return { found: true, selected: true };
  })()`;
}

/** 消息列表页的可见文案 + 会话条目；条目文本用于把「投递回执」和具体岗位绑在一起。 */
export function zhaopinMessageProbeScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
    const items = [];
    for (const element of document.querySelectorAll('li, [class*="message"], [class*="chat"], [class*="session"], [class*="conversation"], [class*="contact"], [class*="item"], [class*="card"]')) {
      if (!visible(element)) continue;
      const value = textOf(element);
      if (value.length >= 6 && value.length <= 400) items.push(value);
    }
    return {
      url: location.href,
      items: [...new Set(items)].slice(0, 120),
      body: String(document.body?.innerText || "").slice(0, 20000),
    };
  })()`;
}

export type ZhaopinMessageProbe = {
  url?: string;
  items?: string[];
  body?: string;
};

/** 智联「消息」页的读取结果，供批量投递结束后核对是否已投递。 */
export type ZhaopinMessageReadResult = {
  ok: boolean;
  state: "ok" | "failed" | "closed" | "blocked";
  message: string;
  url: string;
  items: string[];
  body: string;
  capturedAt: number;
  blocked: "login" | "verification" | "";
};

/**
 * 在消息列表里找「这个岗位刚投出去」的回执。
 *
 * 智联投递后会在消息列表留一条会话，副标题是「您已投递的 <岗位名>」或
 * 「已发送附件简历」。必须同时看到岗位名（和公司名，如果有）才算，
 * 不能只看整页有没有「已投递」——同一个账号里还有别的岗位的历史记录。
 */
export function zhaopinMessageRecord(
  probe: unknown,
  job: { title?: string; company?: string },
): string {
  const source = probe && typeof probe === "object" ? probe as ZhaopinMessageProbe : null;
  if (!source) return "";
  const compact = (value: unknown) => String(value ?? "").replace(/\s+/g, "");
  const title = compact(job.title);
  const company = compact(job.company);
  if (title.length < 2 && company.length < 2) return "";
  const receipt = /已投递|已发送附件简历|投递成功|已发送简历|投递了/;
  const matches = (value: unknown) => {
    const text = compact(value);
    if (!text || !receipt.test(text)) return false;
    const hasTitle = title.length >= 2 && text.includes(title);
    const hasCompany = company.length >= 2 && text.includes(company);
    return company.length >= 2 ? hasTitle && hasCompany : hasTitle;
  };
  for (const item of Array.isArray(source.items) ? source.items : []) {
    if (matches(item)) return compact(item).slice(0, 80);
  }
  const body = compact(source.body);
  for (const key of [title, company]) {
    if (key.length < 2) continue;
    const index = body.indexOf(key);
    if (index < 0) continue;
    const around = body.slice(Math.max(0, index - 80), index + key.length + 160);
    if (matches(around)) return key;
  }
  return "";
}

/**
 * 让页面自己的搜索 action 拉取指定页。
 *
 * 智联首屏是 SSR，`hasMore` 可能在页面水合完成前固定成 false（或者沿用缓存的匿名页），
 * 此时 `loadMoreJobList` 会被这个旧标记挡住，但窗口里手动下滑却能继续加载。
 * 这里复用页面自己的 `fetchSearchList`：它按当前 queryParams 请求下一页、追加列表并重算
 * hasMore；action 内部仍会校验登录，不会绕过平台限制。
 */
export function zhaopinFetchSearchPageScript(pageIndex: number) {
  return `(() => {
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    if (!store || typeof store.dispatch !== "function") return Promise.resolve({ ok: false, reason: "store-missing" });
    const index = Math.max(1, Math.round(Number(${JSON.stringify(pageIndex)}) || 1));
    return store.dispatch("fetchSearchList", { pageIndex: index, skipKeywordCompanySearch: true })
      .then((list) => ({ ok: Array.isArray(list) && list.length > 0, length: Array.isArray(list) ? list.length : 0 }))
      .catch((error) => ({ ok: false, reason: String(error && error.message || error).slice(0, 200) }));
  })()`;
}

/** 调用页面自己的「加载更多」；未登录 / 没有更多时按平台规则直接返回 false。 */
export function zhaopinLoadMoreScript() {
  return `(() => {
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    if (!store || typeof store.dispatch !== "function") return { ok: false, reason: "store-missing" };
    const state = store.state || {};
    if (state.loadingMore === true) return { ok: false, reason: "loading" };
    if (state.hasMore !== true) return { ok: false, reason: "no-more" };
    try {
      const result = store.dispatch("loadMoreJobList");
      if (result && typeof result.then === "function") {
        return result.then(() => ({ ok: true })).catch((error) => ({
          ok: false,
          reason: String(error && error.message || error).slice(0, 200),
        }));
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error).slice(0, 200) };
    }
  })()`;
}
