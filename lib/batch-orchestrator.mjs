import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  BatchApplyQueue,
  buildBossChatAiPrompt,
  jobHistoryKey,
  matchBossContact,
  matchJob51AppliedRecord,
  sanitizeBossChatVerdicts,
  zhaopinMessageRecord,
} from "./job-engine.mjs";
import { normalizeJob } from "./auto-apply-store.mjs";
import { screenJob } from "./apply-rules.mjs";
import { companyNameKey, isAnonymousCompany } from "./company-key.mjs";
import { dailyQuotaKey, estimateBatchMinutes, evaluateGovernor, nextIntervalMs } from "./governor.mjs";
import { isClosedJobReason, shouldPauseBatch } from "./pause-policy.mjs";
import { startOfDay } from "./outcome-store.mjs";
import { createMessageRecords } from "./message-records.mjs";
import { parseResumeAiJson } from "./resume-ai.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const BOSS_CHAT_NOT_FOUND = "Boss 消息记录里没有找到这条招呼；如果确认没发出，请回岗位池重新投递";
const MAX_REPAIR_WAIT_MS = 8 * 60_000;

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

/** 只有明确的「已关闭」结论才排除核对；失败说明里的「可能是岗位已下线」只是猜测。 */
function isClosedConclusion(message) {
  return /这个岗位在平台上已关闭|点了投递之后，页面变成|这个岗位已经投不了了|职位已失效|该职位已过期/.test(String(message ?? ""));
}

