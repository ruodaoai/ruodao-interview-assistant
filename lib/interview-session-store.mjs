import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./durable-json.mjs";

const SESSION_ID = /^s-\d{13,}$/;

function asString(value) {
  return String(value ?? "").trim();
}

function asStringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeRecording(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const filePath = asString(raw.path);
  if (!filePath) return undefined;
  return {
    path: filePath,
    fileName: asString(raw.fileName) || path.basename(filePath),
    durationMs: Math.max(0, Math.round(asNumber(raw.durationMs))),
    channels: Number(raw.channels) === 2 ? 2 : 1,
    label: asString(raw.label) || undefined,
    sizeBytes: Math.max(0, Math.round(asNumber(raw.sizeBytes))) || undefined,
    createdAt: asNumber(raw.createdAt) || Date.now(),
  };
}

function normalizeMockQuestion(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const question = asString(raw.question);
  if (!question) return null;
  return {
    id: asString(raw.id) || `mq-${index + 1}`,
    category: asString(raw.category) || undefined,
    question,
    focus: asString(raw.focus) || undefined,
    expectedPoints: asStringList(raw.expectedPoints),
    allocatedSeconds: Math.max(30, Math.round(asNumber(raw.allocatedSeconds) || 180)),
  };
}

function normalizeMock(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const planRaw = raw.plan && typeof raw.plan === "object" ? raw.plan : null;
  const questions = (Array.isArray(planRaw?.questions) ? planRaw.questions : [])
    .map(normalizeMockQuestion)
    .filter(Boolean);
  const researchRaw = raw.research && typeof raw.research === "object" ? raw.research : null;
  const reportRaw = raw.report && typeof raw.report === "object" ? raw.report : null;
  return {
    status: raw.status === "finished" ? "finished" : "running",
    targetDurationMs: Math.max(60_000, Math.round(asNumber(raw.targetDurationMs))),
    elapsedMs: Math.max(0, Math.round(asNumber(raw.elapsedMs))) || undefined,
    difficulty: asString(raw.difficulty) || undefined,
    jd: asString(raw.jd) || undefined,
    model: raw.model && typeof raw.model === "object" ? {
      provider: asString(raw.model.provider) || undefined,
      model: asString(raw.model.model) || undefined,
      name: asString(raw.model.name) || undefined,
    } : undefined,
    voice: raw.voice && typeof raw.voice === "object" ? {
      engine: asString(raw.voice.engine) || undefined,
      voiceId: asString(raw.voice.voiceId) || undefined,
      sid: Number.isFinite(Number(raw.voice.sid)) ? Math.max(0, Math.min(4, Math.round(Number(raw.voice.sid)))) : undefined,
    } : undefined,
    research: researchRaw ? {
      summary: asString(researchRaw.summary) || undefined,
      companyBrief: asString(researchRaw.companyBrief) || undefined,
      roleFocus: asStringList(researchRaw.roleFocus),
      hotTopics: asStringList(researchRaw.hotTopics),
      interviewStyle: asString(researchRaw.interviewStyle) || undefined,
      sources: Array.isArray(researchRaw.sources)
        ? researchRaw.sources.map((source) => ({
          title: asString(source?.title),
          url: asString(source?.url),
          snippet: asString(source?.snippet) || undefined,
        })).filter((source) => Boolean(source.title && /^https?:\/\//i.test(source.url))).slice(0, 8)
        : [],
      notice: asString(researchRaw.notice) || undefined,
      searchedAt: asNumber(researchRaw.searchedAt) || undefined,
    } : undefined,
    plan: planRaw ? {
      title: asString(planRaw.title) || undefined,
      interviewerName: asString(planRaw.interviewerName) || undefined,
      interviewerTitle: asString(planRaw.interviewerTitle) || undefined,
      opening: asString(planRaw.opening) || undefined,
      questions,
      closing: asString(planRaw.closing) || undefined,
    } : undefined,
    questionIndex: Math.max(0, Math.round(asNumber(raw.questionIndex))) || undefined,
    followUpsUsed: Math.max(0, Math.round(asNumber(raw.followUpsUsed))) || undefined,
    report: reportRaw ? {
      score: Math.max(0, Math.min(100, Math.round(asNumber(reportRaw.score)))) || undefined,
      dimensions: Array.isArray(reportRaw.dimensions)
        ? reportRaw.dimensions.map((item) => ({
          name: asString(item?.name),
          score: Math.max(0, Math.min(100, Math.round(asNumber(item?.score)))),
          comment: asString(item?.comment) || undefined,
        })).filter((item) => Boolean(item.name)).slice(0, 8)
        : [],
      questionFeedback: Array.isArray(reportRaw.questionFeedback)
        ? reportRaw.questionFeedback.map((item) => ({
          question: asString(item?.question),
          score: Math.max(0, Math.min(100, Math.round(asNumber(item?.score)))),
          comment: asString(item?.comment) || undefined,
          missedPoints: asStringList(item?.missedPoints).slice(0, 4),
          betterAnswer: asString(item?.betterAnswer) || undefined,
        })).filter((item) => Boolean(item.question)).slice(0, 30)
        : [],
      interviewerImpression: asString(reportRaw.interviewerImpression) || undefined,
      generatedAt: asNumber(reportRaw.generatedAt) || undefined,
    } : undefined,
  };
}

function normalizeTurn(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "candidate" || raw.role === "noise" ? raw.role : "interviewer";
  const text = asString(raw.text ?? raw.question);
  if (!text) return null;
  return {
    id: asString(raw.id) || `t-${randomUUID()}`,
    role,
    text,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
    audioPath: asString(raw.audioPath) || undefined,
    answer: asString(raw.answer) || undefined,
    points: asStringList(raw.points),
    followUps: asStringList(raw.followUps),
    rating: Number.isFinite(Number(raw.rating)) ? Math.min(5, Math.max(1, Number(raw.rating))) : undefined,
    note: asString(raw.note) || undefined,
    ignored: Boolean(raw.ignored),
    ignoreReason: asString(raw.ignoreReason) || undefined,
    intent: raw.intent === "question" ? "question" : raw.intent === "answer" ? "answer" : undefined,
    questionId: asString(raw.questionId) || undefined,
  };
}

/** 旧版场次只有 items（问题 + AI 答案），读入时迁移成 turns，写回时只写新结构。 */
export function normalizeInterviewSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(raw.id);
  if (!id) return null;
  const base = {
    id,
    startedAt: asString(raw.startedAt) || new Date().toISOString(),
    endedAt: asString(raw.endedAt) || undefined,
    jobRole: asString(raw.jobRole) || undefined,
    company: asString(raw.company) || undefined,
    mode: raw.mode === "mock" ? "mock" : "live",
    notes: asString(raw.notes) || undefined,
  };
  if (Array.isArray(raw.turns)) {
    return {
      ...base,
      turns: raw.turns.map(normalizeTurn).filter(Boolean),
      review: raw.review && typeof raw.review === "object" ? {
        summary: asString(raw.review.summary) || undefined,
        strengths: asStringList(raw.review.strengths),
        weaknesses: asStringList(raw.review.weaknesses),
        nextQuestions: asStringList(raw.review.nextQuestions),
        actionPlan: asStringList(raw.review.actionPlan),
        generatedAt: Number(raw.review.generatedAt) || undefined,
      } : undefined,
      recording: normalizeRecording(raw.recording),
      mock: normalizeMock(raw.mock),
    };
  }
  const turns = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item || typeof item !== "object") continue;
    const question = asString(item.question);
    if (!question) continue;
    if (item.ignored) {
      turns.push({
        id: `t-${randomUUID()}`,
        role: "noise",
        text: question,
        at: Number(item.at) || Date.now(),
        ignored: true,
        ignoreReason: asString(item.ignoreReason) || undefined,
      });
      continue;
    }
    const questionTurn = {
      id: `t-${randomUUID()}`,
      role: "interviewer",
      text: question,
      at: Number(item.at) || Date.now(),
      audioPath: asString(item.audioPath) || undefined,
      answer: asString(item.answer) || undefined,
      points: asStringList(item.points),
    };
    turns.push(questionTurn);
    const candidate = asString(item.candidateAnswer);
    if (candidate) {
      turns.push({
        id: `t-${randomUUID()}`,
        role: "candidate",
        text: candidate,
        at: Number(item.candidateAt) || questionTurn.at + 1,
        audioPath: asString(item.candidateAudioPath) || undefined,
        questionId: questionTurn.id,
      });
    }
  }
  return { ...base, turns, recording: normalizeRecording(raw.recording), mock: normalizeMock(raw.mock) };
}

