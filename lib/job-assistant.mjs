import { parseResumeAiJson, resumeToText } from "./resume-ai.mjs";

/**
 * 求职小助手：把用户的一句话需求翻译成档案补丁、安全规则补丁与搜索计划。
 * 提示词与本地兜底在插件，模型通过注入的 `chat` 调用。
 */

const SITE_IDS = ["boss", "zhaopin", "job51"];
const KINDS = ["不限", "现场", "混合", "远程"];

const SYSTEM = `你是「若道招聘 · 求职小助手」，帮用户把求职需求翻译成可执行的求职档案、筛选规则和搜索计划。

你能看到：求职档案（已去除手机号/邮箱/微信等联系方式）、安全规则（不含 webhook 地址）、招聘平台登录状态、最近投递记录、简历摘要。

硬性规则：
1. 只依据用户明确说出的信息修改档案，禁止编造姓名、年限、学历、技能、项目、公司或数字。用户没说清就不改，改用 questions 追问。
2. 不得建议绕过登录、验证码、人机验证或平台频率限制；不得建议冒充他人、伪造经历、群发骚扰。登录、验证码、最终发送始终由用户本人完成。
3. greetingTemplate 是用户自己的固定招呼语，可用占位符 {name} {job} {company} {city} {skills} {years} {degree}；不得写入用户档案中不存在的事实。
4. salaryMin/salaryMax 单位是 K/月；0 表示不限。dailyLimit 是每个招聘网站每天最多投递的岗位数（各网站独立计数），建议 20-60；dailyCompanyLimit 是每个网站每天最多投递的不同公司数。
5. searchPlan.sites 只能是 boss、zhaopin、job51 中的值；keywords 是岗位关键词数组，最多 6 个。
6. reply 用中文，最多 300 字，直接说明你判断的情况和准备怎么调整；不要客套。
7. 只输出一个 JSON 对象，不要 markdown、不要解释；字符串内不要用英文双引号，不要出现裸换行。

输出结构（字段可省略，但类型必须正确）：
{
  "reply": "给用户的结论",
  "profilePatch": { "targetRoles": ["Java","AI Agent 开发工程师"], "targetCities": ["深圳"], "skills": ["Java","Spring Boot"], "city": "深圳", "years": "5 年", "degree": "本科", "salary": "25-40K", "remote": "不限", "summary": "..." },
  "rulesPatch": { "greetingMode": "ai", "greetingTemplate": "您好，我是{name}...", "repeatMessages": ["..."], "salaryMin": 20, "salaryMax": 45, "dailyLimit": 40, "dailyCompanyLimit": 20, "filterHeadhunter": true, "filterInactiveHr": true, "filterOutsource": true, "filterExperience": false, "filterDegree": false, "allowRepeatChat": false, "sendImageResume": false, "blockedCompanies": [], "blockedKeywords": [] },
  "searchPlan": { "sites": ["boss","zhaopin"], "keywords": ["Java","AI Agent 开发工程师"], "city": "深圳" },
  "questions": ["还希望看哪些城市？"],
  "warnings": ["简历里没有 AI Agent 项目，建议补充真实经历后再投"]
}`;

