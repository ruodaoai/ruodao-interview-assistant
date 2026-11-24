import { normalizeFieldText } from "./text-cleanup.mjs";

const BASICS_FIELDS = [
  { field: "name", label: "姓名", max: 60 },
  { field: "title", label: "当前头衔", max: 120 },
  { field: "phone", label: "手机号", max: 60 },
  { field: "email", label: "邮箱", max: 120 },
  { field: "city", label: "所在城市", max: 60 },
  { field: "wechat", label: "微信号", max: 60 },
  { field: "years", label: "工作年限", max: 40 },
  { field: "degree", label: "最高学历", max: 40 },
  { field: "birth", label: "出生年月", max: 40 },
];

const INTENT_FIELDS = [
  { field: "role", label: "目标岗位", max: 120 },
  { field: "company", label: "目标公司", max: 120 },
  { field: "city", label: "期望城市", max: 60 },
  { field: "salary", label: "期望薪资", max: 60 },
  { field: "type", label: "工作类型", max: 40 },
  { field: "available", label: "到岗时间", max: 60 },
];

const EXPERIENCE_FIELDS = [
  { field: "company", label: "公司", max: 120 },
  { field: "department", label: "部门", max: 120 },
  { field: "role", label: "职位", max: 120 },
  { field: "city", label: "城市", max: 60 },
  { field: "start", label: "开始时间", max: 40 },
  { field: "end", label: "结束时间", max: 40 },
  { field: "description", label: "工作内容与成果", max: 6000, multiline: true },
];

const PROJECT_FIELDS = [
  { field: "name", label: "项目名称", max: 160 },
  { field: "role", label: "担任角色", max: 120 },
  { field: "start", label: "开始时间", max: 40 },
  { field: "end", label: "结束时间", max: 40 },
  { field: "tech", label: "技术栈", max: 200 },
  { field: "description", label: "项目描述", max: 6000, multiline: true },
];

const EDUCATION_FIELDS = [
  { field: "school", label: "学校", max: 120 },
  { field: "major", label: "专业", max: 120 },
  { field: "degree", label: "学历", max: 60 },
  { field: "start", label: "开始时间", max: 40 },
  { field: "end", label: "结束时间", max: 40 },
  { field: "detail", label: "补充说明", max: 2000, multiline: true },
];

const ROOT_FIELDS = [
  { field: "summary", label: "个人简介", max: 4000, multiline: true },
  { field: "skills", label: "技能特长", max: 4000, multiline: true },
  { field: "certificates", label: "证书资质", max: 4000, multiline: true },
  { field: "awards", label: "荣誉奖项", max: 4000, multiline: true },
  { field: "languages", label: "语言能力", max: 2000, multiline: true },
];

const LIST_CONFIG = {
  experience: { label: "工作经历", fields: EXPERIENCE_FIELDS, title: (item) => str(item?.company) || str(item?.role) || "未命名经历" },
  projects: { label: "项目经历", fields: PROJECT_FIELDS, title: (item) => str(item?.name) || "未命名项目" },
  education: { label: "教育经历", fields: EDUCATION_FIELDS, title: (item) => str(item?.school) || str(item?.major) || "未命名学历" },
};

const LIST_KEYS = ["experience", "projects", "education"];

