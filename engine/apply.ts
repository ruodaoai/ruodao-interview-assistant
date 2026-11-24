import type { AutoApplyJob } from "./auto-apply/types";
import type { BrowserDriver } from "./driver";
import type { JobSiteSearchEngine } from "./search";
import type { ApplyDriver } from "./job-sites/apply";
import { isCompanyPageUrl, isJob51ApplySuccessUrl, submitResume } from "./job-sites/apply";
import { blockedKindFromReason } from "./job-sites/blocker";
import { job51JobIdOf, job51LookupScript, normalizeJob51DetailUrl } from "./job-sites/job51-api";
import { JOB_SITES, jobSiteLabel, supportsSiteApply } from "./job-sites/sites";
import type { JobSiteApplyInput, JobSiteApplyResult, JobSiteId } from "./job-sites/types";

const ABORT_MESSAGE = "投递任务已停止，本次操作已中止";

function text(value: unknown, max = 1000) {
  return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeName(value: string) {
  return String(value ?? "shot")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "shot";
}

/**
 * 把浏览器的异步动作适配成 `submitResume` 需要的 ApplyDriver。
 *
 * 原来的驱动把 `currentUrl()` 设计成同步取值（主进程直接读 BrowserWindow），
 * 插件这边只能走 RPC，所以缓存一份地址，并在每次可能发生跳转的动作后刷新：
 * 加载、等待、脚本、点击、输入、阻断检查、读正文之后都重新取一次。
 */
function createApplyDriver(options: {
  driver: BrowserDriver;
  site: JobSiteId;
  evidenceDir: string;
  log: (message: string) => void;
  signal?: AbortSignal;
}): { applyDriver: ApplyDriver; lastUrl: () => string } {
  const { driver, site, evidenceDir, log, signal } = options;
  let currentUrl = "";
  const refreshUrl = async () => {
    const next = await driver.url(site).catch(() => "");
    if (next) currentUrl = next;
    return currentUrl;
  };
  const aborted = () => signal?.aborted === true;
  const guard = () => {
    if (aborted()) throw new Error(ABORT_MESSAGE);
  };
  const shot = async (label: string) => {
    const file = `${String(evidenceDir).replace(/[\\/]+$/, "")}/${Date.now()}-${safeName(label)}.png`;
    const saved = await driver.screenshot(site, file).catch(() => "");
    return saved;
  };
  const applyDriver: ApplyDriver = {
    load: async (url) => {
      guard();
      // 打开岗位页必须等到 SPA 真的画出来：否则后面的「找投递按钮」全在空页面上跑。
      const result = await driver.goto(site, url, { attempts: 1 }).catch(() => ({ ok: false, url: "" }));
      await refreshUrl();
      log(result?.ok ? "岗位页已加载" : "岗位页没有加载出来（白屏），已在窗口里写明原因");
    },
    sleep: async (ms) => {
      guard();
      await sleep(ms);
      await refreshUrl();
    },
    evaluate: (code) => driver.evaluate(site, code, 8_000),
    click: async (selectors, label, clickOptions) => {
      guard();
      const hit = await driver.click(site, selectors, label ?? "", {
        labelSelectors: clickOptions?.labelSelectors ?? [],
        scriptFallback: clickOptions?.scriptFallback === true,
      });
      await refreshUrl();
      return hit;
    },
    type: async (selectors, value, typeOptions) => {
      guard();
      const filled = await driver.fill(site, selectors, value, { enter: typeOptions?.enter === true });
      await refreshUrl();
      return filled;
    },
    blocker: async (blockerOptions) => {
      const kind = await driver.blocker(site, { ignoreLoginText: blockerOptions?.ignoreLoginText === true });
      await refreshUrl();
      return kind;
    },
    hasLoginDialog: () => driver.hasLoginDialog(site),
    bodyText: async () => {
      const body = await driver.body(site);
      await refreshUrl();
      return body;
    },
    currentUrl: () => currentUrl,
    shot,
    upload: (selectors, files) => driver.upload(site, selectors, files),
    log: (message) => {
      log(message);
      // 批量投递是后台模式，用户盯着窗口看不出程序在做什么，至少窗口标题能说明卡在哪一步。
      void driver.title(site, `若道 · ${jobSiteLabel(site)}｜${text(message, 36)}`).catch(() => undefined);
    },
  };
  return { applyDriver, lastUrl: () => currentUrl };
}

/**
 * 前程无忧投递前把岗位地址校正成真正的详情页（jobs.51job.com/{city}/{jobId}.html）。
 *
 * 卡片 DOM 里只有公司主页链接，`we.51job.com/pc/jobdetail?jobId=` 是前端路由，
 * 未登录会被踢到登录页、登录后也经常整页空白。这里在已登录的 we.51job.com
 * 页面里用职位号问一次平台接口，换到 jobHref 再打开。
 */
async function resolveJob51ApplyJob(
  driver: BrowserDriver,
  job: AutoApplyJob,
  log: (message: string) => void,
): Promise<AutoApplyJob | null> {
  const direct = normalizeJob51DetailUrl(job.sourceUrl);
  if (direct) return direct === job.sourceUrl ? job : { ...job, sourceUrl: direct };
  const jobId = job51JobIdOf(job.jobId) || job51JobIdOf(job.sourceUrl);
  if (!jobId) return null;
  if (await driver.isClosed("job51").catch(() => true)) return null;
  // 接口必须在 we.51job.com 同源页面里执行：未登录时首页会被踢到 login.51job.com，
  // 从登录页跨域请求会被 WAF 拦成验证页，所以统一落到公开可访问的搜索页。
  const current = await driver.url("job51").catch(() => "");
  if (!/^https?:\/\/we\.51job\.com\//i.test(current)) {
    const searchUrl = JOB_SITES.job51.searchUrl(text(job.title, 20) || "java", "", 1);
    await driver.goto("job51", searchUrl, { attempts: 1 }).catch((error: any) => {
      log(`打开前程无忧搜索页失败：${text(error?.message ?? error, 120)}`);
    });
    await driver.waitContent("job51", 8_000).catch(() => false);
  }
  // 反查脚本自带一次重试，比默认 8 秒的 evaluate 放宽到 14 秒，避免慢网下误判成拿不到。
  const looked = await driver.evaluate<string>("job51", job51LookupScript(jobId), 14_000).catch(() => "");
  const href = normalizeJob51DetailUrl(looked);
  if (!href) {
    log(`没有换到岗位 ${jobId} 的详情页地址`);
    return null;
  }
  log(`已换成前程无忧岗位详情页：${href}`);
  return { ...job, jobId, sourceUrl: href };
}

/**
 * 在猎聘 / 智联 / 前程无忧 详情页直接投递平台在线简历。
 *
 * 业务判断全部留在插件：入口探测、确认弹窗、附件简历、聊一聊兜底、
 * 投递后的按钮状态复核都在 `submitResume` 里；这里只负责窗口状态与结果收口。
 */
export async function applyJobSite(
  engine: JobSiteSearchEngine,
  driver: BrowserDriver,
  input: JobSiteApplyInput,
): Promise<JobSiteApplyResult> {
  const site = input.job.source;
  if (!supportsSiteApply(site)) {
    throw new Error(`${jobSiteLabel(site)} 不支持直接投递简历`);
  }
  const screenshots: string[] = [];
  const closed = await driver.isClosed(site).catch(() => true);
  if (closed) {
    return {
      state: "failed",
      message: "招聘平台窗口已关闭，无法继续投递。重新打开窗口后可重试",
      screenshots,
      blockedReason: "窗口已关闭",
      successText: "",
      finalUrl: "",
      entryText: "",
    };
  }
  await driver.reveal(site, input.reveal ?? "focus").catch(() => undefined);
  const { applyDriver, lastUrl } = createApplyDriver({
    driver,
    site,
    evidenceDir: input.evidenceDir,
    log: input.log,
    signal: input.signal,
  });
  try {
    input.log(`正在打开${jobSiteLabel(site)}岗位页投递`);
    const job = site === "job51" ? await resolveJob51ApplyJob(driver, input.job, input.log) : input.job;
    if (!job) {
      const file = await applyDriver.shot("apply-bad-url").catch(() => "");
      if (file) screenshots.push(file);
      // 换不到详情页地址时先分清是「被踢到登录页」还是「记录本身没地址」。
      const blocked = await driver.blocker(site).catch(() => "" as const);
      if (blocked) {
        engine.markBlocked(site, blocked, blocked === "verification"
          ? "前程无忧要求人机验证，请在招聘窗口里完成验证后重试投递"
          : "前程无忧岗位详情页没有登录态，本次没有提交简历");
        await driver.reveal(site, "focus").catch(() => undefined);
        const opened = blocked === "login" ? await driver.openLogin(site).catch(() => false) : false;
        input.log(blocked === "verification" ? "岗位页要求人机验证，已把窗口显示到前台" : "岗位页没有登录态，已把窗口显示到前台");
        return {
          state: "blocked",
          message: blocked === "verification"
            ? "前程无忧要求人机验证，请在招聘窗口里完成验证后重试投递"
            : `前程无忧登录态已失效，没有提交简历。${opened ? "已经把窗口显示到前台并打开登录入口，" : "已经把这个窗口显示到前台，"}登录完成后回到岗位池重新点「投递」`,
          screenshots,
          blockedReason: blocked === "verification" ? "需要人机验证" : "需要登录",
          successText: "",
          finalUrl: await driver.url(site).catch(() => lastUrl()),
          entryText: "",
        };
      }
      return {
        state: "needs_user",
        message: "没能拿到这个岗位的前程无忧详情页地址（记录里只有公司主页或搜索页链接）。请在招聘窗口里重新搜索一次这个岗位，再点投递",
        screenshots,
        blockedReason: "岗位链接不是详情页",
        successText: "",
        finalUrl: await driver.url(site).catch(() => lastUrl()),
        entryText: "",
      };
    }
    const result = await submitResume(applyDriver, job, {
      resumeFilePath: input.resumeFilePath,
      greeting: input.greeting,
    });
    screenshots.push(...result.screenshots);
    if (input.signal?.aborted) {
      return {
        ...result,
        state: "failed",
        message: "投递已中止（批量任务被停止，或招聘窗口被关闭）",
        screenshots,
        blockedReason: "已中止",
      };
    }
    // 登录态缺失是最常被忽略的一步：直接把登录入口摆到窗口里，并写清「登录后怎么继续」。
    if (result.blockedReason === "需要登录") {
      await driver.reveal(site, "focus").catch(() => undefined);
      const opened = await driver.openLogin(site).catch(() => false);
      input.log(opened ? "岗位页没有登录态，已把窗口显示到前台并打开登录入口" : "岗位页没有登录态，已把窗口显示到前台，请登录后重试");
      const file = await applyDriver.shot("apply-login-wall").catch(() => "");
      if (file) screenshots.push(file);
      engine.markBlocked(site, "login", `${jobSiteLabel(site)}岗位详情页没有登录态，本次没有提交简历`);
      const next = site === "job51"
        // 51job 登录页带着原岗位地址，登录完会自己跳回岗位页；再说「回岗位池重搜」会误导人。
        ? "登录后会回到这个岗位页，重新点「投递」就能继续"
        : "登录完成后回到岗位池重新点「投递」";
      return {
        ...result,
        state: "blocked",
        message: `${result.message}。${opened ? "已经把窗口显示到前台并打开登录入口。" : "已经把这个窗口显示到前台。"}${next}；如果是批量投递，这一批已经停下来了，登录后点「继续」就能接着投剩下的岗位`,
        screenshots,
        blockedReason: "需要登录",
        finalUrl: await driver.url(site).catch(() => lastUrl()),
      };
    }
    // 登录墙和验证码是两种不同的阻断，文案与后续操作都不一样，别一律标成验证码。
    if (result.state === "blocked") {
      engine.markBlocked(site, blockedKindFromReason(result.blockedReason) || "login", result.message);
      await driver.reveal(site, "focus").catch(() => undefined);
      input.log("本次投递被平台阻断，已把窗口显示到前台，请处理后重试");
    } else {
      engine.markBlocked(site, "", result.message);
    }
    return { ...result, screenshots };
  } catch (error: any) {
    const aborted = input.signal?.aborted === true;
    return {
      state: aborted ? "needs_user" : "failed",
      message: aborted
        ? "投递已中止（批量任务被停止，或招聘窗口被关闭），请到平台确认是否已投出"
        : `${jobSiteLabel(site)}投递失败：${text(error?.message ?? error, 300)}`,
      screenshots,
      blockedReason: aborted ? "已中止" : text(error?.message ?? error, 200),
      successText: "",
      finalUrl: await driver.url(site).catch(() => lastUrl()),
      entryText: "",
    };
  }
}

/** 51job 投递成功页判据，供服务层在记录核对时复用。 */
export { isCompanyPageUrl, isJob51ApplySuccessUrl };
