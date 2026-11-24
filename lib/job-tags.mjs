import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, backupCorruptFile } from "./durable-json.mjs";

const MAX_JOB_TAGS = 8;
const MAX_JOB_TAG_CHARS = 20;
const MAX_ENTRIES = 3000;

function text(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 与宿主 job-sites/parse.ts 的 jobHistoryKey 保持一致：优先用平台岗位 ID。 */
function hash(value) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return Math.abs(result).toString(36);
}

export function jobHistoryKey(job) {
  const id = text(job?.jobId, 80) || hash(`${job?.sourceUrl ?? ""}|${job?.title ?? ""}`);
  return `${job?.source ?? ""}:${id}`;
}

/** 标签去重、去空、限长；同一岗位最多 8 个，避免列表被一两个岗位撑爆。 */
export function normalizeJobTags(value) {
  const seen = new Set();
  const tags = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const tag = text(entry, MAX_JOB_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_JOB_TAGS) break;
  }
  return tags;
}

function normalizeEntry(key, raw) {
  if (!key || !raw || typeof raw !== "object") return null;
  const tags = normalizeJobTags(raw.tags);
  if (!tags.length) return null;
  return {
    key,
    source: text(raw.source, 20),
    jobId: text(raw.jobId, 80),
    sourceUrl: text(raw.sourceUrl, 2000),
    company: text(raw.company, 120),
    title: text(raw.title, 160),
    city: text(raw.city, 60),
    tags,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 岗位级标签（已面过 / 不合适 / 年龄歧视 / 单休…）。
 * 独立小文件，和投递记录、公司情报解耦；每次操作从磁盘读，宿主执行器读同一份文件。
 */
export class JobTagStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
    this.cache = null;
  }

  /** 与宿主 JobTagStore 同名：首次调用预载，之后 get() 同步取标签。 */
  async ready() {
    if (!this.cache) this.cache = await this.load();
    return this.cache;
  }

  get(key) {
    return this.cache?.[key] ?? null;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      const entries = raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
      const result = {};
      for (const [key, value] of Object.entries(entries)) {
        const entry = normalizeEntry(text(key, 240), value);
        if (entry) result[entry.key] = entry;
      }
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") await backupCorruptFile(this.file);
      return {};
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

  async list() {
    const entries = await this.load();
    return Object.values(entries)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((entry) => clone(entry));
  }

  /** 保存一个岗位的标签；传空数组等于清除，不再参与批量跳过。 */
  async save(input) {
    return this.enqueue(async () => {
      const entries = await this.load();
      this.cache = entries;
      const key = text(input?.key, 240);
      if (!key) throw new Error("缺少岗位标识，无法保存标签");
      const tags = normalizeJobTags(input?.tags);
      if (!tags.length) {
        delete entries[key];
        await this.persist(entries);
        return null;
      }
      // 从「岗位标签」列表里改标签时只传 key，不传岗位字段：保留原有公司/岗位信息。
      const existing = entries[key];
      const entry = {
        key,
        source: text(input?.source, 20) || existing?.source || "",
        jobId: text(input?.jobId, 80) || existing?.jobId || "",
        sourceUrl: text(input?.sourceUrl, 2000) || existing?.sourceUrl || "",
        company: text(input?.company, 120) || existing?.company || "",
        title: text(input?.title, 160) || existing?.title || "",
        city: text(input?.city, 60) || existing?.city || "",
        tags,
        updatedAt: Date.now(),
      };
      entries[key] = entry;
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((left, right) => entries[left].updatedAt - entries[right].updatedAt);
        for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[old];
      }
      await this.persist(entries);
      return clone(entry);
    });
  }

  async persist(entries) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, JSON.stringify({ version: 1, entries }));
  }
}
