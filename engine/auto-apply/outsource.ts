import type { AutoApplyJob } from "./types";

const OUTSOURCE_TERMS = [
  "外包",
  "驻场",
  "外派",
  "派遣",
  "外协",
  "劳务",
  "人力资源服务",
  "人力资源外包",
  "招聘服务",
  "服务外包",
  "众包",
  "bpo",
];

type OutsourceInput = Pick<AutoApplyJob, "title" | "company" | "companyIndustry" | "description" | "requirements" | "responsibilities" | "skills"> & {
  tags?: string[];
};

export function outsourceMatch(job: OutsourceInput): string {
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

export function isOutsourceJob(job: OutsourceInput) {
  return outsourceMatch(job) !== "";
}
