import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, backupCorruptFile } from "./durable-json.mjs";

/**
 * 插件侧自动投递数据：求职档案、安全规则、投递记录。
 *
 * 数据仍落在宿主 userData/auto-apply/auto-apply.json，批量执行器、备份等
 * 宿主能力读同一份文件；因此这里不长期缓存，每次操作都从磁盘读，
 * 写入后再由插件服务通知宿主丢弃内存副本。
 */

const MAX_JOB_DESCRIPTION = 12_000;
const MAX_HTML_BYTES = 4_000_000;
const ID_PATTERN = /^[a-z0-9-]{6,64}$/i;
const STATUSES = ["planned", "prepared", "filled", "needs_user", "submitted", "skipped", "blocked", "failed"];
const JOB_SOURCES = ["template", "manual", "boss", "liepin", "zhaopin", "job51"];

export function asText(value, max = 4000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function asStringList(value, maxItems, maxChars) {
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const text = asText(entry, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}

/** 屏蔽原因只保留名单里还存在的公司，解除屏蔽时备注一起清掉，避免越积越多。 */
function asCompanyNotes(value, companies) {
  const source = value && typeof value === "object" ? value : {};
  const allowed = new Set(companies);
  const notes = {};
  for (const [key, note] of Object.entries(source)) {
    const name = asText(key, 80);
    const content = asText(note, 120);
    if (!name || !content || !allowed.has(name)) continue;
    notes[name] = content;
  }
  return notes;
}

function asId(value, prefix) {
  const text = asText(value, 64);
  return ID_PATTERN.test(text) ? text : `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function asUrl(value, max = 2000) {
  const text = asText(value, max);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().slice(0, max) : "";
  } catch {
    return "";
  }
}

function asNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function asNullableNumber(value) {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : Math.round(parsed);
}

function asNullableFloat(value) {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : Math.round(parsed * 100) / 100;
}

export function emptyProfile() {
  return {
    name: "", phone: "", email: "", city: "", years: "", degree: "", wechat: "", salary: "", available: "",
    website: "", github: "", linkedin: "", summary: "", targetRoles: [], targetCities: [], remote: "不限",
    skills: [], resumeId: "", answerBank: [], updatedAt: Date.now(),
  };
}

export function defaultRules() {
  return {
    minMatchScore: 20,
    dailyLimit: 500,
    blockedCompanies: [],
    blockedCompanyNotes: {},
    blockedKeywords: [],
    requireConfirmation: true,
    allowRepeatChat: false,
    filterHeadhunter: false,
    filterInactiveHr: false,
    filterOutsource: false,
    filterStaleJob: false,
    staleJobDays: 90,
    filterExperience: false,
    filterDegree: false,
    sendImageResume: false,
    greetingMode: "template",
    greetingTemplate: "您好，我对这个岗位很感兴趣，与我的行业积累和AI落地经验较匹配，希望你能看看我的简历，谢谢！",
    repeatMessages: [],
    salaryMin: 15,
    salaryMax: 100,
    notifyWebhook: "",
    autoApplyWindow: "08:00-21:00",
    greetIntervalMinSeconds: 10,
    greetIntervalMaxSeconds: 20,
    companyCooldownDays: 30,
    dailyCompanyLimit: 200,
    autoBlockRejected: true,
    showBrowserWindow: true,
  };
}

export function normalizeProfile(raw, fallback) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = fallback ?? emptyProfile();
  const remote = asText(source.remote, 10);
  return {
    name: asText(source.name ?? base.name, 60),
    phone: asText(source.phone ?? base.phone, 60),
    email: asText(source.email ?? base.email, 120),
    city: asText(source.city ?? base.city, 60),
    years: asText(source.years ?? base.years, 40),
    degree: asText(source.degree ?? base.degree, 40),
    wechat: asText(source.wechat ?? base.wechat, 60),
    salary: asText(source.salary ?? base.salary, 60),
    available: asText(source.available ?? base.available, 60),
    website: asUrl(source.website ?? base.website, 400),
    github: asUrl(source.github ?? base.github, 400),
    linkedin: asUrl(source.linkedin ?? base.linkedin, 400),
    summary: asText(source.summary ?? base.summary, 4000),
    targetRoles: asStringList(source.targetRoles ?? base.targetRoles, 12, 60),
    targetCities: asStringList(source.targetCities ?? base.targetCities, 10, 40),
    remote: ["不限", "现场", "混合", "远程"].includes(remote) ? remote : "不限",
    skills: asStringList(source.skills ?? base.skills, 30, 40),
    resumeId: asText(source.resumeId ?? base.resumeId, 64),
    answerBank: (Array.isArray(source.answerBank) ? source.answerBank : base.answerBank)
      .slice(0, 30)
      .map((entry) => ({
        id: asId(entry?.id, "a"),
        question: asText(entry?.question, 200),
        answer: asText(entry?.answer, 2000),
      }))
      .filter((entry) => Boolean(entry.question)),
    updatedAt: Number(source.updatedAt) || base.updatedAt || Date.now(),
  };
}

export function normalizeRules(raw, fallback) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = fallback ?? defaultRules();
  const flag = (key) => source[key] === true || (source[key] === undefined && base[key] === true);
  const greetingMode = source.greetingMode === "template" || source.greetingMode === "ai"
    ? source.greetingMode
    : base.greetingMode;
  const blockedCompanies = asStringList(source.blockedCompanies ?? base.blockedCompanies, 500, 80);
  // 旧版本把「每日投递」和「Boss 每日打招呼」拆成两个上限并取较小值。
  const requestedDaily = source.dailyLimit ?? base.dailyLimit;
  const legacyGreetLimit = Number(source.dailyGreetLimit);
  const dailyLimit = source.dailyGreetLimit !== undefined && Number.isFinite(legacyGreetLimit) && legacyGreetLimit > 0
    ? Math.min(Number(requestedDaily) || base.dailyLimit, legacyGreetLimit)
    : requestedDaily;
  return {
    minMatchScore: asNumber(source.minMatchScore ?? base.minMatchScore, 0, 100, base.minMatchScore),
    dailyLimit: asNumber(dailyLimit, 1, 500, base.dailyLimit),
    blockedCompanies,
    blockedCompanyNotes: asCompanyNotes(source.blockedCompanyNotes ?? base.blockedCompanyNotes, blockedCompanies),
    blockedKeywords: asStringList(source.blockedKeywords ?? base.blockedKeywords, 50, 40),
    // 最后一道提交闸门不可关闭：自动点击提交必须来自用户当次的显式确认。
    requireConfirmation: true,
    allowRepeatChat: flag("allowRepeatChat"),
    filterHeadhunter: flag("filterHeadhunter"),
    filterInactiveHr: flag("filterInactiveHr"),
    filterOutsource: flag("filterOutsource"),
    filterStaleJob: flag("filterStaleJob"),
    staleJobDays: asNumber(source.staleJobDays ?? base.staleJobDays, 7, 365, base.staleJobDays),
    filterExperience: flag("filterExperience"),
    filterDegree: flag("filterDegree"),
    sendImageResume: flag("sendImageResume"),
    greetingMode,
    greetingTemplate: asText(source.greetingTemplate ?? base.greetingTemplate, 1200),
    repeatMessages: asStringList(source.repeatMessages ?? base.repeatMessages, 6, 200),
    salaryMin: asNumber(source.salaryMin ?? base.salaryMin, 0, 500, base.salaryMin),
    salaryMax: asNumber(source.salaryMax ?? base.salaryMax, 0, 500, base.salaryMax),
    notifyWebhook: asUrl(source.notifyWebhook ?? base.notifyWebhook, 600),
    autoApplyWindow: normalizeWindow(source.autoApplyWindow ?? base.autoApplyWindow),
    greetIntervalMinSeconds: asNumber(source.greetIntervalMinSeconds ?? base.greetIntervalMinSeconds, 10, 600, base.greetIntervalMinSeconds),
    greetIntervalMaxSeconds: asNumber(source.greetIntervalMaxSeconds ?? base.greetIntervalMaxSeconds, 10, 900, base.greetIntervalMaxSeconds),
    companyCooldownDays: asNumber(source.companyCooldownDays ?? base.companyCooldownDays, 0, 365, base.companyCooldownDays),
    dailyCompanyLimit: asNumber(source.dailyCompanyLimit ?? base.dailyCompanyLimit, 1, 200, base.dailyCompanyLimit),
    autoBlockRejected: flag("autoBlockRejected"),
    showBrowserWindow: flag("showBrowserWindow"),
  };
}

/** 空字符串 = 不限时段；非法写法回落到默认 08:00-21:00，避免用户写错后整夜投递。 */
function normalizeWindow(value) {
  const text = asText(value, 20);
  if (!text) return "";
  return /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? text : "08:00-21:00";
}

export function normalizeJob(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceType = JOB_SOURCES.includes(source.source) ? source.source : "template";
  return {
    id: asId(source.id, sourceType === "manual" ? "m" : sourceType === "template" ? "job" : `site-${sourceType}`),
    source: sourceType,
    companyId: asText(source.companyId, 64),
    company: asText(source.company ?? source.companyName, 120),
    companyIndustry: asText(source.companyIndustry ?? source.industry, 80),
    careersUrl: asUrl(source.careersUrl ?? source.companyCareersUrl),
    title: asText(source.title ?? source.jobTitle, 160) || "未命名岗位",
    roleFamily: asText(source.roleFamily, 80),
    seniority: asText(source.seniority, 40),
    city: asText(source.city, 60),
    remoteType: asText(source.remoteType, 40),
    salaryMin: asNullableNumber(source.salaryMin),
    salaryMax: asNullableNumber(source.salaryMax),
    salaryUnit: asText(source.salaryUnit, 20),
    salaryLabel: asText(source.salaryLabel, 60),
    description: asText(source.description, MAX_JOB_DESCRIPTION),
    requirements: asText(source.requirements, MAX_JOB_DESCRIPTION),
    responsibilities: asText(source.responsibilities, MAX_JOB_DESCRIPTION),
    skills: asStringList(source.skills, 30, 40),
    tags: asStringList(source.tags, 16, 40),
    recruiter: asText(source.recruiter, 60),
    recruiterActive: asText(source.recruiterActive, 40),
    sourceUrl: asUrl(source.sourceUrl ?? source.jobUrl ?? source.url),
    matchScore: source.matchScore === null || source.matchScore === undefined ? null : asNumber(source.matchScore, 0, 100, 0),
    reasons: asStringList(source.reasons, 10, 160),
    gaps: asStringList(source.gaps ?? source.missingSkills, 10, 80),
    verdict: asText(source.verdict, 20),
    jobId: asText(source.jobId, 80),
    companyStage: asText(source.companyStage, 40),
    companyScale: asText(source.companyScale, 40),
    recruiterTitle: asText(source.recruiterTitle, 60),
    jobStatus: source.jobStatus === "open" || source.jobStatus === "closed" ? source.jobStatus : "",
    jobStatusText: asText(source.jobStatusText, 60),
    companyAnonymous: source.companyAnonymous === true,
    activeDays: asNullableFloat(source.activeDays),
    listingDays: asNullableNumber(source.listingDays),
    seenCount: Math.max(0, Math.min(100000, Math.round(Number(source.seenCount) || 0))),
    longTerm: source.longTerm === true,
    postedAt: asNullableNumber(source.postedAt),
    postedLabel: asText(source.postedLabel, 40),
    postedDays: asNullableNumber(source.postedDays),
    refreshCount: Math.max(0, Math.min(100, Math.round(Number(source.refreshCount) || 0))),
    ageDays: asNullableNumber(source.ageDays),
    trustScore: source.trustScore === null || source.trustScore === undefined ? null : asNumber(source.trustScore, 0, 100, 0),
    trustLevel: ["high", "medium", "low", "suspect"].includes(source.trustLevel) ? source.trustLevel : "",
    trustReasons: asStringList(source.trustReasons, 8, 160),
    trustRisks: asStringList(source.trustRisks, 8, 160),
    ...(Array.isArray(source.userTags) && source.userTags.length
      ? { userTags: asStringList(source.userTags, 8, 20) }
      : {}),
    ...(source.jobTagKey ? { jobTagKey: asText(source.jobTagKey, 240) } : {}),
  };
}

function normalizeMaterials(raw) {
  if (!raw || typeof raw !== "object") return null;
  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .slice(0, 20)
    .map((entry) => ({
      id: asId(entry?.id, "a"),
      question: asText(entry?.question, 200),
      answer: asText(entry?.answer, 2000),
    }))
    .filter((entry) => Boolean(entry.question && entry.answer));
  return {
    headline: asText(raw.headline, 120),
    summary: asText(raw.summary, 1200),
    coverLetter: asText(raw.coverLetter, 4000),
    highlights: asStringList(raw.highlights, 8, 200),
    answers,
    warnings: asStringList(raw.warnings, 10, 200),
    generatedAt: Number(raw.generatedAt) || Date.now(),
    model: asText(raw.model, 120),
  };
}

function emptyEvidence() {
  return {
    screenshots: [], log: [], filled: [], finalUrl: "", pageTitle: "", blockedReason: "", successText: "",
    greeting: "", greetingSource: "", verifiedAt: 0, verifySource: "", verifyNote: "", startedAt: 0, endedAt: 0,
  };
}

function normalizeEvidence(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    screenshots: asStringList(source.screenshots, 20, 1000),
    log: (Array.isArray(source.log) ? source.log : []).slice(-80).map((entry) => ({
      at: Number(entry?.at) || Date.now(),
      message: asText(entry?.message, 300),
    })).filter((entry) => Boolean(entry.message)),
    filled: asStringList(source.filled, 40, 100),
    finalUrl: asUrl(source.finalUrl),
    pageTitle: asText(source.pageTitle, 200),
    blockedReason: asText(source.blockedReason, 500),
    successText: asText(source.successText, 500),
    greeting: asText(source.greeting, 500),
    greetingSource: ["auto", "typed", "already", "verified"].includes(source.greetingSource) ? source.greetingSource : "",
    verifiedAt: Number(source.verifiedAt) || 0,
    verifySource: ["boss-chat", "boss-chat-ai", "job51-records", "zhaopin-message"].includes(source.verifySource) ? source.verifySource : "",
    verifyNote: asText(source.verifyNote, 300),
    startedAt: Number(source.startedAt) || 0,
    endedAt: Number(source.endedAt) || 0,
  };
}

export function normalizeApplication(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const status = STATUSES.includes(source.status) ? source.status : "planned";
  const html = String(source.resumeHtml ?? "");
  return {
    id: asId(source.id, "app"),
    job: normalizeJob(source.job ?? source),
    status,
    note: asText(source.note, 2000),
    resumeId: asText(source.resumeId, 64),
    resumeTitle: asText(source.resumeTitle, 160),
    templateId: asText(source.templateId, 40),
    materials: normalizeMaterials(source.materials),
    resumeHtml: Buffer.byteLength(html, "utf8") <= MAX_HTML_BYTES ? html : "",
    resumePdfPath: asText(source.resumePdfPath, 1000),
    evidence: normalizeEvidence(source.evidence),
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now(),
    preparedAt: Number(source.preparedAt) || 0,
    submittedAt: Number(source.submittedAt) || 0,
  };
}

export function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    profile: normalizeProfile(source.profile),
    rules: normalizeRules(source.rules),
    applications: (Array.isArray(source.applications) ? source.applications : []).map(normalizeApplication),
    lastRunAt: Number(source.lastRunAt) || 0,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AutoApplyStore {
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
  }

  get file() {
    return path.join(this.root, "auto-apply.json");
  }

  async load() {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") await backupCorruptFile(this.file);
      return normalizeState({});
    }
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async flush() {
    await this.queue;
  }

  async persist(state) {
    await fs.mkdir(this.root, { recursive: true });
    await atomicWriteFile(this.file, JSON.stringify(state));
  }

  async state() {
    return clone(await this.load());
  }

  async saveProfile(raw) {
    return this.enqueue(async () => {
      const state = await this.load();
      state.profile = { ...normalizeProfile(raw, state.profile), updatedAt: Date.now() };
      await this.persist(state);
      return clone(state.profile);
    });
  }

  async saveRules(raw) {
    return this.enqueue(async () => {
      const state = await this.load();
      state.rules = normalizeRules(raw, state.rules);
      await this.persist(state);
      return clone(state.rules);
    });
  }

  async findApplication(id) {
    const state = await this.load();
    const found = state.applications.find((entry) => entry.id === id);
    return found ? clone(found) : null;
  }

  /** 同一个岗位重复加入时复用已有记录，避免同一 URL 出现多条投递历史。 */
  async addApplication(job) {
    return this.enqueue(async () => {
      const state = await this.load();
      const normalized = normalizeJob(job);
      const existing = state.applications.find((entry) =>
        entry.job.sourceUrl && entry.job.sourceUrl === normalized.sourceUrl && entry.job.title === normalized.title);
      if (existing) return clone(existing);
      const now = Date.now();
      const application = {
        id: `app-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
        job: normalized,
        status: "planned",
        note: "",
        resumeId: state.profile.resumeId,
        resumeTitle: "",
        templateId: "",
        materials: null,
        resumeHtml: "",
        resumePdfPath: "",
        evidence: emptyEvidence(),
        createdAt: now,
        updatedAt: now,
        preparedAt: 0,
        submittedAt: 0,
      };
      state.applications.unshift(application);
      await this.persist(state);
      return clone(application);
    });
  }

  async removeApplication(id) {
    return this.enqueue(async () => {
      const state = await this.load();
      state.applications = state.applications.filter((entry) => entry.id !== id);
      await this.persist(state);
      return { removed: true };
    });
  }

  async markRun() {
    return this.enqueue(async () => {
      const state = await this.load();
      state.lastRunAt = Date.now();
      await this.persist(state);
    });
  }

  /** 与宿主 store.updateApplication 语义一致：没传的字段保持原值，不整条覆盖。 */
  async updateApplication(id, patch) {
    return this.enqueue(async () => {
      const state = await this.load();
      const index = state.applications.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("投递记录不存在或已删除");
      const current = state.applications[index];
      const source = patch && typeof patch === "object" ? patch : {};
      const html = String(source.resumeHtml ?? "");
      const next = {
        ...current,
        status: STATUSES.includes(source.status) ? source.status : current.status,
        note: source.note === undefined ? current.note : asText(source.note, 2000),
        resumeId: source.resumeId === undefined ? current.resumeId : asText(source.resumeId, 64),
        resumeTitle: source.resumeTitle === undefined ? current.resumeTitle : asText(source.resumeTitle, 160),
        templateId: source.templateId === undefined ? current.templateId : asText(source.templateId, 40),
        materials: source.materials === undefined ? current.materials : normalizeMaterials(source.materials),
        resumeHtml: source.resumeHtml === undefined
          ? current.resumeHtml
          : Buffer.byteLength(html, "utf8") <= MAX_HTML_BYTES
            ? html
            : (() => { throw new Error("简历 HTML 超过 4 MB，无法写入投递记录"); })(),
        resumePdfPath: source.resumePdfPath === undefined ? current.resumePdfPath : asText(source.resumePdfPath, 1000),
        evidence: source.evidence === undefined ? current.evidence : normalizeEvidence(source.evidence),
        job: source.job === undefined ? current.job : normalizeJob(source.job),
        preparedAt: source.preparedAt === undefined ? current.preparedAt : Number(source.preparedAt) || current.preparedAt,
        submittedAt: source.submittedAt === undefined ? current.submittedAt : Number(source.submittedAt) || current.submittedAt,
        updatedAt: Date.now(),
      };
      state.applications[index] = next;
      if (next.status === "submitted") state.lastRunAt = Date.now();
      await this.persist(state);
      return clone(next);
    });
  }
}
