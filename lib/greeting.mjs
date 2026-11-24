import { parseResumeAiJson, resumeToText } from "./resume-ai.mjs";

/**
 * 招呼语生成与润色。
 *
 * 业务规则（提示词、模板占位符、本地兜底）全部留在插件；模型调用通过注入的
 * `chat({ system, user, temperature, maxTokens })` 完成，由宿主 `llm.chat`
 * 负责凭据、网关计费与重试。插件更新不再需要重新打包客户端。
 */

const SYSTEM = `你是求职者的 Boss 直聘开场招呼助手。根据「候选人真实档案与简历」和「目标岗位」，写一条发给招聘者的第一条消息。

硬性规则：
1. 只使用输入里明确出现的事实，禁止编造公司、年限、学历、项目、数字或技能；简历和档案里没有的技能不能声称会。
2. 60-120 字，1-3 句，口语自然，像真人发消息，不要客套模板，不要「贵公司处于行业领先」这类无法验证的赞美。
3. 必须提到应聘岗位；如果有真实匹配的技能或经历，用一句具体说明；没有就只表达应聘意向和沟通意愿。
4. 不要写「附件简历」以外的承诺，不要约面试时间，不要提薪资。
5. 全部中文。只输出一个 JSON 对象：{"greeting":"...","warnings":["..."]}，不要 markdown、不要解释；字符串内不要用英文双引号，不要出现裸换行。warnings 最多 3 条，没有就空数组。`;

const POLISH_SYSTEM = `你是求职沟通话术润色助手，帮用户把已经写好的招呼语改得更自然、更有诚意。

硬性规则：
1. 只优化表达，不新增事实：不得出现原文、候选人档案和简历里都没有的公司、年限、学历、项目、数字或技能。
2. 不改变原意和语言（中文），不加「贵公司处于行业领先」这类无法验证的赞美，不约面试、不提薪资。
3. 长度不超过原文的 1.3 倍；一条招呼语最多 300 字，再次沟通消息每行最多 180 字，固定模板最多 600 字；默认一段话、不要换行。原文是多行（多条再次沟通话术）时必须保持行数、顺序和每行一条的格式，不要合并成一段。
4. kind 为 template 时，必须原样保留原文里的所有占位符（如 {name}、{job}、{skills}），不得改名、删除或替换成真实值；kind 为 repeat 时保持「再次沟通」的语气。
5. 用户给了润色要求时优先满足，但不能突破以上规则。
6. 只输出一个 JSON 对象：{"text":"润色后的话术","notes":["改动说明，最多3条"]}，不要 markdown、不要解释；字符串内不要用英文双引号，不要出现裸换行。`;

function clip(value, max) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function clean(value, max) {
  return clip(value, max).replace(/\r?\n+/g, " ").replace(/\s+/g, " ");
}

function contextOf(profile, resume, job, template, repeat) {
  return [
    "【候选人档案】",
    `姓名：${profile.name || "未填写"}｜城市：${profile.city || "未填写"}｜经验：${profile.years || "未填写"}｜学历：${profile.degree || "未填写"}`,
    profile.summary ? `自述：${profile.summary}` : "",
    profile.skills.length ? `技能：${profile.skills.join("、")}` : "",
    "",
    "【简历全文】",
    resumeToText(resume).slice(0, 8000) || "（未选择简历或简历为空）",
    "",
    "【目标岗位】",
    `公司：${job.company || "未填写"}｜岗位：${job.title}｜城市：${job.city || "未填写"}`,
    job.skills.length ? `岗位技能：${job.skills.join("、")}` : "",
    job.recruiter ? `招聘者：${job.recruiter}` : "",
    job.description ? `岗位描述：${clip(job.description, 2000)}` : "",
    job.requirements ? `岗位要求：${clip(job.requirements, 1800)}` : "",
    repeat ? "【场景】这是同一岗位的再次沟通：不要重复第一次的自我介绍，用一句话说明来意并询问进展。" : "",
    template ? `【用户偏好的招呼话术】\n${clip(template, 800)}\n请沿用其中的称呼、语气和关键信息，但不得加入用户档案与简历中不存在的事实。` : "",
  ].filter(Boolean).join("\n");
}

function fallbackGreeting(profile, resume, job) {
  const resumeText = resumeToText(resume);
  const pool = [...profile.skills, ...job.skills];
  const matched = pool.filter((skill) => {
    const value = String(skill ?? "").trim();
    if (!value) return false;
    return profile.skills.some((entry) => entry === value) || resumeText.includes(value);
  });
  const skills = [...new Set(matched)].slice(0, 3);
  const name = profile.name ? `我是${profile.name}` : "您好";
  const skillLine = skills.length
    ? `我的经历主要围绕${skills.join("、")}，与岗位要求有一定重合。`
    : "我的经历与这个岗位方向相关。";
  return clean(`${name}，看到您在招${job.title}。${skillLine}如果岗位还在招聘，期待和您进一步沟通。`, 160);
}

export function renderGreetingTemplate(template, input) {
  const source = clip(template, 1200);
  if (!source) return "";
  const values = {
    name: input.profile.name || "",
    job: input.job.title || "",
    company: input.job.company || "",
    city: input.job.city || input.profile.city || "",
    skills: input.profile.skills.slice(0, 4).join("、"),
    years: input.profile.years || "",
    degree: input.profile.degree || "",
  };
  return clean(source.replace(/\{(name|job|company|city|skills|years|degree)\}/g, (_match, key) => values[key] ?? ""), 500);
}

export function repeatFallbackGreeting(profile, job) {
  const name = profile.name ? `我是${profile.name}，` : "";
  return clean(`${name}之前和您沟通过${job.title}这个岗位。如果还在招聘，期待您再看一下我的简历，方便的话想再了解一下进展，谢谢。`, 160);
}

