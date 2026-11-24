import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, backupCorruptFile } from "./durable-json.mjs";
import { companyNameKey } from "./company-key.mjs";

const MAX_ENTRIES = 5000;
const KINDS = ["applied", "interview", "rejected", "blocked", "replied_unfit"];

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const company = String(raw.company ?? "").trim().slice(0, 200);
  const nameKey = String(raw.nameKey ?? companyNameKey(company)).slice(0, 200);
  const outcome = String(raw.outcome ?? "");
  if (!company || !nameKey || !KINDS.includes(outcome)) return null;
  return {
    id: /^[a-z0-9-]{6,64}$/i.test(String(raw.id ?? "")) ? String(raw.id) : `out-${randomUUID().slice(0, 12)}`,
    company,
    nameKey,
    jobTitle: String(raw.jobTitle ?? "").slice(0, 200),
    sourceUrl: String(raw.sourceUrl ?? "").slice(0, 1000),
    recruiter: String(raw.recruiter ?? "").slice(0, 120),
    source: String(raw.source ?? "").slice(0, 20),
    outcome,
    note: String(raw.note ?? "").slice(0, 500),
    at: Math.max(0, Number(raw.at) || 0),
  };
}

/**
 * 投递结果台账：只保留「结果」，体积小、可长期保留，
 * 用于自动跳过、自动拉黑，以及给 AI 教练提供真实数据。
 */
export class OutcomeStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async reloadFromDisk() {
    await this.queue;
    this.cache = null;
  }

  async flushPendingWrites() {
    await this.queue;
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.cache = Array.isArray(raw?.entries) ? raw.entries.map(normalize).filter(Boolean) : [];
    } catch (error) {
      if (error?.code !== "ENOENT") await backupCorruptFile(this.file);
      this.cache = [];
    }
    return this.cache;
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async record(input) {
    return this.enqueue(async () => {
      const entries = await this.load();
      const nameKey = companyNameKey(input.company);
      if (!nameKey) throw new Error("公司名不能为空");
      const entry = {
        id: `out-${randomUUID().slice(0, 12)}`,
        company: String(input.company).trim().slice(0, 200),
        nameKey,
        jobTitle: String(input.jobTitle ?? "").slice(0, 200),
        sourceUrl: String(input.sourceUrl ?? "").slice(0, 1000),
        recruiter: String(input.recruiter ?? "").slice(0, 120),
        source: String(input.source ?? "").slice(0, 20),
        outcome: input.outcome,
        note: String(input.note ?? "").slice(0, 500),
        at: input.at ?? Date.now(),
      };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await atomicWriteFile(this.file, JSON.stringify({ version: 1, entries }));
      } catch {
        // 台账写盘失败时保持内存态，下一次写入会重试整个文件。
      }
      return { ...entry };
    });
  }

  async summary(name) {
    const nameKey = companyNameKey(name);
    if (!nameKey) return null;
    const all = await this.summaries();
    return all[nameKey] ?? null;
  }

  async summaries() {
    const entries = await this.load();
    const result = {};
    for (const entry of entries) {
      const current = result[entry.nameKey] ?? {
        nameKey: entry.nameKey,
        company: entry.company,
        applied: 0,
        interview: 0,
        rejected: 0,
        blocked: 0,
        lastAt: 0,
        lastOutcome: "",
      };
      if (entry.outcome === "applied") current.applied += 1;
      else if (entry.outcome === "interview") current.interview += 1;
      else if (entry.outcome === "rejected" || entry.outcome === "replied_unfit") current.rejected += 1;
      else if (entry.outcome === "blocked") current.blocked += 1;
      if (entry.at >= current.lastAt) {
        current.lastAt = entry.at;
        current.lastOutcome = entry.outcome;
        current.company = entry.company;
      }
      result[entry.nameKey] = current;
    }
    return result;
  }

  async today(now = Date.now()) {
    const start = startOfDay(now);
    const entries = (await this.load()).filter((entry) => entry.at >= start);
    return {
      applied: entries.filter((entry) => entry.outcome === "applied").length,
      interview: entries.filter((entry) => entry.outcome === "interview").length,
      rejected: entries.filter((entry) => entry.outcome === "rejected" || entry.outcome === "replied_unfit").length,
      companies: [...new Set(entries.filter((entry) => entry.outcome === "applied").map((entry) => entry.company))],
    };
  }

  async list(limit = 100) {
    const entries = await this.load();
    return entries.slice().sort((left, right) => right.at - left.at).slice(0, Math.max(1, Math.min(500, limit)));
  }

  async counts(now = Date.now()) {
    const weekStart = startOfWeek(now);
    const applied = (await this.load()).filter((entry) => entry.outcome === "applied");
    return {
      weekApplied: applied.filter((entry) => entry.at >= weekStart).length,
      totalApplied: applied.length,
    };
  }
}

export function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 周一 00:00 作为「本周」起点，与国内求职者的习惯一致。 */
export function startOfWeek(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}
