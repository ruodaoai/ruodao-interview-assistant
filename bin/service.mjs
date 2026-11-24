#!/usr/bin/env node
/**
 * 面试助手常驻服务。
 *
 * 宿主只负责拉起进程、转发消息，业务规则都在这里：简历库读写、字段清洗、
 * 修改历史上限、重复副本等。协议为 stdin/stdout 一行一个 JSON：
 *   宿主 → 服务: {type:"init", payload} | {type:"request", id, method, params}
 *               | {type:"response", id, ok, result?, error?} | {type:"shutdown"}
 *   服务 → 宿主: {type:"ready", payload?} | {type:"event", event, payload}
 *               | {type:"response", id, ok, result?, error?}
 *               | {type:"request", id, method, params}
 *
 * 数据目录：优先使用宿主 userData 下的 resume-store，让自动投递、数据备份
 * 等宿主能力继续读同一份文件；独立运行时退回插件自己的数据目录。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ResumeStore } from "../lib/resume-store.mjs";
import { AutoApplyStore, normalizeJob } from "../lib/auto-apply-store.mjs";
import { createAutoApplyRunner } from "../lib/auto-apply-runner.mjs";
import { createBatchOrchestrator } from "../lib/batch-orchestrator.mjs";
import { companyNameKey, isAnonymousCompany } from "../lib/company-key.mjs";
import { JobHistoryStore } from "../lib/job-history.mjs";
import { OutcomeStore } from "../lib/outcome-store.mjs";
import { JobTagStore, jobHistoryKey } from "../lib/job-tags.mjs";
import { mapResumeToProfile, mergeResumeIntoProfile } from "../lib/profile-sync.mjs";
import { InterviewSessionStore } from "../lib/interview-session-store.mjs";
import { resumeToText, runResumeAi } from "../lib/resume-ai.mjs";
import { craftGreeting, polishGreeting } from "../lib/greeting.mjs";
import { localAssistantReply, runJobAssistant } from "../lib/job-assistant.mjs";
import { mergeAnswers, tailorMaterials } from "../lib/tailor.mjs";
import { questionsFor, screenJob } from "../lib/apply-rules.mjs";

const MAX_LINE_CHARS = 16 * 1024 * 1024;
const HOST_REQUEST_TIMEOUT_MS = 60_000;
const LLM_REQUEST_TIMEOUT_MS = 240_000;

const store = new ResumeStore(resolveStoreRoot());
const autoApplyStore = new AutoApplyStore(resolveUserDataPath("auto-apply"));
const jobTags = new JobTagStore(resolveUserDataPath(path.join("auto-apply", "job-tags.json")));
const jobHistory = new JobHistoryStore(resolveUserDataPath(path.join("auto-apply", "job-history.json")));
const autoApplyOutcomes = new OutcomeStore(resolveUserDataPath(path.join("auto-apply", "outcomes.json")));
const interviewSessions = new InterviewSessionStore(resolveUserDataPath("interview-sessions"));
let hostSeq = 0;
const hostPending = new Map();
const inflight = new Set();
let initialized = false;

/** 宿主 userData 下的共享路径；独立运行时退回插件自己的数据目录。 */
function resolveUserDataPath(relative) {
  const userDataDir = String(process.env.RUODAO_USER_DATA_DIR ?? "").trim();
  if (userDataDir) return path.join(userDataDir, relative);
  const pluginDataDir = String(process.env.RUODAO_PLUGIN_DATA_DIR ?? "").trim();
  if (pluginDataDir) return path.join(pluginDataDir, relative);
  return path.join(process.cwd(), ".data", relative);
}

function resolveStoreRoot() {
  return resolveUserDataPath("resume-store");
}

function emit(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* 宿主已退出，stdin 的 close 会触发进程回收 */
  }
}

function log(line) {
  const text = String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (text) process.stderr.write(`[interview-service] ${text}\n`);
}

