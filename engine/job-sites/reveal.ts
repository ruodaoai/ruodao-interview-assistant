// 招聘窗口的显隐策略。
// 手动搜索/单个打招呼要主动把窗口弹到最前，用户才知道浏览器在动；
// 批量投递默认也把窗口显示出来（不抢键盘焦点），用户能直接看到投递过程、扫码登录；
// 只有用户主动关掉「显示浏览器窗口」后才回到纯后台：窗口一律藏起来，
// 绝不 show()/restore()/focus()。页面脚本、计时器和证据截图在隐藏窗口下仍然工作
// （webPreferences.backgroundThrottling = false，截图走 CDP 强制出新帧）。
// 抽成纯函数便于单测——真实 BrowserWindow 的焦点归属在 e2e 里没法稳定断言。

export interface RevealableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  hide(): void;
  focus(): void;
  moveTop(): void;
}

/** focus：弹到最前并抢焦点；visible：显示但不抢焦点；background：彻底藏起来。 */
export type JobWindowRevealMode = "focus" | "visible" | "background";

export function revealJobWindow(
  win: RevealableWindow | null | undefined,
  mode: JobWindowRevealMode = "focus",
): boolean {
  if (!win || win.isDestroyed()) return false;
  if (mode === "focus") {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }
  if (mode === "visible") {
    // 用户自己最小化了窗口就尊重它，不能每投一个岗位又弹回来。
    if (win.isMinimized()) return true;
    // 只在「刚显示出来」时置顶；之后用户把窗口拖到哪里就停在哪里，不能每条岗位都抢视线。
    if (!win.isVisible()) {
      win.showInactive();
      win.moveTop();
    }
    return true;
  }
  // 可见或最小化都收起来；已经隐藏时 hide 是空操作。
  if (win.isVisible() || win.isMinimized()) win.hide();
  return true;
}

/** 批量投递的显示策略：用户没有关掉「显示浏览器窗口」时保持可见（不抢焦点）。 */
export function batchRevealMode(showBrowserWindow: boolean | undefined): JobWindowRevealMode {
  return showBrowserWindow === false ? "background" : "visible";
}