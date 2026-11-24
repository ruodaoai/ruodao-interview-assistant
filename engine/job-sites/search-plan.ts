import type { JobSiteId } from "./types";

/**
 * 一轮深度搜索最多带多少个关键词（含用户输入）。
 *
 * 招聘平台对每个关键词只肯先给一小批岗位（智联匿名甚至只给前 20 条），
 * 反复搜同一批关键词只会拿回同一批已投过的岗位。每轮补几个同方向的岗位说法，
 * 相当于把搜索面横向铺开；数字不能太大，否则一轮搜索会拖到几分钟。
 */
export const MAX_SEARCH_KEYWORDS = 10;
/** 每轮最多补多少个扩展词：补得越多，单轮覆盖越广，但每轮耗时也越长。 */
export const MAX_VARIANT_KEYWORDS = 6;
/** 深度搜索最多翻到第几页（与 sites.ts 的 JOB_SITE_MAX_PAGE 保持一致）。 */
const DEEP_PAGE_LIMIT = 100;

/** 一次深度搜索按什么方式取数：平台排序、薪资区间都靠它轮换。 */
export type SearchPlan = {
  round: number;
  /** 展示给用户的这一批说明，例如「最新发布 · 15-25K」。 */
  label: string;
  /** 智联列表排序：4 最新发布 / 11 综合排序 / 2 薪资最高。 */
  order?: number;
  /** 前程无忧排序：0 综合排序 / 1 最新优先。 */
  sortType?: number;
  /** 智联薪资区间筛选值（salaryType，形如 "15001,25000"）。 */
  salary?: string;
  /** 公司规模筛选码：深挖每批随机换一个，翻页时沿用同一个。 */
  scale?: string;
};

export type JobSiteScale = { code: string; label: string };

/** Boss 搜索页「公司规模」下拉的筛选码，顺序与页面一致。 */
export const BOSS_SCALES: JobSiteScale[] = [
  { code: "301", label: "0-20人" },
  { code: "302", label: "20-99人" },
  { code: "303", label: "100-499人" },
  { code: "304", label: "500-999人" },
  { code: "305", label: "1000-9999人" },
  { code: "306", label: "10000人以上" },
];

/** 智联新版 /jobs/ 的「公司人数」筛选码（URL 参数 cs）；7 是「保密」，不参与轮换。 */
export const ZHAOPIN_SCALES: JobSiteScale[] = [
  { code: "1", label: "20人以下" },
  { code: "2", label: "20-99人" },
  { code: "3", label: "100-299人" },
  { code: "8", label: "300-499人" },
  { code: "4", label: "500-999人" },
  { code: "5", label: "1000-9999人" },
  { code: "6", label: "10000人以上" },
];

/** 前程无忧搜索接口的 companySize 筛选码，取自页面自己的 companysize.js。 */
export const JOB51_SCALES: JobSiteScale[] = [
  { code: "1", label: "少于50人" },
  { code: "2", label: "50-150人" },
  { code: "3", label: "150-500人" },
  { code: "4", label: "500-1000人" },
  { code: "5", label: "1000-5000人" },
  { code: "6", label: "5000-10000人" },
  { code: "7", label: "10000人以上" },
];

/** 支持按公司规模轮换的平台；猎聘没有对应筛选，保持原样。 */
export const JOB_SITE_SCALES: Partial<Record<JobSiteId, JobSiteScale[]>> = {
  boss: BOSS_SCALES,
  zhaopin: ZHAOPIN_SCALES,
  job51: JOB51_SCALES,
};

export function siteScales(site: JobSiteId) {
  return JOB_SITE_SCALES[site] ?? [];
}

export function siteScaleLabel(site: JobSiteId, code: string) {
  return siteScales(site).find((entry) => entry.code === String(code ?? "").trim())?.label ?? "";
}

