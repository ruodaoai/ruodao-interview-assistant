import type { AutoApplyJob, JobTrustLevel } from "../auto-apply/types";
import { isOutsourceJob } from "../auto-apply/outsource";
import { parseActiveDays } from "./parse";

export type JobSighting = {
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  /** 本地见过的最早一次「平台发布时间」。 */
  postedAt?: number | null;
  /** 平台把发布时间往后改了几次（刷新型僵尸岗信号）。 */
  refreshCount?: number;
};

export type JobTrust = {
  score: number;
  level: Exclude<JobTrustLevel, "">;
  reasons: string[];
  risks: string[];
  activeDays: number | null;
  listingDays: number | null;
  postedDays: number | null;
  ageDays: number | null;
  refreshCount: number;
  longTerm: boolean;
};

const DAY = 86_400_000;
const HEADHUNTER_PATTERN = /猎头|人力资源服务|人才服务|招聘服务/;

/**
 * 可解释的「真实招聘」判断：只用页面上能拿到的信号，不猜测、不访问外部数据。
 * 分数只用于排序和提示，不能替代本人核实。
 */
export function assessJobTrust(job: AutoApplyJob, sighting?: JobSighting | null, now = Date.now()): JobTrust {
  const reasons: string[] = [];
  const risks: string[] = [];
  let score = 50;

  const company = String(job.company ?? "").trim();
  const anonymous = job.companyAnonymous === true || !company || /未公开|匿名|保密/.test(company);
  if (anonymous) {
    score -= 12;
    risks.push("企业名称未公开");
  } else {
    score += 12;
    reasons.push(`企业名称公开：${company}`);
  }

  const salaryKnown = (job.salaryMin !== null && job.salaryMin !== undefined && Number(job.salaryMin) > 0)
    || (job.salaryMax !== null && job.salaryMax !== undefined && Number(job.salaryMax) > 0);
  if (salaryKnown) {
    score += 12;
    reasons.push("薪资范围公开");
  } else {
    score -= 6;
    risks.push("薪资未公开");
  }

  const recruiter = String(job.recruiter ?? "").trim();
  if (recruiter) {
    score += 8;
    reasons.push(`招聘者公开：${recruiter}${job.recruiterTitle ? `（${job.recruiterTitle}）` : ""}`);
  } else {
    score -= 4;
    risks.push("未显示招聘者");
  }

  const activeDays = job.activeDays === null || job.activeDays === undefined
    ? parseActiveDays(job.recruiterActive)
    : Number(job.activeDays);
  if (activeDays !== null && Number.isFinite(activeDays)) {
    if (activeDays <= 1) {
      score += 18;
      reasons.push("招聘者今天活跃");
    } else if (activeDays <= 7) {
      score += 14;
      reasons.push("招聘者近 7 天活跃");
    } else if (activeDays <= 30) {
      score += 6;
      reasons.push("招聘者近 30 天活跃");
    } else if (activeDays <= 90) {
      score -= 10;
      risks.push(`招聘者已约 ${Math.round(activeDays)} 天未活跃`);
    } else {
      score -= 20;
      risks.push(`招聘者超过 ${Math.round(activeDays)} 天未活跃`);
    }
  } else {
    score -= 5;
    risks.push("未获取招聘者活跃度");
  }

  const status = String(job.jobStatus ?? "");
  const statusText = String(job.jobStatusText ?? "").trim();
  if (status === "open") {
    score += 12;
    reasons.push(statusText || "平台标记在招");
  } else if (status === "closed") {
    score -= 40;
    risks.push(statusText || "平台标记已关闭");
  }

  let listingDays: number | null = null;
  if (sighting?.firstSeenAt) {
    listingDays = Math.max(0, Math.floor((now - sighting.firstSeenAt) / DAY));
    if (sighting.seenCount >= 3) reasons.push(`招聘池里第 ${sighting.seenCount} 次看到`);
  }

  /**
   * 挂岗时长是「僵尸岗」最直接的信号，但两个来源各有盲区：
   * - 平台发布时间由 HR 刷新，可能天天都是新的（刷新型挂岗）；
   * - 本地首见时间只覆盖本机看过的这段时间。
   * 所以两个都算，取较大值，并单独提示「发布过新但本地一直看到旧岗位」。
   */
  const platformPostedAt = Number(job.postedAt) || Number(sighting?.postedAt) || 0;
  const postedDays = platformPostedAt ? Math.max(0, Math.floor((now - platformPostedAt) / DAY)) : null;
  const refreshCount = Math.max(
    Math.round(Number(job.refreshCount) || 0),
    Math.round(Number(sighting?.refreshCount) || 0),
  );
  const ageCandidates = [postedDays, listingDays].filter((value): value is number => value !== null);
  const ageDays = ageCandidates.length ? Math.max(...ageCandidates) : null;
  if (ageDays !== null) {
    if (ageDays >= 90) {
      score -= 24;
      risks.push(`岗位信息已挂出 ${ageDays} 天`);
    } else if (ageDays >= 60) {
      score -= 15;
      risks.push(`岗位信息已挂出 ${ageDays} 天`);
    } else if (ageDays >= 30) {
      score -= 7;
      risks.push(`岗位信息已挂出 ${ageDays} 天`);
    } else if (ageDays <= 3) {
      score += 6;
      reasons.push(postedDays !== null && postedDays <= 3 ? "平台显示最近发布 / 更新" : "最近才出现在招聘池");
    }
    // 挂着很久却把发布时间刷成新的：平台侧看起来「刚发布」，本地却连续看到同一岗位。
    if (refreshCount >= 2 && ageDays >= 30) {
      score -= 8;
      risks.push(`平台已把发布时间改过 ${refreshCount} 次，但岗位连续在池 ${ageDays} 天`);
    }
  } else {
    risks.push("平台未展示发布时间，也没有本地首见记录");
  }

  if (String(job.description ?? "").length >= 120) {
    score += 5;
    reasons.push("岗位描述完整");
  }

  if (isOutsourceJob(job)) {
    score -= 12;
    risks.push("疑似外包 / 驻场岗位");
  }
  const headhunter = HEADHUNTER_PATTERN.test(`${company} ${recruiter}`);
  if (headhunter) {
    score -= 8;
    risks.push("疑似猎头 / 人力资源公司代招");
  }
  const taggedHeadhunter = (job.tags ?? []).some((tag) => /猎头|代招/.test(tag));
  if (taggedHeadhunter) {
    score -= 6;
    risks.push("平台标注猎头或代招");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level: Exclude<JobTrustLevel, ""> = score >= 75 ? "high" : score >= 55 ? "medium" : score >= 35 ? "low" : "suspect";
  if (status === "closed") level = "suspect";
  else if (level === "high" && (anonymous || !salaryKnown || !recruiter || headhunter || taggedHeadhunter)) level = "medium";
  // 挂出 90 天以上就算其他信号都不错，也不能再标「真实度较高」：僵尸岗最常见的形态就是
  // 公司、薪资、招聘者全都正常，只是这个岗位一直挂着。
  else if (level === "high" && ageDays !== null && ageDays >= 90) level = "medium";

  return {
    score,
    level,
    reasons: reasons.slice(0, 8),
    risks: risks.slice(0, 8),
    activeDays: activeDays !== null && Number.isFinite(activeDays) ? Math.round(activeDays * 100) / 100 : null,
    listingDays,
    postedDays,
    ageDays,
    refreshCount,
    longTerm: ageDays !== null && ageDays >= 30,
  };
}

export function applyJobTrust(job: AutoApplyJob, sighting?: JobSighting | null, now = Date.now()): AutoApplyJob {
  const trust = assessJobTrust(job, sighting, now);
  return {
    ...job,
    activeDays: trust.activeDays,
    listingDays: trust.listingDays,
    postedDays: trust.postedDays,
    ageDays: trust.ageDays,
    refreshCount: trust.refreshCount,
    seenCount: sighting?.seenCount ?? 0,
    longTerm: trust.longTerm,
    trustScore: trust.score,
    trustLevel: trust.level,
    trustReasons: trust.reasons,
    trustRisks: trust.risks,
  };
}
