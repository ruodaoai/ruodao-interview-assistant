import { parseResumeAiJson, resumeToText } from "./resume-ai.mjs";

/**
 * 投递材料定制：求职信、简历摘要、亮点与网申问答。
 * 提示词与本地兜底留在插件，模型调用走注入的 `chat`（宿主 llm.chat）。
 */

const MAX_OUTPUT_QUESTIONS = 8;

const SYSTEM = `你是求职材料定制助手，服务于一位真实求职者。你的任务是根据「候选人真实简历与档案」和「目标岗位」，定制求职信、简历摘要和网申问答。

硬性规则（必须遵守）：
1. 只使用输入里明确出现的事实。禁止编造公司、职位、学历、证书、工作年限、项目、数字或技能。简历里没有的技能不能声称会。
2. 岗位要求里候选人明显缺失的能力，不要硬凑；可以在 warnings 里提示「岗位要求 X，简历未体现」。
3. 求职信 3 段、120-220 字：第一段说明应聘岗位与身份，第二段用简历里的 1-2 个具体经历证明匹配，第三段表达动机与到岗意愿。不要空话套话，不要写「贵公司处于行业领先」这类无法验证的赞美。
4. 简历摘要 2-3 句、80-140 字，突出与该岗位最相关的真实经历和技能；不改写姓名、年限、学历。
5. highlights 3-5 条，每条不超过 45 字，必须是简历中可核实的证据（项目、技术、指标）。
6. answers 只回答输入里给出的问题；回答 60-160 字，口语化、可直接填进网申表单；不知道的事实写「面议」或「可沟通」，不要编。
7. warnings 最多 4 条，指出材料中需要本人补充或核对的信息；没有就给空数组。
8. 全部中文。输出纪律：只输出一个 JSON 对象，不要 markdown、不要解释、不要第二个 JSON；字符串内不要用英文双引号，不要出现裸换行。`;