function asText(value, max = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// 猎聘已下线：不再接受它的开窗/搜索请求，历史投递记录仍按原平台名展示。
const SITE_IDS = ["boss", "zhaopin", "job51"];

function asSiteId(value) {
  const site = asText(value, 20);
  if (!SITE_IDS.includes(site)) throw new Error("不支持的招聘平台");
  return site;
}

/** 反向请求宿主：写入后让宿主的简历缓存失效，并把新简历挂到求职档案。 */
function hostRequest(method, params, timeoutMs = HOST_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = `h${++hostSeq}`;
    const timer = setTimeout(() => {
      if (!hostPending.has(id)) return;
      hostPending.delete(id);
      reject(new Error(`宿主未在 ${timeoutMs}ms 内响应：${method}`));
    }, timeoutMs);
    hostPending.set(id, { resolve, reject, timer });
    emit({ type: "request", id, method, params });
  });
}

function bindingOf(input) {
  return input?.llm && typeof input.llm === "object" ? input.llm : undefined;
}

/**
 * 模型凭据与网络重试由宿主 llm.chat 负责，提示词与清洗留在插件。
 * 先问 llm.available：没配置模型时直接走本地兜底，不必白等一次失败请求；
 * 旧宿主没有该能力时按可用处理，真正的调用失败仍由各业务函数兜底。
 */
async function chatFor(binding) {
  try {
    const status = await hostRequest("llm.available", binding ? { binding } : {}, 15_000);
    if (status && status.available === false) return null;
  } catch {
    /* 旧宿主未开放 llm.available，按可用处理 */
  }
  return (params) => hostRequest("llm.chat", { ...params, ...(binding ? { binding } : {}) }, LLM_REQUEST_TIMEOUT_MS);
}

async function siteStatuses() {
  try {
    const result = await hostRequest("jobSites.status", {}, 15_000);
    return Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    log(`job site status unavailable: ${asText(error?.message ?? error, 160)}`);
    return [];
  }
}

async function notifyResumeChanged(action, resumeId) {
  emit({ type: "event", event: "resume.changed", payload: { action, resumeId, at: Date.now() } });
  try {
    await hostRequest("resume.changed", { action, resumeId });
  } catch (error) {
    // 宿主没声明该能力时不影响保存本身；投递档案会在宿主下次读取时按文件内容补齐。
    log(`host notify failed: ${asText(error?.message ?? error)}`);
  }
}

/** 档案/规则/标签写入后让宿主丢弃内存副本，批量执行器下一次判断直接读新值。 */
async function notifyAutoApplyChanged(scope, action) {
  emit({ type: "event", event: "autoApply.changed", payload: { scope, action, at: Date.now() } });
  try {
    await hostRequest("autoApply.changed", { scope, action });
  } catch (error) {
    log(`host auto-apply notify failed: ${asText(error?.message ?? error)}`);
  }
}

/**
 * 招呼语生成：提示词、素材与重复沟通判定都在插件；
 * 投递流程（聊一聊兜底）和界面上的「换一条」复用同一份实现。
 */
async function craftGreetingForJob(rawJob, input = {}) {
  const state = await autoApplyStore.state();
  const job = normalizeJob(rawJob ?? {});
  const resume = state.profile.resumeId ? await store.get(state.profile.resumeId).catch(() => null) : null;
  const previous = state.applications.filter((entry) =>
    entry.job.sourceUrl && entry.job.sourceUrl === job.sourceUrl && entry.job.title === job.title);
  const repeat = previous.some((entry) => entry.status === "submitted");
  let mode = input.mode ?? state.rules.greetingMode;
  let template = state.rules.greetingTemplate;
  if (repeat && state.rules.repeatMessages.length) {
    mode = "template";
    template = state.rules.repeatMessages[previous.length % state.rules.repeatMessages.length];
  }
  const crafted = await craftGreeting(await chatFor(bindingOf(input)), {
    profile: state.profile,
    resume,
    job,
    mode,
    template,
    repeat,
  });
  return { ...crafted, mode: repeat ? "repeat" : crafted.mode, repeat };
}

/**
 * 招聘平台执行器：搜岗、核实、投递、打招呼全部在插件侧编排；
 * 宿主只执行 browser.* 通用浏览器动作和 HTML 转图片这类底层能力。
 */