/** 智联 order 参数对应的界面说法；未知值返回空串，避免把数字当标签展示。 */
export function zhaopinOrderLabel(order?: number) {
  if (order === 4) return "最新发布";
  if (order === 11) return "综合排序";
  if (order === 2) return "薪资最高";
  return "";
}

/** 前程无忧 sortType 参数对应的界面说法。 */
export function job51SortLabel(sortType?: number) {
  if (sortType === 0) return "综合排序";
  if (sortType === 1) return "最新优先";
  return "";
}

/** 智联 salaryType（"15001,25000"）转成「15-25K」；无效值返回空串。 */
export function salaryRangeText(value?: string) {
  const [min, max] = String(value ?? "").split(",").map((entry) => Math.round(Number(entry) || 0));
  if (min <= 0 || max <= min) return "";
  return `${Math.round(min / 1000)}-${Math.round(max / 1000)}K`;
}

type VariantRule = { match: RegExp; variants: string[] };

/**
 * 同义岗位改写表：平台对措辞很敏感，「Java」和「Spring Boot」经常返回完全不同的公司。
 * 顺序按「和原关键词差异最大」优先，避免补进来的词只是原词加后缀、结果几乎重复。
 * 每类多准备一些说法：轮次够多时仍能拿到没搜过的关键词，而不是很快绕回同一批。
 */
const ROLE_VARIANTS: VariantRule[] = [
  {
    match: /java/i,
    variants: [
      "Spring Boot", "微服务", "后端开发", "Java 架构师", "Java 开发工程师",
      "Java 工程师", "服务端开发", "分布式", "高并发", "中间件",
      "Spring Cloud", "MyBatis", "JVM", "全栈开发", "高级 Java", "资深 Java",
    ],
  },
  {
    match: /ai\s*agent|智能体|\bagent\b/i,
    variants: [
      "大模型应用开发", "LLM 应用开发", "AI 应用开发", "RAG", "Agent 开发",
      "智能体开发", "AI Agent 工程师", "大模型工程师", "AI 工程师",
      "LangChain", "LangGraph", "MCP", "提示词工程", "AIGC", "大模型",
    ],
  },
  {
    match: /全栈/i,
    variants: ["Node.js", "React", "TypeScript", "前端开发", "全栈工程师", "Web 全栈", "Java 全栈", "Vue"],
  },
  {
    match: /前端|web/i,
    variants: ["React", "Vue", "TypeScript", "Web 前端", "前端工程师", "H5 前端", "小程序开发", "Next.js"],
  },
  {
    match: /后端|服务端/i,
    variants: ["Java 后端", "微服务", "Python 后端", "Node.js", "Go 后端", "服务端开发", "分布式", "高并发"],
  },
  {
    match: /python/i,
    variants: ["FastAPI", "Django", "Python 后端", "AI 应用开发", "Python 开发", "数据开发", "爬虫"],
  },
  {
    match: /大模型|llm|aigc|生成式/i,
    variants: ["RAG", "Agent 开发", "LangChain", "AI 应用开发", "大模型应用", "LLM", "智能体", "MCP", "提示词工程", "大模型工程师"],
  },
  {
    match: /测试/i,
    variants: ["自动化测试", "测试开发", "性能测试", "接口测试", "QA 工程师"],
  },
  {
    match: /运维|devops/i,
    variants: ["DevOps", "Kubernetes", "SRE", "运维开发", "云原生", "Linux 运维"],
  },
  {
    match: /产品经理|产品/i,
    variants: ["AI 产品经理", "B 端产品经理", "高级产品经理", "产品经理", "产品设计"],
  },
  {
    match: /数据/i,
    variants: ["数据分析", "数据开发", "数据仓库", "大数据开发", "BI 工程师", "ETL"],
  },
  {
    match: /算法|机器学习|深度学习/i,
    variants: ["算法工程师", "机器学习", "深度学习", "推荐算法", "NLP 算法", "计算机视觉"],
  },
  {
    match: /大数据|hadoop|spark|flink/i,
    variants: ["大数据开发", "Hadoop", "Spark", "Flink", "数据仓库", "ETL"],
  },
  {
    match: /\bgo(?:lang)?\b/i,
    variants: ["Golang", "Go 后端", "高并发", "分布式", "云原生"],
  },
  {
    match: /c\+\+|cpp/i,
    variants: ["C++ 开发", "C++ 工程师", "图形开发", "嵌入式开发"],
  },
  {
    match: /android|安卓/i,
    variants: ["Android 开发", "安卓开发", "移动端开发", "Flutter"],
  },
  {
    match: /ios|苹果/i,
    variants: ["iOS 开发", "移动端开发", "Swift", "Flutter"],
  },
  {
    match: /node/i,
    variants: ["Node.js", "Node 开发", "前端开发", "全栈开发"],
  },
  {
    match: /react/i,
    variants: ["React", "React Native", "前端开发", "TypeScript"],
  },
  {
    match: /vue/i,
    variants: ["Vue", "前端开发", "TypeScript", "小程序开发"],
  },
  {
    match: /架构师/i,
    variants: ["系统架构师", "技术架构师", "平台架构", "微服务架构"],
  },
  {
    match: /技术经理|研发经理|技术负责人/i,
    variants: ["技术经理", "研发经理", "技术负责人", "研发总监"],
  },
  {
    match: /解决方案|售前/i,
    variants: ["解决方案工程师", "售前工程师", "技术支持", "实施工程师"],
  },
  {
    match: /项目经理|交付/i,
    variants: ["项目经理", "交付经理", "实施项目经理"],
  },
  {
    match: /运营/i,
    variants: ["新媒体运营", "用户运营", "内容运营", "产品运营"],
  },
  {
    match: /销售|客户经理/i,
    variants: ["销售经理", "客户经理", "大客户销售"],
  },
  {
    match: /ui|交互|视觉设计|设计师/i,
    variants: ["UI 设计师", "交互设计师", "视觉设计师"],
  },
  {
    match: /财务|会计/i,
    variants: ["财务经理", "会计", "财务分析"],
  },
  {
    match: /hr|人力|招聘/i,
    variants: ["招聘专员", "HRBP", "人力资源经理"],
  },
  {
    match: /客服/i,
    variants: ["客服专员", "客服主管"],
  },
  {
    match: /硬件|嵌入式|电子/i,
    variants: ["硬件工程师", "电子工程师", "嵌入式开发"],
  },
];

