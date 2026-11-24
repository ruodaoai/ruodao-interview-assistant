import { randomUUID } from "node:crypto";
import type { AutoApplyJob } from "./types";

export type BatchItemState = "queued" | "running" | "sent" | "needs_user" | "skipped" | "failed";

export type BatchItemSummary = {
  id: string;
  company: string;
  title: string;
  sourceUrl: string;
  city: string;
  state: BatchItemState;
  message: string;
  updatedAt: number;
};

export type BatchState = "idle" | "running" | "paused" | "stopping" | "stopped" | "done";

/** 队列当前所处的阶段，前端据此告诉用户「程序现在在干嘛」。 */
export type BatchPhase = "idle" | "gate" | "waiting" | "sending" | "settling" | "verifying" | "repairing";

export type BatchLive = {
  /** 正在处理的条目下标（0 基），-1 表示没有在跑。 */
  index: number;
  itemId: string;
  company: string;
  title: string;
  city: string;
  phase: BatchPhase;
  phaseText: string;
  /** 这一条开始处理的时间，用于算「已用时」。 */
  startedAt: number;
  /** 等待结束的时间戳；大于当前时间时前端做倒计时。 */
  waitUntil: number;
  waitReason: string;
  nextCompany: string;
  nextTitle: string;
  /** 最近一次成功发送的时间。 */
  lastSentAt: number;
  /** 预计整批完成的时间戳；0 表示未知。 */
  etaAt: number;
};

export type BatchLogLevel = "info" | "ok" | "warn" | "error";

export type BatchLogEntry = { at: number; level: BatchLogLevel; message: string };

export type BatchStatus = {
  id: string;
  state: BatchState;
  items: BatchItemSummary[];
  startedAt: number;
  finishedAt: number;
  message: string;
  sentCount: number;
  totalCount: number;
  live: BatchLive;
  logs: BatchLogEntry[];
};

export type BatchGate = {
  allowed: boolean;
  reason?: string;
  waitMs?: number;
  skip?: boolean;
  /**
   * 拒绝原因属于「整批环境熔断」（连续失败 / 平台冷却），而不是「这个岗位不合格」。
   * 这种条目不能标成「已跳过」——那会把一个根本还没尝试过的岗位永久吃掉，
   * 用户点「继续」之后又白白少一个岗位（用户 10-31 反馈「越点继续能投的越少」）。
   */
  retain?: boolean;
};

export type BatchRunResult = { state: "sent" | "needs_user" | "failed" | "skipped"; message: string; pauseBatch?: boolean };

export type BatchPostRunItem = {
  id: string;
  job: AutoApplyJob;
  state: BatchItemState;
  message: string;
  updatedAt: number;
};

/**
 * 整批跑完后的核对上下文。
 * 这时候队列还在收尾（loopRunning 仍为 true），不能开始新的一批；
 * 但页面窗口还开着，正好用来读 Boss 消息记录、补发确认没发出去的岗位。
 */
export type BatchPostRunContext = {
  status: BatchStatus;
  items: BatchPostRunItem[];
  signal?: AbortSignal;
  /** 更新顶部实时阶段：verifying = 核对消息记录，repairing = 补发。 */
  report: (message: string, phase?: BatchPhase) => void;
  /** 回写单条岗位的最终状态，用户在进度面板上能立刻看到。 */
  update: (updates: { id: string; state: BatchItemState; message: string }[]) => void;
};

type BatchContext = {
  batchId: string;
  index: number;
  signal: AbortSignal;
  /** 执行过程中回报细节步骤（例如「正在打开聊天窗口」），直接进实时进度与日志。 */
  report: (message: string) => void;
};

export type BatchDeps = {
  run: (job: AutoApplyJob, context: BatchContext) => Promise<BatchRunResult>;
  gate: (job: AutoApplyJob, context: BatchContext) => Promise<BatchGate>;
  settle: (job: AutoApplyJob, result: BatchRunResult) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** 单条投递的硬超时：页面卡死或窗口被关闭时不再无限等待。默认 4 分钟。 */
  itemTimeoutMs?: number;
  /** 条件检查（本地读盘 / 读台账）的超时，默认 60 秒。 */
  gateTimeoutMs?: number;
  /** 每条之间的大致间隔（毫秒），仅用于估算整批完成时间。 */
  estimateMsPerItem?: () => number;
  /** 把最新进度落盘；应用重启后还能看到上一批投了什么。调用方自行节流。 */
  persist?: (status: BatchStatus) => void;
  /**
   * 整批结束（完成 / 停止 / 强制结束）后的回调。
   * 调用方用它做收尾动作，例如关闭批量投递用的真实浏览器窗口——
   * 投递面板要留着给用户看结果，窗口则应该收掉。
   */
  onFinished?: (status: BatchStatus) => void;
  /**
   * 整批正常跑完后的最终核对（Boss 消息记录 / AI 判定 / 受限补发）。
   * 在关闭招聘窗口之前执行；用户点「停止」后不再执行。
   */
  postRun?: (context: BatchPostRunContext) => Promise<unknown>;
};

const MAX_WAIT_CHUNK_MS = 60_000;
const DEFAULT_ITEM_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const MAX_LOG_ENTRIES = 120;