function str(value, max = 100_000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function listOf(resume, key) {
  const value = resume?.[key];
  return Array.isArray(value) ? value : [];
}

/** 所有可被 AI 修改的字段（路径 → 位置/当前值）。空的基础字段不进目录，长文本字段保留以支持补写。 */
export function buildFieldCatalog(resume) {
  if (!resume || typeof resume !== "object") return [];
  const specs = [];
  const basics = resume.basics ?? {};
  for (const spec of BASICS_FIELDS) {
    const value = str(basics[spec.field]);
    if (value) specs.push({ path: `basics.${spec.field}`, label: spec.label, section: "基本信息", itemId: "", field: spec.field, multiline: false, max: spec.max, value });
  }
  const intent = resume.intent ?? {};
  for (const spec of INTENT_FIELDS) {
    const value = str(intent[spec.field]);
    if (value) specs.push({ path: `intent.${spec.field}`, label: spec.label, section: "求职意向", itemId: "", field: spec.field, multiline: false, max: spec.max, value });
  }
  for (const spec of ROOT_FIELDS) {
    const value = str(resume[spec.field]);
    if (value || spec.field === "summary" || spec.field === "skills") {
      specs.push({ path: spec.field, label: spec.label, section: spec.label, itemId: "", field: spec.field, multiline: Boolean(spec.multiline), max: spec.max, value });
    }
  }
  for (const key of LIST_KEYS) {
    const config = LIST_CONFIG[key];
    listOf(resume, key).forEach((item) => {
      const itemId = str(item?.id, 64);
      if (!itemId) return;
      const title = config.title(item);
      const hasContent = Object.entries(item ?? {}).some(([field, value]) => field !== "id" && typeof value === "string" && Boolean(str(value)));
      for (const spec of config.fields) {
        const value = str(item?.[spec.field]);
        if (!value && !(spec.multiline && hasContent)) continue;
        specs.push({
          path: `${key}[${itemId}].${spec.field}`,
          label: `${config.label} · ${title} · ${spec.label}`,
          section: `${config.label} · ${title}`,
          itemId,
          field: spec.field,
          multiline: Boolean(spec.multiline),
          max: spec.max,
          value,
        });
      }
    });
  }
  return specs;
}

/** 给模型看的字段清单：path 是唯一合法修改目标。 */
export function formatFieldCatalog(specs, budget = 10_000) {
  const lines = [];
  let used = 0;
  for (const spec of specs) {
    const value = spec.value ? spec.value.replace(/\n/g, " / ").slice(0, 260) : "（空）";
    const line = `- ${spec.path} ｜ ${spec.label} ｜ ${value}${spec.value.length > 260 ? "…" : ""}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

function parseListPath(path) {
  const match = /^(experience|projects|education)\[([^\]]{1,80})\]\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (!match) return null;
  return { key: match[1], itemId: match[2], field: match[3] };
}

export function readResumeField(resume, path) {
  if (!resume) return "";
  const parsed = parseListPath(path);
  if (parsed) {
    const item = listOf(resume, parsed.key).find((entry) => str(entry?.id, 64) === parsed.itemId);
    return str(item?.[parsed.field]);
  }
  const dot = /^(basics|intent)\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (dot) return str(resume[dot[1]]?.[dot[2]]);
  if (/^(summary|skills|certificates|awards|languages)$/.test(path)) return str(resume[path]);
  return "";
}

function normalizeTargetPath(rawPath) {
  return str(rawPath, 120)
    .replace(/[［【]/g, "[")
    .replace(/[］】]/g, "]")
    .replace(/^resume\./i, "")
    .replace(/\s+/g, "");
}

/** 条目前缀（projects[p-1] / projects[1]）→ 真实 id 的条目前缀。 */
function resolveItemScope(resume, key, token) {
  const items = listOf(resume, key);
  const byId = items.find((item) => str(item?.id, 64) === token);
  if (byId) return `${key}[${token}]`;
  // 模型有时按序号引用条目（第 1 条写成 0 或 1），映射回真实 id。
  if (/^\d{1,2}$/.test(token)) {
    const index = Number(token);
    const item = items[index] ?? items[index - 1];
    const id = str(item?.id, 64);
    if (id) return `${key}[${id}]`;
  }
  return "";
}

function resolvePath(resume, rawPath, catalog) {
  const path = normalizeTargetPath(rawPath);
  if (!path) return "";
  const direct = catalog.find((spec) => spec.path === path);
  if (direct) return direct.path;
  const parsed = /^(experience|projects|education)\[([^\]]{1,80})\]\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (!parsed) return "";
  const scope = resolveItemScope(resume, parsed[1], parsed[2]);
  return scope ? `${scope}.${parsed[3]}` : "";
}

/**
 * 诊断条目 / 修改范围 → 当前简历里真实存在的路径。
 * 字段路径必须命中字段目录；条目前缀按 id 或序号映射回真实 id。
 */
export function resolveResumeTargetPaths(resume, rawPaths, max = 4) {
  if (!resume) return [];
  const catalog = buildFieldCatalog(resume);
  const targets = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawPaths) ? rawPaths : []) {
    if (targets.length >= max) break;
    const path = resolvePath(resume, String(raw ?? ""), catalog);
    if (path) {
      if (!seen.has(path)) {
        seen.add(path);
        targets.push(path);
      }
      continue;
    }
    const item = /^(experience|projects|education)\[([^\]]{1,80})\]$/.exec(normalizeTargetPath(String(raw ?? "")));
    if (!item) continue;
    const scope = resolveItemScope(resume, item[1], item[2]);
    if (scope && !seen.has(scope)) {
      seen.add(scope);
      targets.push(scope);
    }
  }
  return targets;
}

/** 诊断提示里的字段路径清单：只给 path 与位置，避免把整份简历再塞一遍。 */
export function formatFieldPathList(specs, budget = 6000) {
  const lines = [];
  let used = 0;
  for (const spec of specs) {
    const line = `- ${spec.path} ｜ ${spec.section} · ${spec.label}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

function itemPrefix(path) {
  const match = /^(experience|projects|education)\[([^\]]+)\]/.exec(path);
  return match ? `${match[1]}[${match[2]}]` : "";
}

/**
 * 校验并富化模型返回的补丁：
 * - path 必须能在当前简历里解析出真实字段（防止幻觉路径写坏数据）；
 * - before 由服务端读取，模型只负责 after；
 * - after 走字段级清洗与长度上限；
 * - targets 存在时只允许改这些字段 / 条目（诊断单条可定向到 1-3 个字段）；
 * - scope=item 时只允许改指定条目。
 */
export function enrichResumePatches(resume, rawPatches, options = {}) {
  const catalog = buildFieldCatalog(resume);
  const catalogByPath = new Map(catalog.map((spec) => [spec.path, spec]));
  const resolvedScope = options.scope === "item" ? resolvePath(resume, String(options.itemPath ?? ""), catalog) : "";
  // 条目路径（experience[id]）按前缀匹配；具体字段路径（summary / experience[id].description）必须精确命中。
  const scopeIsField = Boolean(resolvedScope) && !/\[[^\]]+\]$/.test(resolvedScope);
  const scopePrefix = resolvedScope || (options.scope === "item" ? normalizeTargetPath(String(options.itemPath ?? "")) : "");
  const targetPaths = resolveResumeTargetPaths(resume, options.targets, 6);
  const targetFields = new Set(targetPaths.filter((path) => !/\[[^\]]+\]$/.test(path)));
  const targetItems = new Set(targetPaths.filter((path) => /\[[^\]]+\]$/.test(path)));
  const hasTargets = targetPaths.length > 0;
  const maxPatches = Math.min(Math.max(Number(options.maxPatches) || 6, 1), 8);
  const patches = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of Array.isArray(rawPatches) ? rawPatches : []) {
    if (patches.length >= maxPatches) { dropped += 1; continue; }
    const path = resolvePath(resume, String(raw?.path ?? ""), catalog);
    const spec = path ? catalogByPath.get(path) : undefined;
    if (!spec) { dropped += 1; continue; }
    const inScope = hasTargets
      ? targetFields.has(path) || targetItems.has(itemPrefix(path))
      : !scopePrefix || (scopeIsField ? path === scopePrefix : itemPrefix(path) === scopePrefix);
    if (!inScope) { dropped += 1; continue; }
    if (seen.has(path)) { dropped += 1; continue; }
    const after = normalizeFieldText(raw?.after ?? raw?.value ?? "", {
      multiline: spec.multiline,
      max: spec.max,
      literalNewlines: spec.multiline ? "newline" : "space",
    });
    if (after === spec.value) { dropped += 1; continue; }
    seen.add(path);
    patches.push({
      path,
      label: spec.label,
      section: spec.section,
      itemId: spec.itemId,
      field: spec.field,
      before: spec.value,
      after,
      reason: normalizeFieldText(raw?.reason, { max: 160 }),
    });
  }
  return { patches, dropped };
}