function text(value, max = 400) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stringList(value, maxItems, maxChars) {
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const item = text(entry, maxChars);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

function clampInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function sanitizedProfile(profile) {
  return {
    name: profile.name,
    city: profile.city,
    years: profile.years,
    degree: profile.degree,
    salary: profile.salary,
    可接受办公方式: profile.remote,
    summary: text(profile.summary, 1200),
    targetRoles: profile.targetRoles,
    targetCities: profile.targetCities,
    skills: profile.skills,
    已选择简历: Boolean(profile.resumeId),
  };
}

function contextOf(input) {
  const now = Date.now();
  const submitted = input.applications.filter((entry) => entry.status === "submitted");
  const today = submitted.filter((entry) => entry.submittedAt >= new Date(new Date().setHours(0, 0, 0, 0)).getTime());
  return [
    "【求职档案（已去除联系方式）】",
    JSON.stringify(sanitizedProfile(input.profile), null, 2),
    "",
    "【安全规则（不含 webhook）】",
    JSON.stringify({
      ...input.rules,
      notifyWebhook: input.rules.notifyWebhook ? "已配置" : "",
    }, null, 2),
    "",
    "【简历摘要】",
    text(resumeToText(input.resume), 1800) || "（未选择简历或简历为空）",
    "",
    "【招聘平台状态】",
    (input.sites || []).map((site) => `${site.label}：${site.open ? "窗口已打开" : "未打开"}${site.blocked === "login" ? "，需要登录" : site.blocked === "verification" ? "，需要人机验证" : ""}`).join("\n"),
    "",
    "【投递概况】",
    `看板共 ${input.applications.length} 条；已投递 ${submitted.length} 条；今天投递/打招呼 ${today.length} 条。`,
    submitted.slice(0, 5).map((entry) => `- ${entry.job.company} · ${entry.job.title}（${entry.job.city || "城市未标注"}）`).join("\n"),
    "",
    "【时间】",
    new Date(now).toLocaleString("zh-CN"),
    "",
    "【最近对话】",
    input.history.slice(-10).map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${text(turn.content, 500)}`).join("\n") || "（无）",
    "",
    "【用户这次说】",
    text(input.message, 2000),
  ].filter(Boolean).join("\n");
}

function pickProfilePatch(raw) {
  if (!raw || typeof raw !== "object") return {};
  const patch = {};
  const roles = stringList(raw.targetRoles, 6, 30);
  const cities = stringList(raw.targetCities, 5, 20);
  const skills = stringList(raw.skills, 15, 24);
  if (roles.length) patch.targetRoles = roles;
  if (cities.length) patch.targetCities = cities;
  if (skills.length) patch.skills = skills;
  const city = text(raw.city, 20);
  const years = text(raw.years, 20);
  const degree = text(raw.degree, 20);
  const salary = text(raw.salary, 40);
  const summary = text(raw.summary, 800);
  const remote = text(raw.remote, 10);
  if (city) patch.city = city;
  if (years) patch.years = years;
  if (degree) patch.degree = degree;
  if (salary) patch.salary = salary;
  if (summary) patch.summary = summary;
  if (KINDS.includes(remote)) patch.remote = remote;
  return patch;
}

function pickRulesPatch(raw) {
  if (!raw || typeof raw !== "object") return {};
  const patch = {};
  const flagKeys = ["filterHeadhunter", "filterInactiveHr", "filterOutsource", "filterExperience", "filterDegree", "allowRepeatChat", "sendImageResume"];
  for (const key of flagKeys) {
    if (typeof raw[key] === "boolean") patch[key] = raw[key];
  }
  if (raw.greetingMode === "ai" || raw.greetingMode === "template") patch.greetingMode = raw.greetingMode;
  const greetingTemplate = String(raw.greetingTemplate ?? "").replace(/\u0000/g, "").trim().slice(0, 600);
  if (greetingTemplate) patch.greetingTemplate = greetingTemplate;
  const repeatMessages = stringList(raw.repeatMessages, 6, 200);
  if (repeatMessages.length) patch.repeatMessages = repeatMessages;
  const salaryMin = clampInt(raw.salaryMin, 0, 500);
  const salaryMax = clampInt(raw.salaryMax, 0, 500);
  const dailyLimit = clampInt(raw.dailyLimit, 1, 500);
  const dailyCompanyLimit = clampInt(raw.dailyCompanyLimit, 1, 200);
  if (salaryMin !== undefined) patch.salaryMin = salaryMin;
  if (salaryMax !== undefined) patch.salaryMax = salaryMax;
  if (dailyLimit !== undefined) patch.dailyLimit = dailyLimit;
  if (dailyCompanyLimit !== undefined) patch.dailyCompanyLimit = dailyCompanyLimit;
  const blockedCompanies = stringList(raw.blockedCompanies, 20, 60);
  const blockedKeywords = stringList(raw.blockedKeywords, 20, 30);
  if (blockedCompanies.length) patch.blockedCompanies = blockedCompanies;
  if (blockedKeywords.length) patch.blockedKeywords = blockedKeywords;
  return patch;
}

function pickSearchPlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const sites = (Array.isArray(raw.sites) ? raw.sites : [])
    .filter((site) => typeof site === "string" && SITE_IDS.includes(site));
  const keywords = stringList(raw.keywords, 6, 40);
  if (!sites.length || !keywords.length) return null;
  return { sites: [...new Set(sites)].slice(0, 4), keywords, city: text(raw.city, 20) };
}

function parseReply(content) {
  const parsed = parseResumeAiJson(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function toReply(parsed, model) {
  const profilePatch = pickProfilePatch(parsed?.profilePatch);
  const rulesPatch = pickRulesPatch(parsed?.rulesPatch);
  const searchPlan = pickSearchPlan(parsed?.searchPlan);
  const questions = stringList(parsed?.questions, 3, 120);
  const warnings = stringList(parsed?.warnings, 3, 160);
  const reply = text(parsed?.reply, 600);
  const changed = Boolean(
    Object.keys(profilePatch).length ||
    Object.keys(rulesPatch).length ||
    searchPlan,
  );
  return {
    reply: reply || (changed ? "我整理了一版求职配置，确认后可以直接应用。" : "我还需要更多信息才能给出建议。"),
    profilePatch,
    rulesPatch,
    searchPlan,
    questions,
    warnings,
    model,
    mode: "ai",
  };
}

export function localAssistantReply(input, warning = "") {
  const { profile, rules, resume } = input;
  const notes = [];
  const questions = [];
  const profilePatch = {};
  const rulesPatch = {};

  if (!profile.targetRoles.length) {
    questions.push("你想找哪些岗位？可以一次写多个，例如：Java、AI Agent 开发工程师。");
    notes.push("你的求职档案还没有目标岗位，我暂时无法为你批量搜索。");
  } else {
    notes.push(`目标岗位已设置为：${profile.targetRoles.join("、")}，搜索时会逐个关键词查询并在各平台去重。`);
  }
  if (!profile.targetCities.length && !profile.city) {
    questions.push("你希望在哪些城市找工作？");
  } else {
    const cities = profile.targetCities.length ? profile.targetCities : [profile.city];
    notes.push(`目标城市：${cities.join("、")}。若平台没有收录该城市代码，会在本地按城市名过滤岗位。`);
  }
  if (!profile.resumeId && !resume) {
    questions.push("你还没有选择简历，要到「我的档案」绑定一份简历后再生成招呼语和投递材料。");
  }
  if (rules.salaryMin === 0 && rules.salaryMax === 0 && !profile.salary) {
    questions.push("你的期望月薪范围是多少？例如：20-40K/月。");
  }
  if (!rules.filterInactiveHr) {
    rulesPatch.filterInactiveHr = true;
    notes.push("建议开启「过滤不活跃 HR」（超过 30 天未活跃），减少无效沟通。");
  }
  if (!rules.filterOutsource && /外包|驻场|外派|派遣|外协|劳务|人力资源服务|bpo/i.test(input.message)) {
    rulesPatch.filterOutsource = true;
    notes.push("你提到不想投外包/驻场岗位，我已建议开启「过滤外包 / 驻场岗位」；专项外包公司还可以在岗位卡片上点「屏蔽公司」，随时能在屏蔽名单里恢复。");
  }
  if (!rules.greetingTemplate) {
    const roles = profile.targetRoles.slice(0, 2).join("、") || "目标岗位";
    rulesPatch.greetingMode = "template";
    rulesPatch.greetingTemplate = `您好，${profile.name ? `我是{name}，` : "我"}看到您在招{job}。我的经历主要围绕{skills}，和${roles}方向相关，期待和您进一步沟通。`;
    notes.push("我替你先写了一条可编辑的固定招呼语，确认后再保存；也可以切换回 AI 生成。");
  }
  if (rules.dailyLimit > 60) {
    rulesPatch.dailyLimit = 40;
    notes.push("每个网站每日投递上限偏高，已建议降到 40，避免账号被平台限流。");
  }

  return {
    reply: [notes.join(" "), questions.length ? "我还需要确认：" : "配置确认后，可以直接去岗位池按目标岗位搜索。"].filter(Boolean).join("\n"),
    profilePatch,
    rulesPatch,
    searchPlan: profile.targetRoles.length
      ? {
          sites: ["boss", "zhaopin"],
          keywords: profile.targetRoles.slice(0, 6),
          city: profile.targetCities[0] || profile.city || "",
        }
      : null,
    questions: questions.slice(0, 3),
    warnings: [
      ...(warning ? [warning] : []),
      "本地模式只做档案检查，没有调用模型；配置文本请逐条核对后再保存。",
    ],
    model: "local-rules",
    mode: "local",
  };
}

export async function runJobAssistant(chat, input) {
  const user = contextOf(input);
  let completion = await chat({
    system: SYSTEM,
    user,
    temperature: 0.3,
    maxTokens: 1600,
  });
  let parsed = parseReply(completion.content);
  if (!parsed) {
    completion = await chat({
      system: SYSTEM,
      user: `${user}\n\n【输出预算】上一次输出无法解析。这次只输出一个更短的 JSON，字段可以为空，但必须完整闭合。`,
      temperature: 0.15,
      maxTokens: 1200,
    });
    parsed = parseReply(completion.content);
  }
  if (!parsed) {
    return localAssistantReply(input, "模型返回的内容无法解析，已改用本地规则检查");
  }
  return toReply(parsed, completion.model || "");
}
