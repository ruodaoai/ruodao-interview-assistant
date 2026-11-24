import { buildFieldCatalog, enrichResumePatches, formatFieldCatalog, formatFieldPathList, resolveResumeTargetPaths, sanitizeResumeTextFields } from "./resume-fields.mjs";
import { buildTimelineFacts, formatYearMonth, isFalseFutureClaim, localToday } from "./resume-timeline.mjs";
import { normalizeFieldText, normalizeImportedText } from "./text-cleanup.mjs";

// 网关普遍把单次输出卡在 4096 token；超过这个预算的 JSON 会被截断成非法文本，
// 所以每个模式的条数与字段长度都按「能装进 4096」来约束，而不是只调大 max_tokens。
const JSON_DISCIPLINE = `输出纪律（必须遵守）：
- 只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要输出第二个 JSON。
- 所有 JSON 字符串内部禁止出现英文双引号（需要引用时用「」），禁止裸换行（用 \\n 转义）。
- JSON 必须完整闭合；宁可少写一条，也不要写到一半被截断。`;

// 首轮就把输出预算给足：之前卡在 4096，长简历的导入解析、8 条诊断几乎必然被切断，
// 用户只能反复点重试。网关不支持这么高的上限时，宿主 llm.chat 会自动降级到 4096。
const MAX_TOKENS = 8000;

