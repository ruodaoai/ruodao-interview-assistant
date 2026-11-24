import fs from "node:fs/promises";
import path from "node:path";
import { companyNameKey } from "./company-key.mjs";

/**
 * 公司情报的本地缓存读取（只读）。
 *
 * 情报文件由插件与宿主共用：<userData>/auto-apply/company-intel.json。
 * 批量准入与搜岗过滤只需要「已判定的结论」，这里直接读文件，
 * AI 判定 / 云端共享仍走原有的情报中心（宿主内置页兜底期间继续可用）。
 */
export function createCompanyIntelView(dataRoot, log = () => {}) {
  const file = path.join(dataRoot, "company-intel.json");
  let cache = null;
  let cacheAt = 0;

  async function entries() {
    if (cache && Date.now() - cacheAt < 10_000) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      const source = raw && typeof raw.entries === "object" && raw.entries ? raw.entries : {};
      const result = {};
      for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== "object") continue;
        const name = String(value.name ?? key).trim();
        const nameKey = companyNameKey(name) || String(key);
        result[nameKey] = { ...value, name, key: nameKey };
      }
      cache = result;
      cacheAt = Date.now();
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") log(`company intel read failed: ${String(error?.message ?? error).slice(0, 160)}`);
      cache = {};
      cacheAt = Date.now();
      return cache;
    }
  }

  async function lookup(name) {
    const key = companyNameKey(name);
    if (!key) return null;
    return (await entries())[key] ?? null;
  }

  /** 与宿主 companyVerdictSkipReason 同语义：人工结论优先，AI 结论尊重过滤开关。 */
  async function verdictSkipReason(job, rules) {
    const name = String(job?.company ?? "").trim();
    if (!name) return "";
    const intel = await lookup(name);
    if (!intel) return "";
    const manualOutsource = intel.manualVerdict === "outsource" || (Array.isArray(intel.tags) && intel.tags.includes("outsource"));
    if (manualOutsource) return `「${name}」你已标记为外包 / 驻场，不再投递`;
    if (intel.manualVerdict === "not_outsource") return "";
    if (!rules?.filterOutsource) return "";
    if (intel.aiVerdict === "outsource" || intel.isOutsource === true) return `「${name}」判定为外包 / 驻场公司`;
    return "";
  }

  /** 搜岗结果附加情报（只读缓存，绝不在这里触发 AI / 云端请求）。 */
  async function annotate(jobs) {
    if (!jobs.length) return jobs;
    const all = await entries();
    return jobs.map((job) => {
      const key = companyNameKey(job.company);
      const intel = key ? all[key] : null;
      return intel ? { ...job, companyKey: key, companyIntel: intel } : job;
    });
  }

  return { lookup, verdictSkipReason, annotate, file };
}
