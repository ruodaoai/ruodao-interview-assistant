import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, backupCorruptFile } from "./durable-json.mjs";

const MAX_ENTRIES = 4000;
/** 发布时间只按天变化，小于这个跨度的差异当作平台展示误差，不算「重新发布」。 */
const REFRESH_THRESHOLD_MS = 3 * 86_400_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 只记录「哪个岗位在什么时候被看到过」，用于识别长期挂岗。
 * 独立小文件，避免每次搜索都重写包含简历 HTML 的 auto-apply.json。
 */
export class JobHistoryStore {
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
      const entries = raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
      const result = {};
      for (const [key, value] of Object.entries(entries)) {
        const firstSeenAt = Number(value?.firstSeenAt) || 0;
        if (!key || !firstSeenAt) continue;
        const postedAt = Number(value?.postedAt) || 0;
        result[key] = {
          firstSeenAt,
          lastSeenAt: Number(value?.lastSeenAt) || firstSeenAt,
          seenCount: Math.max(1, Math.round(Number(value?.seenCount) || 1)),
          postedAt: postedAt || null,
          refreshCount: Math.max(0, Math.round(Number(value?.refreshCount) || 0)),
        };
      }
      this.cache = result;
    } catch (error) {
      if (error?.code !== "ENOENT") await backupCorruptFile(this.file);
      this.cache = {};
    }
    return this.cache;
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 记录这一轮又看到了这些岗位；平台把发布时间改新时 refreshCount 累加。 */
  async observe(items, now = Date.now()) {
    return this.enqueue(async () => {
      const entries = await this.load();
      const touched = {};
      for (const rawItem of items) {
        const rawKey = typeof rawItem === "string" ? rawItem : rawItem?.key;
        const key = String(rawKey ?? "").slice(0, 240);
        if (!key) continue;
        const postedAt = typeof rawItem === "string" ? 0 : Math.max(0, Math.round(Number(rawItem?.postedAt) || 0));
        const existing = entries[key];
        let next;
        if (!existing) {
          next = { firstSeenAt: now, lastSeenAt: now, seenCount: 1, postedAt: postedAt || null, refreshCount: 0 };
        } else {
          const knownPostedAt = Number(existing.postedAt) || 0;
          let refreshCount = Math.max(0, Math.round(Number(existing.refreshCount) || 0));
          let earliestPostedAt = knownPostedAt || 0;
          if (postedAt) {
            if (!knownPostedAt) earliestPostedAt = postedAt;
            else if (postedAt > knownPostedAt + REFRESH_THRESHOLD_MS) refreshCount += 1;
            else if (postedAt < knownPostedAt - REFRESH_THRESHOLD_MS) earliestPostedAt = postedAt;
          }
          next = {
            firstSeenAt: existing.firstSeenAt,
            lastSeenAt: now,
            seenCount: existing.seenCount + 1,
            postedAt: earliestPostedAt || null,
            refreshCount,
          };
        }
        entries[key] = next;
        touched[key] = next;
      }
      const allKeys = Object.keys(entries);
      if (allKeys.length > MAX_ENTRIES) {
        allKeys.sort((left, right) => entries[left].lastSeenAt - entries[right].lastSeenAt);
        for (const key of allKeys.slice(0, allKeys.length - MAX_ENTRIES)) delete entries[key];
      }
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await atomicWriteFile(this.file, JSON.stringify({ version: 1, entries }));
      } catch {
        // 历史只用于长期挂岗提示，写入失败不能影响搜索。
      }
      return clone(touched);
    });
  }

  get(key) {
    const entry = this.cache?.[key];
    return entry ? clone(entry) : null;
  }
}