const autoApplyRunner = createAutoApplyRunner({
  store: autoApplyStore,
  tags: jobTags,
  history: jobHistory,
  outcomes: autoApplyOutcomes,
  dataRoot: resolveUserDataPath("auto-apply"),
  hostCall: hostRequest,
  getResumeText: async (resumeId) => {
    if (!resumeId) return "";
    const resume = await store.get(resumeId).catch(() => null);
    return resumeToText(resume).slice(0, 16_000);
  },
  greetingFactory: ({ job }) => craftGreetingForJob(job),
  log,
});

const autoApplyOrchestrator = createBatchOrchestrator({
  store: autoApplyStore,
  tags: jobTags,
  outcomes: autoApplyOutcomes,
  dataRoot: resolveUserDataPath("auto-apply"),
  runner: autoApplyRunner,
  greetingFor: ({ job }) => craftGreetingForJob(job),
  chatFor: () => chatFor(),
  log,
});

const handlers = {
  "service.info": async () => ({
    ok: true,
    version: String(process.env.RUODAO_PLUGIN_VERSION ?? ""),
    pid: process.pid,
    dataRoot: store.root,
    methods: Object.keys(handlers),
  }),
  "resume.list": () => store.list(),
  "resume.get": ({ id }) => store.get(asText(id, 64)),
  "resume.save": async ({ document }) => {
    const saved = await store.save(document);
    await notifyResumeChanged("save", saved.item.id);
    return saved;
  },
  "resume.remove": async ({ id }) => {
    const result = await store.remove(asText(id, 64));
    await notifyResumeChanged("remove", asText(id, 64));
    return result;
  },
  "resume.duplicate": async ({ id }) => {
    const copy = await store.duplicate(asText(id, 64));
    await notifyResumeChanged("duplicate", copy.id);
    return copy;
  },
  "resume.prefs.save": ({ prefs }) => store.savePrefs(prefs),
  // 简历 AI：提示词、模式与结果清洗全在插件；宿主只提供通用文本模型能力。
  // 推理模型整份诊断可能跑 2 分钟以上，反向请求要留够 240 秒。
  "resume.ai": async ({ input } = {}) => {
    const payload = input && typeof input === "object" ? input : {};
    const binding = payload.llm && typeof payload.llm === "object" ? payload.llm : undefined;
    return runResumeAi(
      (params) => hostRequest("llm.chat", { ...params, ...(binding ? { binding } : {}) }, 240_000),
      payload,
      (line) => log(`[resume-ai] ${line}`),
    );
  },

  // ── 自动投递：档案、安全规则、简历同步、岗位标签。
  // 数据文件与宿主执行器共用；写完后反向通知宿主刷新缓存。
  "autoApply.state": () => autoApplyStore.state(),
  "autoApply.profile.save": async ({ profile }) => {
    const saved = await autoApplyStore.saveProfile(profile);
    await notifyAutoApplyChanged("profile", "save");
    return saved;
  },
  "autoApply.rules.save": async ({ rules }) => {
    const saved = await autoApplyStore.saveRules(rules);
    await notifyAutoApplyChanged("rules", "save");
    // 用户可能把某家公司临时加进屏蔽名单：排队项要立刻显示跳过，不能继续挂着「排队中」。
    await autoApplyOrchestrator.refreshBatchSkips();
    return saved;
  },
  "autoApply.profile.sync": async ({ input } = {}) => {
    const state = await autoApplyStore.state();
    const resumeId = asText(input?.resumeId, 64) || state.profile.resumeId;
    if (!resumeId) throw new Error("请先选择一份简历，再同步到求职档案");
    const resume = await store.get(resumeId);
    if (!resume) throw new Error("这份简历已不存在，请到「简历管理」重新选择");
    const overwrite = input?.overwrite === true;
    const base = input?.base && typeof input.base === "object"
      ? { ...state.profile, ...input.base, resumeId }
      : { ...state.profile, resumeId };
    const merged = mergeResumeIntoProfile(base, mapResumeToProfile(resume), overwrite ? "overwrite" : "fill-empty", resumeId);
    const saved = await autoApplyStore.saveProfile(merged.profile);
    await notifyAutoApplyChanged("profile", "sync");
    return {
      profile: saved,
      filled: merged.filled,
      resumeTitle: asText(resume?.title, 120) || "未命名简历",
      overwrite,
    };
  },
  // ── 招呼语、求职小助手与投递材料：提示词、素材拼装、重复沟通判定都在插件；
  // 宿主只提供通用模型调用（llm.chat）、站点状态与平台详情页读取（jobSites.*）。
  "autoApply.greeting": async (input = {}) => {
    const crafted = await craftGreetingForJob(input.job, input);
    const state = await autoApplyStore.state();
    return {
      ...crafted,
      mode: crafted.mode,
      repeat: crafted.repeat,
      imageResumeAvailable: Boolean(state.profile.resumeId),
    };
  },
  "autoApply.greeting.polish": async (input = {}) => {
    const state = await autoApplyStore.state();
    const resume = state.profile.resumeId ? await store.get(state.profile.resumeId).catch(() => null) : null;
    const job = input.job && typeof input.job === "object" ? normalizeJob(input.job) : null;
    const chat = await chatFor(bindingOf(input));
    if (!chat) throw new Error("未找到可用文本模型，请先在「模型管理」里添加并启用一个文本模型");
    return polishGreeting(chat, {
      text: input.text,
      instruction: asText(input.instruction, 500),
      kind: input.kind,
      profile: state.profile,
      resume,
      job,
    });
  },
  "autoApply.assistant": async (input = {}) => {
    const message = asText(input.message, 2000);
    if (!message) throw new Error("请先输入你的求职需求");
    const state = await autoApplyStore.state();
    const resume = state.profile.resumeId ? await store.get(state.profile.resumeId).catch(() => null) : null;
    const history = (Array.isArray(input.history) ? input.history : [])
      .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant") && asText(turn.content, 500))
      .slice(-10)
      .map((turn) => ({ role: turn.role, content: asText(turn.content, 500) }));
    const payload = {
      message,
      history,
      profile: state.profile,
      rules: state.rules,
      resume,
      sites: await siteStatuses(),
      applications: state.applications.slice(0, 20),
    };
    const chat = await chatFor(bindingOf(input));
    if (!chat) return localAssistantReply(payload);
    try {
      return await runJobAssistant(chat, payload);
    } catch (error) {
      log(`assistant failed: ${asText(error?.message ?? error, 200)}`);
      return localAssistantReply(payload, `模型调用失败：${asText(error?.message ?? error, 160)}`);
    }
  },
  "autoApply.materials": async (input = {}) => {
    const id = asText(input.id, 64);
    const app = await autoApplyStore.findApplication(id);
    if (!app) throw new Error("投递记录不存在");
    if (app.status === "submitted") throw new Error("该岗位已投递成功，无需重复生成材料");
    const state = await autoApplyStore.state();
    const profile = state.profile;
    const blocked = screenJob(state.rules, app.job);
    if (blocked) {
      await autoApplyStore.updateApplication(app.id, { status: "blocked", note: blocked });
      await notifyAutoApplyChanged("applications", "block");
      throw new Error(`已按安全规则拦截：${blocked}`);
    }
    let job = app.job;
    const platformJob = job.source !== "template" && job.source !== "manual";
    if (platformJob && !job.description) {
      // 详情页读取也走插件引擎；拿不到就保留列表页字段继续生成。
      try {
        const enrichment = await autoApplyRunner.enrich(job);
        if (enrichment && typeof enrichment === "object") {
          job = normalizeJob({ ...job, ...enrichment });
          await autoApplyStore.updateApplication(app.id, { job });
          log(`enriched ${app.id} from ${job.source}`);
        }
      } catch (error) {
        log(`enrich ${app.id} failed: ${asText(error?.message ?? error, 200)}`);
      }
    }
    const resumeId = asText(input.resumeId, 64) || profile.resumeId || app.resumeId;
    const resume = resumeId ? await store.get(resumeId).catch(() => null) : null;
    if (!resume && !profile.summary && !profile.skills.length) {
      throw new Error("请先在「我的档案」选择一份简历，或填写技能与个人简介");
    }
    const materials = mergeAnswers(profile, await tailorMaterials(await chatFor(bindingOf(input)), {
      profile,
      resume,
      job,
      questions: questionsFor(profile),
    }));
    const updated = await autoApplyStore.updateApplication(app.id, {
      materials,
      resumeId,
      resumeTitle: asText(input.resumeTitle, 160) || app.resumeTitle || asText(resume?.title, 160),
      templateId: asText(input.templateId, 40) || app.templateId || asText(resume?.templateId, 40),
      resumeHtml: String(input.resumeHtml ?? "").slice(0, 4_000_000) || app.resumeHtml,
      status: "prepared",
      preparedAt: Date.now(),
      note: materials.warnings.length ? materials.warnings.join("；") : app.note,
      evidence: {
        ...app.evidence,
        log: [...app.evidence.log, { at: Date.now(), message: `已生成投递材料（${materials.model}）` }].slice(-80),
      },
    });
    await notifyAutoApplyChanged("applications", "prepare");
    log(`prepared ${app.id} (${materials.model})`);
    return updated;
  },
  "autoApply.jobTags.list": async () => {
    const items = await jobTags.list();
    return { items, total: items.length };
  },
  "autoApply.jobTags.save": async ({ job: rawJob, key: rawKey, tags } = {}) => {
    const job = rawJob && typeof rawJob === "object" ? normalizeJob(rawJob) : null;
    const key = asText(rawKey, 240) || (job ? jobHistoryKey(job) : "");
    if (!key) throw new Error("缺少岗位标识，无法保存标签");
    const entry = await jobTags.save({
      key,
      source: job?.source,
      jobId: job?.jobId,
      sourceUrl: job?.sourceUrl,
      company: job?.company,
      title: job?.title,
      city: job?.city,
      tags,
    });
    const items = await jobTags.list();
    await notifyAutoApplyChanged("tags", "save");
    await autoApplyOrchestrator.refreshBatchSkips();
    return { entry, items };
  },

  // ── 招聘平台：窗口、搜岗、核实、打招呼与直接投递。
  // 平台页面上的业务判断在 lib/job-engine.mjs，这里只负责状态、台账与节奏。
  "jobSites.status": async () => ({ items: await autoApplyRunner.statuses() }),
  "jobSites.refresh": async () => ({ items: await autoApplyRunner.refreshStatuses() }),
  "jobSites.open": ({ site } = {}) => autoApplyRunner.openSite(asSiteId(site)),
  "jobSites.close": async ({ site } = {}) => {
    const id = asSiteId(site);
    const result = await autoApplyRunner.closeSite(id);
    // 投递窗口被用户关掉时，批量队列要立刻暂停，不能在后台干等一个不存在的窗口。
    autoApplyOrchestrator.onJobSiteClosed(id);
    return result;
  },
  // 宿主看到招聘窗口被手动关闭（点窗口右上角）时转发过来，语义与插件内关闭一致。
  "jobSites.closed": ({ site } = {}) => {
    autoApplyOrchestrator.onJobSiteClosed(asSiteId(site));
    return { ok: true };
  },
  "jobSites.search": ({ query } = {}) => autoApplyRunner.search(query && typeof query === "object" ? query : {}),
  "jobSites.verify": ({ job } = {}) => autoApplyRunner.verify(job && typeof job === "object" ? job : {}),
  "jobSites.enrich": ({ job } = {}) => autoApplyRunner.enrich(job && typeof job === "object" ? job : {}) ?? null,
  "autoApply.applySite": async ({ input } = {}) => {
    const result = await autoApplyRunner.applySite(input && typeof input === "object" ? input : {}, {});
    await notifyAutoApplyChanged("applications", "apply");
    return result;
  },
  "autoApply.greet": async ({ input } = {}) => {
    const result = await autoApplyRunner.greet(input && typeof input === "object" ? input : {}, {});
    await notifyAutoApplyChanged("applications", "greet");
    return result;
  },

  // ── 批量投递：队列、节奏、准入与结束后的平台记录核对都在插件侧，
  // 宿主只负责浏览器动作与模型调用。队列状态落在共享的 auto-apply/batch-status.json。
  "autoApply.batchStatus": () => autoApplyOrchestrator.status(),
  "autoApply.batchPreflight": ({ jobs } = {}) =>
    autoApplyOrchestrator.preflight(Array.isArray(jobs) ? jobs : []),
  "autoApply.batchStart": ({ jobs, confirm } = {}) =>
    autoApplyOrchestrator.start({ jobs: Array.isArray(jobs) ? jobs : [], confirm: confirm === true }),
  "autoApply.batchPause": () => autoApplyOrchestrator.pause(),
  "autoApply.batchResume": () => autoApplyOrchestrator.resume(),
  "autoApply.batchStop": () => autoApplyOrchestrator.stop(),
  "autoApply.batchForceStop": () => autoApplyOrchestrator.forceStop(),
  "autoApply.batchRecheck": () => autoApplyOrchestrator.recheck(),

  // ── 投递记录增删改与结果台账：文件与宿主的旧实现共用，插件写入后通知宿主刷新缓存。
  "autoApply.add": async ({ job } = {}) => {
    const app = await autoApplyStore.addApplication(job ?? {});
    await notifyAutoApplyChanged("applications", "add");
    return app;
  },
  "autoApply.update": async ({ id, patch } = {}) => {
    const app = await autoApplyStore.updateApplication(asText(id, 64), patch ?? {});
    await notifyAutoApplyChanged("applications", "update");
    return app;
  },
  "autoApply.remove": async ({ id } = {}) => {
    const result = await autoApplyStore.removeApplication(asText(id, 64));
    await notifyAutoApplyChanged("applications", "remove");
    return result;
  },
  "autoApply.markSubmitted": async ({ id, note } = {}) => {
    const app = await autoApplyStore.findApplication(asText(id, 64));
    if (!app) throw new Error("投递记录不存在");
    const message = asText(note, 500) || "已由本人确认投递完成";
    const updated = await autoApplyStore.updateApplication(app.id, {
      status: "submitted",
      submittedAt: Date.now(),
      note: message,
      evidence: {
        ...app.evidence,
        successText: app.evidence.successText || "人工确认已投递",
        endedAt: Date.now(),
        log: [...app.evidence.log, { at: Date.now(), message: asText(note, 300) || "本人标记为已投递" }].slice(-80),
      },
    });
    await autoApplyStore.markRun();
    await notifyAutoApplyChanged("applications", "mark-submitted");
    return updated;
  },
  "autoApply.close": async ({ id } = {}) => {
    const app = await autoApplyStore.findApplication(asText(id, 64));
    if (!app) throw new Error("投递记录不存在");
    const updated = await autoApplyStore.updateApplication(app.id, {
      evidence: {
        ...app.evidence,
        log: [...app.evidence.log, { at: Date.now(), message: "投递窗口已关闭" }].slice(-80),
      },
    });
    await notifyAutoApplyChanged("applications", "close");
    return updated;
  },
  "autoApply.evidence": async ({ id } = {}) => {
    const app = await autoApplyStore.findApplication(asText(id, 64));
    if (!app) throw new Error("投递记录不存在");
    const dir = path.join(resolveUserDataPath("auto-apply"), "evidence", app.id);
    const names = await fs.readdir(dir).catch(() => []);
    const items = [];
    for (const name of names.filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry)).sort().slice(-12)) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > 4_000_000) continue;
      const data = await fs.readFile(file).catch(() => null);
      if (!data) continue;
      const mime = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png";
      items.push({ name, at: stat.mtimeMs, dataUrl: `data:${mime};base64,${data.toString("base64")}` });
    }
    return { items, dir };
  },
  "autoApply.reportOutcome": async (input = {}) => {
    const kinds = ["applied", "interview", "rejected", "blocked", "replied_unfit"];
    if (!kinds.includes(input.outcome)) throw new Error("未知的投递结果类型");
    const state = await autoApplyStore.state();
    let company = asText(input.company, 200);
    let jobTitle = asText(input.jobTitle, 200);
    let sourceUrl = asText(input.sourceUrl, 1000);
    let recruiter = asText(input.recruiter, 120);
    let platform = asText(input.source, 40);
    if (input.applicationId) {
      const app = await autoApplyStore.findApplication(asText(input.applicationId, 64));
      if (!app) throw new Error("投递记录不存在");
      company = company || app.job.company;
      jobTitle = app.job.title;
      sourceUrl = app.job.sourceUrl;
      recruiter = app.job.recruiter ?? "";
      platform = app.job.source;
    }
    if (!company) throw new Error("需要提供公司名");
    if (isAnonymousCompany(company)) throw new Error("匿名公司无法记录结果，请先在投递记录里补全公司名");
    const note = asText(input.note, 500);
    const entry = await autoApplyOutcomes.record({ company, jobTitle, sourceUrl, recruiter, source: platform, outcome: input.outcome, note });
    const rejection = input.outcome === "rejected" || input.outcome === "replied_unfit";
    let blocked = false;
    if (rejection && state.rules.autoBlockRejected) {
      const key = companyNameKey(company);
      const names = [...state.rules.blockedCompanies];
      const notes = { ...(state.rules.blockedCompanyNotes ?? {}) };
      const existing = names.find((entry) => companyNameKey(entry) === key);
      const autoNote = input.outcome === "replied_unfit" ? "对方回复不合适" : "对方明确拒绝";
      if (existing) {
        if (!notes[existing]) notes[existing] = autoNote;
      } else {
        names.push(company);
        notes[company] = autoNote;
      }
      await autoApplyStore.saveRules({ ...state.rules, blockedCompanies: names, blockedCompanyNotes: notes });
      blocked = names.some((entry) => companyNameKey(entry) === key);
    }
    const key = companyNameKey(company);
    const related = state.applications.filter((app) => companyNameKey(app.job.company) === key && app.status !== "blocked");
    for (const app of related) {
      if (rejection) {
        await autoApplyStore.updateApplication(app.id, {
          status: "blocked",
          note: `${input.outcome === "replied_unfit" ? "对方回复不合适" : "对方明确拒绝"}${note ? `：${note}` : ""}`,
        });
      } else if (input.outcome === "interview") {
        await autoApplyStore.updateApplication(app.id, { note: `已进入面试${note ? `：${note}` : ""}` });
      } else if (input.outcome === "applied" && (app.status === "filled" || app.status === "needs_user")) {
        await autoApplyStore.updateApplication(app.id, {
          status: "submitted",
          submittedAt: app.submittedAt || Date.now(),
          note: note || "本人核对后确认招呼已发出",
        });
      }
    }
    await notifyAutoApplyChanged("outcomes", "report");
    // 拒绝/不合适会自动拉黑公司：排队中的同公司岗位要立刻变成跳过。
    await autoApplyOrchestrator.refreshBatchSkips();
    return { entry, summary: await autoApplyOutcomes.summary(company), blocked };
  },
  "autoApply.outcomes": async () => {
    const [all, counts] = await Promise.all([autoApplyOutcomes.summaries(), autoApplyOutcomes.counts()]);
    return {
      today: await autoApplyOutcomes.today(),
      ...counts,
      summaries: Object.values(all).sort((left, right) => right.lastAt - left.lastAt).slice(0, 200),
      recent: await autoApplyOutcomes.list(60),
    };
  },

  // ── 面试场次：复盘页的列表、详情、自评/备注/复盘报告与删除。
  // 录音采集与模拟面试编排仍在宿主（音频、模型是公共底层），
  // 但场次文件由双方按同一份 JSON 读写，操作前都重新读盘。
  "interview.session.start": async ({ jobRole, company } = {}) => {
    const session = await interviewSessions.create({ jobRole, company });
    return { id: session.id, dir: interviewSessions.dir(session.id), startedAt: session.startedAt };
  },
  "interview.session.end": async ({ id } = {}) => {
    const session = await interviewSessions.end(asText(id, 64));
    return {
      id: session.id,
      items: session.turns.filter((turn) => turn.role === "interviewer").length,
      candidateCount: session.turns.filter((turn) => turn.role === "candidate").length,
      dir: interviewSessions.dir(session.id),
      transcriptPath: interviewSessions.transcriptPath(session.id),
    };
  },
  "interview.session.list": () => interviewSessions.list(),
  "interview.session.detail": async ({ id } = {}) => {
    const session = await interviewSessions.detail(asText(id, 64));
    if (!session) throw new Error("面试场次不存在");
    return session;
  },
  "interview.session.remove": async ({ id } = {}) => {
    await interviewSessions.remove(asText(id, 64));
    return { ok: true };
  },
  "interview.session.update": async ({ sessionId, notes, review, turnId, turn } = {}) => {
    const id = asText(sessionId, 64);
    if (!id) throw new Error("缺少面试场次 ID");
    if (turnId && turn && typeof turn === "object") {
      await interviewSessions.updateTurn(id, asText(turnId, 64), turn);
    }
    if (notes !== undefined || review !== undefined) {
      await interviewSessions.updateSession(id, { notes, review });
    }
    await interviewSessions.syncTranscript(id).catch(() => undefined);
    const detail = await interviewSessions.detail(id);
    if (!detail) throw new Error("面试场次不存在");
    return detail;
  },
};