export function summarizeInterviewSession(session) {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    jobRole: session.jobRole,
    company: session.company,
    mode: session.mode === "mock" ? "mock" : "live",
    questionCount: session.turns.filter((turn) => turn.role === "interviewer").length,
    candidateCount: session.turns.filter((turn) => turn.role === "candidate").length,
    turnCount: session.turns.length,
    durationMs: session.recording?.durationMs || session.mock?.elapsedMs || 0,
    hasRecording: Boolean(session.recording?.path),
    plannedQuestions: session.mock?.plan?.questions.length || undefined,
    targetDurationMs: session.mock?.targetDurationMs || undefined,
  };
}

export function buildInterviewTranscript(session) {
  const lines = [
    `# 面试回顾 · ${session.startedAt.replace("T", " ").slice(0, 19)}`,
    "",
    `${session.company ? `${session.company} · ` : ""}${session.jobRole || "岗位未填写"} · ${session.turns.filter((turn) => turn.role === "interviewer").length} 个问题 · ${session.turns.filter((turn) => turn.role === "candidate").length} 段回答`,
    "",
  ];
  const questions = new Map(session.turns.filter((turn) => turn.role === "interviewer").map((turn) => [turn.id, turn]));
  let questionNo = 0;
  for (const turn of session.turns) {
    const time = new Date(turn.at).toLocaleTimeString("zh-CN");
    if (turn.role === "noise") continue;
    if (turn.role === "interviewer") {
      questionNo += 1;
      lines.push(`## ${questionNo}. 面试官提问（${time}）`, "", turn.text, "");
      if (turn.answer) lines.push("**AI 参考回答**：", "", turn.answer, "");
      if (turn.points?.length) lines.push("**要点**：", ...turn.points.map((point) => `- ${point}`), "");
      if (turn.followUps?.length) lines.push("**可能的追问**：", ...turn.followUps.map((item) => `- ${item}`), "");
      if (turn.rating) lines.push(`**自评**：${"★".repeat(turn.rating)}${"☆".repeat(5 - turn.rating)}`, "");
      if (turn.note) lines.push(`**备注**：${turn.note}`, "");
      lines.push("---", "");
      continue;
    }
    const parent = turn.questionId ? questions.get(turn.questionId) : undefined;
    lines.push(`### 我的回答（${time}${parent ? ` · 对应第 ${[...questions.keys()].indexOf(parent.id) + 1} 题` : ""}）`, "", turn.text, "");
    if (turn.note) lines.push(`备注：${turn.note}`, "");
    lines.push("");
  }
  if (session.notes) lines.push("## 整场备注", "", session.notes, "");
  if (session.review) {
    lines.push("## AI 复盘报告", "");
    if (session.review.summary) lines.push(session.review.summary, "");
    if (session.review.strengths?.length) lines.push("**做得好的地方**：", ...session.review.strengths.map((item) => `- ${item}`), "");
    if (session.review.weaknesses?.length) lines.push("**需要加强**：", ...session.review.weaknesses.map((item) => `- ${item}`), "");
    if (session.review.nextQuestions?.length) lines.push("**下一轮可能被问**：", ...session.review.nextQuestions.map((item) => `- ${item}`), "");
    if (session.review.actionPlan?.length) lines.push("**行动计划**：", ...session.review.actionPlan.map((item) => `- ${item}`), "");
    lines.push("");
  }
  lines.push("> 说明：面试官与面试者的发言按录音通道/说话人判定分开记录；AI 参考回答仅用于辅助表达，不代表标准答案。");
  return lines.join("\n");
}

