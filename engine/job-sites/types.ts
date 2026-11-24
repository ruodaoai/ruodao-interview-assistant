import type { AutoApplyJob, SiteFilteredItem } from "../auto-apply/types";
import type { JobWindowRevealMode } from "./reveal";

/** 猎聘已下线：保留该类型只为读取历史投递记录，不再参与搜索与投递入口。 */
export type JobSiteId = "boss" | "liepin" | "zhaopin" | "job51";

export type JobSiteQuery = {
  site: JobSiteId;
  keyword?: string;
  /** 多岗位批量搜索，例如 ["Java", "AI Agent 开发工程师"]。 */
  keywords?: string[];
  city?: string;
  page?: number;
  /** 从 page 开始连续加载多少页（1-5）；Boss 第 2 页起走页面内列表接口。 */
  pages?: number;
  /** 深度搜索：按轮次补充与原关键词同方向的岗位说法，换一批没投过的岗位。 */
  extend?: boolean;
  /** 第几轮深度搜索（从 0 开始）：每轮换关键词批次和平台排序。 */
  round?: number;
  /** 上一批实际使用的公司规模筛选码：继续加载必须沿用，否则页码会对不上。 */
  scale?: string;
  /** 用户在公司规模下拉里的选择：none 不传规模（默认）；fixed 固定用 scale。不传时按 none 处理。 */
  scaleMode?: "none" | "fixed";
  /** 用户在排序下拉里的选择：auto 随深挖轮换；default 不传排序参数；fixed 按 order / sortType。 */
  sortMode?: "auto" | "default" | "fixed";
  /** 智联列表排序：4 最新发布 / 11 综合排序 / 2 薪资最高。 */
  order?: number;
  /** 前程无忧排序：0 综合排序 / 1 最新优先。 */
  sortType?: number;
  /** 智联薪资区间筛选值（salaryType）；继续加载原样传回，保证翻页还是同一批结果。 */
  salary?: string;
  /** 求职档案里的技能，仅用于深度搜索时补关键词。 */
  skills?: string[];
  /** 安全规则里的期望薪资，用来决定智联要轮换哪些薪资区间。 */
  salaryMin?: number;
  salaryMax?: number;
  /** 用户当前选中的文本模型：搜岗后顺带做公司判定时要用它，不能退回默认供应商。 */
  llm?: { provider?: string; model?: string };
};

export type JobSiteStatus = {
  site: JobSiteId;
  label: string;
  open: boolean;
  /** 页面探测到的登录状态；空字符串表示当前页面无法可靠判断。 */
  loginState: "in" | "out" | "";
  blocked: "login" | "verification" | "";
  message: string;
  lastSearchAt: number;
  lastCheckedAt: number;
};

/** 被隐藏岗位的原因拆分，UI 用来解释「已过滤 N 个」而不是只给一个数字。 */
export type SiteFilterDetail = {
  duplicate: number;
  city: number;
  safety: number;
  outsource: number;
  /** 薪资不在用户期望范围的岗位数。 */
  salary: number;
  /** 本地匹配分低于「最低匹配分」的岗位数。 */
  score: number;
};

export type JobSiteSearchResult = {
  site: JobSiteId;
  items: AutoApplyJob[];
  total: number;
  message: string;
  blocked: "login" | "verification" | "";
  pagesScanned: number;
  filtered: number;
  filteredDetail: SiteFilterDetail;
  /** 被隐藏岗位的明细，供 UI 列出公司 / 岗位 / 原因。 */
  filteredItems: SiteFilteredItem[];
  page: number;
  city: string;
  searchedAt: number;
  keywords: string[];
  keywordCounts: { keyword: string; total: number }[];
  /** 整页薪资几乎全是「面议」时的说明：已自动重搜 / 重搜后仍缺失。 */
  salaryNote?: string;
  /** 翻页过程中的说明：平台明确没有更多、或接口没返回下一页时给用户一个原因。 */
  pagingNote?: string;
  /** 所有关键词都已经没有下一页；界面据此停用「继续加载」，避免重复请求空页。 */
  exhausted?: boolean;
  /** 本轮深度搜索的轮次（从 0 开始）。 */
  round?: number;
  /** 本轮平台取数方式，例如「最新发布 · 15-25K」「综合排序」「公司规模 20-99人」。 */
  variant?: string;
  /** 本批实际使用的公司规模筛选码；继续加载时原样传回。 */
  scale?: string;
  /** 本批实际使用的排序参数；继续加载时原样传回，避免翻页换了排序导致页码错位。 */
  sortMode?: "auto" | "default" | "fixed";
  order?: number;
  sortType?: number;
  salary?: string;
};

