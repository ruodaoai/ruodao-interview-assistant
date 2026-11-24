import type { JobSiteId } from "./job-sites/types";

/**
 * 插件持有的浏览器驱动。
 *
 * 招聘平台的业务逻辑全部在这个包里；宿主只实现下面这些通用动作：
 * 开窗、导航、执行页面脚本、等待渲染、监听接口、输入、上传、截图。
 * 所有调用都带站点名，宿主按白名单决定能不能落在招聘平台窗口上。
 */
export type BrowserHostCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export type BrowserTab = "main" | "aux";
export type RevealMode = "focus" | "visible" | "background";
export type BlockedKind = "login" | "verification" | "";
export type LoginState = "in" | "out" | "";

export type BrowserDriver = {
  call: BrowserHostCall;
  statusAll(): Promise<any[]>;
  status(site: JobSiteId): Promise<any>;
  isClosed(site: JobSiteId, tab?: BrowserTab): Promise<boolean>;
  tokenState(site: JobSiteId): Promise<LoginState>;
  open(site: JobSiteId): Promise<any>;
  close(site: JobSiteId): Promise<any>;
  refresh(): Promise<any[]>;
  openAux(site: JobSiteId): Promise<void>;
  closeAux(site: JobSiteId): Promise<void>;
  goto(site: JobSiteId, url: string, options?: { tab?: BrowserTab; attempts?: number }): Promise<{ ok: boolean; url: string }>;
  evaluate<T = unknown>(site: JobSiteId, code: string, timeoutMs?: number, tab?: BrowserTab): Promise<T | undefined>;
  waitContent(site: JobSiteId, timeoutMs?: number, tab?: BrowserTab): Promise<boolean>;
  captureStart(site: JobSiteId, pattern: string, tab?: BrowserTab): Promise<string>;
  captureStop(token: string, timeoutMs?: number): Promise<any[]>;
  blocker(site: JobSiteId, options?: { ignoreLoginText?: boolean }): Promise<BlockedKind>;
  loginState(site: JobSiteId): Promise<LoginState>;
  openLogin(site: JobSiteId): Promise<boolean>;
  hasLoginDialog(site: JobSiteId): Promise<boolean>;
  body(site: JobSiteId, tab?: BrowserTab): Promise<string>;
  url(site: JobSiteId, tab?: BrowserTab): Promise<string>;
  title(site: JobSiteId, text: string): Promise<void>;
  reveal(site: JobSiteId, mode: RevealMode): Promise<void>;
  click(site: JobSiteId, selectors: string[], label?: string, options?: { labelSelectors?: string[]; scriptFallback?: boolean }): Promise<boolean>;
  fill(site: JobSiteId, selectors: string[], value: string, options?: { enter?: boolean }): Promise<boolean>;
  pressKey(site: JobSiteId, key: string): Promise<void>;
  upload(site: JobSiteId, selectors: string[], files: string[]): Promise<boolean>;
  /** 页面没有文件输入、只能点按钮弹出选择框时，由宿主接管选择框并注入文件。 */
  chooseFile(site: JobSiteId, triggerSelectors: string[], file: string): Promise<boolean>;
  screenshot(site: JobSiteId, file: string): Promise<string>;
};

export function createBrowserDriver(hostCall: BrowserHostCall): BrowserDriver {
  // 打开窗口 / 加载页面会包含「等内容 + 重试」，比普通脚本调用慢得多；
  // 这里按动作给出明确上限，避免插件服务反过来把宿主的慢操作提前判成失败。
  const call = (method: string, params: Record<string, unknown>, timeoutMs: number) => hostCall(method, params, timeoutMs);
  const site = (value: JobSiteId) => ({ site: value });

  return {
    call: hostCall,
    async statusAll() {
      const result = await call("browser.statusAll", {}, 20_000);
      return Array.isArray(result?.items) ? result.items : [];
    },
    status: (value) => call("browser.status", site(value), 20_000),
    isClosed: (value, tab) => call("browser.isClosed", { ...site(value), tab }, 20_000),
    tokenState: (value) => call("browser.tokenState", site(value), 20_000),
    open: (value) => call("browser.open", site(value), 300_000),
    close: (value) => call("browser.close", site(value), 30_000),
    async refresh() {
      const result = await call("browser.refresh", {}, 90_000);
      return Array.isArray(result?.items) ? result.items : [];
    },
    async openAux(value) {
      await call("browser.openAux", site(value), 30_000);
    },
    async closeAux(value) {
      await call("browser.closeAux", site(value), 30_000);
    },
    goto: (value, url, options = {}) => call("browser.goto", { ...site(value), url, tab: options.tab, attempts: options.attempts }, 210_000),
    evaluate: <T>(value: JobSiteId, code: string, timeoutMs = 8_000, tab?: BrowserTab) =>
      call("browser.evaluate", { ...site(value), code, timeoutMs, tab }, timeoutMs + 15_000) as Promise<T | undefined>,
    waitContent: (value, timeoutMs = 12_000, tab) => call("browser.waitContent", { ...site(value), timeoutMs, tab }, timeoutMs + 15_000),
    async captureStart(value, pattern, tab) {
      const result = await call("browser.capture.start", { ...site(value), pattern, tab }, 30_000);
      return String(result?.token ?? "");
    },
    async captureStop(token, timeoutMs = 2_500) {
      if (!token) return [];
      const result = await call("browser.capture.stop", { token, timeoutMs }, timeoutMs + 20_000);
      return Array.isArray(result?.payloads) ? result.payloads : [];
    },
    blocker: (value, options = {}) => call("browser.blocker", { ...site(value), ignoreLoginText: options.ignoreLoginText === true }, 30_000),
    loginState: (value) => call("browser.loginState", site(value), 30_000),
    openLogin: (value) => call("browser.openLogin", site(value), 60_000),
    hasLoginDialog: (value) => call("browser.hasLoginDialog", site(value), 20_000),
    body: (value, tab) => call("browser.body", { ...site(value), tab }, 30_000).then((text) => String(text ?? "")),
    url: (value, tab) => call("browser.url", { ...site(value), tab }, 20_000).then((url) => String(url ?? "")),
    async title(value, textValue) {
      await call("browser.title", { ...site(value), text: textValue }, 20_000);
    },
    async reveal(value, mode) {
      await call("browser.reveal", { ...site(value), mode }, 20_000);
    },
    click: (value, selectors, label = "", options = {}) =>
      call("browser.click", { ...site(value), selectors, label, labelSelectors: options.labelSelectors, scriptFallback: options.scriptFallback === true }, 30_000),
    fill: (value, selectors, textValue, options = {}) =>
      call("browser.fill", { ...site(value), selectors, value: textValue, enter: options.enter === true }, 30_000),
    async pressKey(value, key) {
      await call("browser.pressKey", { ...site(value), key }, 20_000);
    },
    upload: (value, selectors, files) => call("browser.upload", { ...site(value), selectors, files }, 30_000),
    chooseFile: (value, selectors, file) => call("browser.chooseFile", { ...site(value), selectors, file }, 30_000),
    async screenshot(value, file) {
      const result = await call("browser.screenshot", { ...site(value), file }, 90_000);
      return result?.ok === true ? String(result.file ?? "") : "";
    },
  };
}