/** 只拿真正能当搜索词的技能去补关键词，避免把「团队管理」这类泛能力词丢给平台。 */
const SKILL_QUERY_KEEP = /java|python|go(?:lang)?|node|react|vue|angular|typescript|javascript|spring|mysql|redis|postgres|kafka|docker|kubernetes|微服务|全栈|前端|后端|大模型|智能体|ai|llm|rag|agent|langchain|fastapi|django|uniapp|solidity|netty|架构/i;
const SKILL_QUERY_STOP = /^(?:linux|eclipse|codex|git|office|excel|word|ppt)$/i;

const ZHAOPIN_SALARY_BANDS = [
  { min: 8001, max: 10000, text: "8-10K" },
  { min: 10001, max: 15000, text: "10-15K" },
  { min: 15001, max: 25000, text: "15-25K" },
  { min: 25001, max: 35000, text: "25-35K" },
  { min: 35001, max: 50000, text: "35-50K" },
  { min: 50001, max: 9999999, text: "50K以上" },
];

function normalizeKeyword(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function uniqueKeywords(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const keyword = normalizeKeyword(value);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
  }
  return result;
}

function seedKeywords(base: string[]) {
  return uniqueKeywords(base).slice(0, 6);
}

function variantSlots(seedCount: number) {
  return Math.min(MAX_VARIANT_KEYWORDS, Math.max(0, MAX_SEARCH_KEYWORDS - seedCount));
}