export type JobSiteGreetInput = {
  job: AutoApplyJob;
  greeting: string;
  imagePath: string;
  evidenceDir: string;
  log: (message: string) => void;
  /** 批量投递被停止时立即中止本次操作，不再等待页面响应。 */
  signal?: AbortSignal;
  /**
   * 窗口显隐策略：默认 focus（手动操作弹到最前）；
   * 批量投递用 visible（显示但不抢焦点）或 background（完全隐藏）。
   */
  reveal?: JobWindowRevealMode;
  /** 安全规则里的「允许重复沟通」：开启后，Boss 显示「继续沟通」时也会再次发送。 */
  allowRepeatChat?: boolean;
};

export type JobSiteGreetResult = {
  state: "sent" | "needs_user" | "blocked" | "failed";
  message: string;
  screenshots: string[];
  blockedReason: string;
  successText: string;
  finalUrl: string;
  /** 实际发出的招呼正文：自动招呼取确认框内容，手动发送取输入内容，历史会话为空。 */
  greeting?: string;
  greetingSource?: "auto" | "typed" | "already" | "";
};

/** 非 Boss 平台「直接投递简历」的入参：用平台在线简历，可选补一份附件简历。 */
export type JobSiteApplyInput = {
  job: AutoApplyJob;
  evidenceDir: string;
  log: (message: string) => void;
  /** 附件简历路径（PDF / 图片）；平台弹窗有文件输入时才会上传。 */
  resumeFilePath?: string;
  /**
   * 岗位没有投递按钮、只能「聊一聊」时的开场话术（猎聘 / 智联 / 前程无忧共用）。
   * 只有真的走到聊天兜底时才会调用，不会为每次投递都生成一遍。
   */
  greeting?: () => Promise<string>;
  signal?: AbortSignal;
  /** 同 JobSiteGreetInput.reveal：批量投递默认可见但不抢焦点。 */
  reveal?: JobWindowRevealMode;
};

export type JobSiteApplyResult = {
  /** already = 页面显示已经投递过，本次没有重复点。 */
  state: "submitted" | "already" | "needs_user" | "blocked" | "failed";
  message: string;
  screenshots: string[];
  blockedReason: string;
  successText: string;
  finalUrl: string;
  /** 命中的投递入口（详情页按钮 / 聊天窗口），供用户核对。 */
  entryText: string;
};

export type RawSiteJob = {
  title: string;
  company: string;
  city: string;
  salary: string;
  url: string;
  tags: string[];
  recruiter: string;
  recruiterActive: string;
  extra: string;
  companyIndustry?: string;
  companyStage?: string;
  companyScale?: string;
  recruiterTitle?: string;
  /** 平台职位号，用于跨次搜索识别同一岗位。 */
  jobId?: string;
  /** open = 平台标记在招，closed = 平台标记关闭，空 = 未知。 */
  jobStatus?: "open" | "closed" | "";
  jobStatusText?: string;
  anonymous?: boolean;
  headhunter?: boolean;
  proxy?: boolean;
  /** 平台展示的发布时间 / 更新时间原文，例如「3天前发布」「更新于 2026-09-12」。 */
  postedText?: string;
};