type Guarded<T> =
  | { status: "ok"; value: T }
  | { status: "aborted" }
  /** 招聘窗口被关闭：只打断当前这一条，批次保持暂停，点「继续」后再接着投。 */
  | { status: "paused" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * 批量投递队列：顺序执行、可暂停/继续/停止。
 * 真正的发送仍复用单条打招呼（含证据截图与成功校验），
 * 这里只负责节奏、跳过规则和失败熔断。
 *
 * 关键约束：每一处 await 都可以被 stop() 打断。
 * 之前 stop() 只是改状态位，正在执行的单条投递若卡在浏览器调用上，
 * 队列就永远停在 running，用户再点开始只会得到「已有批量投递任务在执行」。
 */
export class BatchApplyQueue {
  private status: BatchStatus = emptyStatus();
  private jobs = new Map<string, AutoApplyJob>();
  private paused = false;
  /** 是否还有一条岗位正在执行（gate/run/settle）；重新核对消息记录前必须等它收尾。 */
  private processing = false;
  private stopped = false;
  /** runLoop 是否还活着；用状态位判断会因为卡住的 await 永远为真。 */
  private loopRunning = false;
  private controller: AbortController | null = null;
  private wake: (() => void) | null = null;
  /**
   * 当前这一条的打断开关。窗口被关闭时浏览器调用可能一直不返回，
   * 只改暂停标志会让 runLoop 卡在 guard 里，用户点「继续」看起来毫无反应。
   * 这里只打断当前条目，整批仍保持暂停。
   */
  private itemController: AbortController | null = null;
  /** 批次世代号：旧批次的收尾逻辑不许覆盖新批次的状态。 */
  private runToken = 0;
  private logs: BatchLogEntry[] = [];

  constructor(private readonly deps: BatchDeps) {}

  private log(line: string) {
    this.deps.log?.(`[auto-apply-batch] ${line}`);
  }

  /** 写一条用户可见的实时日志（同时写系统日志）。 */
  private pushLog(message: string, level: BatchLogLevel = "info") {
    const text = String(message ?? "").trim();
    if (!text) return;
    this.logs.push({ at: this.now(), level, message: text.slice(0, 300) });
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
    this.status.logs = this.logs;
    this.log(text);
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  private sleep(ms: number) {
    const duration = Math.max(0, ms);
    const custom = this.deps.sleep;
    return new Promise<void>((resolve) => {
      let done = false;
      const signal = this.signal;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = null;
      };
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const timer = setTimeout(finish, duration);
      signal?.addEventListener("abort", finish);
      this.wake = finish;
      // 允许测试注入自定义 sleep；但仍然由 abort 唤醒。
      void custom;
    });
  }

  private notify() {
    this.status = {
      ...this.status,
      items: this.status.items.map((item) => ({ ...item })),
      sentCount: this.status.items.filter((item) => item.state === "sent").length,
      totalCount: this.status.items.length,
      logs: this.logs,
    };
    this.deps.persist?.(this.statusSnapshot());
  }

  /**
   * 启动时恢复上一批进度：用户重启应用后仍然能看到投了哪些、卡在哪一条。
   * 进程已经退出，队列不可能继续跑，所以运行中的批次一律降级为「已中断」，
   * 真正在处理的那一条按「需本人确认」保留，避免用户以为它没发出去而重复投递。
   */
  hydrate(raw: unknown) {
    const status = normalizeStatus(raw);
    if (!status || !status.id) return;
    this.logs = status.logs;
    if (status.state === "running" || status.state === "paused" || status.state === "stopping") {
      status.state = "stopped";
      status.finishedAt = status.finishedAt || this.now();
      status.message = "上次批量投递在应用重启时中断；已发送的结果都已保留，没轮到的岗位可以重新勾选再投";
      status.live = {
        ...status.live,
        phase: "idle",
        phaseText: "应用重启前的批次已中断",
        waitUntil: 0,
        waitReason: "",
        nextCompany: "",
        nextTitle: "",
        etaAt: 0,
      };
      status.items = status.items.map((item) => {
        if (item.state === "running") {
          return { ...item, state: "needs_user", message: "应用重启前正在投这个岗位，请到 Boss 聊天窗口确认是否已发出" };
        }
        if (item.state === "queued") return { ...item, state: "skipped", message: "批次被中断，未执行" };
        return item;
      });
      this.logs.push({ at: this.now(), level: "warn", message: "应用重启，上一批投递已标记为中断" });
      status.logs = this.logs;
    }
    this.status = status;
    this.notify();
    this.log(`hydrated ${status.id} ${status.state}`);
  }

  statusSnapshot(): BatchStatus {
    return {
      ...this.status,
      items: this.status.items.map((item) => ({ ...item })),
      live: { ...this.status.live, etaAt: this.estimateEta() },
      logs: this.logs.map((entry) => ({ ...entry })),
    };
  }

  /** 还排在队里、可以被重新预检的岗位（带岗位详情，供上层重新跑一遍准入规则）。 */
  pending(): { id: string; job: AutoApplyJob }[] {
    return this.status.items
      .filter((item) => item.state === "queued")
      .map((item) => ({ id: item.id, job: this.jobs.get(item.id) }))
      .filter((entry): entry is { id: string; job: AutoApplyJob } => Boolean(entry.job));
  }

  /** 队列里保存的岗位详情；应用重启后 this.jobs 为空，需要上层从投递记录补齐。 */
  jobFor(itemId: string): AutoApplyJob | undefined {
    return this.jobs.get(itemId);
  }

  /** 已结束批次里仍待本人确认 / 未发出的条目；重启后没有岗位详情时返回空。 */
  postRunCandidates(): BatchPostRunItem[] {
    if (this.active()) return [];
    return this.status.items
      .filter((item) => item.state === "needs_user" || item.state === "failed")
      .map((item): BatchPostRunItem | null => {
        const job = this.jobs.get(item.id);
        return job ? { id: item.id, job, state: item.state, message: item.message, updatedAt: item.updatedAt } : null;
      })
      .filter((item): item is BatchPostRunItem => Boolean(item));
  }

  /** 手动重新核对只追加日志，不把「已完成」批次改回运行中，避免用户以为又在投递。 */
  reportVerification(message: string, level: BatchLogLevel = "info") {
    this.pushLog(message, level);
  }

  /** 手动核对回写单条岗位状态（复用批量结束后的同一套回写与落盘）。 */
  applyVerification(updates: { id: string; state: BatchItemState; message: string }[]) {
    this.applyPostRunUpdates(updates);
  }

  /**
   * 运行中重新预检：把已经注定被跳过的排队项标成跳过。
   * 批次开始后用户才屏蔽这家公司 / 把它标成外包时，队列不会自己变，用户会一直
   * 看到「排队中」，以为马上就要投出去。正在投的那一条不动（消息可能已经发出）。
   */
  markSkipped(entries: { id: string; reason: string }[]) {
    if (!entries.length) return 0;
    const reasons = new Map(entries.map((entry) => [entry.id, entry.reason]));
    let changed = 0;
    this.status.items = this.status.items.map((item) => {
      const reason = reasons.get(item.id);
      if (!reason || item.state !== "queued") return item;
      changed += 1;
      return { ...item, state: "skipped" as const, message: reason, updatedAt: this.now() };
    });
    if (changed) {
      this.pushLog(`队列更新：${changed} 个岗位不再投递（${[...new Set(entries.map((entry) => entry.reason))].join("；")}）`, "warn");
      this.notify();
    }
    return changed;
  }

  /** 估算整批完成时间：当前等待/处理结束点 + 剩余条数 × 平均间隔。 */
  private estimateEta() {
    const live = this.status.live;
    if (!this.active()) return 0;
    const remaining = this.status.items.filter((item) => item.state === "queued").length;
    if (!remaining) return 0;
    const per = Math.max(1_000, Math.round(this.deps.estimateMsPerItem?.() ?? 60_000));
    return Math.max(this.now(), live.waitUntil || 0) + remaining * per;
  }

  private setLive(patch: Partial<BatchLive>) {
    this.status.live = { ...this.status.live, ...patch };
    this.notify();
  }

  /** 下一个还没处理的岗位，用于提前告诉用户「接下来投哪家」。 */
  private nextPending(afterIndex: number) {
    for (let index = Math.max(0, afterIndex + 1); index < this.status.items.length; index += 1) {
      const item = this.status.items[index];
      if (item.state === "queued") return item;
    }
    return null;
  }

  active() {
    return this.status.state === "running" || this.status.state === "paused" || this.status.state === "stopping";
  }

  /** 队列是否还有活着的执行循环（停止后通常在一个 tick 内变 false）。 */
  busy() {
    return this.loopRunning;
  }

  /**
   * 是否停在可以读 Boss 消息记录的状态：已结束、已停止，或暂停且当前岗位已收尾。
   * 暂停时如果还有一条在 gate/run 里，读消息会把它的页面导航走，必须等它结束。
   */
  idleForRecheck() {
    if (this.processing) return false;
    const state = this.status.state;
    return state === "done" || state === "stopped" || state === "paused";
  }

  private resetRunState(startedAt: number) {
    this.paused = false;
    this.stopped = false;
    this.controller = new AbortController();
    this.status.startedAt = startedAt;
    this.status.finishedAt = 0;
  }

  /**
   * 入队时就已经确定会被跳过的岗位（公司冷却、已标记外包、已经打过招呼）由 skipped 传入，
   * 创建队列项时直接置为 skipped 并写清原因。
   *
   * 必须在启动执行循环之前带上：start 之后第一条会立刻被置为 running，
   * 事后再标记就会漏掉它。同时队列里的「排队中 N」也不会把注定不投的岗位算进去——
   * 用户看到「外企德科 排队中」却永远等不到它，就是因为它其实会被跳过。
   * 执行循环仍会对每一条再走一次准入检查，这里只负责提前把结论摆到界面上。
   */
  async start(jobs: AutoApplyJob[], skipped: Record<string, string> = {}): Promise<BatchStatus> {
    if (this.loopRunning) {
      // 上一批已经被要求停止、但循环还没退出的窗口期：给它一点时间收尾，
      // 否则用户点「停止」后再点「开始」会立刻撞上旧任务。
      await this.waitForIdle(1500);
    }
    if (this.loopRunning) throw new Error("已有批量投递任务在执行，请先停止当前任务");
    // 平台无关：Boss 走打招呼，猎聘 / 智联 / 前程无忧 走详情页投递，
    // 具体执行哪个动作由 deps.run 按 job.source 分流。
    const list = jobs.filter((job) => job && job.sourceUrl);
    if (!list.length) throw new Error("请先选择至少一个岗位再开始批量投递");
    const startedAt = this.now();
    this.jobs = new Map();
    this.logs = [];
    const preSkipped = list.filter((job) => skipped[job.sourceUrl]).length;
    this.status = {
      id: `batch-${randomUUID().slice(0, 12)}`,
      state: "running",
      items: list.map((job) => {
        const id = `bi-${randomUUID().slice(0, 12)}`;
        this.jobs.set(id, job);
        const reason = skipped[job.sourceUrl] ?? "";
        return {
          id,
          company: job.company || "未命名公司",
          title: job.title,
          sourceUrl: job.sourceUrl,
          city: job.city,
          state: reason ? "skipped" as const : "queued" as const,
          message: reason,
          updatedAt: startedAt,
        };
      }),
      startedAt,
      finishedAt: 0,
      message: "批量投递已开始，遇到登录或验证码会自动暂停",
      sentCount: 0,
      totalCount: list.length,
      live: { ...emptyLive(), phase: "gate", phaseText: "准备开始", startedAt },
      logs: [],
    };
    this.resetRunState(startedAt);
    this.runToken += 1;
    const token = this.runToken;
    this.pushLog(`批量投递开始，共 ${list.length} 个岗位`, "info");
    if (preSkipped) {
      this.pushLog(`预检跳过 ${preSkipped} 个岗位：${[...new Set(list.map((job) => skipped[job.sourceUrl]).filter(Boolean))].join("；")}`, "warn");
    }
    this.notify();
    void this.runLoop(token);
    return this.statusSnapshot();
  }

  private async waitForIdle(timeoutMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.loopRunning && Date.now() < deadline) await this.sleep(50);
  }

  pause(message = "已暂停批量投递", options: { abortActive?: boolean } = {}) {
    if (this.status.state !== "running") return this.statusSnapshot();
    this.paused = true;
    this.status.state = "paused";
    this.status.message = message;
    this.status.live = { ...this.status.live, phase: "waiting", phaseText: "已暂停", waitUntil: 0 };
    this.pushLog(message, "warn");
    // 窗口已经被关掉时，正在跑的浏览器调用不会自己结束：立刻打断这一条，
    // 让 runLoop 回到暂停等待，而不是把整个队列挂在这里。
    if (options.abortActive) this.itemController?.abort();
    this.interrupt();
    this.notify();
    return this.statusSnapshot();
  }

  /** 暂停期间更新提示文案（例如点「继续」时窗口重新打开失败）。 */
  updatePausedMessage(message: string) {
    if (this.status.state !== "paused") return;
    this.status.message = message;
    this.notify();
  }

  resume() {
    if (this.status.state !== "paused") return this.statusSnapshot();
    this.paused = false;
    this.stopped = false;
    // 上一轮 runLoop 若异常退出会清掉 controller；继续时补一个，避免恢复后没有中断信号。
    if (!this.controller) this.controller = new AbortController();
    this.status.state = "running";
    this.status.message = "已继续批量投递";
    this.status.live = { ...this.status.live, phase: "gate", phaseText: "已继续，正在检查投递条件", waitUntil: 0 };
    this.pushLog("继续批量投递", "info");
    this.interrupt();
    if (!this.loopRunning) {
      // 执行循环如果已经退出（异常 / 崩溃），继续必须把它重新拉起来，否则只会改状态不动。
      const startIndex = this.status.items.findIndex((item) => item.state === "queued");
      if (startIndex >= 0) {
        this.runToken += 1;
        const token = this.runToken;
        this.pushLog("执行循环已退出，从剩余岗位重新开始", "warn");
        this.notify();
        void this.runLoop(token, startIndex);
        return this.statusSnapshot();
      }
    }
    this.notify();
    return this.statusSnapshot();
  }

  stop(message = "已停止批量投递") {
    if (!this.active()) return this.statusSnapshot();
    this.stopped = true;
    this.paused = false;
    this.status.state = "stopped";
    this.status.message = message;
    this.status.finishedAt = this.now();
    this.status.live = { ...this.status.live, phase: "idle", phaseText: "已停止", waitUntil: 0 };
    this.pushLog(message, "warn");
    this.interrupt();
    // 中断信号让正在进行的 run/gate 立即返回，队列在下一拍退出。
    this.controller?.abort();
    this.notify();
    return this.statusSnapshot();
  }

  /** 极端情况下强制把队列复位，允许用户重新开始（不会保留本批次结果）。 */
  reset(message = "已强制结束上一批任务") {
    const wasActive = this.active();
    this.stopped = true;
    this.paused = false;
    this.loopRunning = false;
    this.runToken += 1;
    this.controller?.abort();
    this.controller = null;
    this.jobs.clear();
    this.logs = [];
    this.status = { ...emptyStatus(), message };
    this.notify();
    // 强制结束通常是「上一批卡在浏览器操作上」：同样要触发收尾，把那个卡住的窗口收掉。
    if (wasActive) this.finish(message);
    return this.statusSnapshot();
  }

  /** 通知调用方本批已结束（幂等由调用方判断，这里只负责投递事件）。 */
  private finish(message = "") {
    if (!this.deps.onFinished) return;
    try {
      const status: BatchStatus = {
        ...this.statusSnapshot(),
        state: this.status.state === "idle" ? "stopped" : this.status.state,
        message: message || this.status.message,
      };
      this.deps.onFinished(status);
    } catch (error: any) {
      this.log(`onFinished failed: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }

  private interrupt() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private update(index: number, patch: Partial<BatchItemSummary>) {
    const item = this.status.items[index];
    if (!item) return;
    this.status.items[index] = { ...item, ...patch, updatedAt: this.now() };
    this.notify();
  }

  /** 批量结束后的核对 / 补发回写条目状态；只改传进来的条目。 */
  private applyPostRunUpdates(updates: { id: string; state: BatchItemState; message: string }[]) {
    if (!updates.length) return;
    const patch = new Map(updates.map((entry) => [entry.id, entry]));
    let changed = 0;
    this.status.items = this.status.items.map((item) => {
      const next = patch.get(item.id);
      if (!next) return item;
      if (item.state === next.state && item.message === next.message) return item;
      changed += 1;
      return { ...item, state: next.state, message: next.message.slice(0, 300), updatedAt: this.now() };
    });
    if (!changed) return;
    const first = updates[0]?.message ?? "";
    this.pushLog(updates.length === 1 ? `核对结果：${first}` : `核对结果：${updates.length} 个岗位状态已更新（${first}）`, "info");
    this.notify();
  }

  /** 结束文案统一在这里算，避免「成功 0 个」之类的状态漏报。 */
  private summaryMessage() {
    const items = this.status.items;
    const sent = items.filter((item) => item.state === "sent").length;
    const skipped = items.filter((item) => item.state === "skipped").length;
    const pending = items.filter((item) => item.state === "needs_user").length;
    const failed = items.filter((item) => item.state === "failed").length;
    const bossVerified = items.filter((item) => item.state === "sent" && /Boss 消息记录/.test(item.message)).length;
    const job51Verified = items.filter((item) => item.state === "sent" && /前程无忧申请记录/.test(item.message)).length;
    const zhaopinVerified = items.filter((item) => item.state === "sent" && /智联消息记录/.test(item.message)).length;
    const verified = [
      bossVerified ? `${bossVerified} 个由 Boss 消息记录确认` : "",
      job51Verified ? `${job51Verified} 个由前程无忧申请记录确认` : "",
      zhaopinVerified ? `${zhaopinVerified} 个由智联消息记录确认` : "",
    ].filter(Boolean).join("，");
    const bits = [`成功 ${sent} 个${verified ? `（其中 ${verified}）` : ""}`];
    if (skipped) bits.push(`跳过 ${skipped} 个`);
    if (pending) bits.push(`待确认 ${pending} 个`);
    if (failed) bits.push(`未发出 ${failed} 个`);
    return `批量投递结束：${bits.join("，")}`;
  }

  private async waitWhilePaused() {
    while (this.paused && !this.stopped) await this.sleep(250);
  }

  private async waitFor(ms: number) {
    // 长等待拆成小块，用户停止时能及时退出。
    // 用真实时间算截止点：暂停会提前唤醒 sleep，按块数递减会少等一大截。
    const deadline = Date.now() + Math.max(0, ms);
    while (!this.stopped) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(remaining, MAX_WAIT_CHUNK_MS));
      await this.waitWhilePaused();
    }
  }

  /**
   * 给任意异步任务套上「停止 / 窗口关闭 / 超时」三道闸门。
   * 底层 Promise 无法真正取消（Electron 的浏览器调用可能永远不返回），
   * 但队列不必陪着它一起卡死。
   */
  private guard<T>(task: Promise<T>, timeoutMs: number, pauseSignal?: AbortSignal): Promise<Guarded<T>> {
    const signal = this.signal;
    if (signal?.aborted) return Promise.resolve({ status: "aborted" });
    if (pauseSignal?.aborted) return Promise.resolve({ status: "paused" });
    return new Promise<Guarded<T>>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: Guarded<T>) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pauseSignal?.removeEventListener("abort", onPause);
        resolve(result);
      };
      const onAbort = () => finish({ status: "aborted" });
      const onPause = () => finish({ status: "paused" });
      signal?.addEventListener("abort", onAbort);
      pauseSignal?.addEventListener("abort", onPause);
      if (timeoutMs > 0) timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
      task.then((value) => finish({ status: "ok", value })).catch((error) => finish({ status: "error", error }));
    });
  }

  private freshItemSignal(): AbortSignal {
    this.itemController = new AbortController();
    return this.itemController.signal;
  }

  private async runLoop(token: number, startIndex = 0) {
    this.loopRunning = true;
    const itemTimeoutMs = Math.max(1_000, Math.round(this.deps.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS));
    const gateTimeoutMs = Math.max(1_000, Math.round(this.deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS));
    try {
      for (let index = startIndex; index < this.status.items.length; index += 1) {
        if (this.stopped) break;
        await this.waitWhilePaused();
        if (this.stopped) break;
        const summary = this.status.items[index];
        const job = this.jobs.get(summary.id);
        if (!job) continue;
        const context: BatchContext = {
          batchId: this.status.id,
          index,
          signal: this.signal ?? new AbortController().signal,
          report: (message: string) => {
            // 只在还停留在这一条时更新，避免旧回调污染下一条的进度。
            if (this.status.live.itemId !== summary.id) return;
            const detail = String(message ?? "").trim();
            if (!detail) return;
            this.status.live = { ...this.status.live, phaseText: detail.slice(0, 120) };
            this.pushLog(detail);
            this.notify();
          },
        };
        const next = this.nextPending(index);
        const position = `${index + 1}/${this.status.items.length}`;

        this.setLive({
          index,
          itemId: summary.id,
          company: summary.company,
          title: summary.title,
          city: summary.city,
          phase: "gate",
          phaseText: "正在检查投递条件",
          startedAt: this.now(),
          waitUntil: 0,
          waitReason: "",
          nextCompany: next ? next.company : "",
          nextTitle: next ? next.title : "",
        });
        this.update(index, { state: "running", message: "正在检查投递条件" });
        this.pushLog(`第 ${position} 个：检查「${summary.company}」的投递条件`, "info");
        const gated = await this.guard(this.deps.gate(job, context), gateTimeoutMs, this.freshItemSignal());
        if (gated.status === "aborted") {
          this.update(index, { state: "skipped", message: "已停止，未投递" });
          break;
        }
        if (gated.status === "paused") {
          // 条件检查本身没有副作用：窗口重新打开后重新检查同一个岗位即可。
          this.update(index, { state: "queued", message: "招聘窗口被关闭，已暂停；点「继续」会重新检查这个岗位" });
          index -= 1;
          continue;
        }
        if (gated.status === "timeout") {
          this.update(index, { state: "failed", message: "检查投递条件超时，已跳过这个岗位" });
          this.pushLog(`「${summary.company}」检查投递条件超时，已跳过`, "error");
          continue;
        }
        if (gated.status === "error") {
          const reason = String((gated.error as any)?.message ?? gated.error).slice(0, 160);
          this.update(index, { state: "failed", message: `检查失败：${reason}` });
          this.pushLog(`「${summary.company}」检查失败：${reason}`, "error");
          continue;
        }
        const gate = gated.value;
        if (gate.skip) {
          this.update(index, { state: "skipped", message: gate.reason || "已跳过" });
          this.pushLog(`跳过「${summary.company}」：${gate.reason || "不满足投递条件"}`, "warn");
          continue;
        }
        if (!gate.allowed) {
          if (gate.waitMs && gate.waitMs > 0) {
            const waitUntil = this.now() + gate.waitMs;
            this.update(index, { state: "queued", message: gate.reason || "等待下一个投递窗口" });
            this.status.message = gate.reason || "等待投递窗口";
            this.setLive({
              phase: "waiting",
              phaseText: `按安全规则等待 ${formatDuration(gate.waitMs)}后自动继续`,
              waitUntil,
              waitReason: gate.reason || "",
            });
            this.pushLog(`等待 ${formatDuration(gate.waitMs)}后继续（${gate.reason || "投递间隔"}）`, "info");
            await this.waitFor(gate.waitMs);
            this.setLive({ phase: "gate", phaseText: "等待结束，重新检查投递条件", waitUntil: 0, waitReason: "" });
            index -= 1; // 重新评估同一个岗位
            continue;
          }
          if (gate.retain) {
            // 熔断暂停：这个岗位还没真正尝试过，不能记成「已跳过」。
            // 恢复为待投并回退下标，用户点「继续」后从同一个岗位接着走。
            this.update(index, { state: "queued", message: gate.reason || "已暂停，等待本人处理" });
            this.status.state = "paused";
            this.paused = true;
            this.status.message = `${gate.reason || "已暂停"}；处理好后点「继续」会重新投这个岗位`;
            this.status.live = { ...this.status.live, phase: "waiting", phaseText: "已暂停，等待本人处理", waitUntil: 0 };
            this.pushLog(`批量投递已暂停：${gate.reason || "需要本人处理"}（当前岗位保留，点「继续」会重新投它）`, "warn");
            this.notify();
            index -= 1;
            continue;
          }
          this.update(index, { state: "skipped", message: gate.reason || "不满足投递条件" });
          this.pushLog(`跳过「${summary.company}」：${gate.reason || "不满足投递条件"}`, "warn");
          if (gate.reason && /上限|暂停|屏蔽/.test(gate.reason) && !/冷却/.test(gate.reason)) {
            this.status.state = "paused";
            this.paused = true;
            this.status.message = gate.reason;
            this.status.live = { ...this.status.live, phase: "waiting", phaseText: "已暂停", waitUntil: 0 };
            this.pushLog(`批量投递已暂停：${gate.reason}`, "warn");
            this.notify();
          }
          continue;
        }

        this.update(index, { state: "running", message: "正在发送招呼" });
        this.setLive({ phase: "sending", phaseText: "正在发送招呼", waitUntil: 0, waitReason: "" });
        this.pushLog(`正在向「${summary.company} · ${summary.title}」发送招呼`, "info");
        // 重新核对要读 Boss 消息记录，必须等这条岗位真的收尾；
        // guard 超时后底层任务可能还在跑，所以以任务自身 settle 的时间释放。
        this.processing = true;
        const runTask = this.deps.run(job, context);
        void runTask.finally(() => { this.processing = false; }).catch(() => undefined);
        const ran = await this.guard(runTask, itemTimeoutMs, this.freshItemSignal());
        if (ran.status === "aborted") {
          this.update(index, {
            state: "needs_user",
            message: "已停止本轮投递；如果 Boss 聊天窗口已经把消息发出去了，请到投递看板标记",
          });
          break;
        }
        if (ran.status === "paused") {
          // 窗口关闭时消息可能已经发出去了，不能自动重投；先记为待确认，
          // 点「继续」后从下一个岗位接着投，整批结束后再按平台记录核对这一条。
          this.update(index, {
            state: "needs_user",
            message: "发送过程中招聘窗口被关闭：如果这条已经发出去了，请在投递看板标记；点「继续」会从下一个岗位接着投",
          });
          this.pushLog(`「${summary.company}」发送过程中窗口被关闭，已暂停整批`, "warn");
          continue;
        }
        if (ran.status === "timeout") {
          // 页面卡死（例如窗口被手动关闭）时不再继续下一个岗位，
          // 否则会在同一个卡住的浏览器窗口上叠加操作。
          this.update(index, {
            state: "needs_user",
            message: `超过 ${Math.round(itemTimeoutMs / 60_000)} 分钟没有完成，已暂停整批。请检查 Boss 窗口是否被关闭或卡住后再继续`,
          });
          this.paused = true;
          this.status.state = "paused";
          this.status.message = "单条投递超时，已暂停，请检查 Boss 窗口后继续或停止";
          this.status.live = { ...this.status.live, phase: "waiting", phaseText: "已暂停（单条投递超时）", waitUntil: 0 };
          this.pushLog(`「${summary.company}」超过 ${Math.round(itemTimeoutMs / 60_000)} 分钟未完成，已暂停整批`, "error");
          this.notify();
          continue;
        }
        const result: BatchRunResult = ran.status === "ok"
          ? ran.value
          : { state: "failed", message: `投递失败：${String((ran.error as any)?.message ?? ran.error).slice(0, 200)}` };
        this.update(index, { state: result.state, message: result.message });
        this.setLive({
          phase: "settling",
          phaseText: "正在保存投递结果",
          waitUntil: 0,
          lastSentAt: result.state === "sent" ? this.now() : this.status.live.lastSentAt,
        });
        this.pushLog(
          `${result.state === "sent" ? "已发送" : result.state === "skipped" ? "已跳过" : result.state === "needs_user" ? "需要本人处理" : "失败"}「${summary.company}」：${result.message}`,
          result.state === "sent" ? "ok" : result.state === "skipped" ? "warn" : "error",
        );
        const settled = await this.guard(this.deps.settle(job, result), gateTimeoutMs);
        if (settled.status === "error") {
          this.log(`settle failed: ${String((settled.error as any)?.message ?? settled.error).slice(0, 160)}`);
        }
        if (result.pauseBatch) {
          this.status.state = "paused";
          this.paused = true;
          this.status.message = result.message || "需要本人处理登录或验证，批量投递已暂停";
          this.status.live = { ...this.status.live, phase: "waiting", phaseText: "已暂停，等待本人处理", waitUntil: 0 };
          this.pushLog(`批量投递已暂停：${this.status.message}`, "warn");
          this.notify();
        }
        if (this.stopped) break;
      }
    } catch (error: any) {
      const reason = String(error?.message ?? error).slice(0, 160);
      this.log(`batch loop crashed: ${reason}`);
      this.status.message = `批量投递异常中断：${reason}`;
      this.pushLog(`批量投递异常中断：${reason}`, "error");
    } finally {
      // 这一批已经被 stop/reset 甚至已被新一批取代：只收尾，不改状态。
      if (token !== this.runToken) return;
      // 最后一条触发风控暂停时循环已经退出，队列不能再假装 paused 等一个不会发生的 resume。
      const queued = this.status.items.some((item) => item.state === "queued");
      if (this.stopped) {
        this.status.state = "stopped";
        if (!this.status.message) this.status.message = "已停止批量投递";
      } else if (this.status.state === "paused" && queued) {
        // 还有排队项：保持暂停，等用户处理登录 / 验证后点「继续」。
      } else if (this.status.state === "running" || this.status.state === "paused") {
        this.status.state = "done";
      }
      if (this.stopped) {
        // 停止之后剩下的岗位不会再执行：标成「已跳过」。
        // 否则结束面板会一直显示「排队中」，用户会以为任务还在跑。
        this.status.items = this.status.items.map((item) => (item.state === "queued"
          ? { ...item, state: "skipped", message: "本次投递已停止，未执行", updatedAt: this.now() }
          : item));
      }
      // 正常跑完才做最终核对；用户主动停止时不继续读消息 / 补发。
      if (!this.stopped && this.status.state === "done" && this.deps.postRun) {
        const candidates = this.status.items
          .filter((item) => item.state === "needs_user" || item.state === "failed")
          .map((item): BatchPostRunItem | null => {
            const job = this.jobs.get(item.id);
            return job ? { id: item.id, job, state: item.state, message: item.message, updatedAt: item.updatedAt } : null;
          })
          .filter((item): item is BatchPostRunItem => Boolean(item));
        if (candidates.length) {
          this.status.state = "running";
          this.status.message = "批量投递已结束，正在核对平台投递记录";
          this.status.live = {
            ...this.status.live,
            phase: "verifying",
            phaseText: "正在读取平台投递记录",
            waitUntil: 0,
            waitReason: "",
            nextCompany: "",
            nextTitle: "",
          };
          this.pushLog(`批量投递结束，开始核对 ${candidates.length} 个未确认岗位的投递记录`, "info");
          this.notify();
          try {
            await this.deps.postRun({
              status: this.statusSnapshot(),
              items: candidates,
              signal: this.signal,
              report: (message, phase = "verifying") => {
                if (token !== this.runToken) return;
                const detail = String(message ?? "").trim().slice(0, 160);
                if (!detail) return;
                this.status.live = { ...this.status.live, phase, phaseText: detail, waitUntil: 0 };
                this.pushLog(detail);
                this.notify();
              },
              update: (updates) => this.applyPostRunUpdates(updates),
            });
          } catch (error: any) {
            const reason = String(error?.message ?? error).slice(0, 160);
            this.log(`post run failed: ${reason}`);
            this.pushLog(`批量结束后的投递记录核对失败：${reason}，未确认的岗位已保留`, "warn");
          }
          if (token !== this.runToken) return;
          this.status.state = this.stopped ? "stopped" : "done";
        }
      }
      this.loopRunning = false;
      if (this.stopped) {
        this.status.items = this.status.items.map((item) => (item.state === "queued"
          ? { ...item, state: "skipped", message: "本次投递已停止，未执行", updatedAt: this.now() }
          : item));
      }
      this.status.finishedAt = this.now();
      if (this.status.state === "done") {
        this.status.message = this.summaryMessage();
      }
      this.status.live = {
        ...this.status.live,
        phase: this.status.state === "paused" ? "waiting" : "idle",
        phaseText: this.status.state === "done" ? "已全部处理完" : this.status.state === "paused" ? "已暂停" : "已停止",
        waitUntil: 0,
        nextCompany: "",
        nextTitle: "",
      };
      this.pushLog(this.status.message, this.status.state === "done" ? "ok" : "warn");
      this.controller = null;
      this.notify();
      this.log(`batch ${this.status.id} ${this.status.state}`);
      this.finish();
    }
  }
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function emptyLive(): BatchLive {
  return {
    index: -1,
    itemId: "",
    company: "",
    title: "",
    city: "",
    phase: "idle",
    phaseText: "",
    startedAt: 0,
    waitUntil: 0,
    waitReason: "",
    nextCompany: "",
    nextTitle: "",
    lastSentAt: 0,
    etaAt: 0,
  };
}

const ITEM_STATES: BatchItemState[] = ["queued", "running", "sent", "needs_user", "skipped", "failed"];
const BATCH_STATES: BatchState[] = ["idle", "running", "paused", "stopping", "stopped", "done"];
const PHASES: BatchPhase[] = ["idle", "gate", "waiting", "sending", "settling", "verifying", "repairing"];
const LOG_LEVELS: BatchLogLevel[] = ["info", "ok", "warn", "error"];

function pick<T extends string>(values: T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

function time(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** 落盘文件可能被手工改过或来自旧版本：逐字段收口，坏数据宁可不显示也不能让页面崩。 */
function normalizeStatus(raw: unknown): BatchStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, any>;
  const items = (Array.isArray(source.items) ? source.items : [])
    .filter((item: any) => item && typeof item === "object")
    .map((item: any): BatchItemSummary => ({
      id: String(item.id ?? "").slice(0, 40),
      company: String(item.company ?? "").slice(0, 200),
      title: String(item.title ?? "").slice(0, 200),
      sourceUrl: String(item.sourceUrl ?? "").slice(0, 1000),
      city: String(item.city ?? "").slice(0, 80),
      state: pick(ITEM_STATES, item.state, "queued"),
      message: String(item.message ?? "").slice(0, 300),
      updatedAt: time(item.updatedAt),
    }))
    .filter((item: BatchItemSummary) => item.id);
  const liveSource = source.live && typeof source.live === "object" ? source.live : {};
  const logs = (Array.isArray(source.logs) ? source.logs : [])
    .filter((entry: any) => entry && typeof entry === "object")
    .slice(-MAX_LOG_ENTRIES)
    .map((entry: any): BatchLogEntry => ({
      at: time(entry.at),
      level: pick(LOG_LEVELS, entry.level, "info"),
      message: String(entry.message ?? "").slice(0, 300),
    }))
    .filter((entry: BatchLogEntry) => entry.message);
  return {
    id: String(source.id ?? "").slice(0, 60),
    state: pick(BATCH_STATES, source.state, "idle"),
    items,
    startedAt: time(source.startedAt),
    finishedAt: time(source.finishedAt),
    message: String(source.message ?? "").slice(0, 400),
    sentCount: items.filter((item: BatchItemSummary) => item.state === "sent").length,
    totalCount: items.length,
    live: {
      ...emptyLive(),
      index: Number.isFinite(Number(liveSource.index)) ? Number(liveSource.index) : -1,
      itemId: String(liveSource.itemId ?? "").slice(0, 40),
      company: String(liveSource.company ?? "").slice(0, 200),
      title: String(liveSource.title ?? "").slice(0, 200),
      city: String(liveSource.city ?? "").slice(0, 80),
      phase: pick(PHASES, liveSource.phase, "idle"),
      phaseText: String(liveSource.phaseText ?? "").slice(0, 160),
      startedAt: time(liveSource.startedAt),
      waitUntil: 0,
      waitReason: String(liveSource.waitReason ?? "").slice(0, 300),
      nextCompany: String(liveSource.nextCompany ?? "").slice(0, 200),
      nextTitle: String(liveSource.nextTitle ?? "").slice(0, 200),
      lastSentAt: time(liveSource.lastSentAt),
      etaAt: time(liveSource.etaAt),
    },
    logs,
  };
}

function emptyStatus(): BatchStatus {
  return {
    id: "",
    state: "idle",
    items: [],
    startedAt: 0,
    finishedAt: 0,
    message: "",
    sentCount: 0,
    totalCount: 0,
    live: emptyLive(),
    logs: [],
  };
}