const MODES = {
  "import-parse": {
    temperature: 0.15,
    maxTokens: MAX_TOKENS,
    prompt: `你是简历结构化解析器。输入是一份简历的纯文本（来自 PDF/DOCX 提取或用户粘贴，可能含排版噪声、断行、页眉页脚）。
请把它整理成结构化 JSON，供简历编辑器直接使用。

要求：
1. 不编造任何事实：原文没有的字段留空字符串，没有的条目不要凭空补。保留原文中的数字、指标、时间、公司名、学校名。
2. 工作/项目描述按原文语义拆成多行，每行一条职责或成果；不要合并不同项目，不要把教育经历塞进工作经历。
3. 日期统一为 "YYYY.MM"；「至今」保留为「至今」。学历写「本科 / 硕士 / 大专 / 博士」。
4. 联系方式只保留原文出现的；无法确定归属的文本放进 summary，不要丢信息。
5. 中文输出，时间从近到远排序。
6. 今天是 [[TODAY]]。日期只按原文抄录，不要推算、不要补全原文没有写的时间；原文写「至今 / 现在」才输出「至今」，原文没写结束时间就留空字符串。任何情况下都不要写出晚于今天的结束时间。

${JSON_DISCIPLINE}

只输出一个 JSON 对象，结构如下（字段必须齐全，值类型严格一致）：
{
  "title": "简历标题（通常是姓名+岗位）",
  "basics": { "name": "", "title": "当前职位/头衔", "phone": "", "email": "", "city": "", "wechat": "", "years": "工作年限，如 5 年", "degree": "最高学历", "birth": "" },
  "intent": { "role": "求职岗位", "city": "", "salary": "", "type": "全职/实习/兼职", "available": "到岗时间", "company": "目标公司（如原文有）" },
  "summary": "自我评价/个人简介，没有就留空",
  "education": [{ "school": "", "major": "", "degree": "", "start": "", "end": "", "detail": "GPA/主修课程/荣誉，没有就留空" }],
  "experience": [{ "company": "", "department": "", "role": "", "city": "", "start": "", "end": "", "description": "多行，每行一条职责/成果" }],
  "projects": [{ "name": "", "role": "", "start": "", "end": "", "tech": "技术栈", "description": "多行，每行一条职责/成果" }],
  "skills": "技能特长，多行，每行一类",
  "certificates": "证书，多行",
  "awards": "荣誉奖项，多行",
  "languages": "语言能力，多行"
}`,
  },
  polish: {
    temperature: 0.5,
    maxTokens: 3000,
    prompt: `你是资深简历顾问，负责润色简历中的「单个模块」，让它更专业、更有说服力、更容易被 ATS 解析。

规则：
1. 保留全部事实与数字，绝不新增未提供的经历、公司、指标；不确定的地方保持原意。
2. 工作/项目描述优先改成 3-5 条 bullet：动词开头 + 做法 + 结果/指标；原文没有数字时不要编数字，可以提示补充。
3. 去掉「负责了/参与了/协助」这类弱表达，换成有主导性的动作；去掉空话套话。
4. 自我评价 2-3 句，突出岗位匹配度；技能按熟练度/类别分组；一条一行。
5. 中文输出，不要 markdown 标记、不要解释过程。
6. 如果用户给了润色要求，优先满足；但不得违背事实。

${JSON_DISCIPLINE}

只输出 JSON：{"polished":"润色后的完整文本（保留换行）","notes":["改动说明，最多4条"],"keywords":["建议补充的关键词，最多6个"]}`,
  },
  diagnose: {
    temperature: 0.3,
    maxTokens: MAX_TOKENS,
    prompt: `你是资深招聘经理 + 简历顾问，请对整份简历做「可投递性诊断」。先判断候选人目标岗位（用户提供优先），再按招聘方视角挑问题。

评分维度（0-100，严格但公允）：
- content：信息完整度（联系方式、时间线、职责与成果）
- impact：量化成果与影响力
- match：与目标岗位/JD 的匹配度
- structure：结构与可读性
- wording：表达专业度（动词、结果、无空话）
- keywords：ATS 关键词覆盖

要求：
1. issues 6-8 条，按严重程度排序；每条必须指出具体位置，并绑定【字段路径清单】里的字段路径。section 用中文写位置（如「工作经历 · 第 2 段 · 工作内容」），targets 原样复制清单里的 path，1-2 个；一条问题只指向真正需要改的那处，不要顺带列无关条目。
2. 控制篇幅：detail 不超过 60 字，suggestion 不超过 40 字，dimension 的 comment 不超过 28 字；宁可少一条，也不要写长。
3. strengths 3-4 条，指出真正有竞争力的证据。
4. missingKeywords 基于 JD 与岗位常见要求，最多 8 个；matchedKeywords 最多 8 个。
5. summary 120 字以内，直接说「能不能投、最该改哪三件事」。
6. targets 只能用清单里出现的 path 原文；清单里没有合适字段时留空，不要编造。
7. 日期一律以【时间线事实】为准：结束时间早于或等于今天的就是已经结束的过去经历，绝对不能写成「未来日期 / 尚未到期 / 尚未结束」；只有晚于今天才算未来。今天 [[TODAY]]。「系统核验结果」里已经列出真实存在的日期问题，没列出来就不要自己再报日期错误；日期本身没问题时，请改看内容、量化、结构与关键词。

[[TIMELINE_BLOCK]]

${JSON_DISCIPLINE}

只输出 JSON：
{"score": 0, "summary": "", "dimensions": [{"key":"content","label":"信息完整度","score":0,"comment":""}],
 "issues": [{"severity":"high|medium|low","section":"","targets":["清单里的 path"],"title":"","detail":"","suggestion":""}],
 "strengths": [""], "matchedKeywords": [""], "missingKeywords": [""]}`,
  },
  career: {
    temperature: 0.5,
    maxTokens: 6000,
    prompt: `你是职业规划顾问。基于候选人的简历和目标岗位，给出可执行的中文职业规划。

要求：
1. paths：3 条现实可行的发展路径（当前岗位的纵深、相邻岗位、跨界方向），fit 是 0-100 的匹配度，reason 说明为什么适合或需要补什么，reason 不超过 80 字。
2. phases：0-1 年、1-3 年、3-5 年三个阶段，每阶段给 focus（不超过 30 字）和 3-4 条 actions（每条不超过 35 字，具体到项目类型/能力/证书/作品）。阶段从今天 [[TODAY]] 起算。
3. gaps：3-4 个当前最影响晋升或跳槽的能力缺口，每个不超过 20 字。
4. learning：3-4 条学习建议（课程方向/书籍类型/练习方式），不要编造具体链接，每条不超过 50 字。
5. summary 80 字以内，点明主线。
6. 建议必须结合简历里的真实经历，不要给放之四海皆准的空话；控制篇幅，保证 JSON 完整闭合。
7. 计算工作年限、经历长短时以 [[TODAY]] 为今天，不要把已经过去的年份当成未来。

${JSON_DISCIPLINE}

只输出 JSON：
{"summary":"","paths":[{"title":"","fit":0,"reason":""}],
 "phases":[{"stage":"0-1 年","focus":"","actions":[""]}],
 "gaps":[""], "learning":[""]}`,
  },
  interview: {
    temperature: 0.45,
    maxTokens: 6000,
    prompt: `你是资深面试教练。基于候选人的简历与目标岗位，生成针对这份简历的面试准备建议。

要求：
1. questions：8 道最可能被问的问题，必须来自简历里的具体经历/技术/指标（不要通用题库）；intent 说明面试官想验证什么，hint 给出回答抓手（用哪段经历、强调什么证据）；三道字段各自不超过 50 字。
2. talkingPoints：4 条表达要点（STAR 结构提示、量化口径、技术取舍），每条不超过 45 字。
3. risks：3 条简历可能被质疑的点（空窗期、跳槽频率、指标口径、职责夸大），每条给应对话术方向，不超过 40 字。空窗期只按【时间线事实】里真实存在的间隔来写。
4. questionsToAsk：2-3 个适合在面试尾声反问的问题。
5. 中文、具体、直接可用；控制篇幅，保证 JSON 完整闭合。
6. 今天是 [[TODAY]]：早于这个日期的经历都已发生，不要描述成「尚未开始 / 未来」。

[[TIMELINE_BLOCK]]

${JSON_DISCIPLINE}

只输出 JSON：
{"summary":"","questions":[{"question":"","intent":"","hint":""}],
 "talkingPoints":[""], "risks":[""], "questionsToAsk":[""]}`,
  },
  "resume-tips": {
    temperature: 0.4,
    maxTokens: 4500,
    prompt: `你是简历优化顾问。请针对这份简历给出「具体到这一份」的修改建议，不要通用模板话术。

要求：
1. tips：6 条建议，title 是动作（如「把第 2 段经历的职责改成结果」，不超过 18 字），detail 说明改哪里、怎么改、改成什么样（不超过 50 字）。
2. keywords：基于目标岗位/JD 给出已覆盖与缺失关键词，各最多 8 个。
3. summary：60 字以内结论。
4. 不编造经历与数字；日期问题只按【时间线事实】里真实存在的写，今天是 [[TODAY]]。

[[TIMELINE_BLOCK]]

${JSON_DISCIPLINE}

只输出 JSON：
{"summary":"","tips":[{"title":"","detail":""}],
 "keywords":{"matched":[""],"missing":[""]}}`,
  },
  revise: {
    temperature: 0.35,
    maxTokens: MAX_TOKENS,
    prompt: `你是资深简历顾问，负责把「诊断建议」直接落成可应用的简历修改。输入包含简历全文、岗位目标、可修改字段清单（path 是唯一合法目标）和本次要解决的问题。

规则：
1. 只能修改清单里出现的 path；不得新增或删除条目，不得改清单外的字段。
2. after 必须是该字段修改后的完整文本：保留原文真实事实、数字、公司、时间；只优化结构、表达和信息密度。
3. 绝不编造未提供的经历、项目、公司或指标。缺少量化数据时，用原文已有的信息表达，并在 reason 里写「需本人补充真实数据」。
4. description / summary / skills 等长文本：一条 bullet 占一行；行内不要出现 \\n；不要 markdown 符号；每条 bullet 不超过 80 字。
5. 按问题范围给 patch：目标只有 1 个字段时只给 1 条；范围较大时最多 6 条，优先改最影响投递通过率的地方；若这个问题不需要改内容，返回空 patches 并在 notes 说明。
6. 日期字段（start / end）保持原有格式（YYYY.MM 或「至今」）。今天是 [[TODAY]]，早于今天的日期都是已经发生的过去经历：不要因为「看着像未来」就把已经过去的起止日期改掉；只有【时间线事实】里明确标为未来日期的条目才需要修正。
7. 中文输出。

[[TIMELINE_BLOCK]]

${JSON_DISCIPLINE}

只输出 JSON：{"summary":"本次修改策略，60 字内","patches":[{"path":"清单里的 path","after":"修改后的完整文本","reason":"为什么这样改，40 字内"}],"notes":["需要本人确认或补充的点，最多 3 条"]}`,
  },
};