async function handleRequest(message) {
  const id = String(message.id ?? "");
  const method = String(message.method ?? "");
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const handler = handlers[method];
  if (!handler) {
    emit({ type: "response", id, ok: false, error: `不支持的插件服务方法：${method || "(空)"}` });
    return;
  }
  if (!initialized && method !== "service.info") {
    emit({ type: "response", id, ok: false, error: "插件服务尚未初始化" });
    return;
  }
  try {
    const result = await handler(params);
    emit({ type: "response", id, ok: true, result });
  } catch (error) {
    emit({ type: "response", id, ok: false, error: asText(error?.message ?? error) });
  }
}

function handleHostResponse(message) {
  const id = String(message.id ?? "");
  const pending = hostPending.get(id);
  if (!pending) return;
  hostPending.delete(id);
  clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message.result);
  else pending.reject(new Error(asText(message.error) || "宿主调用失败"));
}

function applyInitConfig(payload) {
  const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
  for (const [key, value] of Object.entries(config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) {
      process.env[key] = String(value).trim();
    }
  }
}

function handleInit(message) {
  applyInitConfig(message.payload);
  initialized = true;
  emit({
    type: "ready",
    payload: {
      service: "interview-assistant",
      version: String(process.env.RUODAO_PLUGIN_VERSION ?? ""),
      dataRoot: store.root,
      methods: Object.keys(handlers),
    },
  });
  log(`ready pid=${process.pid} dataRoot=${store.root}`);
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  if (text.length > MAX_LINE_CHARS) {
    log(`单行消息超过 ${MAX_LINE_CHARS} 字符，已丢弃`);
    return;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log(`收到非 JSON 输入：${text.slice(0, 200)}`);
    return;
  }
  if (!message || typeof message !== "object") return;
  const type = String(message.type ?? "");
  if (type === "init") handleInit(message);
  else if (type === "request") {
    const task = handleRequest(message);
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  } else if (type === "response") handleHostResponse(message);
  else if (type === "shutdown") {
    void shutdown();
  } else {
    log(`未知消息类型：${type || "(空)"}`);
  }
});

async function shutdown() {
  // 先让在途请求把响应写完，再等写入队列落盘，避免宿主 stop 时丢掉最后一次保存。
  await Promise.allSettled([...inflight]);
  autoApplyOrchestrator.stop("插件服务退出，批量投递已停止");
  autoApplyOrchestrator.flush();
  await Promise.all([
    store.flush(),
    autoApplyStore.flush(),
    jobTags.flush(),
    jobHistory.flushPendingWrites(),
    autoApplyOutcomes.flushPendingWrites(),
    interviewSessions.flush(),
  ]);
  process.exit(0);
}

reader.on("close", () => {
  // 宿主退出时 stdin 关闭；把在途写入落盘后自行结束。
  void shutdown();
});

process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${asText(error?.stack ?? error)}`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  log(`unhandledRejection: ${asText(error?.message ?? error)}`);
});

// 保持 stdin 打开：宿主通过它发送后续请求。
process.stdin.resume();