function sleepAbortable(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

/**
 * 批量投递编排：队列节奏、准入规则、结束后的平台记录核对与受限补投。
 *
 * 单条投递动作仍由 auto-apply-runner 执行；这里只负责「怎么排队、什么时候停、
 * 结束后怎么确认到底发没发出去」。宿主只提供浏览器与模型能力。
 */
export function createBatchOrchestrator(options) {
  const { store, tags, outcomes, dataRoot, runner, greetingFor, chatFor, log } = options;
  const { driver } = runner;
  const records = createMessageRecords(driver, log);
  const batchStatusFile = path.join(dataRoot, "batch-status.json");

  let batchSnapshot = null;
  let persistTimer = null;
  let rechecking = false;
  let batchAvgItemMs = 60_000;
  const batchSites = new Set();
  const batchGreetings = new Map();
  let needOpenWindows = false;
  // repairGate 需要一个和 runner 共享的间隔缓存；从 runner 的 governorState 不可见，
  // 这里单独维护一份，语义与宿主一致（同一时刻只随机一次）。
  const governorState = { intervalKey: 0, intervalGapMs: 0 };

  const batch = new BatchApplyQueue({
    run: (job, context) => runBatchItem(job, context),
    gate: (job) => gateJob(job),
    settle: (job, result) => settleBatchItem(job, result),
    log: (line) => log(line),
    estimateMsPerItem: () => batchAvgItemMs,
    persist: (status) => scheduleBatchPersist(status),
    onFinished: (status) => { void handleBatchFinished(status); },
    postRun: (context) => reconcileBatch(context),
  });

  function scheduleBatchPersist(status) {
    batchSnapshot = status;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void writeBatchStatus();
    }, 400);
  }

  async function writeBatchStatus() {
    const snapshot = batchSnapshot;
    if (!snapshot) return;
    try {
      await fsp.mkdir(path.dirname(batchStatusFile), { recursive: true });
      await fsp.writeFile(batchStatusFile, JSON.stringify(snapshot), "utf8");
    } catch (error) {
      log(`batch status persist failed: ${text(error?.message ?? error, 160)}`);
    }
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const snapshot = batchSnapshot;
    if (!snapshot) return;
    try {
      fs.mkdirSync(path.dirname(batchStatusFile), { recursive: true });
      fs.writeFileSync(batchStatusFile, JSON.stringify(snapshot), "utf8");
    } catch {
      /* 退出时写盘失败不影响关闭 */
    }
  }

  function hydrate() {
    try {
      if (!fs.existsSync(batchStatusFile)) return;
      const raw = JSON.parse(fs.readFileSync(batchStatusFile, "utf8"));
      batch.hydrate(raw);
      batchSnapshot = batch.statusSnapshot();
    } catch (error) {
      log(`batch status restore failed: ${text(error?.message ?? error, 160)}`);
    }
  }

  async function handleBatchFinished(status) {
    log(`batch finished ${status.id} ${status.state}`);
    if (status.state !== "done" && status.state !== "stopped") return;
    const needsManual = status.items.some((item) => item.state === "needs_user");
    const blockedSites = (await runner.statuses().catch(() => [])).filter((entry) => entry.blocked);
    if (needsManual || blockedSites.length) {
      log(`batch finished: keep job-site windows open (${needsManual ? "needs_user items" : ""}${blockedSites.length ? ` blocked: ${blockedSites.map((entry) => entry.site).join(",")}` : ""})`);
      return;
    }
    const sites = batchSites.size ? [...batchSites] : ["boss"];
    for (const site of sites) {
      try {
        await runner.closeSite(site);
        log(`batch finished: ${site} window closed`);
      } catch (error) {
        log(`batch finished: close ${site} window failed: ${text(error?.message ?? error, 160)}`);
      }
    }
    batchSites.clear();
  }

  /**
   * 招聘窗口被关闭：不光要暂停，还要立刻打断正在等待的那一条浏览器调用。
   * 只改暂停标志时，runLoop 会卡在窗口已经消失的调用上，用户点「继续」看起来毫无反应。
   */
  function onJobSiteClosed(site) {
    if (!batch.active()) return;
    const status = batch.pause(`${sourceLabel(site)} 窗口被关闭，批量投递已暂停。点「继续」会重新打开窗口接着投`, { abortActive: true });
    log(`batch paused because ${site} window closed (${status.state})`);
  }

  /** 队列里还没处理完的岗位来自哪些平台；继续前要保证这些窗口都开着。 */
  function pendingSites(status) {
    const sites = new Set();
    for (const item of status.items) {
      if (item.state !== "queued" && item.state !== "running") continue;
      const job = batch.jobFor(item.id);
      const source = job?.source || guessSourceOfUrl(item.sourceUrl);
      if (source) sites.add(source);
    }
    return [...sites];
  }

  function guessSourceOfUrl(url) {
    const value = String(url ?? "");
    if (/zhipin\.com/i.test(value)) return "boss";
    if (/zhaopin\.com/i.test(value)) return "zhaopin";
    if (/51job\.com/i.test(value)) return "job51";
    if (/liepin\.com/i.test(value)) return "liepin";
    return "";
  }

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  /**
   * 点「继续」时先把关闭的招聘窗口重新打开。
   * 读窗口状态失败时不去猜：直接继续，让队列自己在遇到关闭窗口时再次暂停并提示，
   * 避免误把用户刚处理完的登录页重新导航走。
   */
  async function ensureResumeWindows(sites) {
    if (!sites.length) return { ok: true, message: "" };
    let statuses;
    try {
      statuses = await withTimeout(runner.statuses(), 15_000, "读取招聘窗口状态超时");
    } catch (error) {
      log(`batch resume: read job site status failed: ${text(error?.message ?? error, 160)}`);
      return { ok: true, message: "" };
    }
    const open = new Set((Array.isArray(statuses) ? statuses : []).filter((entry) => entry?.open).map((entry) => entry.site));
    const failures = [];
    for (const site of sites) {
      if (open.has(site)) continue;
      batch.reportVerification(`${sourceLabel(site)} 窗口未打开，正在重新打开后继续`, "info");
      try {
        await withTimeout(runner.openSite(site), 90_000, `打开${sourceLabel(site)}窗口超时`);
        batch.reportVerification(`${sourceLabel(site)} 窗口已重新打开`, "info");
      } catch (error) {
        const reason = text(error?.message ?? error, 160);
        failures.push(`${sourceLabel(site)}：${reason}`);
        log(`batch resume: open ${site} failed: ${reason}`);
      }
    }
    return {
      ok: !failures.length,
      message: failures.length ? `重新打开窗口失败：${failures.join("；")}。请手动打开招聘窗口后再点「继续」` : "",
    };
  }

  /**
   * 用户点「继续」= 已经处理完登录 / 验证 / 窗口。
   * 先清掉连续失败与平台冷却（否则 governor 下一拍又判 risk-pause，看起来还是「点继续没用」），
   * 再把关闭的窗口重新打开，最后才恢复队列。
   */
  async function resume() {
    const current = batch.statusSnapshot();
    if (current.state !== "paused") return batch.resume();
    const sites = pendingSites(current);
    runner.resetGuards(sites.length ? sites : batchSites, "batch resume", { cooldown: true });
    const windows = await ensureResumeWindows(sites);
    if (!windows.ok) {
      batch.reportVerification(windows.message, "warn");
      batch.updatePausedMessage(windows.message);
      return batch.statusSnapshot();
    }
    return batch.resume();
  }

  function runBatchItem(job, context) {
    if (job.source !== "boss") return runBatchApplyItem(job, context);
    return (async () => {
      const state = await store.state();
      context?.report?.("正在根据岗位生成招呼语");
      const crafted = await greetingFor({ job });
      if (job.sourceUrl) batchGreetings.set(job.sourceUrl, crafted.text);
      const result = await runner.greet({
        job,
        greeting: crafted.text,
        sendImageResume: state.rules.sendImageResume,
      }, { fromBatch: true, signal: context?.signal, onProgress: context?.report });
      return batchResultOf(result.run);
    })();
  }

  async function runBatchApplyItem(job, context) {
    context?.report?.(`正在提交${job.source === "liepin" ? "猎聘" : job.source === "zhaopin" ? "智联" : "前程无忧"}简历`);
    const result = await runner.applySite({ job }, {
      fromBatch: true,
      signal: context?.signal,
      onProgress: context?.report,
    });
    return batchResultOf(result.run);
  }

  function batchResultOf(run) {
    const runState = run.state;
    const closed = runState !== "submitted" && isClosedJobReason(run.blockedReason);
    return {
      state: closed
        ? "skipped"
        : runState === "submitted" ? "sent" : runState === "blocked" ? "skipped" : runState === "needs_user" ? "needs_user" : "failed",
      message: run.message,
      pauseBatch: closed ? false : shouldPauseBatch({ state: runState, blockedReason: run.blockedReason }),
    };
  }

  async function settleBatchItem(job, result) {
    const guard = runner.siteGuard(job.source);
    if (result.state === "sent") {
      guard.failures = 0;
      guard.unconfirmed = 0;
      return;
    }
    if (result.state === "needs_user") {
      if (result.pauseBatch) {
        guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
        guard.unconfirmed = 0;
        log(`batch paused for verification on ${job.company} (${dailyQuotaKey(job.source)})`);
      } else {
        guard.unconfirmed += 1;
        log(`batch item unconfirmed on ${job.company} (${guard.unconfirmed} in a row): ${text(result.message, 120)}`);
        return;
      }
      guard.failures += 1;
      return;
    }
    if (result.state === "failed") {
      guard.unconfirmed = 0;
      guard.failures += 1;
    }
  }

  // ── 准入规则：本地跳过判定 + 节奏闸门 ─────────────────────────────────

  async function jobTagSkipReason(job) {
    await tags.ready();
    const entry = tags.get(jobHistoryKey(job));
    if (!entry?.tags?.length) return "";
    return `岗位已打标签「${entry.tags.join("、")}」，不再投递`;
  }

  function companySkipReason(state, job, summaries, now = Date.now()) {
    const rules = state.rules;
    const key = companyNameKey(job.company);
    if (!key) return "";
    const summary = summaries[key] ?? null;
    if (summary && summary.blocked > 0) return "这家公司已被你屏蔽";
    if (summary && rules.autoBlockRejected && summary.rejected > 0) return "这家公司已回复不合适，已自动跳过";
    const days = Math.max(0, Math.round(rules.companyCooldownDays || 0));
    if (days <= 0) return "";
    const lastAt = companyLastContactAt(state, key, summary?.lastAt ?? 0);
    if (!lastAt) return "";
    const remain = days * DAY_MS - (now - lastAt);
    if (remain <= 0) return "";
    const remainDays = Math.max(1, Math.ceil(remain / DAY_MS));
    return `「${job.company || "这家公司"}」${days} 天内已经投过，还需等 ${remainDays} 天`;
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

  function dailyQuotaSkipReason(state, job, now = Date.now()) {
    const key = dailyQuotaKey(job.source);
    const submittedToday = state.applications.filter((entry) =>
      entry.status === "submitted"
      && entry.submittedAt >= startOfDay(now)
      && dailyQuotaKey(entry.job.source) === key);
    const limit = Math.max(1, Math.round(state.rules.dailyLimit || 1));
    if (submittedToday.length >= limit) {
      return `${quotaLabel(job.source)}今天的投递已达上限（${limit} 个），这个岗位未投`;
    }
    const companyLimit = Math.max(1, Math.round(state.rules.dailyCompanyLimit || 1));
    const companies = new Set(submittedToday.map((entry) => companyNameKey(entry.job.company)).filter(Boolean));
    const nameKey = companyNameKey(job.company);
    if (nameKey && !companies.has(nameKey) && companies.size >= companyLimit) {
      return `${quotaLabel(job.source)}今天已投递 ${companies.size} 家公司，达到每日公司数上限`;
    }
    return "";
  }

  async function localSkipReason(state, job, summaries, now = Date.now()) {
    const screened = screenJob(state.rules, job);
    if (screened) return screened;
    const lowScore = matchScoreSkipReason(state.rules, job);
    if (lowScore) return lowScore;
    const tagged = await jobTagSkipReason(job);
    if (tagged) return tagged;
    if (!job.sourceUrl) return "岗位缺少官方链接";
    const sameJob = state.applications.filter((entry) =>
      entry.job.title === job.title
      && (entry.job.sourceUrl === job.sourceUrl || Boolean(entry.job.jobId && entry.job.jobId === job.jobId)));
    if (!state.rules.allowRepeatChat) {
      if (sameJob.some((entry) => entry.status === "submitted")) return "这个岗位已经打过招呼";
      if (sameJob.some((entry) => entry.status === "needs_user")) {
        const source = sameJob.find((entry) => entry.status === "needs_user")?.job.source ?? job.source;
        const where = source === "boss" ? "Boss 聊天窗口" : `${sourceLabel(source)}「我的投递」`;
        return `这个岗位上次的投递没确认成功，请先到${where}核对；确认没发出可在「安全规则」开启「允许重复沟通」后重投`;
      }
    }
    const verdictSkip = await runner.companyIntel.verdictSkipReason(job, state.rules);
    if (verdictSkip) return verdictSkip;
    const companySkip = companySkipReason(state, job, summaries, now);
    if (companySkip) return companySkip;
    return dailyQuotaSkipReason(state, job, now);
  }

  async function gateJob(job) {
    const state = await store.state();
    const summaries = await outcomes.summaries();
    const skip = await localSkipReason(state, job, summaries);
    if (skip) return { allowed: false, skip: true, reason: skip };
    const decision = await runner.governorDecision(job);
    if (decision.allowed) return { allowed: true };
    if (decision.waitMs > 0) return { allowed: false, waitMs: decision.waitMs, reason: decision.reason };
    const retain = decision.code === "risk-pause";
    const terminal = decision.code === "company-cooling"
      || decision.code === "company-rejected"
      || decision.code === "daily-limit"
      || decision.code === "daily-company-limit";
    return { allowed: false, skip: terminal, retain, reason: decision.reason };
  }

  async function batchPreflight(rawJobs = []) {
    const state = await store.state();
    const summaries = await outcomes.summaries();
    const now = Date.now();
    const jobs = (Array.isArray(rawJobs) ? rawJobs : []).map(normalizeJob);
    const items = await Promise.all(jobs.map(async (job, index) => {
      const reason = await localSkipReason(state, job, summaries, now);
      return { index, company: job.company || "未命名公司", title: job.title, skip: Boolean(reason), reason };
    }));
    return {
      items,
      skipCount: items.filter((item) => item.skip).length,
      total: items.length,
      cooldownDays: state.rules.companyCooldownDays,
    };
  }

  async function refreshBatchSkips() {
    if (!batch.active()) return 0;
    const pending = batch.pending();
    if (!pending.length) return 0;
    try {
      const state = await store.state();
      const summaries = await outcomes.summaries();
      const entries = [];
      for (const entry of pending) {
        const reason = await localSkipReason(state, entry.job, summaries);
        if (reason) entries.push({ id: entry.id, reason });
      }
      return batch.markSkipped(entries);
    } catch (error) {
      log(`refresh batch skips failed: ${text(error?.message ?? error, 160)}`);
      return 0;
    }
  }

  async function start(input = {}) {
    if (input.confirm !== true) throw new Error("批量投递需要你先确认投递清单");
    if (runner.isActive()) throw new Error("已有投递任务在执行，请等当前任务结束");
    if (rechecking) throw new Error("正在核对上一批的投递记录，请等核对完成");
    if (batch.active()) throw new Error("已有批量投递任务在执行，请先停止");
    const state = await store.state();
    // 投递只依赖平台登录态：档案与简历是加分项，缺了不拦；招呼语会退回固定模板或本机拼装。
    const jobs = (Array.isArray(input.jobs) ? input.jobs : [])
      .map(normalizeJob)
      .filter((job) => (job.source === "boss"
        || job.source === "liepin"
        || job.source === "zhaopin"
        || job.source === "job51") && job.sourceUrl);
    if (!jobs.length) throw new Error("请先勾选至少一个可投递的岗位（Boss / 智联 / 前程无忧）");
    const summaries = await outcomes.summaries();
    const now = Date.now();
    const preflightItems = await Promise.all(jobs.map((job) => localSkipReason(state, job, summaries, now)));
    const skipCount = preflightItems.filter(Boolean).length;
    if (skipCount === jobs.length) {
      const first = preflightItems.find(Boolean) ?? "这些岗位都不满足投递条件";
      throw new Error(`这批 ${jobs.length} 个岗位都会被跳过：${first}。换一批岗位，或到「安全规则」里调整每日额度和公司冷却天数`);
    }
    const firstRunnableIndex = preflightItems.findIndex((reason) => !reason);
    runner.resetGuards(jobs.map((job) => job.source), "batch start");
    const firstDecision = await runner.governorDecision(jobs[firstRunnableIndex >= 0 ? firstRunnableIndex : 0]);
    if (firstDecision.code === "platform-cooldown") throw new Error(firstDecision.reason);
    batchGreetings.clear();
    const minSeconds = Math.max(0, state.rules.greetIntervalMinSeconds || 0);
    const maxSeconds = Math.max(minSeconds, state.rules.greetIntervalMaxSeconds || minSeconds);
    batchAvgItemMs = Math.max(15_000, Math.round(((minSeconds + maxSeconds) / 2) * 1000));
    const preskipped = {};
    jobs.forEach((job, index) => {
      const reason = preflightItems[index];
      if (reason) preskipped[job.sourceUrl] = reason;
    });
    batchSites.clear();
    jobs.forEach((job) => batchSites.add(job.source));
    const status = await batch.start(jobs, preskipped);
    log(`batch started with ${jobs.length} jobs (skip ${skipCount})`);
    return {
      batch: status,
      estimateMinutes: estimateBatchMinutes(Math.max(1, jobs.length - skipCount), {
        intervalMinSeconds: state.rules.greetIntervalMinSeconds,
        intervalMaxSeconds: state.rules.greetIntervalMaxSeconds,
      }),
      firstDecision,
      preflight: { skipCount, total: jobs.length },
    };
  }

  function status() {
    return { batch: batch.statusSnapshot(), governor: runner.governorSnapshot() };
  }

  async function recheck() {
    if (rechecking) throw new Error("正在核对上一批的投递记录，请稍候");
    if (runner.isActive()) throw new Error("已有投递任务在执行，请等当前任务结束");
    const current = batch.statusSnapshot();
    if (!batch.idleForRecheck()) {
      throw new Error(current.state === "paused"
        ? "还有一条岗位正在收尾，请等几秒后再核对"
        : "批量投递还在执行，结束后才能重新核对");
    }
    if (!current.id) throw new Error("当前没有可核对的批量投递");
    const targets = current.items.filter((item) => {
      if (item.state === "needs_user" || item.state === "failed") return true;
      return item.state === "skipped"
        && /51job\.com/i.test(item.sourceUrl)
        && /岗位已关闭|已下线|职位不存在|投递不了了/.test(item.message);
    });
    if (!targets.length) throw new Error("这批没有待确认的岗位，不需要重新核对");
    rechecking = true;
    try {
      const state = await store.state();
      const items = [];
      let skippedOther = 0;
      for (const item of targets) {
        const guessed = /51job\.com/i.test(item.sourceUrl)
          ? "job51"
          : /zhipin\.com/i.test(item.sourceUrl) ? "boss" : /zhaopin\.com/i.test(item.sourceUrl) ? "zhaopin" : "";
        if (!guessed) {
          skippedOther += 1;
          continue;
        }
        const fallback = normalizeJob({
          source: guessed,
          company: item.company,
          title: item.title,
          sourceUrl: item.sourceUrl,
          city: item.city,
        });
        const stored = batch.jobFor(item.id);
        const application = findApplicationForJob(state, stored ?? fallback);
        const job = stored ?? application?.job ?? fallback;
        if (job.source !== "boss" && job.source !== "job51" && job.source !== "zhaopin") {
          skippedOther += 1;
          continue;
        }
        items.push({ id: item.id, job, state: item.state, message: item.message, updatedAt: item.updatedAt });
      }
      if (!items.length) throw new Error("这批待确认岗位不是 Boss / 前程无忧 / 智联岗位，暂时没有可读的平台记录");
      const openFailures = [];
      const siteStates = await runner.statuses().catch(() => []);
      for (const site of ["boss", "job51", "zhaopin"]) {
        if (!items.some((item) => item.job.source === site)) continue;
        const siteStatus = siteStates.find((entry) => entry.site === site);
        if (siteStatus?.open) continue;
        batch.reportVerification(`${sourceLabel(site)} 窗口未打开，正在打开窗口读取记录`, "info");
        try {
          await runner.openSite(site);
        } catch (error) {
          const reason = text(error?.message ?? error, 160);
          openFailures.push(`${sourceLabel(site)}：${reason}`);
          log(`batch recheck open ${site} failed: ${reason}`);
        }
      }
      if (openFailures.length) {
        const message = `打开核对窗口失败：${openFailures.join("；")}；请先手动打开窗口后再试`;
        batch.reportVerification(message, "warn");
        return {
          ok: false,
          batch: batch.statusSnapshot(),
          checked: items.length,
          sent: countTargetState(items, "sent"),
          pending: items.length - countTargetState(items, "sent"),
          message,
        };
      }
      const startedAt = current.startedAt || Date.now();
      const since = Math.max(0, startedAt - 3 * 60_000);
      batch.reportVerification(`开始重新核对 ${items.length} 个待确认岗位的平台记录`, "info");
      const context = {
        status: current,
        items,
        report: (message) => batch.reportVerification(message, "info"),
        update: (updates) => batch.applyVerification(updates),
      };
      let readResult = { readOk: true, readMessage: "" };
      try {
        readResult = await reconcileBatch(context, { repair: false, since });
      } catch (error) {
        const reason = text(error?.message ?? error, 160);
        log(`batch recheck failed: ${reason}`);
        batch.reportVerification(`重新核对失败：${reason}；已确认的结果不会丢失，可以稍后重试`, "error");
        return {
          ok: false,
          batch: batch.statusSnapshot(),
          checked: items.length,
          sent: countTargetState(items, "sent"),
          pending: items.length - countTargetState(items, "sent"),
          message: `重新核对失败：${reason}`,
        };
      }
      const after = batch.statusSnapshot();
      const sent = items.filter((item) => after.items.find((entry) => entry.id === item.id)?.state === "sent").length;
      const bossNotFound = items.filter((item) => {
        const entry = after.items.find((candidate) => candidate.id === item.id);
        return item.job.source === "boss" && entry?.state === "needs_user" && entry.message === BOSS_CHAT_NOT_FOUND;
      }).length;
      const pendingOf = (source) => items.filter((item) => {
        if (item.job.source !== source) return false;
        return after.items.find((entry) => entry.id === item.id)?.state !== "sent";
      }).length;
      const job51Pending = pendingOf("job51");
      const zhaopinPending = pendingOf("zhaopin");
      const pending = items.length - sent;
      const uncertain = Math.max(0, pending - bossNotFound - job51Pending - zhaopinPending);
      const skipped = skippedOther ? `；另有 ${skippedOther} 个其他平台岗位未参与核对` : "";
      const message = readResult.readOk
        ? sent || bossNotFound || job51Pending || zhaopinPending
          ? `重新核对完成：${sent} 个岗位已确认投递${bossNotFound ? `；${bossNotFound} 个 Boss 岗位在消息列表里没有记录，可按未发送处理` : ""}${job51Pending ? `；${job51Pending} 个前程无忧岗位仍无法从申请记录确认` : ""}${zhaopinPending ? `；${zhaopinPending} 个智联岗位仍无法从消息记录确认` : ""}${uncertain ? `；${uncertain} 个仍需本人确认` : ""}${skipped}`
          : `重新核对完成：平台记录仍无法确认这 ${pending} 个岗位；Boss / 智联请确认窗口停在消息页，前程无忧请确认「社会申请」能正常打开再试${skipped}`
        : `重新核对未完成：${readResult.readMessage}${skipped}`;
      batch.reportVerification(message, readResult.readOk && sent ? "ok" : "warn");
      log(`batch recheck: ${sent}/${items.length} verified (readOk=${readResult.readOk})`);
      return { ok: readResult.readOk, batch: batch.statusSnapshot(), checked: items.length, sent, pending, message };
    } finally {
      rechecking = false;
    }
  }

  function countTargetState(items, state) {
    const snapshot = batch.statusSnapshot();
    return items.filter((item) => snapshot.items.find((entry) => entry.id === item.id)?.state === state).length;
  }

  // ── 平台记录核对 ──────────────────────────────────────────────────────

  async function reconcileBatch(context, options = {}) {
    const bossItems = context.items.filter((item) => shouldReconcileBatchItem(item));
    const job51Items = context.items.filter((item) => shouldReconcileJob51BatchItem(item));
    const zhaopinItems = context.items.filter((item) => shouldReconcileZhaopinBatchItem(item));
    const siteApplyItems = context.items.filter((item) => shouldRetrySiteApplyItem(item));
    if (!bossItems.length && !job51Items.length && !zhaopinItems.length && !siteApplyItems.length) {
      return { readOk: true, readMessage: "没有需要核对的待确认岗位" };
    }
    const results = [];
    if (bossItems.length) results.push(await reconcileBossItems(context, bossItems, options));
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    if (job51Items.length) results.push(await reconcileJob51Items(context, job51Items, options));
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    let zhaopinConfirmed = new Set();
    if (zhaopinItems.length) {
      const checked = await reconcileZhaopinItems(context, zhaopinItems);
      zhaopinConfirmed = checked.confirmed;
      results.push({ readOk: checked.readOk, readMessage: checked.readMessage });
    }
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    const retryItems = siteApplyItems.filter((item) => !zhaopinConfirmed.has(item.id));
    if (retryItems.length) results.push(await reconcileSiteApplyItems(context, retryItems, options));
    return {
      readOk: results.every((entry) => entry.readOk),
      readMessage: results.map((entry) => entry.readMessage).filter(Boolean).join("；"),
    };
  }

  function shouldRetrySiteApplyItem(item) {
    if (item.job.source !== "zhaopin" && item.job.source !== "liepin") return false;
    if (item.state !== "needs_user" && item.state !== "failed") return false;
    return /没有点成投递|没有找到投递按钮|未找到投递入口|页面空白|页面没有加载出来|页面是空白的|链接不是详情页|打开的是公司主页/.test(item.message);
  }

  async function reconcileSiteApplyItems(context, candidates, options = {}) {
    const platforms = Array.from(new Set(candidates.map((item) => sourceLabel(item.job.source)))).join(" / ");
    if (options.repair === false) {
      return { readOk: true, readMessage: `${platforms}记录里没有确认的岗位未自动补投` };
    }
    context.report(`${platforms}仍有 ${candidates.length} 个岗位明确没投成，正在按详情页状态补投`, "repairing");
    const retry = await retryApplyBatchItems(context, candidates);
    const summary = retry.submitted.size
      ? `${platforms}自动补投完成，确认 ${retry.submitted.size} 个岗位已投递`
      : `${platforms}自动补投完成，仍有 ${candidates.length} 个岗位未确认`;
    context.report(summary, "verifying");
    return { readOk: true, readMessage: summary };
  }

  function shouldReconcileZhaopinBatchItem(item) {
    if (item.job.source !== "zhaopin") return false;
    if (item.state !== "needs_user" && item.state !== "failed") return false;
    return !isClosedConclusion(item.message);
  }

  async function reconcileZhaopinItems(context, candidates) {
    const confirmed = new Set();
    context.report("正在读取智联消息记录", "verifying");
    let snapshot;
    try {
      snapshot = await records.readZhaopinMessages();
    } catch (error) {
      snapshot = {
        ok: false,
        state: "failed",
        message: `读取智联消息记录失败：${text(error?.message ?? error, 160)}`,
        url: "",
        items: [],
        body: "",
        capturedAt: Date.now(),
        blocked: "",
      };
    }
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消", confirmed };
    if (!snapshot.ok) {
      if (snapshot.blocked === "verification") {
        const guard = runner.siteGuard("zhaopin");
        guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
      }
      const reason = snapshot.message || "智联消息记录读取失败";
      context.update(candidates.map((item) => ({
        id: item.id,
        state: "needs_user",
        message: `${reason}；这条是否已发出尚未确认，请打开智联消息页核对`,
      })));
      context.report(reason, "verifying");
      return { readOk: false, readMessage: reason, confirmed };
    }
    context.report(`已读取 ${snapshot.items.length} 条智联消息记录，正在逐条核对`, "verifying");
    let sent = 0;
    for (const item of candidates) {
      if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消", confirmed };
      const matched = zhaopinMessageRecord(snapshot, item.job);
      if (matched) {
        await applyVerifiedSent(context, item, undefined, "zhaopin-message", `消息列表记录：${matched}`);
        confirmed.add(item.id);
        sent += 1;
        continue;
      }
      context.update([{
        id: item.id,
        state: "needs_user",
        message: "智联消息列表里暂时没有找到这条投递记录（可能还没同步或不在当前列表）；请打开智联消息页核对",
      }]);
    }
    const summary = sent ? `智联消息记录确认 ${sent} 个岗位已投递` : "智联消息记录里没有新增可确认的岗位";
    context.report(summary, "verifying");
    return { readOk: true, readMessage: summary, confirmed };
  }

  async function reconcileBossItems(context, candidates, options = {}) {
    const repair = options.repair !== false;
    const startedAt = context.status.startedAt || Date.now();
    const since = options.since ?? Math.max(0, startedAt - 3 * 60_000);
    context.report("正在读取 Boss 消息记录", "verifying");
    let snapshot;
    try {
      snapshot = await records.readBossChatList({ since });
    } catch (error) {
      snapshot = {
        ok: false,
        state: "failed",
        message: `读取 Boss 消息记录失败：${text(error?.message ?? error, 160)}`,
        url: "",
        contacts: [],
        complete: false,
        oldestAt: 0,
        capturedAt: Date.now(),
        blocked: "",
      };
    }
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    if (!snapshot.ok) {
      if (snapshot.blocked === "verification") {
        const guard = runner.siteGuard("boss");
        guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
      }
      const reason = snapshot.message || "Boss 消息记录读取失败";
      context.update(candidates.map((item) => ({
        id: item.id,
        state: "needs_user",
        message: `${reason}；这条是否已发出尚未确认，请到 Boss 聊天窗口核对`,
      })));
      context.report(reason, "verifying");
      return { readOk: false, readMessage: reason };
    }
    context.report(`已读取 ${snapshot.contacts.length} 条 Boss 消息记录，正在逐条核对`, "verifying");
    const hints = await greetingHints(candidates);
    const uncertain = [];
    const unsent = [];
    for (const item of candidates) {
      if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
      const match = matchBossContact({
        job: item.job,
        contacts: snapshot.contacts,
        complete: snapshot.complete,
        since,
        greetingHint: hints.get(item.id) ?? "",
      });
      if (match.verdict === "sent") {
        await applyVerifiedSent(context, item, snapshot.contacts[match.contactIndex], "boss-chat", match.reason);
        continue;
      }
      if (match.verdict === "not_sent") {
        unsent.push(item);
        continue;
      }
      uncertain.push({ item, reason: match.reason || "Boss 消息记录里无法确定" });
    }
    if (uncertain.length && !context.signal?.aborted) {
      context.report(`消息记录里还有 ${uncertain.length} 条无法确定，正在让 AI 复核`, "verifying");
      const ai = await askBossChatAi(uncertain.map((entry) => entry.item), hints, snapshot, startedAt, since);
      if (!ai.verdicts.length) {
        const suffix = ai.error ? `（AI 复核不可用：${ai.error}）` : "";
        context.update(uncertain.map(({ item, reason }) => ({
          id: item.id,
          state: "needs_user",
          message: `Boss 消息记录无法确定是否发出：${reason}${suffix}；请到聊天窗口核对`,
        })));
        context.report(`AI 复核没有给出结论：${ai.error || "模型未返回结果"}`, "verifying");
      } else {
        for (const verdict of ai.verdicts) {
          const entry = uncertain.find((candidate) => candidate.item.id === verdict.id);
          if (!entry) continue;
          const contact = verdict.contactIndex >= 0 ? snapshot.contacts[verdict.contactIndex] : undefined;
          if (verdict.verdict === "sent" && contact) {
            await applyVerifiedSent(context, entry.item, contact, "boss-chat-ai", verdict.reason || "AI 复核确认");
            continue;
          }
          if (verdict.verdict === "not_sent") {
            unsent.push(entry.item);
            continue;
          }
          context.update([{
            id: entry.item.id,
            state: "needs_user",
            message: `Boss 消息记录无法确认是否发出：${verdict.reason || entry.reason}；请到聊天窗口核对`,
          }]);
        }
      }
    }
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    if (unsent.length) {
      if (!repair) {
        context.update(unsent.map((item) => ({
          id: item.id,
          state: "needs_user",
          message: BOSS_CHAT_NOT_FOUND,
        })));
        context.report(`Boss 消息记录里仍有 ${unsent.length} 个岗位没有找到，未自动补发`, "verifying");
      } else {
        context.report(`Boss 消息记录确认 ${unsent.length} 个岗位没有发出，开始按节奏补发`, "repairing");
        const stopReason = await repairBatchItems(context, unsent, hints, since);
        if (stopReason && !context.signal?.aborted) log(`batch repair stopped: ${text(stopReason, 160)}`);
      }
      return { readOk: true, readMessage: snapshot.message };
    }
    context.report("Boss 消息记录核对完成", "verifying");
    return { readOk: true, readMessage: snapshot.message };
  }

  function shouldReconcileBatchItem(item) {
    if (item.job.source !== "boss") return false;
    if (item.state !== "needs_user" && item.state !== "failed") return false;
    return !isClosedConclusion(item.message);
  }

  function shouldReconcileJob51BatchItem(item) {
    if (item.job.source !== "job51") return false;
    if (item.state === "needs_user" || item.state === "failed") return !isClosedConclusion(item.message);
    if (item.state === "skipped") return /岗位已关闭|已下线|职位不存在|投递不了了/.test(item.message);
    return false;
  }

  async function reconcileJob51Items(context, candidates, options = {}) {
    context.report("正在读取前程无忧「社会申请」记录", "verifying");
    let snapshot;
    try {
      snapshot = await records.readJob51AppliedRecords();
    } catch (error) {
      snapshot = {
        ok: false,
        state: "failed",
        message: `读取前程无忧申请记录失败：${text(error?.message ?? error, 160)}`,
        url: "",
        records: [],
        capturedAt: Date.now(),
        blocked: "",
      };
    }
    if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
    if (!snapshot.ok) {
      if (snapshot.blocked === "verification") {
        const guard = runner.siteGuard("job51");
        guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
      }
      const reason = snapshot.message || "前程无忧申请记录读取失败";
      const pending = candidates.filter((item) => item.state === "needs_user" || item.state === "failed");
      if (pending.length) {
        context.update(pending.map((item) => ({
          id: item.id,
          state: "needs_user",
          message: `${reason}；这条是否已投递尚未确认，请打开前程无忧「社会申请」核对`,
        })));
      }
      context.report(reason, "verifying");
      return { readOk: false, readMessage: reason };
    }
    context.report(`已读取 ${snapshot.records.length} 条前程无忧申请记录，正在逐条核对`, "verifying");
    let sent = 0;
    const unmatched = [];
    for (const item of candidates) {
      if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
      const match = matchJob51AppliedRecord(item.job, snapshot.records);
      if (match.matched) {
        await applyVerifiedSent(context, item, undefined, "job51-records", match.reason);
        sent += 1;
        continue;
      }
      if (item.state === "skipped") continue;
      unmatched.push(item);
      context.update([{
        id: item.id,
        state: "needs_user",
        message: "前程无忧申请记录里没有找到这条（可能还没同步或不在第一页）；请打开「社会申请」核对",
      }]);
    }
    let retried = 0;
    let confirmedAfterRetry = 0;
    const recordsTrustworthy = snapshot.records.length > 0;
    if (unmatched.length && recordsTrustworthy && options.repair !== false && !context.signal?.aborted) {
      context.report(`申请记录里没有 ${unmatched.length} 个岗位，开始自动补投（每个岗位只补一次）`, "repairing");
      const retry = await retryApplyBatchItems(context, unmatched);
      retried = retry.attempted.length;
      if (context.signal?.aborted) return { readOk: true, readMessage: "核对已取消" };
      if (retry.attempted.length) {
        confirmedAfterRetry = await confirmJob51Retry(context, retry.attempted, retry.submitted, retry.held);
      }
    }
    const summary = [
      sent ? `前程无忧申请记录确认 ${sent} 个岗位已投递` : "",
      retried ? `记录里没有的 ${retried} 个岗位已自动补投` : "",
      confirmedAfterRetry ? `补投后记录又确认 ${confirmedAfterRetry} 个` : "",
    ].filter(Boolean).join("；");
    context.report(summary || "前程无忧申请记录核对完成，没有新增可确认的岗位", "verifying");
    return { readOk: true, readMessage: summary || "前程无忧申请记录核对完成，没有新增可确认的岗位" };
  }

  async function confirmJob51Retry(context, tried, pageSubmitted, held) {
    context.report("补投结束，正在重新读取前程无忧申请记录确认", "verifying");
    let snapshot = null;
    try {
      snapshot = await records.readJob51AppliedRecords();
    } catch (error) {
      log(`job51 retry recheck read failed: ${text(error?.message ?? error, 160)}`);
    }
    if (context.signal?.aborted) return 0;
    if (!snapshot?.ok) {
      context.update(tried
        .filter((item) => !pageSubmitted.has(item.id))
        .map((item) => ({
          id: item.id,
          state: "needs_user",
          message: `已自动补投一次，但重新读取申请记录失败（${snapshot?.message || "未知原因"}）；请打开「社会申请」核对`,
        })));
      return 0;
    }
    let confirmed = 0;
    for (const item of tried) {
      if (context.signal?.aborted) return confirmed;
      const match = matchJob51AppliedRecord(item.job, snapshot.records);
      if (match.matched) {
        await applyVerifiedSent(context, item, undefined, "job51-records", match.reason);
        confirmed += 1;
        continue;
      }
      if (pageSubmitted.has(item.id)) continue;
      if (held.has(item.id)) continue;
      context.update([{
        id: item.id,
        state: "needs_user",
        message: "已自动补投一次，前程无忧申请记录里仍没有找到；请打开「社会申请」核对后手动处理",
      }]);
    }
    return confirmed;
  }

  async function retryApplyBatchItems(context, items) {
    const tried = [];
    const attempted = [];
    const submitted = new Set();
    const held = new Set();
    let stopReason = "";
    for (const item of items) {
      if (context.signal?.aborted) {
        stopReason = "已停止";
        break;
      }
      const gate = await waitForRepairGate(item.job, context);
      if (!gate.allowed) {
        const reason = gate.reason || "当前不满足补投条件";
        context.update([{ id: item.id, state: "needs_user", message: `确认没有投出去，但本次未自动补投：${reason}` }]);
        context.report(`未补投「${item.job.company}」：${reason}`, "repairing");
        tried.push(item);
        held.add(item.id);
        if (gate.fatal) {
          stopReason = reason;
          break;
        }
        continue;
      }
      tried.push(item);
      attempted.push(item);
      context.update([{ id: item.id, state: "running", message: "已确认没有投出去，正在自动补投（每个岗位只补一次）" }]);
      context.report(`正在自动补投「${item.job.company} · ${item.job.title}」`, "repairing");
      let result;
      try {
        result = await runner.applySite({ job: item.job }, {
          fromBatch: true,
          signal: context.signal,
          onProgress: (message) => context.report(message, "repairing"),
        });
      } catch (error) {
        if (context.signal?.aborted) {
          stopReason = "已停止";
          break;
        }
        const reason = text(error?.message ?? error, 200);
        if (/已经投递过/.test(reason)) {
          submitted.add(item.id);
          context.update([{ id: item.id, state: "sent", message: "补投前发现这个岗位已经投递过，没有重复提交" }]);
          continue;
        }
        context.update([{ id: item.id, state: "needs_user", message: `自动补投失败：${reason}` }]);
        context.report(`「${item.job.company}」自动补投失败：${reason}`, "repairing");
        held.add(item.id);
        if (shouldPauseBatch({ state: "failed", blockedReason: reason })) {
          stopReason = reason;
          break;
        }
        continue;
      }
      const run = result.run;
      if (run.state === "submitted") {
        submitted.add(item.id);
        const already = /已经显示投递过|没有重复投递|已经投递/.test(run.message);
        context.update([{
          id: item.id,
          state: "sent",
          message: already ? "补投时详情页显示已经投递过，没有重复提交" : `自动补投成功：${run.message || "页面确认已投递"}`,
        }]);
        context.report(`「${item.job.company}」自动补投成功`, "repairing");
        continue;
      }
      const wall = shouldPauseBatch({ state: run.state, blockedReason: run.blockedReason });
      const closed = isClosedJobReason(run.blockedReason);
      if (wall || closed) held.add(item.id);
      context.update([{
        id: item.id,
        state: "needs_user",
        message: closed
          ? `自动补投时发现岗位已关闭：${run.message}`
          : wall
            ? `自动补投需要先处理平台登录 / 验证：${run.message}`
            : `自动补投后仍未确认：${run.message}`,
      }]);
      context.report(`「${item.job.company}」补投后仍未确认：${run.message}`, "repairing");
      if (wall) {
        const guard = runner.siteGuard(item.job.source);
        guard.cooldownUntil = Math.max(guard.cooldownUntil, Date.now() + 30 * 60_000);
        stopReason = run.blockedReason || run.message || "平台拦截";
        break;
      }
    }
    if (stopReason) {
      const rest = items.filter((item) => !tried.includes(item));
      if (rest.length) {
        context.update(rest.map((item) => ({
          id: item.id,
          state: "needs_user",
          message: `确认没有投出去，但自动补投已停止（${stopReason}），请稍后手动重投`,
        })));
      }
    }
    return { tried, attempted, submitted, held, stopReason };
  }

  function findApplicationForJob(state, job) {
    return state.applications.find((entry) =>
      entry.job.title === job.title
      && (
        (entry.job.sourceUrl && entry.job.sourceUrl === job.sourceUrl)
        || Boolean(entry.job.jobId && job.jobId && entry.job.jobId === job.jobId)
      )) ?? null;
  }

  async function greetingHints(items) {
    const state = await store.state();
    const hints = new Map();
    for (const item of items) {
      const cached = batchGreetings.get(item.job.sourceUrl) ?? "";
      const stored = text(findApplicationForJob(state, item.job)?.evidence?.greeting ?? "", 500);
      const value = cached || stored;
      if (value) hints.set(item.id, value);
    }
    return hints;
  }

  async function applyVerifiedSent(context, item, contact, source, reason) {
    try {
      await markVerifiedSent(item, contact, source, reason);
      const label = source === "job51-records"
        ? "前程无忧申请记录已确认投递"
        : source === "zhaopin-message"
          ? "智联消息记录已确认投递"
          : source === "boss-chat-ai" ? "Boss 消息记录 + AI 复核确认已发出" : "Boss 消息记录已确认发出";
      const when = contact?.timeText ? `（${contact.timeText}）` : "";
      context.update([{ id: item.id, state: "sent", message: `${label}${when}` }]);
      context.report(`「${item.job.company || item.job.title}」${label}`, "verifying");
    } catch (error) {
      const where = source === "job51-records"
        ? "前程无忧申请记录已找到这条投递"
        : source === "zhaopin-message" ? "智联消息记录已找到这条投递" : "Boss 消息记录已找到这条招呼";
      const message = `${where}，但写入投递记录失败：${text(error?.message ?? error, 160)}`;
      log(message);
      context.update([{ id: item.id, state: "needs_user", message }]);
      context.report(message, "verifying");
    }
  }

  async function markVerifiedSent(item, contact, source, reason) {
    const state = await store.state();
    const existing = findApplicationForJob(state, item.job);
    const app = existing ?? await store.addApplication(item.job);
    const wasSubmitted = app.status === "submitted";
    const verifiedAt = Date.now();
    const when = contact?.timeText ? `（${contact.timeText}）` : "";
    const bossSource = source === "boss-chat" || source === "boss-chat-ai";
    const recordLabel = source === "job51-records"
      ? "前程无忧申请记录"
      : source === "zhaopin-message" ? "智联消息记录" : "Boss 消息记录";
    const note = bossSource ? `Boss 消息记录确认已发出${when}` : `${recordLabel}确认已投递`;
    const updated = await store.updateApplication(app.id, {
      status: "submitted",
      submittedAt: app.submittedAt || verifiedAt,
      evidence: {
        ...app.evidence,
        greeting: bossSource ? (app.evidence.greeting || batchGreetings.get(item.job.sourceUrl) || "") : app.evidence.greeting,
        greetingSource: bossSource ? "verified" : app.evidence.greetingSource,
        verifiedAt,
        verifySource: source,
        verifyNote: text(`${recordLabel}${when ? ` ${when}` : ""} · ${reason}`, 200),
        successText: app.evidence.successText || (bossSource ? "Boss 消息记录里已出现这次招呼" : `${recordLabel}里已有这条投递`),
        endedAt: app.evidence.endedAt || verifiedAt,
      },
    });
    if (wasSubmitted) return updated;
    await store.markRun();
    const guard = runner.siteGuard(item.job.source);
    guard.failures = 0;
    guard.unconfirmed = 0;
    await runner.recordOutcome({
      company: updated.job.company,
      jobTitle: updated.job.title,
      sourceUrl: updated.job.sourceUrl,
      recruiter: updated.job.recruiter,
      platform: updated.job.source,
      outcome: "applied",
      note,
    }).catch((error) => log(`outcome record failed: ${text(error?.message ?? error, 160)}`));
    if (state.rules.notifyWebhook) void runner.deliverWebhook(state.rules.notifyWebhook, updated);
    return updated;
  }

  async function askBossChatAi(items, hints, snapshot, batchStartedAt, since) {
    let chat = null;
    try {
      chat = await chatFor();
    } catch (error) {
      log(`boss chat ai model resolve failed: ${text(error?.message ?? error, 200)}`);
    }
    if (!chat) return { verdicts: [], error: "未配置可用模型", model: "" };
    const aiItems = items.map((item) => ({
      id: item.id,
      company: item.job.company,
      title: item.job.title,
      recruiter: item.job.recruiter ?? "",
      city: item.job.city ?? "",
      state: item.state,
      message: item.message,
      processedAt: item.updatedAt,
      anonymous: isAnonymousCompany(item.job.company),
      greetingHint: hints.get(item.id) ?? "",
    }));
    try {
      const prompt = buildBossChatAiPrompt({
        items: aiItems,
        contacts: snapshot.contacts,
        complete: snapshot.complete,
        batchStartedAt,
      });
      const completion = await chat({
        ...prompt,
        temperature: 0.1,
        maxTokens: 4000,
      });
      const parsed = parseResumeAiJson(completion?.content ?? "");
      if (!parsed) return { verdicts: [], error: "模型返回内容无法解析", model: completion?.model ?? "" };
      const verdicts = sanitizeBossChatVerdicts({
        raw: parsed,
        items: aiItems,
        contacts: snapshot.contacts,
        complete: snapshot.complete,
        since,
        greetingHints: Object.fromEntries(hints),
      });
      log(`boss chat ai verify: ${verdicts.map((entry) => `${entry.id}=${entry.verdict}`).join(",")}`);
      return { verdicts, error: "", model: completion?.model ?? "" };
    } catch (error) {
      const message = text(error?.message ?? error, 200);
      log(`boss chat ai verify failed: ${message}`);
      return { verdicts: [], error: message, model: "" };
    }
  }

  async function repairBatchItems(context, items, hints, since) {
    let stopReason = "";
    const finalized = new Set();
    const repairedState = new Map();
    for (const item of items) {
      if (context.signal?.aborted) return "已停止";
      const gate = await waitForRepairGate(item.job, context);
      if (!gate.allowed) {
        const reason = gate.reason || "当前不满足补发条件";
        context.update([{ id: item.id, state: "needs_user", message: `Boss 消息记录确认没发出，但本次未补发：${reason}` }]);
        context.report(`未补发「${item.job.company}」：${reason}`, "repairing");
        finalized.add(item.id);
        if (gate.fatal) {
          stopReason = reason;
          break;
        }
        continue;
      }
      let greeting = hints.get(item.id) || batchGreetings.get(item.job.sourceUrl) || "";
      if (!greeting) {
        try {
          greeting = (await greetingFor({ job: item.job })).text;
          batchGreetings.set(item.job.sourceUrl, greeting);
        } catch (error) {
          log(`repair greeting failed: ${text(error?.message ?? error, 160)}`);
        }
      }
      if (!greeting) {
        context.update([{ id: item.id, state: "needs_user", message: "Boss 消息记录确认没发出，但没有可用的招呼语，未补发" }]);
        finalized.add(item.id);
        continue;
      }
      context.report(`正在补发「${item.job.company} · ${item.job.title}」`, "repairing");
      let result;
      try {
        result = await runner.greet({ job: item.job, greeting }, {
          fromBatch: true,
          signal: context.signal,
          onProgress: (message) => context.report(message, "repairing"),
        });
      } catch (error) {
        if (context.signal?.aborted) return "已停止";
        const message = text(error?.message ?? error, 200);
        context.update([{ id: item.id, state: "failed", message: `补发失败：${message}` }]);
        repairedState.set(item.id, "failed");
        finalized.add(item.id);
        continue;
      }
      finalized.add(item.id);
      const runState = result.run.state;
      if (runState === "submitted") {
        repairedState.set(item.id, "sent");
        context.update([{ id: item.id, state: "sent", message: `补发成功：${result.run.message || "页面确认已发出"}` }]);
        context.report(`「${item.job.company}」补发成功`, "repairing");
        continue;
      }
      const nextState = runState === "failed" ? "failed" : "needs_user";
      repairedState.set(item.id, nextState);
      context.update([{ id: item.id, state: nextState, message: `补发后仍未确认：${result.run.message}` }]);
      if (shouldPauseBatch({ state: runState, blockedReason: result.run.blockedReason })) {
        stopReason = result.run.blockedReason || result.run.message || "平台拦截";
        break;
      }
    }
    if (stopReason) {
      const rest = items.filter((item) => !finalized.has(item.id));
      if (rest.length) {
        context.update(rest.map((item) => ({
          id: item.id,
          state: "needs_user",
          message: `Boss 消息记录确认没发出，但补发已停止（${stopReason}），请稍后重试`,
        })));
      }
    }
    if (repairedState.size && !context.signal?.aborted) {
      await confirmRepaired(context, items, repairedState, since);
    }
    return stopReason;
  }

  async function repairGate(job) {
    const state = await store.state();
    const screened = screenJob(state.rules, job);
    if (screened) return { allowed: false, waitMs: 0, reason: `已按安全规则拦截：${screened}`, fatal: false };
    const tagged = await jobTagSkipReason(job);
    if (tagged) return { allowed: false, waitMs: 0, reason: tagged, fatal: false };
    if (!job.sourceUrl) return { allowed: false, waitMs: 0, reason: "岗位缺少官方链接", fatal: false };
    const summaries = await outcomes.summaries();
    const key = companyNameKey(job.company);
    const summary = key ? summaries[key] ?? null : null;
    if (summary && (summary.blocked > 0 || (state.rules.autoBlockRejected && summary.rejected > 0))) {
      return { allowed: false, waitMs: 0, reason: "这家公司已回复不合适或已被屏蔽，未补发", fatal: false };
    }
    const now = Date.now();
    const submittedToday = state.applications.filter((entry) => entry.status === "submitted" && entry.submittedAt >= startOfDay(now));
    const quotaKey = dailyQuotaKey(job.source);
    const siteSubmitted = submittedToday.filter((entry) => dailyQuotaKey(entry.job.source) === quotaKey);
    const lastActionAt = runner.lastGreetAt() || submittedToday.reduce((max, entry) => Math.max(max, entry.submittedAt), 0);
    // 与宿主一致：间隔只在上次投递时间变化时随机一次，等待期间倒计时不会跳。
    const intervalKey = governorState.intervalKey;
    if (lastActionAt !== intervalKey) {
      governorState.intervalKey = lastActionAt;
      governorState.intervalGapMs = nextIntervalMs({
        intervalMinSeconds: state.rules.greetIntervalMinSeconds,
        intervalMaxSeconds: state.rules.greetIntervalMaxSeconds,
      });
    }
    const decision = evaluateGovernor({
      config: {
        window: state.rules.autoApplyWindow,
        intervalMinSeconds: state.rules.greetIntervalMinSeconds,
        intervalMaxSeconds: state.rules.greetIntervalMaxSeconds,
        dailyLimit: state.rules.dailyLimit,
        dailyCompanyLimit: state.rules.dailyCompanyLimit,
        companyCooldownDays: state.rules.companyCooldownDays,
      },
      now,
      lastActionAt,
      gapMs: governorState.intervalGapMs,
      todayCount: siteSubmitted.length,
      todayCompanies: siteSubmitted.map((entry) => companyNameKey(entry.job.company)).filter(Boolean),
      company: key,
      companyLastAt: 0,
      companyOutcome: "",
      consecutiveFailures: 0,
      cooldownUntil: runner.siteGuard(job.source).cooldownUntil,
      siteLabel: quotaLabel(job.source),
    });
    if (decision.allowed) return { allowed: true, waitMs: 0, reason: "", fatal: false };
    if (decision.waitMs > 0) return { allowed: false, waitMs: decision.waitMs, reason: decision.reason, fatal: false };
    return { allowed: false, waitMs: 0, reason: decision.reason, fatal: true };
  }

  async function waitForRepairGate(job, context) {
    let waited = 0;
    for (;;) {
      if (context.signal?.aborted) return { allowed: false, reason: "已停止", fatal: true };
      const gate = await repairGate(job);
      if (gate.allowed) return { allowed: true, reason: "", fatal: false };
      if (!gate.waitMs) return { allowed: false, reason: gate.reason, fatal: gate.fatal };
      if (waited + gate.waitMs > MAX_REPAIR_WAIT_MS) {
        return { allowed: false, reason: `${gate.reason}（等待超过 8 分钟，本次未补发）`, fatal: true };
      }
      context.report(`等待 ${Math.ceil(gate.waitMs / 1000)} 秒后补发「${job.company}」`, "repairing");
      await sleepAbortable(gate.waitMs, context.signal);
      waited += gate.waitMs;
    }
  }

  async function confirmRepaired(context, items, repairedState, since) {
    const targets = items.filter((item) => repairedState.has(item.id));
    if (!targets.length) return;
    context.report("补发结束，正在重新读取 Boss 消息记录确认", "verifying");
    const snapshot = await records.readBossChatList({ since }).catch((error) => {
      log(`repair recheck read failed: ${text(error?.message ?? error, 160)}`);
      return null;
    });
    if (!snapshot || !snapshot.ok) {
      context.report(`补发后重新读取消息记录失败：${snapshot?.message || "未知原因"}`, "verifying");
      return;
    }
    const hints = await greetingHints(targets);
    for (const item of targets) {
      if (context.signal?.aborted) return;
      const match = matchBossContact({
        job: item.job,
        contacts: snapshot.contacts,
        complete: snapshot.complete,
        since,
        greetingHint: hints.get(item.id) ?? "",
      });
      if (match.verdict === "sent") {
        await applyVerifiedSent(context, item, snapshot.contacts[match.contactIndex], "boss-chat", match.reason);
        continue;
      }
      if (match.verdict === "not_sent" && repairedState.get(item.id) !== "sent") {
        context.update([{ id: item.id, state: "needs_user", message: "补发后 Boss 消息记录里仍没有这家公司的招呼，请人工核对" }]);
      }
    }
  }

  hydrate();

  return {
    queue: batch,
    batchStatusFile,
    status,
    preflight: batchPreflight,
    start,
    pause: (message) => batch.pause(message),
    resume,
    stop: (message) => batch.stop(message),
    forceStop: (message) => batch.reset(message),
    recheck,
    refreshBatchSkips,
    onJobSiteClosed,
    reconcileBatch,
    flush,
  };
}
