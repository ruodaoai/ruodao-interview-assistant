/**
 * 招聘平台「挡住投递」的两类判定：需要登录、需要人机验证。
 *
 * 单独拆成纯函数模块的原因：这套判定曾经把「未登录时页面上的短信验证码登录框」
 * 当成「人机验证」，导致批量投递既没提示登录、也不停下来等人处理（用户 10-31 反馈）。
 * 判定规则必须能被单元测试直接覆盖，不能埋在 Electron 窗口代码里。
 */

/**
 * 真正的平台风控 / 人机验证：只认这些明确的反爬文案。
 *
 * 刻意不匹配裸的「验证码」：51job / 智联 未登录时的登录浮层里就有
 * 「短信验证码 / 发送验证码」，把它当成人机验证会让用户按提示去找一个不存在的验证码。
 */
export const VERIFY_PATTERN = /Security Verification|正在验证连接安全性|Protected by Tencent Cloud EdgeOne|人机验证|滑块验证|请完成验证|按住滑块|拖动到最右边|访问验证|访问过于频繁|checking your browser|verify you are human|图形验证码|请输入验证码后继续/i;

export const LOGIN_URL_PATTERN = /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i;

/** 登录墙文案：登录浮层里的「短信验证码 / 发送验证码」属于登录，不是人机验证。 */
export const LOGIN_TEXT_PATTERN = /扫码登录|手机号登录|密码登录|账号登录|短信验证码登录|发送验证码|登录后查看|登录后继续|请先登录|请登录后|登录\/注册|立即登录/;

/** 页面上真实存在的登录表单 / 登录浮层选择器（点了投递按钮才弹出来的那种也要能抓到）。 */
export const LOGIN_DIALOG_SELECTORS = [
  'input[type="password"]',
  'input[placeholder*="手机号"]',
  'input[placeholder*="账号"]',
  'iframe[src*="login"]',
  'iframe[src*="passport"]',
  '[class*="login-dialog"]',
  '[class*="loginDialog"]',
  '[class*="login-modal"]',
  '[class*="loginModal"]',
  '[class*="login-pop"]',
  '[id*="loginModal"]',
];

export type BlockedKind = "login" | "verification" | "";

export type BlockedOptions = {
  /**
   * 忽略正文里的「登录/注册」等软文案，只按登录页地址 / 人机验证判定。
   *
   * 前程无忧的岗位详情页（jobs.51job.com）匿名时页头和侧栏常驻登录组件，
   * 正文里一定有「登录/注册 / 短信验证码」。如果把这种软文案当成登录墙，
   * 投递会在点「立即投递」之前就被判死——用户明明已经登录搜索页也会被告知
   * 「点投递就要登录」。真正的登录墙要等点了投递、平台跳到 login.51job.com
   * 之后才认（见 apply.ts 的点击后复检）。
   */
  ignoreLoginText?: boolean;
};

export function classifyBlocked(url: string, body: string, options: BlockedOptions = {}): BlockedKind {
  if (VERIFY_PATTERN.test(body)) return "verification";
  if (LOGIN_URL_PATTERN.test(url)) return "login";
  if (!options.ignoreLoginText && LOGIN_TEXT_PATTERN.test(body)) return "login";
  // 只剩一句「验证码」、页面上又没有登录 / 注册要素时，才按人机验证处理。
  if (/验证码/.test(body) && !/登录|注册/.test(body)) return "verification";
  return "";
}

/** 页面登录态：in = 已登录，out = 需要登录，"" = 判断不出来（绝不猜成已登录）。 */
export type LoginState = "in" | "out" | "";

/**
 * 从投递结果的原因反推平台阻断类型。
 *
 * 只有明确提到登录 / 人机验证才算「撞墙」。像「未检测到发送成功提示」这种
 * 单条没拿到回执的情况必须返回空字符串——把它当成登录墙会让状态栏一直谎报
 * 「需要登录」，用户去登录又发现本来就是登录的（用户 11-01 反馈）。
 */
export function blockedKindFromReason(reason: string): BlockedKind {
  const value = String(reason ?? "");
  if (/人机验证|验证码|滑块|滑动验证|安全验证|请完成验证|拖动.*验证/.test(value)) return "verification";
  if (/需要登录|未登录|登录态|登录后|请先登录|请登录/.test(value)) return "login";
  return "";
}

const LOGIN_OUT_LABELS = /^(登录|登录\/注册|登录注册|立即登录|注册)$/;
const LOGIN_IN_LABELS = /退出登录|我的简历|在线简历|我的51job|个人中心|我的账户|切换账号/;

/**
 * 平台的登录令牌 cookie：登录后才下发，匿名时没有。
 *
 * Boss 匿名访问搜索页同样会显示「登录/注册 / 立即登录」（实测匿名也会返回岗位），
 * 页面文案只能说明「摆着登录入口」，不能说明现在没登录；登录令牌才是真实登录态。
 * 未收录的平台 / 没有令牌时返回 ""（判断不出来绝不猜）。
 */
const LOGIN_COOKIE_NAMES: Partial<Record<string, RegExp>> = {
  boss: /^(wt2|zp_token)$/,
  // 智联新版列表自己的 store 就是看 cookiesData.at / rt 判断登录；
  // 页面登录后头像入口可能只剩图标、没有「退出登录」文案，只有这两个令牌可靠。
  zhaopin: /^(at|rt)$/,
};

export function loginStateFromCookies(site: string, cookieNames: string[]): LoginState {
  const pattern = LOGIN_COOKIE_NAMES[site];
  if (!pattern) return "";
  const found = cookieNames.some((name) => pattern.test(String(name ?? "").trim()));
  return found ? "in" : "";
}

export function loginStateFromLabels(labels: string[]): LoginState {
  let sawOut = false;
  for (const raw of labels) {
    const label = String(raw ?? "").replace(/\s+/g, "").trim();
    if (!label) continue;
    // 页面可能同时保留「登录」入口和「我的简历/退出登录」入口，
    // 只要有明确的用户入口就优先判为已登录，避免把正常页面误报成登录墙。
    if (LOGIN_IN_LABELS.test(label)) return "in";
    if (LOGIN_OUT_LABELS.test(label)) sawOut = true;
  }
  return sawOut ? "out" : "";
}