function clip(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function clean(value, max) {
  return clip(value, max).replace(/\r?\n+/g, " ").replace(/\s+/g, " ");
}

function list(value, maxItems, maxChars) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => clean(entry, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function salaryText(job) {
  if (job.salaryMin === null && job.salaryMax === null) return "面议";
  const unit = job.salaryUnit || "K/月";
  if (job.salaryMin !== null && job.salaryMax !== null && job.salaryMin !== job.salaryMax) return `${job.salaryMin}-${job.salaryMax}${unit}`;
  return `${job.salaryMin ?? job.salaryMax}${unit}`;
}

function contextOf(profile, resume, job, questions) {
  const resumeText = resumeToText(resume);
  return [
    `【候选人档案】`,
    `姓名：${profile.name || "未填写"}｜城市：${profile.city || "未填写"}｜经验：${profile.years || "未填写"}｜学历：${profile.degree || "未填写"}`,
    profile.salary ? `期望薪资：${profile.salary}` : "",
    profile.available ? `到岗时间：${profile.available}` : "",
    profile.summary ? `自述：${profile.summary}` : "",
    profile.skills.length ? `技能：${profile.skills.join("、")}` : "",
    profile.github || profile.website || profile.linkedin ? `链接：${[profile.github, profile.website, profile.linkedin].filter(Boolean).join(" ")}` : "",
    ``,
    `【简历全文】`,
    resumeText || "（未选择简历或简历为空）",
    ``,
    `【目标岗位】`,
    `公司：${job.company || "未填写"}｜岗位：${job.title}｜城市：${job.city || "未填写"}｜办公方式：${job.remoteType || "未填写"}｜薪资：${salaryText(job)}`,
    job.roleFamily || job.seniority ? `方向：${job.roleFamily || "-"}｜级别：${job.seniority || "-"}` : "",
    job.skills.length ? `岗位技能：${job.skills.join("、")}` : "",
    job.description ? `岗位描述：${clip(job.description, 2500)}` : "",
    job.requirements ? `岗位要求：${clip(job.requirements, 2500)}` : "",
    job.responsibilities ? `岗位职责：${clip(job.responsibilities, 2500)}` : "",
    ``,
    `【需要回答的网申问题】`,
    questions.length ? questions.map((question, index) => `${index + 1}. ${question}`).join("\n") : "（无）",
  ].filter((line) => line !== "").join("\n");
}

function fallbackAnswers(profile, job, questions) {
  return questions.map((question, index) => {
    let answer = "";
    if (/薪资|salary|待遇/i.test(question)) answer = profile.salary ? `我的期望薪资是${profile.salary}，具体可以根据岗位职责和整体福利再沟通。` : "薪资可以结合岗位职责与整体福利沟通，我的期望在合理区间内。";
    else if (/到岗|入职|available|notice/i.test(question)) answer = profile.available ? `我可以在${profile.available}到岗，具体时间可以提前沟通确认。` : "我可以尽快到岗，具体时间可以沟通确认。";
    else if (/优势|strength|擅长/i.test(question)) answer = profile.summary || (profile.skills.length ? `我的优势主要集中在${profile.skills.slice(0, 4).join("、")}，并在实际项目中持续使用。` : "");
    else if (/为什么|动机|加入|company/i.test(question)) answer = `我应聘${job.company || "贵公司"}的${job.title}岗位，希望把我在相关项目中的经验用到更匹配的业务场景里，也期待在团队里继续成长。`;
    else if (/项目|经历|project/i.test(question)) answer = "";
    return { id: `a-fallback-${index}`, question, answer };
  }).filter((entry) => entry.answer);
}

function localMaterials(profile, resume, job, questions, warning) {
  const resumeText = resumeToText(resume);
  const name = profile.name || "您好";
  const skills = job.skills.filter((skill) => `${profile.skills.join(" ")} ${resumeText}`.toLowerCase().includes(skill.toLowerCase())).slice(0, 4);
  const highlights = (skills.length ? skills.map((skill) => `熟悉 ${skill}，并在过往项目中使用`) : profile.skills.slice(0, 4).map((skill) => `具备 ${skill} 相关经验`)).slice(0, 5);
  const summary = profile.summary || clean(resumeText.replace(/【[^】]+】/g, " "), 140);
  const coverLetter = [
    `您好，我是${name}，应聘${job.company || "贵公司"}的${job.title}岗位。`,
    summary ? `我的经历与这个岗位相关：${summary}` : `我的技能覆盖${profile.skills.slice(0, 4).join("、") || "岗位所需方向"}，希望在更匹配的团队中持续投入。`,
    `如果岗位仍在招聘，我可以尽快沟通并配合面试安排，期待进一步交流。`,
  ].join("\n\n");
  return {
    headline: job.title,
    summary: summary || `应聘${job.title}岗位，期待进一步沟通。`,
    coverLetter,
    highlights,
    answers: fallbackAnswers(profile, job, questions),
    warnings: [warning, ...(job.skills.length ? [`投递前请核对岗位要求的 ${job.skills.slice(0, 3).join("、")} 是否都能在简历中找到证据`] : [])],
    generatedAt: Date.now(),
    model: "local-fallback",
  };
}

function looksValid(parsed) {
  return Boolean(parsed && typeof parsed === "object" && (clip(parsed.coverLetter, 10) || clip(parsed.summary, 10)));
}

export async function tailorMaterials(chat, input) {
  const questions = input.questions.map((question) => clean(question, 160)).filter(Boolean).slice(0, MAX_OUTPUT_QUESTIONS);
  if (!chat) {
    return localMaterials(input.profile, input.resume, input.job, questions, "未连接可用文本模型，材料由档案与简历原文拼装，建议配置模型后重新生成");
  }
  const user = contextOf(input.profile, input.resume, input.job, questions);
  const base = {
    system: SYSTEM,
    user,
    temperature: 0.35,
    maxTokens: 3800,
  };
  let completion;
  let parsed;
  try {
    completion = await chat(base);
    parsed = parseResumeAiJson(completion.content);
    if (!looksValid(parsed)) {
      completion = await chat({
        ...base,
        user: `${user}\n\n【输出预算】上一次输出不可解析。这次更短：coverLetter 不超过 200 字，answers 每条不超过 100 字，只输出一个完整闭合的 JSON。`,
        temperature: 0.2,
      });
      parsed = parseResumeAiJson(completion.content);
    }
  } catch (error) {
    return localMaterials(input.profile, input.resume, input.job, questions, `模型调用失败：${clean(error?.message ?? error, 160)}，已用档案信息生成基础版本，请人工润色`);
  }
  if (!looksValid(parsed)) {
    return localMaterials(input.profile, input.resume, input.job, questions, "模型没有返回可解析的材料，已用档案信息生成基础版本，请人工润色");
  }

  const answers = (Array.isArray(parsed.answers) ? parsed.answers : [])
    .slice(0, MAX_OUTPUT_QUESTIONS)
    .map((entry) => ({
      id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      question: clean(entry?.question, 160),
      answer: clean(entry?.answer, 500),
    }))
    .filter((entry) => Boolean(entry.question && entry.answer));

  return {
    headline: clean(parsed.headline, 120) || input.job.title,
    summary: clean(parsed.summary, 500),
    coverLetter: clip(parsed.coverLetter, 3000),
    highlights: list(parsed.highlights, 6, 120),
    answers,
    warnings: list(parsed.warnings, 5, 160),
    generatedAt: Date.now(),
    model: completion.model || "",
  };
}

function hash(value) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return result;
}

/** 合并档案里的固定答案：用户自己写的答案优先于模型生成，避免每次投递口径漂移。 */
export function mergeAnswers(profile, materials) {
  const byQuestion = new Map();
  for (const entry of materials.answers) byQuestion.set(entry.question, entry.answer);
  for (const entry of profile.answerBank) {
    if (!entry.answer.trim()) continue;
    byQuestion.set(entry.question, entry.answer);
  }
  return {
    ...materials,
    answers: [...byQuestion.entries()].map(([question, answer], index) => ({
      id: `a-${index}-${Math.abs(hash(question)).toString(36)}`,
      question,
      answer,
    })),
  };
}
