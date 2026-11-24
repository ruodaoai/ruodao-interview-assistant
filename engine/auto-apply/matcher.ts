import type { AutoApplyJob, AutoApplyProfile, AutoApplyRules } from "./types";
import { outsourceMatch } from "./outsource";

const LATIN_STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "you", "your", "are", "our", "will", "have", "has", "job", "role", "team", "work"]);

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[，。；、！？：""''（）【】《》,.;:!?"'()]/g, " ").replace(/\s+/g, " ").trim();
}

function isCjk(char: string) {
  return /[\u3400-\u9fff]/.test(char);
}

function terms(value: unknown) {
  const text = normalize(value);
  const result = new Set<string>();
  const latin = text.match(/[a-z][a-z0-9+#.-]{1,30}/g) ?? [];
  for (const word of latin) if (!LATIN_STOP.has(word)) result.add(word);
  const cjk = text.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return result;
}

function dice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function containsLoose(haystack: string, needle: string) {
  const left = normalize(haystack);
  const right = normalize(needle);
  if (!right) return false;
  return left.includes(right) || right.includes(left) && right.length >= 3;
}

function parseSalary(value: string): [number, number] | null {
  const numbers = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (!numbers.length) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (numbers.length === 1) return [min, min];
  return [min, max];
}

function salaryOverlap(profile: AutoApplyProfile, job: AutoApplyJob) {
  if (job.salaryMin === null && job.salaryMax === null) return null;
  const expected = parseSalary(profile.salary);
  if (!expected) return null;
  const jobMin = job.salaryMin ?? job.salaryMax ?? 0;
  const jobMax = job.salaryMax ?? job.salaryMin ?? 0;
  return !(jobMax < expected[0] || jobMin > expected[1]);
}

function roleMatch(profile: AutoApplyProfile, job: AutoApplyJob) {
  if (!profile.targetRoles.length) return 0.55;
  const haystack = `${job.title} ${job.roleFamily} ${job.skills.join(" ")}`;
  return profile.targetRoles.some((role) => containsLoose(haystack, role)) ? 1 : 0;
}

function cityMatch(profile: AutoApplyProfile, job: AutoApplyJob) {
  if (job.remoteType === "remote" && profile.remote === "远程") return 1;
  if (!profile.targetCities.length) return 0.6;
  const city = job.city || "";
  return profile.targetCities.some((target) => city.includes(target) || target.includes(city) && city.length >= 2) ? 1 : 0;
}

export function scoreJob(profile: AutoApplyProfile, job: AutoApplyJob, resumeText = "") {
  const profileText = [profile.summary, profile.skills.join(" "), resumeText].filter(Boolean).join("\n");
  const jobText = [job.title, job.description, job.requirements, job.responsibilities, job.skills.join(" "), job.roleFamily].filter(Boolean).join("\n");
  const similarity = dice(terms(profileText), terms(jobText));
  const matchedSkills = job.skills.filter((skill) => containsLoose(profileText, skill));
  const missingSkills = job.skills.filter((skill) => !matchedSkills.includes(skill));
  const skillRatio = job.skills.length ? matchedSkills.length / job.skills.length : 0.5;
  const role = roleMatch(profile, job);
  const city = cityMatch(profile, job);
  const salary = salaryOverlap(profile, job);
  let score = Math.round(similarity * 42 + skillRatio * 30 + role * 18 + city * 10);
  if (salary === true) score += 4;
  if (salary === false) score -= 6;
  if (profile.remote === "远程" && job.remoteType === "remote") score += 3;
  score = Math.max(0, Math.min(100, score));

  const reasons: string[] = [];
  if (matchedSkills.length) reasons.push(`技能命中：${matchedSkills.slice(0, 4).join(" / ")}`);
  if (role === 1) reasons.push(`岗位方向与目标一致：${profile.targetRoles.slice(0, 2).join(" / ")}`);
  if (city === 1) reasons.push(job.remoteType === "remote" && profile.remote === "远程" ? "支持远程，符合你的偏好" : `工作城市匹配：${job.city || "不限"}`);
  if (salary === true) reasons.push("薪资区间与期望有交集");
  if (!reasons.length) reasons.push("岗位描述与你的经历有部分关键词重合，建议人工再确认");

  const gaps = missingSkills.slice(0, 6);
  const verdict = score >= 78 ? "strong" : score >= 60 ? "worth" : "skip";
  return { score, reasons, gaps, matchedSkills, missingSkills, verdict };
}

export function withLocalScore(profile: AutoApplyProfile, job: AutoApplyJob, resumeText = ""): AutoApplyJob {
  const result = scoreJob(profile, job, resumeText);
  return { ...job, matchScore: result.score, reasons: result.reasons, gaps: result.gaps, verdict: result.verdict };
}

export function screenJob(rules: AutoApplyRules, job: AutoApplyJob) {
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

export function buildProfileTerms(profile: AutoApplyProfile, resumeText = "") {
  return [...terms(`${profile.summary} ${profile.skills.join(" ")} ${resumeText}`)].slice(0, 200);
}

export { isCjk, normalize as normalizeMatchText };
