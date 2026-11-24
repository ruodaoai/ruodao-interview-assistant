import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RESUME_TEMPLATE_NAMES } from "./resume-templates.mjs";

/**
 * 插件侧简历库：数据仍落在宿主 userData/resume-store，自动投递、数据备份等
 * 宿主能力读的是同一份文件；因此这里不长期缓存，每次操作都从磁盘读，
 * 避免两个进程各持一份内存副本互相覆盖。
 */

const MAX_RESUMES = 40;
const MAX_RESUME_BYTES = 2_500_000;
const MAX_STORE_BYTES = 8_000_000;
const MAX_REVISIONS = 80;
const REVISION_SOURCES = new Set(["diagnosis", "item-ai", "polish", "import", "manual"]);
const ID_PATTERN = /^r-[a-z0-9-]{6,64}$/i;
const DEFAULT_PREFS = { defaultResumeId: "", defaultTemplateId: "", favoriteTemplates: [] };

function asString(value, max = 4000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function asText(value, max = 8000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function asId(value, prefix) {
  const text = asString(value, 64);
  return /^[a-z0-9-]{4,64}$/i.test(text) ? text : `${prefix}-${randomUUID()}`;
}

function asHexColor(value) {
  const text = asString(value, 16);
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : "";
}

function asList(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function normalizeItem(raw, prefix, fields) {
  const item = { id: asId(raw?.id, prefix) };
  for (const [key, max] of Object.entries(fields)) item[key] = asText(raw?.[key], max);
  return item;
}

function normalizeRevisions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_REVISIONS).map((entry) => {
    const source = asString(entry?.source, 20);
    return {
      id: asString(entry?.id, 64),
      at: Number(entry?.at) || 0,
      source: REVISION_SOURCES.has(source) ? source : "manual",
      path: asString(entry?.path, 160),
      label: asString(entry?.label, 200),
      section: asString(entry?.section, 80),
      itemId: asString(entry?.itemId, 64),
      field: asString(entry?.field, 40),
      before: asText(entry?.before, 6000),
      after: asText(entry?.after, 6000),
      reason: asString(entry?.reason, 200),
      issue: asString(entry?.issue, 300),
      batchId: asString(entry?.batchId, 64),
      undoneAt: Number(entry?.undoneAt) || 0,
    };
  }).filter((entry) => entry.id && entry.path);
}

export function normalizeResume(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const basics = source.basics && typeof source.basics === "object" ? source.basics : {};
  const intent = source.intent && typeof source.intent === "object" ? source.intent : {};
  const avatar = asString(basics.avatar, 1_800_000);
  const id = ID_PATTERN.test(asString(source.id)) ? asString(source.id) : `r-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const templateId = asString(source.templateId, 40).toLowerCase();
  return {
    id,
    title: asString(source.title, 120) || "未命名简历",
    templateId: RESUME_TEMPLATE_NAMES[templateId] ? templateId : "geek",
    accent: asHexColor(source.accent),
    basics: {
      name: asString(basics.name, 60),
      title: asString(basics.title, 120),
      phone: asString(basics.phone, 60),
      email: asString(basics.email, 120),
      city: asString(basics.city, 60),
      wechat: asString(basics.wechat, 60),
      years: asString(basics.years, 40),
      degree: asString(basics.degree, 40),
      birth: asString(basics.birth, 40),
      avatar: /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(avatar) ? avatar : "",
      links: asList(basics.links, 6)
        .map((link) => ({ label: asString(link?.label, 40), url: asString(link?.url, 300) }))
        .filter((link) => Boolean(link.label || link.url)),
    },
    intent: {
      role: asString(intent.role, 120),
      city: asString(intent.city, 60),
      salary: asString(intent.salary, 60),
      type: asString(intent.type, 40),
      available: asString(intent.available, 60),
      company: asString(intent.company, 120),
    },
    targetJd: asText(source.targetJd, 8000),
    summary: asText(source.summary, 4000),
    education: asList(source.education, 12)
      .map((item) => normalizeItem(item, "d", { school: 120, major: 120, degree: 60, start: 40, end: 40, detail: 2000 }))
      .filter((item) => Object.entries(item).some(([key, value]) => key !== "id" && value)),
    experience: asList(source.experience, 20)
      .map((item) => normalizeItem(item, "e", { company: 120, department: 120, role: 120, city: 60, start: 40, end: 40, description: 6000 }))
      .filter((item) => Object.entries(item).some(([key, value]) => key !== "id" && value)),
    projects: asList(source.projects, 20)
      .map((item) => normalizeItem(item, "p", { name: 160, role: 120, start: 40, end: 40, tech: 200, description: 6000 }))
      .filter((item) => Object.entries(item).some(([key, value]) => key !== "id" && value)),
    skills: asText(source.skills, 4000),
    certificates: asText(source.certificates, 4000),
    awards: asText(source.awards, 4000),
    languages: asText(source.languages, 2000),
    diagnosis: source.diagnosis && typeof source.diagnosis === "object" ? source.diagnosis : undefined,
    advice: source.advice && typeof source.advice === "object" ? source.advice : undefined,
    revisions: normalizeRevisions(source.revisions),
    createdAt: Number(source.createdAt) || now,
    updatedAt: Number(source.updatedAt) || now,
  };
}

export function summarizeResume(resume, prefs) {
  return {
    id: resume.id,
    title: resume.title,
    name: resume.basics?.name ?? "",
    role: resume.intent?.role || resume.basics?.title || "",
    templateId: resume.templateId,
    templateName: RESUME_TEMPLATE_NAMES[resume.templateId] ?? resume.templateId,
    updatedAt: resume.updatedAt,
    createdAt: resume.createdAt,
  };
}

export function normalizeResumePrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const favorites = Array.isArray(source.favoriteTemplates)
    ? Array.from(new Set(source.favoriteTemplates.map((entry) => asString(entry, 40).toLowerCase()).filter((entry) => Boolean(RESUME_TEMPLATE_NAMES[entry]))))
    : [];
  const templateId = asString(source.defaultTemplateId, 40).toLowerCase();
  return {
    defaultResumeId: asString(source.defaultResumeId, 64),
    defaultTemplateId: RESUME_TEMPLATE_NAMES[templateId] ? templateId : "",
    favoriteTemplates: favorites.slice(0, 12),
  };
}

function normalizeStore(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const resumes = (Array.isArray(source.resumes) ? source.resumes.slice(0, MAX_RESUMES) : []).map(normalizeResume);
  return { version: 1, prefs: normalizeResumePrefs(source.prefs), resumes };
}

async function atomicWriteFile(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    try {
      await fs.rename(tmp, file);
    } catch {
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function backupCorruptFile(file) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(file, backup).catch(() => undefined);
  return backup;
}

export class ResumeStore {
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
    this.log = () => {};
  }

  get file() {
    return path.join(this.root, "resumes.json");
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      return normalizeStore(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") await backupCorruptFile(this.file);
      return normalizeStore({});
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

  async persist(store) {
    const encoded = JSON.stringify(store);
    if (encoded.length > MAX_STORE_BYTES) throw new Error("简历库超过 8 MB，请删除不再使用的简历后再保存");
    await fs.mkdir(this.root, { recursive: true });
    await atomicWriteFile(this.file, encoded);
  }

  async list() {
    const store = await this.load();
    return {
      items: [...store.resumes]
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
        .map((resume) => summarizeResume(resume, store.prefs)),
      prefs: { ...store.prefs, favoriteTemplates: [...store.prefs.favoriteTemplates] },
    };
  }

  async get(id) {
    const store = await this.load();
    const found = store.resumes.find((resume) => resume.id === id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async save(raw) {
    return this.enqueue(async () => {
      const store = await this.load();
      const resume = normalizeResume(raw);
      const encoded = JSON.stringify(resume);
      if (encoded.length > MAX_RESUME_BYTES) throw new Error("单份简历超过 2.5 MB，请压缩头像或删减内容");
      const index = store.resumes.findIndex((entry) => entry.id === resume.id);
      if (index >= 0) store.resumes[index] = resume;
      else {
        if (store.resumes.length >= MAX_RESUMES) throw new Error(`最多保存 ${MAX_RESUMES} 份简历`);
        store.resumes.push(resume);
      }
      await this.persist(store);
      return { item: summarizeResume(resume, store.prefs), prefs: { ...store.prefs } };
    });
  }

  async remove(id) {
    return this.enqueue(async () => {
      const store = await this.load();
      store.resumes = store.resumes.filter((resume) => resume.id !== id);
      if (store.prefs.defaultResumeId === id) store.prefs.defaultResumeId = "";
      await this.persist(store);
      return { prefs: { ...store.prefs } };
    });
  }

  async duplicate(id) {
    return this.enqueue(async () => {
      const store = await this.load();
      const source = store.resumes.find((resume) => resume.id === id);
      if (!source) throw new Error("简历不存在或已删除");
      if (store.resumes.length >= MAX_RESUMES) throw new Error(`最多保存 ${MAX_RESUMES} 份简历`);
      const now = Date.now();
      const copy = normalizeResume({
        ...source,
        id: `r-${now}-${randomUUID().slice(0, 8)}`,
        title: `${source.title} 副本`,
        createdAt: now,
        updatedAt: now,
        // AI 报告与修改历史绑定原简历的内容快照，副本需要重新生成。
        diagnosis: undefined,
        advice: undefined,
        revisions: [],
      });
      store.resumes.push(copy);
      await this.persist(store);
      return JSON.parse(JSON.stringify(store.resumes[store.resumes.length - 1]));
    });
  }

  async savePrefs(raw) {
    return this.enqueue(async () => {
      const store = await this.load();
      const next = normalizeResumePrefs({ ...store.prefs, ...(raw && typeof raw === "object" ? raw : {}) });
      if (next.defaultResumeId && !store.resumes.some((resume) => resume.id === next.defaultResumeId)) next.defaultResumeId = "";
      store.prefs = next;
      await this.persist(store);
      return { ...next, favoriteTemplates: [...next.favoriteTemplates] };
    });
  }
}

export { DEFAULT_PREFS, MAX_RESUMES };
