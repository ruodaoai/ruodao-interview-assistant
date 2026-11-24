import fs from "node:fs/promises";
import path from "node:path";
import {
  JOB_SITES,
  JobSiteSearchEngine,
  applyJobSite,
  applyJobTrust,
  createBrowserDriver,
  filterSiteJobs,
  greetBoss,
  jobHistoryKey,
  jobSiteLabel,
  supportsSiteApply,
  withLocalScore,
} from "./job-engine.mjs";
import { normalizeJob } from "./auto-apply-store.mjs";
import { screenJob } from "./apply-rules.mjs";
import { companyNameKey } from "./company-key.mjs";
import { createCompanyIntelView } from "./company-intel-lite.mjs";
import { dailyQuotaKey, evaluateGovernor, nextIntervalMs } from "./governor.mjs";
import { isClosedJobReason, shouldPauseBatch } from "./pause-policy.mjs";
import { startOfDay } from "./outcome-store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function text(value, max = 1000) {
  return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}

function sourceLabel(source) {
  if (source === "boss") return "Boss";
  if (source === "liepin") return "猎聘";
  if (source === "zhaopin") return "智联";
  if (source === "job51") return "前程无忧";
  return "招聘平台";
}

function quotaLabel(source) {
  return dailyQuotaKey(source) === "web" ? "官网网申" : sourceLabel(source);
}

function minMatchScoreOf(rules) {
  return Math.max(0, Math.min(100, Math.round(Number(rules.minMatchScore) || 0)));
}

function matchScoreSkipReason(rules, job) {
  const min = minMatchScoreOf(rules);
  if (!min || job.matchScore === null || job.matchScore === undefined) return "";
  if (job.matchScore >= min) return "";
  return `匹配分 ${job.matchScore} 低于最低匹配分 ${min}`;
}

function batchRevealMode(showBrowserWindow) {
  return showBrowserWindow === false ? "background" : "visible";
}

/**
 * 自动投递编排：从宿主 AutoApplyService 迁到插件侧。
 *
 * 搜岗、投递、打招呼、安全规则、节奏限制、证据与台账都在这里，
 * 宿主只保留通用浏览器驱动。主进程里那份旧实现继续服务内置页兜底，
 * 但新功能只改这一份。
 */