function text(value, max = 8000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function resumeToText(resume) {
  if (!resume || typeof resume !== "object") return "";
  const basics = resume.basics ?? {};
  const intent = resume.intent ?? {};
  const lines = [];
  const contact = [basics.phone, basics.email, basics.city, basics.wechat, basics.years, basics.degree, basics.birth].map((entry) => text(entry, 80)).filter(Boolean).join(" | ");
  lines.push(`姓名：${text(basics.name, 60) || "未填写"}`);
  lines.push(`当前头衔：${text(basics.title, 120) || "未填写"}`);
  if (contact) lines.push(`基本信息：${contact}`);
  if (intent.role || intent.city || intent.salary || intent.type || intent.company) {
    lines.push(`求职意向：${[text(intent.role, 120), text(intent.company, 120), text(intent.city, 60), text(intent.salary, 60), text(intent.type, 40)].filter(Boolean).join(" | ")}`);
  }
  if (text(resume.summary)) lines.push(`\n【个人简介】\n${text(resume.summary, 4000)}`);
  const experience = Array.isArray(resume.experience) ? resume.experience : [];
  if (experience.length) {
    lines.push("\n【工作经历】");
    experience.forEach((item, index) => {
      lines.push(`${index + 1}. ${[text(item.company, 120), text(item.department, 120), text(item.role, 120), text(item.city, 60), [text(item.start, 40), text(item.end, 40)].filter(Boolean).join("-")].filter(Boolean).join(" | ")}`);
      if (text(item.description)) lines.push(text(item.description, 6000));
    });
  }
  const projects = Array.isArray(resume.projects) ? resume.projects : [];
  if (projects.length) {
    lines.push("\n【项目经历】");
    projects.forEach((item, index) => {
      lines.push(`${index + 1}. ${[text(item.name, 160), text(item.role, 120), text(item.tech, 200), [text(item.start, 40), text(item.end, 40)].filter(Boolean).join("-")].filter(Boolean).join(" | ")}`);
      if (text(item.description)) lines.push(text(item.description, 6000));
    });
  }
  const education = Array.isArray(resume.education) ? resume.education : [];
  if (education.length) {
    lines.push("\n【教育经历】");
    education.forEach((item) => {
      lines.push(`${[text(item.school, 120), text(item.major, 120), text(item.degree, 60), [text(item.start, 40), text(item.end, 40)].filter(Boolean).join("-"), text(item.detail, 2000)].filter(Boolean).join(" | ")}`);
    });
  }
  for (const [label, value] of [["技能特长", resume.skills], ["证书", resume.certificates], ["荣誉奖项", resume.awards], ["语言能力", resume.languages]]) {
    if (text(value)) lines.push(`\n【${label}】\n${text(value, 4000)}`);
  }
  return lines.join("\n").slice(0, 16_000);
}

function targetBlock(input) {
  const resume = input.resume ?? {};
  const target = input.target ?? {};
  const role = text(target.role ?? resume.intent?.role, 120);
  const company = text(target.company ?? resume.intent?.company, 120);
  const jd = text(target.jd ?? resume.targetJd, 6000);
  return [
    role ? `目标岗位：${role}` : "",
    company ? `目标公司：${company}` : "",
    jd ? `岗位 JD：\n${jd}` : "",
  ].filter(Boolean).join("\n");
}

function todayLabel(now = new Date()) {
  return formatYearMonth(localToday(now));
}

/** prompt 里的 [[TODAY]] / [[TIMELINE_BLOCK]] 在发请求前替换成真实时间线。 */
function resolvePrompt(prompt, resume, now = new Date()) {
  const block = buildTimelineFacts(resume, now);
  return prompt
    .replace(/\[\[TODAY\]\]/g, todayLabel(now))
    .replace(/\[\[TIMELINE_BLOCK\]\]/g, block ? `${block}\n` : "")
    .replace(/\n{3,}/g, "\n\n");
}

function buildContext(input) {
  const target = targetBlock(input);
  if (input.mode === "import-parse") {
    return `目标信息（可空）：\n${target || "未提供"}\n\n简历原文：\n${normalizeImportedText(text(input.text, 20_000), { joinWrapped: true }) || "（空）"}`;
  }
  if (input.mode === "polish") {
    const section = input.section ?? {};
    return [
      target,
      `【简历概况】\n${resumeToText(input.resume)}`,
      `【待润色模块】${text(section.label, 80) || "未命名"}`,
      text(section.content, 8000) || "（空）",
      input.instruction ? `【润色要求】${text(input.instruction, 500)}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (input.mode === "revise") {
    const targets = resolveResumeTargetPaths(input.resume, input.targets, 6);
    const scope = input.scope === "item" ? text(input.itemPath, 120) : "";
    const specs = buildFieldCatalog(input.resume).filter((spec) => {
      if (targets.length) {
        return targets.some((path) => (/\[[^\]]+\]$/.test(path)
          ? spec.path.startsWith(`${path}.`) || spec.path.startsWith(`${path}[`)
          : spec.path === path));
      }
      if (!scope) return true;
      if (spec.path === scope) return true;
      return spec.path.startsWith(`${scope}.`) || spec.path.startsWith(`${scope}[`);
    });
    const scopeLine = targets.length
      ? `只允许修改：${targets.join("、")}（其他字段一律不动）`
      : scope ? `只允许修改 ${scope} 下的字段` : "整份简历";
    return [
      target,
      `【简历全文】\n${resumeToText(input.resume)}`,
      `【可修改字段清单】\n${formatFieldCatalog(specs) || "（空）"}`,
      `【修改范围】${scopeLine}`,
      `【本次要解决的问题】\n${text(input.issue, 600) || "整体提升这份简历的投递通过率"}`,
      input.instruction ? `【补充要求】${text(input.instruction, 500)}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (input.mode === "diagnose") {
    return [
      target,
      `【简历全文】\n${resumeToText(input.resume)}`,
      `【字段路径清单】（issues[].targets 只能原样引用这里的 path）\n${formatFieldPathList(buildFieldCatalog(input.resume)) || "（空）"}`,
    ].filter(Boolean).join("\n\n");
  }
  return [target, `【简历全文】\n${resumeToText(input.resume)}`].filter(Boolean).join("\n\n");
}

function cleanModelText(content) {
  return String(content ?? "")
    .replace(/\u0000/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/```[a-zA-Z]*\s*/g, "")
    .replace(/```/g, "")
    .trim();
}

// 只取第一个「括号配平」的 JSON 对象：模型经常在它后面再追加一段内容，
// 用 first-{ 到 last-} 截取会把两段拼坏。
function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

function balancedObjects(text) {
  const found = [];
  for (let start = text.indexOf("{"); start >= 0 && found.length < 8; start = text.indexOf("{", start + 1)) {
    const candidate = balancedObjectAt(text, start);
    if (!candidate) continue;
    // 按出现顺序保留最外层对象：嵌套对象已经被外层包含，重复尝试只会拖慢解析。
    if (found.some((entry) => entry.includes(candidate))) continue;
    found.push(candidate);
  }
  return found;
}

// 模型中常见的两种非法 JSON：字符串里塞了未转义的英文双引号，以及尾逗号。
// 只有合法收尾引号后面才会是 , : } ] 或结尾，其余一律当成字符串内容转义。
function repairJsonText(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) { out += char; escaped = false; continue; }
    if (char === "\\") { out += char; escaped = true; continue; }
    if (char === "\n") { out += "\\n"; continue; }
    if (char === "\r") { out += "\\r"; continue; }
    if (char === "\t") { out += "\\t"; continue; }
    if (char === '"') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      const following = text[next];
      if (following === undefined || following === "," || following === ":" || following === "}" || following === "]") {
        out += char;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

export function parseResumeAiJson(content) {
  const cleaned = cleanModelText(content);
  if (!cleaned) return null;
  const direct = [cleaned, ...balancedObjects(cleaned)];
  for (const candidate of direct) {
    try { return JSON.parse(candidate); } catch { /* 继续尝试修复 */ }
  }
  for (const candidate of direct) {
    const repaired = repairJsonText(candidate);
    try { return JSON.parse(repaired); } catch { /* 继续 */ }
    const balanced = balancedObjectAt(repaired, repaired.indexOf("{"));
    if (balanced) {
      try { return JSON.parse(balanced); } catch { /* 继续 */ }
    }
  }
  return null;
}

/**
 * 被 max_tokens 切断的 JSON 局部恢复。
 *
 * 一次 4096 token 的截断通常只断在最后一条 issue / 最后一段描述上，前面的
 * score、dimensions、issues 都已经写完。以前整份丢弃 → 用户只能再点一次诊断；
 * 现在从尾部往回找「最后一个完整值」，丢掉半截字段后补齐未闭合的括号，
 * 已经写出来的内容可以直接用。
 */
function truncationCandidates(content, limit = 16) {
  const stack = [];
  const candidates = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        candidates.push({ end: index + 1, stack: [...stack] });
      }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") { stack.push(char === "{" ? "}" : "]"); continue; }
    if (char === "}" || char === "]") {
      if (stack[stack.length - 1] === char) stack.pop();
      candidates.push({ end: index + 1, stack: [...stack] });
    }
  }
  return candidates.slice(-limit).reverse();
}

function completeTruncatedJson(prefix, stack) {
  // 尾部可能停在 `,` / `:` / 空白上，先削掉再补括号，否则会拼出 {"a":,"b"} 这种非法结构。
  const body = prefix.replace(/[\s,]+$/, "").replace(/:\s*$/, "");
  return `${body}${[...stack].reverse().join("")}`;
}

export function recoverTruncatedJson(content) {
  const cleaned = cleanModelText(content);
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const source = cleaned.slice(start);
  for (const candidate of truncationCandidates(source)) {
    const rebuilt = completeTruncatedJson(source.slice(0, candidate.end), candidate.stack);
    if (!rebuilt || rebuilt === source) continue;
    let parsed;
    try { parsed = JSON.parse(rebuilt); } catch { continue; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function modeResultLooksValid(mode, parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (mode === "diagnose") return typeof parsed.score === "number" || Array.isArray(parsed.issues);
  if (mode === "career") return Array.isArray(parsed.paths) || Array.isArray(parsed.phases);
  if (mode === "interview") return Array.isArray(parsed.questions);
  if (mode === "resume-tips") return Array.isArray(parsed.tips);
  if (mode === "polish") return Boolean(text(parsed.polished));
  if (mode === "revise") return Array.isArray(parsed.patches);
  return Boolean(text(parsed.title) || parsed.basics);
}

const REPAIR_SYSTEM = `你是 JSON 修复器。输入是一段本应是 JSON 的模型输出，可能包含多余说明、markdown 代码块、未转义的英文双引号或尾逗号。
请在不改变原意、不新增内容的前提下，把它修复成一个严格合法的 JSON 对象，只输出这个 JSON：
- 字符串内部需要引用时用「」，不要用英文双引号；
- 不要输出解释、不要输出第二个 JSON、不要使用 markdown 代码块。`;

const COMPACT_HINT = `\n\n【输出预算】上一次输出超出长度被截断。这次必须更短：条数取下限，每条不超过 25 个汉字，summary 不超过 60 字，不要解释、不要 markdown。宁可少写，也要保证 JSON 完整闭合。`;

const MINIMAL_HINT = `\n\n【输出预算】连续两次输出都超出长度被截断。这次只给最小可用版本：issues / tips / questions 最多 3 条，每条不超过 20 个汉字，dimension 的 comment 不超过 12 字，summary 不超过 40 字；不要任何解释，直接输出能被解析的最小 JSON。`;

const IMPORT_MINIMAL_HINT = `\n\n【输出预算】连续两次解析都超出长度被截断。这次优先保证结构完整可解析：experience 最多 3 段、projects 最多 2 个，每段描述最多 3 条、每条不超过 40 字；education 最多 2 条；skills / certificates / awards / languages 各不超过 60 字；不要解释、不要 markdown。`;

/**
 * 抢救出来的残片能不能直接交给用户？
 * 只剩一个 score、一条 issues 都没有的残片没有使用价值，宁可再请求一轮；
 * 已经写到第 6 条、只断在最后一条上的残片就直接用，省掉一次几十秒的等待。
 */
function salvageIsUsable(mode, parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (mode === "diagnose") return Array.isArray(parsed.issues) && parsed.issues.length >= 2;
  if (mode === "career") return Array.isArray(parsed.paths) && parsed.paths.length >= 1;
  if (mode === "interview") return Array.isArray(parsed.questions) && parsed.questions.length >= 3;
  if (mode === "resume-tips") return Array.isArray(parsed.tips) && parsed.tips.length >= 2;
  if (mode === "revise") return Array.isArray(parsed.patches) && parsed.patches.length >= 1;
  if (mode === "polish") return Boolean(text(parsed.polished));
  if (mode === "import-parse") return Boolean(text(parsed.basics?.name)) || (Array.isArray(parsed.experience) && parsed.experience.length > 0);
  return false;
}

/** 一次生成最多请求三轮：第二轮压缩输出，第三轮到极简版本，基本能覆盖网关卡 4096 的情况。 */
const ATTEMPT_ROUNDS = 3;

/**
 * `chat` 由调用方注入（宿主 llm.chat 或测试桩），
 * 入参 { system, user, temperature, maxTokens }，返回 { content, finishReason, model, providerName }。
 */
export async function runResumeAi(chat, input, onDiagnostic) {
  const mode = text(input?.mode, 40);
  const config = MODES[mode];
  if (!config) throw new Error(`不支持的简历 AI 模式：${mode || "(空)"}`);
  const context = buildContext({ ...input, mode });
  if (mode === "import-parse" && !text(input?.text).trim()) throw new Error("没有可解析的简历文本");
  if (mode === "polish" && !text(input?.section?.content).trim()) throw new Error("待润色的内容为空");
  if (mode === "revise" && input?.scope === "item" && !text(input?.itemPath).trim()) throw new Error("没有指定要优化的条目");
  if (mode !== "import-parse" && mode !== "polish" && !resumeToText(input?.resume).trim()) throw new Error("简历内容为空，请先填写简历");
  const reviseTargets = mode === "revise" ? resolveResumeTargetPaths(input?.resume, input?.targets, 6) : [];
  if (mode === "revise" && Array.isArray(input?.targets) && input.targets.length && !reviseTargets.length) {
    throw new Error("这次要修改的字段已不存在，请重新生成诊断报告后再试");
  }

  // 模型不知道今天几号，会把自己训练截止之后的正常日期判成「未来」。这里把真实时间线
  // 作为既定事实写进 system prompt，模型只做判断、不再自己推算。
  const system = resolvePrompt(config.prompt, input?.resume ?? null);
  const hints = mode === "import-parse" ? [COMPACT_HINT, IMPORT_MINIMAL_HINT] : [COMPACT_HINT, MINIMAL_HINT];
  const acceptParsed = (candidate) => (candidate && modeResultLooksValid(mode, candidate) ? candidate : null);

  let parsed = null;
  let completion = null;
  let repairedOnce = false;
  let partial = false;
  for (let round = 0; round < ATTEMPT_ROUNDS && !parsed; round++) {
    completion = await chat({
      system,
      user: round === 0 ? context : `${context}${hints[Math.min(round - 1, hints.length - 1)]}`,
      temperature: Math.max(0, config.temperature - round * 0.1),
      maxTokens: config.maxTokens,
    });
    const truncated = completion.finishReason === "length";
    parsed = acceptParsed(parseResumeAiJson(completion.content));
    if (!parsed && truncated && mode !== "import-parse") {
      // 切断时先保留已经写完的部分：诊断/润色少最后一条远比整份重跑好。
      const salvaged = acceptParsed(recoverTruncatedJson(completion.content));
      if (salvaged && salvageIsUsable(mode, salvaged)) { parsed = salvaged; partial = true; }
    }
    if (parsed) break;
    onDiagnostic?.(`${mode} 第 ${round + 1} 轮${truncated ? "输出被截断" : "返回非法 JSON"}（finish=${completion.finishReason || "-"}，${completion.content.length} 字），自动补偿`);
    // 非截断的非法输出交给修复模型救一次；截断靠上面的压缩重试解决。
    if (!truncated && !repairedOnce && completion.content.trim()) {
      repairedOnce = true;
      const repaired = await chat({
        system: REPAIR_SYSTEM,
        user: `把下面这段模型输出修复成严格合法的 JSON：\n\n${completion.content.slice(0, 12_000)}`,
        temperature: 0,
        maxTokens: Math.max(config.maxTokens, 2400),
      });
      parsed = acceptParsed(parseResumeAiJson(repaired.content));
    }
  }
  if (!parsed && mode === "import-parse" && completion?.finishReason === "length") {
    // 导入解析宁可给一份缺几条描述的简历，也不要让用户对着空表单重来一次。
    const salvaged = acceptParsed(recoverTruncatedJson(completion.content));
    if (salvaged) { parsed = salvaged; partial = true; }
  }
  if (!parsed) {
    const truncated = completion?.finishReason === "length";
    throw new Error(truncated
      ? "模型输出连续被截断，压缩重试后仍未拿到完整 JSON。请重试，或换一个支持更长输出的文本模型。"
      : `模型没有返回可解析的 JSON（${completion?.content.length ?? 0} 字），自动修复也失败了。请重试，或换一个文本模型。`);
  }
  if (mode === "polish" && !text(parsed?.polished)) throw new Error("模型没有返回润色结果，请重试");
  if (mode === "import-parse") parsed = sanitizeResumeTextFields(parsed);
  if (mode === "diagnose") {
    const issues = Array.isArray(parsed?.issues) ? parsed.issues.slice(0, 10) : [];
    const normalized = issues.map((issue) => ({
      severity: text(issue?.severity, 12) || "medium",
      section: normalizeFieldText(issue?.section, { max: 80 }),
      // targets 只保留当前简历里真实存在的字段路径；旧模型没给就留空，由渲染层按 section 兜底解析。
      targets: resolveResumeTargetPaths(input.resume, issue?.targets, 3),
      title: normalizeFieldText(issue?.title, { max: 80 }),
      detail: normalizeFieldText(issue?.detail, { max: 200 }),
      suggestion: normalizeFieldText(issue?.suggestion, { max: 160 }),
    }));
    // 兜底：模型仍可能把已经过去的日期说成未来日期，简历里根本没有未来日期时这类条目
    // 就是纯误报，删掉比让用户照着假问题改正常简历更安全。
    const kept = normalized.filter((issue) => !isFalseFutureClaim(`${issue.title} ${issue.detail} ${issue.suggestion}`, input.resume ?? null));
    if (kept.length !== normalized.length) onDiagnostic?.(`diagnose 过滤掉 ${normalized.length - kept.length} 条「未来日期」误报（简历里没有晚于今天的日期）`);
    parsed = { ...parsed, issues: kept };
  }
  if (mode === "polish") {
    parsed = {
      ...parsed,
      polished: normalizeFieldText(parsed.polished, { multiline: true, max: 8000, literalNewlines: "newline" }),
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 4).map((note) => normalizeFieldText(note, { max: 160 })) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 6).map((keyword) => normalizeFieldText(keyword, { max: 40 })) : [],
    };
  }
  if (mode === "revise") {
    const enriched = enrichResumePatches(input.resume ?? {}, parsed?.patches, {
      scope: input.scope,
      itemPath: input.itemPath,
      targets: reviseTargets,
      maxPatches: input.maxPatches,
    });
    if (!enriched.patches.length) {
      throw new Error("模型没有给出可应用的修改（可能字段路径不匹配或内容没有变化），请换个描述再试一次");
    }
    parsed = {
      summary: normalizeFieldText(parsed?.summary, { max: 200 }),
      patches: enriched.patches,
      dropped: enriched.dropped,
      notes: Array.isArray(parsed?.notes) ? parsed.notes.slice(0, 3).map((note) => normalizeFieldText(note, { max: 160 })) : [],
    };
  }
  // partial=true：结果是模型输出被截断后抢救出来的残片，内容可能少最后一条，
  // 但已经可以落库，前端不需要再让用户重试。
  return { state: "succeeded", mode, ...parsed, ...(partial ? { partial: true } : {}), model: completion?.model || "", providerName: completion?.providerName || "" };
}