/** JSON 导入 / AI 解析结果里的字段清洗：字面量 `\n` 与多余空白就地归一。 */
export function sanitizeResumeTextFields(resume) {
  if (!resume || typeof resume !== "object") return resume;
  const next = { ...resume };
  if ("title" in next) next.title = normalizeFieldText(next.title, { max: 120 });
  for (const [group, fields] of [["basics", BASICS_FIELDS], ["intent", INTENT_FIELDS]]) {
    if (next[group] && typeof next[group] === "object") {
      const source = { ...next[group] };
      for (const spec of fields) if (spec.field in source) source[spec.field] = normalizeFieldText(source[spec.field], { max: spec.max });
      next[group] = source;
    }
  }
  for (const spec of ROOT_FIELDS) {
    if (spec.field in next) next[spec.field] = normalizeFieldText(next[spec.field], { multiline: true, max: spec.max });
  }
  for (const key of LIST_KEYS) {
    if (!Array.isArray(next[key])) continue;
    const fields = LIST_CONFIG[key].fields;
    next[key] = next[key].slice(0, 30).map((item) => {
      if (!item || typeof item !== "object") return item;
      const copy = { ...item };
      for (const spec of fields) if (spec.field in copy) copy[spec.field] = normalizeFieldText(copy[spec.field], { multiline: spec.multiline, max: spec.max });
      return copy;
    });
  }
  return next;
}