export function createAutoApplyRunner(options) {
  const {
    store,
    tags,
    history,
    outcomes,
    dataRoot,
    hostCall,
    getResumeText,
    greetingFactory,
    log,
  } = options;

  const driver = createBrowserDriver(hostCall);
  const engine = new JobSiteSearchEngine({ driver, log });
  const companyIntel = createCompanyIntelView(dataRoot, log);
  const governorState = {
    lastGreetAt: 0,
    sites: new Map(),
    lastDecision: null,
    intervalKey: 0,
    intervalGapMs: 0,
  };
  /** 手动单条投递的执行锁；批量队列走自己的 fromBatch 通道。 */
  let active = false;

  function siteGuard(source) {
    const key = dailyQuotaKey(source);
    const existing = governorState.sites.get(key);
    if (existing) return existing;
    const created = { failures: 0, unconfirmed: 0, cooldownUntil: 0 };
    governorState.sites.set(key, created);
    return created;
  }

  function resetGuards(sources, reason, guardOptions = {}) {
    for (const source of new Set([...sources].map((entry) => dailyQuotaKey(entry)))) {
      const guard = siteGuard(source);
      if (guard.failures || guard.unconfirmed || guard.cooldownUntil) {
        log(`governor ${source} reset (${reason}): failures=${guard.failures} unconfirmed=${guard.unconfirmed} cooldown=${Math.max(0, guard.cooldownUntil - Date.now())}ms`);
      }
      guard.failures = 0;
      guard.unconfirmed = 0;
      if (guardOptions.cooldown) guard.cooldownUntil = 0;
    }
  }

  async function withJobTags(jobs) {
    if (!jobs.length) return jobs;
    await tags.ready();
    return jobs.map((job) => {
      const key = jobHistoryKey(job);
      const entry = tags.get(key);
      return entry ? { ...job, jobTagKey: key, userTags: entry.tags } : job;
    });
  }

  async function assessJobs(jobs) {
    if (!jobs.length) return jobs;
    const keys = jobs.map((job) => jobHistoryKey(job));
    const sightings = await history
      .observe(jobs.map((job, index) => ({ key: keys[index], postedAt: job.postedAt ?? null })))
      .catch(() => ({}));
    return jobs.map((job, index) => applyJobTrust(job, sightings[keys[index]]));
  }

  async function assessJob(job) {
    const [assessed] = await assessJobs([job]);
    return assessed ?? job;
  }

  function companyLastContactAt(state, key, fallback = 0) {
    if (!key) return fallback;
    return state.applications.reduce((max, entry) => {
      if (entry.status !== "submitted" && entry.status !== "needs_user") return max;
      if (companyNameKey(entry.job.company) !== key) return max;
      const at = entry.submittedAt || entry.evidence?.endedAt || entry.updatedAt || 0;
      return Math.max(max, at);
    }, fallback);
  }

  async function governorDecision(job) {
    const state = await store.state();
    const rules = state.rules;
    const now = Date.now();
    const submittedToday = state.applications.filter((entry) => entry.status === "submitted" && entry.submittedAt >= startOfDay(now));
    const quotaKey = dailyQuotaKey(job.source);
    const siteSubmitted = submittedToday.filter((entry) => dailyQuotaKey(entry.job.source) === quotaKey);
    const summaries = await outcomes.summaries();
    const key = companyNameKey(job.company);
    const summary = key ? summaries[key] ?? null : null;
    const rejected = Boolean(summary && (summary.blocked > 0 || (rules.autoBlockRejected && summary.rejected > 0)));
    const lastActionAt = governorState.lastGreetAt || submittedToday.reduce((max, entry) => Math.max(max, entry.submittedAt), 0);
    // 间隔只在上次投递时间变化时随机一次：批量队列等待后会重新检查同一岗位，
    // 每次重算随机数会让倒计时跳来跳去，用户根本看不出还要等多久。
    if (lastActionAt !== governorState.intervalKey) {
      governorState.intervalKey = lastActionAt;
      governorState.intervalGapMs = nextIntervalMs({
        intervalMinSeconds: rules.greetIntervalMinSeconds,
        intervalMaxSeconds: rules.greetIntervalMaxSeconds,
      });
    }
    const decision = evaluateGovernor({
      config: {
        window: rules.autoApplyWindow,
        intervalMinSeconds: rules.greetIntervalMinSeconds,
        intervalMaxSeconds: rules.greetIntervalMaxSeconds,
        dailyLimit: rules.dailyLimit,
        dailyCompanyLimit: rules.dailyCompanyLimit,
        companyCooldownDays: rules.companyCooldownDays,
      },
      now,
      lastActionAt,
      gapMs: governorState.intervalGapMs,
      todayCount: siteSubmitted.length,
      todayCompanies: siteSubmitted.map((entry) => companyNameKey(entry.job.company)).filter(Boolean),
      company: key,
      companyLastAt: companyLastContactAt(state, key, summary?.lastAt ?? 0),
      companyOutcome: summary && summary.blocked > 0 ? "blocked" : rejected ? "rejected" : "",
      consecutiveFailures: siteGuard(job.source).failures,
      cooldownUntil: siteGuard(job.source).cooldownUntil,
      siteLabel: quotaLabel(job.source),
    });
    governorState.lastDecision = decision;
    return decision;
  }

  async function recordOutcome(input) {
    const note = [input.note, input.platform].filter(Boolean).join(" · ");
    return outcomes.record({
      company: input.company,
      jobTitle: input.jobTitle,
      sourceUrl: input.sourceUrl,
      recruiter: input.recruiter,
      source: input.platform,
      outcome: input.outcome,
      note,
    });
  }

  async function deliverWebhook(url, app) {
    if (!/^https?:\/\//i.test(String(url ?? ""))) return;
    const at = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const content = [
      "【若道招聘】已发送 Boss 打招呼",
      `岗位：${app.job.title}`,
      `公司：${app.job.company || "未公开"}`,
      `城市：${app.job.city || "未标注"}`,
      app.job.salaryLabel ? `薪资：${app.job.salaryLabel}` : "",
      app.job.sourceUrl ? `链接：${app.job.sourceUrl}` : "",
      `时间：${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
      "请在 Boss 聊天窗口核对消息是否已发出。",
    ].filter(Boolean).join("\n");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) log(`webhook notify failed: HTTP ${response.status}`);
    } catch (error) {
      log(`webhook notify failed: ${text(error?.message ?? error, 200)}`);
    }
  }

  /**
   * 岗位搜索：平台抓取（引擎）+ 本地准入、过滤、匹配分、长期挂岗识别。
   * 与宿主 searchJobSite 保持同一顺序，界面看到的筛选明细才不会对不上。
   */
  async function search(raw) {
    const state = await store.state();
    const profile = state.profile;
    const resumeText = await getResumeText(profile.resumeId).catch(() => "");
    const { llm, ...query } = raw ?? {};
    const result = await engine.search(query);
    if (!result.items.length) return result;
    const taggedItems = await withJobTags(result.items);
    let safetyBlocked = 0;
    let keywordOutsource = 0;
    const rejectedItems = [];
    const screened = taggedItems.filter((job) => {
      const reason = screenJob(state.rules, job);
      if (reason) {
        const outsource = reason.includes("外包 / 驻场过滤");
        if (outsource) keywordOutsource += 1;
        else safetyBlocked += 1;
        rejectedItems.push({ job, reason, category: outsource ? "outsource" : "safety" });
      }
      return !reason;
    });
    const blocked = safetyBlocked + keywordOutsource;
    const { items: kept, filtered, rejected } = filterSiteJobs(screened, state.rules, profile);
    let salaryFiltered = 0;
    let filteredOutsource = 0;
    for (const entry of rejected) {
      if (entry.category === "salary") salaryFiltered += 1;
      else if (entry.category === "outsource") filteredOutsource += 1;
      rejectedItems.push({ job: entry.job, reason: entry.reason, category: entry.category });
    }
    const profileReady = Boolean(profile.name || profile.summary || profile.skills.length || profile.targetRoles.length || profile.resumeId);
    const scored = kept.map((job) => {
      if (!profileReady) return job;
      const local = withLocalScore(profile, job, resumeText);
      return {
        ...job,
        matchScore: local.matchScore,
        verdict: local.verdict,
        reasons: local.reasons,
        gaps: local.gaps,
      };
    });
    let scoreFiltered = 0;
    const scoreFilteredItems = [];
    const aboveMinScore = scored.filter((job) => {
      const reason = matchScoreSkipReason(state.rules, job);
      if (!reason) return true;
      scoreFiltered += 1;
      scoreFilteredItems.push({ job, reason, category: "score" });
      return false;
    });
    if (profileReady) aboveMinScore.sort((left, right) => (right.matchScore ?? 0) - (left.matchScore ?? 0));
    const assessed = await assessJobs(aboveMinScore);
    let intelFiltered = 0;
    const intelFilteredItems = [];
    const annotated = await companyIntel.annotate(assessed).catch((error) => {
      log(`company intel failed: ${text(error?.message ?? error, 160)}`);
      return assessed;
    });
    const withIntel = annotated.filter((job) => {
      // 只有「本地规则 + 云端多人反馈 + 模型」给出较确定结论时才自动隐藏，避免误杀。
      if (!state.rules.filterOutsource) return true;
      const intel = job.companyIntel;
      if (!intel?.isOutsource) return true;
      const sources = Array.isArray(intel.sources) ? intel.sources : [];
      const confirmed = sources.includes("cloud") || Number(intel.reportCount) > 0;
      if (!confirmed && Number(intel.outsourceConfidence ?? 0) < 70) return true;
      intelFiltered += 1;
      intelFilteredItems.push({
        job,
        reason: `公司被${sources.includes("cloud") ? "云端多人反馈" : "模型"}判定为疑似外包${intel.outsourceConfidence ? `（置信度 ${intel.outsourceConfidence}%）` : ""}`,
        category: "outsource",
      });
      return false;
    });
    const extraFiltered = blocked + filtered + scoreFiltered + intelFiltered;
    const salaryRange = state.rules.salaryMin > 0 || state.rules.salaryMax > 0
      ? `${state.rules.salaryMin > 0 ? state.rules.salaryMin : "不限"}-${state.rules.salaryMax > 0 ? state.rules.salaryMax : "不限"}K/月`
      : "";
    const filteredNotes = [
      salaryFiltered ? `${salaryFiltered} 个薪资不在期望范围 ${salaryRange}` : "",
      scoreFiltered ? `${scoreFiltered} 个匹配分低于 ${minMatchScoreOf(state.rules)}` : "",
      intelFiltered ? `${intelFiltered} 家疑似外包公司` : "",
    ].filter(Boolean).join("，");
    return {
      ...result,
      items: withIntel,
      total: withIntel.length,
      filtered: result.filtered + extraFiltered,
      filteredDetail: {
        duplicate: result.filteredDetail?.duplicate ?? 0,
        city: result.filteredDetail?.city ?? 0,
        safety: safetyBlocked + filtered - salaryFiltered - filteredOutsource,
        outsource: keywordOutsource + filteredOutsource + intelFiltered,
        salary: salaryFiltered,
        score: scoreFiltered,
      },
      filteredItems: [...(result.filteredItems ?? []), ...rejectedItems, ...scoreFilteredItems, ...intelFilteredItems].slice(0, 120),
      message: extraFiltered
        ? `${result.message}；已按安全规则与过滤条件隐藏 ${extraFiltered} 个岗位${filteredNotes ? `（其中 ${filteredNotes}）` : ""}`
        : result.message,
    };
  }

  /** 单岗核实：打开详情页读取真实薪资、招聘者活跃度与在招状态，再重算真实度。 */
  async function verify(rawJob) {
    const job = normalizeJob(rawJob);
    if (job.source === "template" || job.source === "manual") throw new Error("只有招聘平台岗位支持核实在招状态");
    const enrichment = await engine.enrich(job).catch(() => null);
    const assessed = await assessJob(enrichment ? { ...job, ...enrichment } : job);
    const [tagged] = await withJobTags([assessed]);
    return tagged ?? assessed;
  }

  async function addApplication(job) {
    const app = await store.addApplication(job);
    return app;
  }

  async function renderResumeImage(html, file) {
    try {
      const result = await hostCall("autoApply.renderResumeImage", { html, file }, 120_000);
      return Boolean(result?.ok);
    } catch (error) {
      log(`resume image host capability unavailable: ${text(error?.message ?? error, 200)}`);
      return false;
    }
  }

  /**
   * 非 Boss 平台直接投递简历（猎聘 / 智联 / 前程无忧）。
   * 与宿主 applySite 同语义：先过安全规则与节奏闸门，再执行平台动作并回写证据。
   */
  async function applySite(input, runOptions = {}) {
    if (active && !runOptions.fromBatch) throw new Error("已有投递任务在执行，请等当前任务结束");
    if (runOptions.signal?.aborted) throw new Error("投递任务已停止");
    const state = await store.state();
    const rawJob = normalizeJob(input?.job);
    if (!supportsSiteApply(rawJob.source)) {
      throw new Error(`${rawJob.source === "boss" ? "Boss直聘" : "这个平台"}不支持直接投递简历${rawJob.source === "boss" ? "，请用「打招呼」" : ""}`);
    }
    if (!rawJob.sourceUrl) throw new Error("岗位缺少官方链接，无法投递");
    const blocked = screenJob(state.rules, rawJob);
    if (blocked) throw new Error(`已按安全规则拦截：${blocked}`);
    if (!runOptions.fromBatch) {
      const decision = await governorDecision(rawJob);
      if (!decision.allowed) throw new Error(`${decision.reason || "当前不满足投递条件"}；如有需要可在「安全规则」里调整投递时段与节奏`);
    }

    const app = await addApplication(rawJob);
    if (app.status === "submitted" && !state.rules.allowRepeatChat) {
      throw new Error("这个岗位已经投递过。如需重复投递，请先在「安全规则」里开启「允许重复沟通」");
    }
    const markActive = !runOptions.fromBatch;
    if (markActive) active = true;
    const startedAt = Date.now();
    const runLog = [];
    const runLogPush = (message) => {
      runLog.push({ at: Date.now(), message: text(message, 300) });
      log(`${app.id}: ${message}`);
      runOptions.onProgress?.(text(message, 160));
    };
    const evidenceDir = path.join(dataRoot, "evidence", app.id);
    const greetingResolver = async () => {
      try {
        const crafted = await greetingFactory({ job: rawJob });
        runLogPush(`岗位没有投递按钮，已准备「聊一聊」开场话术（${crafted.mode}）`);
        return crafted.text;
      } catch (error) {
        log(`${rawJob.source} greeting failed: ${text(error?.message ?? error, 160)}`);
        return "";
      }
    };
    try {
      await fs.mkdir(evidenceDir, { recursive: true });
      const result = await applyJobSite(engine, driver, {
        job: { ...app.job, ...rawJob, description: rawJob.description || app.job.description },
        evidenceDir,
        log: runLogPush,
        resumeFilePath: input.attachResume ? app.resumePdfPath : "",
        greeting: greetingResolver,
        signal: runOptions.signal,
        reveal: runOptions.fromBatch ? batchRevealMode(state.rules.showBrowserWindow) : "focus",
      });
      const submitted = result.state === "submitted" || result.state === "already";
      const status = submitted
        ? "submitted"
        : result.state === "needs_user"
          ? "needs_user"
          : result.state === "blocked"
            ? "blocked"
            : "failed";
      const updated = await store.updateApplication(app.id, {
        status,
        submittedAt: submitted ? (app.submittedAt || Date.now()) : app.submittedAt,
        note: result.message,
        evidence: {
          screenshots: result.screenshots.slice(-20),
          log: [...app.evidence.log, ...runLog].slice(-80),
          filled: [],
          finalUrl: result.finalUrl,
          pageTitle: "",
          blockedReason: result.blockedReason,
          successText: result.successText,
          greeting: "",
          greetingSource: "",
          verifiedAt: 0,
          verifySource: "",
          verifyNote: "",
          startedAt,
          endedAt: Date.now(),
        },
      });
      if (submitted) {
        await store.markRun();
        siteGuard(rawJob.source).failures = 0;
        governorState.lastGreetAt = Date.now();
        await recordOutcome({
          company: updated.job.company,
          jobTitle: updated.job.title,
          sourceUrl: updated.job.sourceUrl,
          recruiter: updated.job.recruiter,
          platform: updated.job.source,
          outcome: "applied",
          note: result.state === "already" ? "平台显示已投递（未重复提交）" : "自动投递简历成功",
        }).catch((error) => log(`outcome record failed: ${text(error?.message ?? error, 160)}`));
        if (state.rules.notifyWebhook) void deliverWebhook(state.rules.notifyWebhook, updated);
      } else if (status === "needs_user") {
        if (shouldPauseBatch({ state: result.state, blockedReason: result.blockedReason })) {
          const guard = siteGuard(rawJob.source);
          guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
        }
      } else if (status === "failed" && !isClosedJobReason(result.blockedReason) && !runOptions.fromBatch) {
        siteGuard(rawJob.source).failures += 1;
      }
      return {
        application: updated,
        run: {
          state: submitted ? "submitted" : result.state === "needs_user" ? "needs_user" : result.state === "blocked" ? "blocked" : "failed",
          message: result.message,
          filled: 0,
          blockedReason: result.blockedReason,
          successText: result.successText,
          screenshots: result.screenshots,
        },
      };
    } catch (error) {
      const aborted = runOptions.signal?.aborted === true;
      const message = aborted ? "投递已中止（批量任务被停止或招聘窗口被关闭）" : text(error?.message ?? error, 500);
      const updated = await store.updateApplication(app.id, {
        status: aborted ? "needs_user" : "failed",
        note: aborted ? message : `投递简历失败：${message}`,
        evidence: {
          ...app.evidence,
          blockedReason: message,
          startedAt,
          endedAt: Date.now(),
          log: [...app.evidence.log, ...runLog, { at: Date.now(), message: aborted ? message : `执行失败：${message}` }].slice(-80),
        },
      });
      return {
        application: updated,
        run: {
          state: aborted ? "needs_user" : "failed",
          message: aborted ? message : `投递简历失败：${message}`,
          filled: 0,
          blockedReason: message,
          successText: "",
          screenshots: [],
        },
      };
    } finally {
      if (markActive) active = false;
    }
  }

  /** Boss 打招呼：复用引擎里的聊天窗口识别、探测与回执校验。 */
  async function greet(input, runOptions = {}) {
    const greeting = text(input?.greeting, 500);
    if (!greeting) throw new Error("请先填写打招呼内容");
    if (active && !runOptions.fromBatch) throw new Error("已有投递任务在执行，请等当前任务结束");
    if (runOptions.signal?.aborted) throw new Error("投递任务已停止");
    const state = await store.state();
    const rawJob = normalizeJob(input?.job);
    if (rawJob.source !== "boss") throw new Error("目前只有 Boss直聘支持自动打招呼");
    const blocked = screenJob(state.rules, rawJob);
    if (blocked) throw new Error(`已按安全规则拦截：${blocked}`);
    if (!runOptions.fromBatch) {
      const decision = await governorDecision(rawJob);
      if (!decision.allowed) throw new Error(`${decision.reason || "当前不满足投递条件"}；如有需要可在「安全规则」里调整投递时段与节奏`);
    }

    const app = await addApplication(rawJob);
    if (app.status === "submitted" && !state.rules.allowRepeatChat) {
      throw new Error("这个岗位已经打过招呼。如需重复沟通，请先在「安全规则」里开启「允许重复沟通」");
    }
    const sendImage = input.sendImageResume === true;
    const resumeHtml = text(input.resumeHtml, 4_000_000) || app.resumeHtml;
    if (sendImage && !resumeHtml.trim()) throw new Error("发送图片简历需要先生成简历 HTML，请先在简历管理里选择一份简历");

    const markActive = !runOptions.fromBatch;
    if (markActive) active = true;
    const startedAt = Date.now();
    const runLog = [];
    const runLogPush = (message) => {
      runLog.push({ at: Date.now(), message: text(message, 300) });
      log(`${app.id}: ${message}`);
      runOptions.onProgress?.(text(message, 160));
    };
    const evidenceDir = path.join(dataRoot, "evidence", app.id);
    try {
      await fs.mkdir(evidenceDir, { recursive: true });
      let imagePath = "";
      if (sendImage) {
        imagePath = path.join(evidenceDir, `resume-image-${Date.now()}.png`);
        const ok = await renderResumeImage(resumeHtml, imagePath);
        if (ok) runLogPush("已生成图片简历");
        else {
          imagePath = "";
          runLogPush("图片简历生成失败，将继续发送文字招呼");
        }
      }
      const result = await greetBoss(engine, driver, {
        job: { ...app.job, ...rawJob, description: rawJob.description || app.job.description },
        greeting,
        imagePath,
        evidenceDir,
        log: runLogPush,
        signal: runOptions.signal,
        reveal: runOptions.fromBatch ? batchRevealMode(state.rules.showBrowserWindow) : "focus",
        allowRepeatChat: state.rules.allowRepeatChat,
      });
      const status = result.state === "sent"
        ? "submitted"
        : result.state === "needs_user"
          ? "needs_user"
          : result.state === "blocked"
            ? "blocked"
            : "failed";
      const updated = await store.updateApplication(app.id, {
        resumeHtml,
        resumeId: text(input.resumeId, 64) || app.resumeId || state.profile.resumeId,
        resumeTitle: text(input.resumeTitle, 160) || app.resumeTitle,
        status,
        submittedAt: status === "submitted" ? Date.now() : app.submittedAt,
        note: result.message,
        evidence: {
          screenshots: result.screenshots.slice(-20),
          log: [...app.evidence.log, ...runLog].slice(-80),
          filled: [],
          finalUrl: result.finalUrl,
          pageTitle: "",
          blockedReason: result.blockedReason,
          successText: result.successText,
          greeting: text(result.greeting ?? "", 500),
          greetingSource: result.greetingSource ?? "",
          verifiedAt: 0,
          verifySource: "",
          verifyNote: "",
          startedAt,
          endedAt: Date.now(),
        },
      });
      if (status === "submitted") {
        await store.markRun();
        siteGuard(rawJob.source).failures = 0;
        governorState.lastGreetAt = Date.now();
        await recordOutcome({
          company: updated.job.company,
          jobTitle: updated.job.title,
          sourceUrl: updated.job.sourceUrl,
          recruiter: updated.job.recruiter,
          platform: updated.job.source,
          outcome: "applied",
          note: result.greetingSource === "already"
            ? "Boss 显示已沟通过（历史记录，本次未重复发送）"
            : result.greeting
              ? `自动打招呼成功：${text(result.greeting, 120)}`
              : "自动打招呼成功",
        }).catch((error) => log(`outcome record failed: ${text(error?.message ?? error, 160)}`));
        if (state.rules.notifyWebhook) void deliverWebhook(state.rules.notifyWebhook, updated);
      } else if (status === "needs_user") {
        if (shouldPauseBatch({ state: result.state, blockedReason: result.blockedReason })) {
          const guard = siteGuard(rawJob.source);
          guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
        }
      } else if (status === "failed" && !isClosedJobReason(result.blockedReason) && !runOptions.fromBatch) {
        siteGuard(rawJob.source).failures += 1;
      }
      return {
        application: updated,
        run: {
          state: result.state === "sent" ? "submitted" : result.state,
          message: result.message,
          filled: 0,
          blockedReason: result.blockedReason,
          successText: result.successText,
          screenshots: result.screenshots,
        },
      };
    } catch (error) {
      const aborted = runOptions.signal?.aborted === true;
      const message = aborted ? "投递已中止（批量任务被停止或 Boss 窗口被关闭）" : text(error?.message ?? error, 500);
      const updated = await store.updateApplication(app.id, {
        status: aborted ? "needs_user" : "failed",
        note: aborted ? message : `Boss 打招呼失败：${message}`,
        evidence: {
          ...app.evidence,
          blockedReason: message,
          startedAt,
          endedAt: Date.now(),
          log: [...app.evidence.log, ...runLog, { at: Date.now(), message: aborted ? message : `执行失败：${message}` }].slice(-80),
        },
      });
      return {
        application: updated,
        run: {
          state: aborted ? "needs_user" : "failed",
          message: aborted ? message : `Boss 打招呼失败：${message}`,
          filled: 0,
          blockedReason: message,
          successText: "",
          screenshots: [],
        },
      };
    } finally {
      if (markActive) active = false;
    }
  }

  return {
    engine,
    driver,
    search,
    verify,
    governorDecision,
    resetGuards,
    siteGuard,
    recordOutcome,
    deliverWebhook,
    companyIntel,
    applySite,
    greet,
    isActive: () => active,
    statuses: () => engine.statuses(),
    refreshStatuses: () => engine.refresh(),
    openSite: (site) => engine.open(site),
    closeSite: (site) => engine.close(site),
    enrich: (job) => engine.enrich(job),
    jobLabelOf: (site) => JOB_SITES[site]?.label ?? jobSiteLabel(site),
    governorSnapshot: () => governorState.lastDecision,
    lastGreetAt: () => governorState.lastGreetAt,
  };
}