function roleVariants(keyword: string) {
  const matched = ROLE_VARIANTS.filter((rule) => rule.match.test(keyword)).flatMap((rule) => rule.variants);
  if (matched.length) return uniqueKeywords(matched);
  // 没命中改写表的英文技能：补「开发 / 工程师」两个常见岗位说法。
  if (/^[a-z0-9+#.\s-]{2,24}$/i.test(keyword)) return uniqueKeywords([`${keyword} 开发`, `${keyword} 工程师`]);
  return [];
}

function skillQuery(raw: string) {
  const value = normalizeKeyword(raw);
  if (!value || SKILL_QUERY_STOP.test(value) || !SKILL_QUERY_KEEP.test(value)) return "";
  const trimmed = value.replace(/\s*(?:开发工程师|开发|工程师|架构)$/g, "").trim();
  return trimmed || value;
}

/**
 * 档案技能只有和本次搜索方向一致时才补进关键词。
 * 搜「agent」时 Spring Boot / 全栈 / Java 这些技能不能混进来，否则会拿回一堆
 * Java 运维、测试岗位，看起来像「搜 agent 出来 Java」。
 * 英文按词边界比较，避免 java 命中 javascript；中文按包含关系比较。
 */
function sharesDirection(left: string, right: string) {
  const a = normalizeKeyword(left).toLowerCase();
  const b = normalizeKeyword(right).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const contains = (haystack: string, needle: string) => {
    if (/[\u3400-\u9fff]/.test(needle)) return haystack.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
  };
  return contains(a, b) || contains(b, a);
}

/** 所有可轮换的扩展词（不含用户原词），顺序即轮换顺序。 */
function buildVariantPool(seeds: string[], skills: string[]) {
  const seedKeys = new Set(seeds.map((keyword) => keyword.toLowerCase()));
  const seen = new Set(seedKeys);
  const pool: string[] = [];
  const push = (value: string) => {
    const keyword = normalizeKeyword(value);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) return;
    seen.add(key);
    pool.push(keyword);
  };
  // 多个原词的变体交替进池：每轮取到的几个词来自不同岗位方向，不会挤在同一类岗位上。
  const perSeed = seeds.map((keyword) => roleVariants(keyword));
  const longest = Math.max(0, ...perSeed.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of perSeed) {
      if (list[index]) push(list[index]);
    }
  }
  // 技能只作为同方向的补充词：搜 agent 时 Spring Boot / 全栈这类技能不参与扩展。
  const directions = [...seeds, ...perSeed.flat()];
  for (const skill of skills) {
    const query = skillQuery(skill);
    if (query && directions.some((keyword) => sharesDirection(query, keyword))) push(query);
  }
  return pool;
}

/**
 * 生成这一轮要搜的关键词：用户输入的原词永远排最前，后面补最多 6 个变体。
 * 变体按轮次切片，保证每点一次搜索都换一批；轮完一轮后再从头循环。
 */
export function expandSearchKeywords(base: string[], skills: string[] = [], round = 0): string[] {
  const seeds = seedKeywords(base);
  const slots = variantSlots(seeds.length);
  if (!slots) return seeds;
  const pool = buildVariantPool(seeds, skills);
  if (!pool.length) return seeds;
  const safeRound = Math.max(0, Math.round(Number(round) || 0));
  const start = (safeRound * slots) % pool.length;
  const picked: string[] = [];
  for (let step = 0; step < pool.length && picked.length < slots; step += 1) {
    const keyword = pool[(start + step) % pool.length];
    if (!picked.includes(keyword)) picked.push(keyword);
  }
  return [...seeds, ...picked];
}

/**
 * 关键词池轮完一圈需要几轮：Boss 没有排序参数，靠它决定什么时候把同一批关键词
 * 往更深的页码翻（第 1 圈翻 1-3 页，第 2 圈翻 4-6 页……），避免每轮都只重复前几页。
 */
