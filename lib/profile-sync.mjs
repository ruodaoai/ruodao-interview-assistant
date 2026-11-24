/**
 * 把简历文档映射成求职档案字段。
 *
 * fill-empty：只补齐档案里空着的字段（选择简历时自动执行，绝不动用户已填内容）；
 * overwrite：用简历里的值覆盖对应字段（用户点「从简历同步」时执行），简历里为空的字段保持不变。
 * 规则必须和宿主 electron/auto-apply/profile-sync.ts 保持一致，两边写的是同一份档案。
 */

function clean(value, max = 200) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 长的自由文本保留换行，避免把简历里的分段压成一大段。 */
function block(value, max = 4000) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function splitValues(value, maxItems, maxChars) {
  const source = clean(value, 400);
  if (!source) return [];
  const seen = new Set();
  const items = [];
  for (const entry of source.split(/[\/、,，;；|·]+/)) {
    const item = entry.trim().replace(/^[-—~～\s]+|[-—~～\s]+$/g, "").slice(0, maxChars);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

const SKILL_PREFIX = /^(熟练掌握|熟练使用|熟悉|掌握|精通|了解|具备|擅长|能够|可以)[\s:：]*/;

/** 技能在简历里是按类别写的长文本，先拆成可匹配的标签，过滤掉描述性句子。 */
function parseSkills(value) {
  const source = block(value, 4000);
  if (!source) return [];
  const seen = new Set();
  const items = [];
  for (const rawLine of source.split("\n")) {
    let line = rawLine.replace(/^[\s\-*•·\d.、)）]+/, "").trim();
    if (!line) continue;
    const colon = line.search(/[：:]/);
    if (colon >= 0) line = line.slice(colon + 1).trim();
    for (const piece of line.split(/[\/、,，;；|]+/)) {
      const token = piece
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(SKILL_PREFIX, "")
        .replace(/^[\s\-—~～]+|[\s\-—~～。.;；]+$/g, "")
        .trim();
      if (!token || token.length > 24) continue;
      // 没有英文/数字的长句多是「状态管理与组件体系设计」这类描述，不是技能标签。
      if (!/[a-z0-9+#.]/i.test(token) && token.length > 10) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      items.push(token);
      if (items.length >= 24) break;
    }
    if (items.length >= 24) break;
  }
  return items;
}

const DEGREE_RANK = [
  [/博士|phd/i, 5],
  [/硕士|研究生|mba/i, 4],
  [/本科|学士|bachelor/i, 3],
  [/大专|专科|高职/i, 2],
  [/高中|中专|中技/i, 1],
];

function highestDegree(resume) {
  const direct = clean(resume?.basics?.degree, 40);
  if (direct) return direct;
  let best = "";
  let bestRank = 0;
  for (const item of Array.isArray(resume?.education) ? resume.education : []) {
    const degree = clean(item?.degree, 40);
    if (!degree) continue;
    const rank = DEGREE_RANK.find(([pattern]) => pattern.test(degree))?.[1] ?? 0;
    if (rank > bestRank) {
      best = degree;
      bestRank = rank;
    }
  }
  return best;
}

function linksOf(resume) {
  const result = { website: "", github: "", linkedin: "" };
  for (const link of Array.isArray(resume?.basics?.links) ? resume.basics.links : []) {
    const label = clean(link?.label, 40);
    const raw = clean(link?.url, 300);
    const value = raw || label;
    if (!value) continue;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (!result.github && (/github/i.test(label) || /github\.com/i.test(value))) result.github = url;
    else if (!result.linkedin && (/linkedin/i.test(label) || /linkedin\.com/i.test(value))) result.linkedin = url;
    else if (!result.website) result.website = url;
  }
  return result;
}

/** 把简历文档映射成求职档案字段；只取真实存在的内容，空字段不产生值。 */
export function mapResumeToProfile(resume) {
  if (!resume || typeof resume !== "object") return {};
  const basics = resume.basics && typeof resume.basics === "object" ? resume.basics : {};
  const intent = resume.intent && typeof resume.intent === "object" ? resume.intent : {};
  const mapped = {};
  const name = clean(basics.name, 60);
  const phone = clean(basics.phone, 60);
  const email = clean(basics.email, 120);
  const city = clean(basics.city, 60);
  const years = clean(basics.years, 40);
  const degree = highestDegree(resume);
  const wechat = clean(basics.wechat, 60);
  const salary = clean(intent.salary, 60);
  const available = clean(intent.available, 60);
  const summary = block(resume.summary, 4000);
  if (name) mapped.name = name;
  if (phone) mapped.phone = phone;
  if (email) mapped.email = email;
  if (city) mapped.city = city;
  if (years) mapped.years = years;
  if (degree) mapped.degree = degree;
  if (wechat) mapped.wechat = wechat;
  if (salary) mapped.salary = salary;
  if (available) mapped.available = available;
  if (summary) mapped.summary = summary;

  const roles = splitValues(intent.role, 6, 60);
  if (roles.length) mapped.targetRoles = roles;
  const cities = splitValues(intent.city, 5, 40);
  if (cities.length) mapped.targetCities = cities;
  else if (city) mapped.targetCities = [city];
  const skills = parseSkills(resume.skills);
  if (skills.length) mapped.skills = skills;

  const links = linksOf(resume);
  if (links.github) mapped.github = links.github;
  if (links.linkedin) mapped.linkedin = links.linkedin;
  if (links.website) mapped.website = links.website;
  return mapped;
}

const SCALAR_FIELDS = [
  { key: "name", label: "姓名" },
  { key: "phone", label: "手机号" },
  { key: "email", label: "邮箱" },
  { key: "city", label: "所在城市" },
  { key: "years", label: "工作年限" },
  { key: "degree", label: "学历" },
  { key: "wechat", label: "微信" },
  { key: "available", label: "到岗时间" },
  { key: "salary", label: "期望薪资" },
  { key: "targetRoles", label: "目标岗位" },
  { key: "targetCities", label: "目标城市" },
  { key: "skills", label: "技能标签" },
  { key: "summary", label: "个人简介" },
  { key: "github", label: "GitHub" },
  { key: "website", label: "个人网站" },
  { key: "linkedin", label: "LinkedIn" },
];

export function mergeResumeIntoProfile(profile, mapped, mode = "fill-empty", resumeId = "") {
  const next = {
    ...profile,
    targetRoles: [...profile.targetRoles],
    targetCities: [...profile.targetCities],
    skills: [...profile.skills],
  };
  const filled = [];
  for (const { key, label } of SCALAR_FIELDS) {
    const value = mapped[key];
    const current = next[key];
    const currentEmpty = Array.isArray(current) ? current.length === 0 : !String(current ?? "").trim();
    if (mode === "fill-empty" && !currentEmpty) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      next[key] = value;
      filled.push(label);
    } else {
      const text = String(value ?? "").trim();
      if (!text) continue;
      if (current === text) continue;
      next[key] = text;
      filled.push(label);
    }
  }
  if (resumeId) next.resumeId = resumeId;
  return { profile: next, filled };
}
