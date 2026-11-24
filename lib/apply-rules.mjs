/**
 * 自动投递的本地准入规则与网申默认问题。
 * 与宿主 electron/auto-apply/{matcher,outsource,types}.ts 保持同一套判定，
 * 保证插件生成的预检结论和宿主真正执行时一致。
 */

const OUTSOURCE_TERMS = [
  "外包", "驻场", "外派", "派遣", "外协", "劳务",
  "人力资源服务", "人力资源外包", "招聘服务", "服务外包", "众包", "bpo",
];

export const DEFAULT_ANSWERS = [
  { question: "为什么想加入我们公司？", answer: "" },
  { question: "你的期望薪资是多少？", answer: "" },
  { question: "最快什么时候可以到岗？", answer: "" },
  { question: "介绍一下你最有代表性的项目。", answer: "" },
  { question: "你觉得自己最大的优势是什么？", answer: "" },
  { question: "还有什么想了解的吗？", answer: "" },
];

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[，。；、！？：""''（）【】《》,.;:!?"'()]/g, " ").replace(/\s+/g, " ").trim();
}

export function outsourceMatch(job) {
  const haystack = [
    job.title,
    job.company,
    job.companyIndustry,
    job.description,
    job.requirements,
    job.responsibilities,
    (job.tags ?? []).join(" "),
    job.skills.join(" "),
  ].join(" ").toLowerCase();
  for (const term of OUTSOURCE_TERMS) {
    if (term === "bpo") {
      if (/(^|[^a-z])bpo([^a-z]|$)/.test(haystack)) return "BPO";
      continue;
    }
    if (haystack.includes(term)) return term;
  }
  return "";
}

export function hasProfileData(profile) {
  return Boolean(profile.name || profile.summary || profile.skills.length || profile.targetRoles.length || profile.resumeId);
}

/** 返回跳过原因；空串表示可以投递。 */
export function screenJob(rules, job) {
  const company = normalize(`${job.company} ${job.companyIndustry}`);
  const blockedCompany = rules.blockedCompanies.find((entry) => {
    const needle = normalize(entry);
    return needle && (company.includes(needle) || needle.includes(company));
  });
  if (blockedCompany) {
    const note = String(rules.blockedCompanyNotes?.[blockedCompany] ?? "").trim();
    return `公司「${job.company}」命中屏蔽名单「${blockedCompany}」${note ? `：${note}` : ""}`;
  }
  const haystack = normalize(`${job.title} ${job.company} ${job.companyIndustry} ${job.description} ${job.requirements} ${job.responsibilities} ${(job.tags ?? []).join(" ")} ${job.skills.join(" ")}`);
  const blockedKeyword = rules.blockedKeywords.find((entry) => {
    const needle = normalize(entry);
    return needle && haystack.includes(needle);
  });
  if (blockedKeyword) return `岗位内容命中屏蔽词「${blockedKeyword}」`;
  if (rules.filterOutsource) {
    const term = outsourceMatch(job);
    if (term) return `岗位命中外包 / 驻场过滤「${term}」`;
  }
  return "";
}

/** 还没有人工固定答案的默认问题；生成材料时只回答这些。 */
export function questionsFor(profile) {
  const answered = new Set(profile.answerBank.filter((entry) => entry.answer.trim()).map((entry) => entry.question.trim()));
  return DEFAULT_ANSWERS.map((entry) => entry.question).filter((question) => !answered.has(question));
}
