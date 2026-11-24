/**
 * 招聘平台业务引擎入口：由宿主 Vite 构建成 lib/job-engine.mjs，供插件常驻服务直接导入。
 *
 * 宿主只提供通用浏览器驱动（窗口、导航、页面脚本、接口旁路、点击输入、截图），
 * 搜岗、投递、打招呼、记录核对的判断全部留在这个包里。
 */
export { createBrowserDriver } from "./driver";
export type { BrowserDriver, BrowserHostCall, BrowserTab, RevealMode } from "./driver";
export { JobSiteSearchEngine } from "./search";
export { applyJobSite } from "./apply";
export { greetBoss } from "./greet";
export { isJob51ApplySuccessUrl, isCompanyPageUrl } from "./job-sites/apply";
export { filterSiteJobs, jobHistoryKey } from "./job-sites/parse";
export { applyJobTrust } from "./job-sites/trust";
export { JOB_SITES, JOB_SITE_IDS, jobSiteLabel, supportsSiteApply } from "./job-sites/sites";
export { withLocalScore } from "./auto-apply/matcher";
export { blockedKindFromReason } from "./job-sites/blocker";
export { job51RecordsScript, matchJob51AppliedRecord, parseJob51AppliedRecords } from "./job-sites/job51-records";
export { zhaopinMessageProbeScript, zhaopinMessageRecord, zhaopinMessageUrlScript } from "./job-sites/zhaopin-api";
export {
  bossChatListScript,
  buildBossChatAiPrompt,
  matchBossContact,
  parseBossChatContacts,
  sanitizeBossChatVerdicts,
} from "./job-sites/boss-chat-list";
export { BatchApplyQueue } from "./auto-apply/batch";