/**
 * 场次 JSON 与录音/文字稿同目录：userData/interview-sessions。
 * 宿主采集管线也写同一批文件，所以每次操作重新读盘；服务内写入串行化，
 * 避免同一服务里「读-改-写」互相覆盖。
 */
export class InterviewSessionStore {
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
  }

  filePath(id) {
    const safe = asString(id);
    if (!SESSION_ID.test(safe)) throw new Error("面试场次 ID 无效");
    return path.join(this.root, `${safe}.json`);
  }

  dir(id) {
    const safe = asString(id);
    if (!SESSION_ID.test(safe)) throw new Error("面试场次 ID 无效");
    return path.join(this.root, safe);
  }

  transcriptPath(id) {
    return path.join(this.dir(id), "transcript.md");
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async flush() {
    await this.queue;
  }

  async create(input = {}) {
    return this.enqueue(async () => {
      const session = {
        id: `s-${Date.now()}`,
        startedAt: new Date().toISOString(),
        jobRole: asString(input?.jobRole) || undefined,
        company: asString(input?.company) || undefined,
        mode: input?.mode === "mock" ? "mock" : "live",
        turns: [],
      };
      await fs.mkdir(this.dir(session.id), { recursive: true });
      await this.write(session);
      return session;
    });
  }

  async read(id) {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath(id), "utf8"));
      return normalizeInterviewSession(raw);
    } catch {
      return null;
    }
  }

  async write(session) {
    await fs.mkdir(this.root, { recursive: true });
    const payload = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      jobRole: session.jobRole,
      company: session.company,
      mode: session.mode ?? "live",
      turns: session.turns,
      notes: session.notes,
      review: session.review,
      recording: session.recording,
      mock: session.mock,
    };
    await atomicWriteFile(this.filePath(session.id), JSON.stringify(payload, null, 2));
  }

  async list() {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      const sessions = (await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return normalizeInterviewSession(JSON.parse(await fs.readFile(path.join(this.root, entry.name), "utf8")));
          } catch {
            return null;
          }
        }))).filter(Boolean);
      return sessions
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map(summarizeInterviewSession);
    } catch {
      return [];
    }
  }

  async detail(id) {
    const session = await this.read(id);
    if (!session) return null;
    return { ...session, dir: this.dir(id), transcriptPath: this.transcriptPath(id) };
  }

  async remove(id) {
    return this.enqueue(async () => {
      this.filePath(id);
      await fs.rm(this.dir(id), { recursive: true, force: true });
      await fs.rm(this.filePath(id), { force: true });
    });
  }

  async appendTurn(id, input) {
    return this.enqueue(async () => {
      const session = await this.read(id);
      if (!session) throw new Error("面试场次不存在或已删除");
      const text = asString(input?.text);
      if (!text) throw new Error("发言内容为空");
      const lastQuestion = [...session.turns].reverse().find((turn) => turn.role === "interviewer");
      const turn = {
        id: `t-${randomUUID()}`,
        role: input.role,
        text,
        at: Number(input.at) || Date.now(),
        audioPath: asString(input.audioPath) || undefined,
        answer: asString(input.answer) || undefined,
        points: asStringList(input.points),
        followUps: asStringList(input.followUps),
        ignored: Boolean(input.ignored),
        ignoreReason: asString(input.ignoreReason) || undefined,
        intent: input.intent === "question" ? "question" : input.intent === "answer" ? "answer" : undefined,
        questionId: input.role === "candidate" ? asString(input.questionId) || lastQuestion?.id : asString(input.questionId) || undefined,
      };
      session.turns.push(turn);
      await this.write(session);
      return { session, turn };
    });
  }

  async updateTurn(id, turnId, patch = {}) {
    return this.enqueue(async () => {
      const session = await this.read(id);
      if (!session) throw new Error("面试场次不存在或已删除");
      const turn = session.turns.find((entry) => entry.id === turnId);
      if (!turn) throw new Error("面试对话轮次不存在");
      if (patch.role) turn.role = patch.role;
      if (patch.text !== undefined) turn.text = asString(patch.text) || turn.text;
      if (patch.answer !== undefined) turn.answer = asString(patch.answer) || undefined;
      if (patch.points !== undefined) turn.points = asStringList(patch.points);
      if (patch.followUps !== undefined) turn.followUps = asStringList(patch.followUps);
      if (patch.rating !== undefined) turn.rating = Number.isFinite(Number(patch.rating)) ? Math.min(5, Math.max(1, Number(patch.rating))) : undefined;
      if (patch.note !== undefined) turn.note = asString(patch.note) || undefined;
      if (patch.ignored !== undefined) turn.ignored = Boolean(patch.ignored);
      if (patch.ignoreReason !== undefined) turn.ignoreReason = asString(patch.ignoreReason) || undefined;
      if (patch.questionId !== undefined) turn.questionId = asString(patch.questionId) || undefined;
      await this.write(session);
      return { session, turn };
    });
  }

  async updateSession(id, patch = {}) {
    return this.enqueue(async () => {
      const session = await this.read(id);
      if (!session) throw new Error("面试场次不存在或已删除");
      if (patch.jobRole !== undefined) session.jobRole = asString(patch.jobRole) || undefined;
      if (patch.company !== undefined) session.company = asString(patch.company) || undefined;
      if (patch.notes !== undefined) session.notes = asString(patch.notes) || undefined;
      if (patch.review !== undefined) session.review = patch.review;
      if (patch.mode) session.mode = patch.mode;
      if (patch.recording !== undefined) session.recording = normalizeRecording(patch.recording);
      if (patch.mock !== undefined) session.mock = normalizeMock(patch.mock);
      await this.write(session);
      return session;
    });
  }

  async syncTranscript(id) {
    const session = await this.read(id);
    if (!session) return null;
    await fs.mkdir(this.dir(id), { recursive: true });
    await fs.writeFile(this.transcriptPath(id), buildInterviewTranscript(session), "utf8");
    return session;
  }

  async end(id) {
    return this.enqueue(async () => {
      const session = await this.read(id);
      if (!session) throw new Error("面试场次不存在");
      session.endedAt = new Date().toISOString();
      await this.write(session);
      await this.syncTranscript(id);
      return session;
    });
  }
}