export function keywordCycleLength(base: string[], skills: string[] = []): number {
  const seeds = seedKeywords(base);
  const slots = variantSlots(seeds.length);
  if (!slots) return 1;
  const pool = buildVariantPool(seeds, skills);
  return Math.max(1, Math.ceil(pool.length / slots));
}

/**
 * 深度搜索的页码窗口：第 0 圈从第 1 页开始，之后每轮关键词池循环一圈，
 * 就整体向深页推进一个窗口；到最后一页后回到前面。
 */
export function deepPageWindow(round: number, pages: number, cycle: number, maxPage = DEEP_PAGE_LIMIT) {
  const safePages = Math.max(1, Math.min(maxPage, Math.round(Number(pages) || 1)));
  const safeCycle = Math.max(1, Math.round(Number(cycle) || 1));
  const depth = Math.floor(Math.max(0, Math.round(Number(round) || 0)) / safeCycle);
  if (depth <= 0) return { start: 1, end: safePages };
  const start = 1 + (depth * safePages) % maxPage;
  return { start, end: Math.min(maxPage, start + safePages - 1) };
}

function salaryBands(salaryMin: number, salaryMax: number) {
  // 安全规则里的薪资单位是 K/月，智联 salaryType 用的是元/月。
  const min = Math.max(0, Number(salaryMin) || 0) * 1000;
  const max = Math.max(0, Number(salaryMax) || 0) * 1000;
  if (!min && !max) return [];
  // 上下限都有时按 5K 切窗口：匿名只给每个关键词前 20 条，窄窗口能把列表后面的岗位翻出来。
  // 这些窗口只影响平台取数，最终仍按用户的期望薪资在本地过滤。
  if (min > 0 && max > min) {
    const windows: typeof ZHAOPIN_SALARY_BANDS = [];
    const step = 5000;
    for (let start = min; start < max; start += step) {
      const end = Math.min(max, start + step);
      windows.push({ min: start + 1, max: end, text: `${Math.round(start / 1000)}-${Math.round(end / 1000)}K` });
    }
    windows.push({ min: min + 1, max, text: `${Math.round(min / 1000)}-${Math.round(max / 1000)}K` });
    return windows;
  }
  return ZHAOPIN_SALARY_BANDS.filter((band) => {
    if (max > 0 && band.min >= max) return false;
    if (min > 0 && band.max <= min) return false;
    return true;
  });
}

/**
 * 这一轮的平台取数变体。
 *
 * 智联匿名每个关键词只给前 20 条，换排序 / 换薪资区间等于换一批 20 条；
 * 前程无忧的列表页支持 sortType，综合排序和最新优先的结果差异也很大。
 * Boss 列表接口没有排序参数，靠扩展关键词和圈数翻深页（见 deepPageWindow）。
 */
export function resolveSearchPlan(
  site: JobSiteId,
  round: number,
  salaryMin = 0,
  salaryMax = 0,
): SearchPlan {
  const safeRound = Math.max(0, Math.round(Number(round) || 0));
  if (site === "zhaopin") {
    const variants: Omit<SearchPlan, "round">[] = [
      { label: "最新发布", order: 4 },
      { label: "综合排序", order: 11 },
      { label: "薪资最高", order: 2 },
    ];
    for (const band of salaryBands(salaryMin, salaryMax)) {
      variants.push({
        label: `最新发布 · ${band.text}`,
        order: 4,
        salary: `${band.min},${band.max}`,
      });
      variants.push({
        label: `薪资最高 · ${band.text}`,
        order: 2,
        salary: `${band.min},${band.max}`,
      });
    }
    return { round: safeRound, ...variants[safeRound % variants.length] };
  }
  if (site === "job51") {
    const variants: Omit<SearchPlan, "round">[] = [
      { label: "综合排序", sortType: 0 },
      { label: "最新发布", sortType: 1 },
    ];
    return { round: safeRound, ...variants[safeRound % variants.length] };
  }
  return { round: safeRound, label: "" };
}