export function polishPlaceholders(value) {
  return [...new Set(String(value ?? "").match(/\{(name|job|company|city|skills|years|degree)\}/g) ?? [])];
}

function polishContext(profile, resume, job) {
  return [
    "【候选人档案】",
    `姓名：${profile.name || "未填写"}｜城市：${profile.city || "未填写"}｜经验：${profile.years || "未填写"}｜学历：${profile.degree || "未填写"}`,
    profile.skills.length ? `技能：${profile.skills.join("、")}` : "",
    job ? `【目标岗位】${job.company ? `${job.company} · ` : ""}${job.title}${job.city ? `（${job.city}）` : ""}` : "",
    resumeToText(resume).slice(0, 3000) || "",
  ].filter(Boolean).join("\n");
}

export async function polishGreeting(chat, input) {
  const source = clip(input.text, 2000);
  if (!source) throw new Error("请先填写要润色的招呼语");
  const kind = input.kind === "template" || input.kind === "repeat" ? input.kind : "greeting";
  const multiline = kind === "repeat" && /\n/.test(source);
  const maxLength = kind === "template" ? 1200 : kind === "repeat" ? 200 : 500;
  const required = kind === "template" ? polishPlaceholders(source) : [];
  const tidy = (value) => {
    const raw = String(value ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
    if (multiline) return raw.slice(0, 1200);
    return raw.replace(/\n+/g, " ").replace(/\s+/g, " ").slice(0, maxLength);
  };
  const user = [
    polishContext(input.profile, input.resume, input.job ?? null),
    "",
    `【话术类型】${kind === "template" ? "固定模板（占位符必须原样保留）" : kind === "repeat" ? "再次沟通消息" : "第一条招呼语"}`,
    `【润色要求】${clip(input.instruction, 500) || "更自然、更有诚意，突出与岗位的真实匹配"}`,
    required.length ? `【必须保留的占位符】${required.join(" ")}` : "",
    "",
    "【原文】",
    source,
  ].filter(Boolean).join("\n");

  const attempt = async (extra = "", maxTokens = 700) => {
    const completion = await chat({
      system: POLISH_SYSTEM,
      user: `${user}${extra}`,
      temperature: 0.35,
      maxTokens,
    });
    const parsed = parseResumeAiJson(completion.content);
    const polished = tidy(parsed?.text);
    const notes = (Array.isArray(parsed?.notes) ? parsed.notes : [])
      .map((entry) => clean(entry, 120))
      .filter(Boolean)
      .slice(0, 3);
    return { polished, notes, model: completion.model || "" };
  };

  let result = await attempt();
  if (!result.polished) {
    result = await attempt("\n\n【输出预算】上一次输出无法解析。这次只输出一个更短的 JSON：{\"text\":\"不超过150字\",\"notes\":[]}", 500);
  }
  if (!result.polished) throw new Error("模型没有返回可用的润色结果，请稍后重试");
  if (required.length && required.some((placeholder) => !result.polished.includes(placeholder))) {
    result = await attempt(`\n\n【修正】上一次结果丢失了占位符。必须原样保留：${required.join(" ")}`, 600);
  }
  const missing = required.filter((placeholder) => !result.polished.includes(placeholder));
  if (!result.polished || (required.length && missing.length)) {
    throw new Error(`润色结果没有保留占位符 ${missing.join(" ")}，请重试或直接手动修改`);
  }
  return { text: result.polished, notes: result.notes, model: result.model };
}

export async function craftGreeting(chat, input) {
  const template = input.template?.trim() ?? "";
  const useTemplate = input.mode === "template";
  const local = (warning) => ({
    text: input.repeat ? repeatFallbackGreeting(input.profile, input.job) : fallbackGreeting(input.profile, input.resume, input.job),
    model: "local-fallback",
    mode: "local",
    warnings: [warning],
  });
  // 与宿主一致：模板模式或没有可用模型时，不发起 AI 调用。
  if (useTemplate || !chat) {
    const rendered = renderGreetingTemplate(template, input);
    if (rendered) {
      return {
        text: rendered,
        model: "template",
        mode: "template",
        warnings: useTemplate ? ["当前使用固定模板发送，请确认称呼与信息适用于这个岗位"] : [],
      };
    }
    return local(useTemplate ? "固定模板为空或过短，已改用档案信息生成基础版本" : "未连接文本模型，招呼语由档案与简历原文拼装，建议配置模型后重新生成");
  }
  const user = contextOf(input.profile, input.resume, input.job, template, input.repeat === true);
  try {
    let completion = await chat({
      system: SYSTEM,
      user,
      temperature: 0.4,
      maxTokens: 500,
    });
    let parsed = parseResumeAiJson(completion.content);
    if (!parsed || !clean(parsed.greeting, 10)) {
      completion = await chat({
        system: SYSTEM,
        user: `${user}\n\n【输出预算】上一次输出不可解析。这次只输出一个更短的 JSON：{"greeting":"不超过100字","warnings":[]}`,
        temperature: 0.2,
        maxTokens: 400,
      });
      parsed = parseResumeAiJson(completion.content);
    }
    const text = clean(parsed?.greeting, 500);
    if (!text) return local("模型没有返回可用的招呼语，已用档案信息生成基础版本，请发送前核对");
    return {
      text,
      model: completion.model || "",
      mode: "ai",
      warnings: (Array.isArray(parsed?.warnings) ? parsed.warnings : []).map((entry) => clean(entry, 160)).filter(Boolean).slice(0, 3),
    };
  } catch (error) {
    return local(`模型调用失败：${clean(error?.message ?? error, 160)}，已用档案信息生成基础版本，请发送前核对`);
  }
}
