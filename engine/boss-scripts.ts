/**
 * Boss 打招呼流程用到的页面脚本。
 *
 * 与主进程旧引擎保持一致：入口状态、开聊接口探针、输入框读写、气泡确认。
 * 这些脚本只观察和操作页面自己的控件，不额外发请求。
 */

/** Boss 聊天输入框选择器：新版「立即沟通」弹窗的输入框既没有 chat-input 类也不叫「消息」。 */
export const BOSS_CHAT_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[class*="chat-input"]',
  'div[contenteditable="true"][class*="chat-input"]',
  '.chat-input[contenteditable="true"]',
  '.chat-editor [contenteditable="true"]',
  'textarea[placeholder*="消息"]',
  '[contenteditable="true"][data-placeholder*="消息"]',
  ".startchat-dialog textarea.input-area",
  ".startchat-dialog .input-area",
  '.startchat-dialog [contenteditable="true"]',
];

export type BossChatState = {
  label: string;
  point: { x: number; y: number } | null;
  hasInput: boolean;
  /** 确认框 / 提示条 / 页面首尾的文本，用于识别「已向BOSS发送消息」和提取招呼正文。 */
  text: string;
  /** 页面脚本已经挂上 jQuery / Detail.startChat：此时点击才会被 Boss 处理。 */
  ready: boolean;
  /** 沟通入口自己的 data-url / 进行中状态。 */
  entry: { selector: string; dataUrl: string; redirectUrl: string; isFriend: boolean; busy: boolean } | null;
  /** 点击坐标是否真的落在入口上（被浮层盖住时为 false）。 */
  hitEntry: boolean;
  /** 新版开聊弹窗 startchat-dialog 已出现。 */
  startchatOpen: boolean;
  /** 弹窗里状态为「已发送」的招呼正文。 */
  sentText: string;
  /** 页面上的提醒 / 上限 / 无法投递对话框文字。 */
  remindText: string;
};

/** 一次读全 Boss 沟通入口需要的页面状态；只认真正的沟通入口，不碰页头「消息」链接。 */
export function bossChatStateScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelOf = (element) => String(element.innerText || element.textContent || "")
      .replace(/\\s+/g, "").trim();
    const selectors = ['a.btn-startchat', 'a.op-btn-chat', '[class*="btn-startchat"]', 'button[class*="startchat"]'];
    let entry = null;
    let entrySelector = "";
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const label = labelOf(element);
        if (!/立即沟通|继续沟通|打招呼/.test(label)) continue;
        element.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        entry = element;
        entrySelector = selector;
        break;
      }
      if (entry) break;
    }
    let point = null;
    let hitEntry = false;
    if (entry) {
      const rect = entry.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      point = { x: x, y: y };
      const hit = document.elementFromPoint(x, y);
      hitEntry = Boolean(hit && (hit === entry || entry.contains(hit)));
    }
    const hasInput = ${JSON.stringify(BOSS_CHAT_INPUT_SELECTORS)}
      .some((selector) => [...document.querySelectorAll(selector)].some(visible));
    const chunks = [];
    for (const selector of ['.greet-pop', '.greet-boss-pop', '[class*="greet-boss"]', '[class*="greet-pop"]', '[class*="toast"]', '[class*="dialog"]']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const value = String(element.innerText || "").trim();
        if (value) chunks.push(value.slice(0, 2000));
      }
    }
    const body = String(document.body?.innerText || "");
    chunks.push(body.slice(0, 1500), body.slice(-1500));
    const startchat = [...document.querySelectorAll('.startchat-dialog, .startchat-content')].find(visible) || null;
    let sentText = "";
    if (startchat) {
      for (const item of document.querySelectorAll('.startchat-dialog .message-item')) {
        const status = item.querySelector('.status');
        const statusText = String(status?.innerText || "").trim();
        const statusClass = String(status?.className || "");
        if (!/已发送|success/.test(statusText + " " + statusClass)) continue;
        const value = String(item.querySelector('.text')?.innerText || "").trim();
        if (value) { sentText = value.slice(0, 500); break; }
      }
      if (!sentText) {
        const greet = document.querySelector('.startchat-dialog #greet, .startchat-dialog .greet-con');
        if (greet) sentText = String(greet.innerText || "").trim().slice(0, 500);
      }
    }
    const remindNodes = [...document.querySelectorAll('.greet-pop, .greet-boss-pop, [class*="chat-remind"], [class*="remind-dialog"]')].filter(visible);
    const remindText = remindNodes.map((element) => String(element.innerText || "").trim()).filter(Boolean).join("\\n").slice(0, 1000);
    const classText = entry ? String(entry.className || "") : "";
    return {
      label: entry ? labelOf(entry) : "",
      point: point,
      hasInput: hasInput,
      text: chunks.join("\\n"),
      ready: Boolean(window.jQuery && window.Detail && typeof window.Detail.startChat === "function"),
      entry: entry ? {
        selector: entrySelector,
        dataUrl: String(entry.getAttribute("data-url") || "").slice(0, 500),
        redirectUrl: String(entry.getAttribute("redirect-url") || "").slice(0, 500),
        isFriend: entry.getAttribute("data-isfriend") === "true",
        busy: /btn-disabled|btn-loading/.test(classText),
      } : null,
      hitEntry: hitEntry,
      startchatOpen: Boolean(startchat),
      sentText: sentText,
      remindText: remindText,
    };
  })()`;
}

/** 在页面里旁路记录 Boss 开聊接口的回包；不额外发请求、不改页面行为。 */
export function bossGreetProbeInstallScript() {
  return `(() => {
    if (window.__ruodaoBossGreet && window.__ruodaoBossGreet.version === 1) {
      window.__ruodaoBossGreet.calls = [];
      window.__ruodaoBossGreet.installedAt = Date.now();
      return true;
    }
    const state = { version: 1, installedAt: Date.now(), calls: [] };
    window.__ruodaoBossGreet = state;
    const interesting = (url) => /\\/wapi\\/zpgeek\\/friend\\/(add|continuechat)\\.json|\\/wapi\\/zpchat\\/config\\/get/i.test(String(url || ""));
    const strip = (value) => String(value || "").replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
    const record = (url, method) => {
      const call = {
        api: String(url || "").split("?")[0],
        method: String(method || "GET").toUpperCase(),
        startedAt: Date.now(),
        endedAt: 0,
        status: 0,
        code: null,
        message: "",
        bizCode: null,
        greeting: "",
        remindTitle: "",
        remindContent: "",
      };
      state.calls.push(call);
      if (state.calls.length > 20) state.calls.shift();
      return call;
    };
    const complete = (call, status, text) => {
      if (!call || call.endedAt) return;
      call.endedAt = Date.now();
      call.status = Number(status) || 0;
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = null; }
      if (!data) return;
      call.code = typeof data.code === "number" ? data.code : null;
      call.message = strip(data.message).slice(0, 300);
      const zp = data.zpData || {};
      if (typeof zp.bizCode === "number") call.bizCode = zp.bizCode;
      if (zp.greeting) call.greeting = strip(zp.greeting).slice(0, 500);
      const remind = zp.bizData && zp.bizData.chatRemindDialog;
      if (remind) {
        call.remindTitle = strip(remind.title).slice(0, 120);
        call.remindContent = strip(remind.content).slice(0, 600);
      }
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ruodaoBossUrl = url;
      this.__ruodaoBossMethod = method;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const url = this.__ruodaoBossUrl;
      if (interesting(url)) {
        const call = record(url, this.__ruodaoBossMethod);
        this.addEventListener("loadend", () => {
          let text = "";
          try { text = this.responseText || ""; } catch (error) { text = ""; }
          complete(call, this.status, text);
        });
      }
      return originalSend.apply(this, arguments);
    };
    if (window.fetch) {
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (!interesting(url)) return originalFetch.apply(this, arguments);
        const call = record(url, (init && init.method) || "GET");
        return originalFetch.apply(this, arguments).then((response) => {
          try {
            response.clone().text().then((text) => complete(call, response.status, text)).catch(() => complete(call, 0, ""));
          } catch (error) { complete(call, response.status, ""); }
          return response;
        }, (error) => {
          complete(call, 0, "");
          throw error;
        });
      };
    }
    return true;
  })()`;
}

export function bossGreetProbeReadScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const state = window.__ruodaoBossGreet || null;
    const startchat = [...document.querySelectorAll('.startchat-dialog, .startchat-content')].find(visible) || null;
    let sentText = "";
    if (startchat) {
      for (const item of document.querySelectorAll('.startchat-dialog .message-item')) {
        const status = item.querySelector('.status');
        const statusText = String(status?.innerText || "").trim();
        const statusClass = String(status?.className || "");
        if (!/已发送|success/.test(statusText + " " + statusClass)) continue;
        const value = String(item.querySelector('.text')?.innerText || "").trim();
        if (value) { sentText = value.slice(0, 500); break; }
      }
    }
    const remindNodes = [...document.querySelectorAll('.greet-pop, .greet-boss-pop, [class*="chat-remind"], [class*="remind-dialog"]')].filter(visible);
    return {
      installed: Boolean(state),
      calls: state ? state.calls.slice(-10) : [],
      chatRemind: remindNodes.length > 0,
      remindText: remindNodes.map((element) => String(element.innerText || "").trim()).filter(Boolean).join("\\n").slice(0, 1000),
      startchatOpen: Boolean(startchat),
      sentText: sentText,
    };
  })()`;
}

/** 直接触发入口元素的原生 click：用于确认页面处理器是否真的绑上了。 */
export function bossDomGreetScript() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelOf = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "").trim();
    for (const selector of ['a.btn-startchat', 'a.op-btn-chat', '[class*="btn-startchat"]', 'button[class*="startchat"]']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || !/立即沟通|继续沟通|打招呼/.test(labelOf(element))) continue;
        if (element.hasAttribute("disabled") || /btn-disabled|btn-loading/.test(String(element.className || ""))) return false;
        element.scrollIntoView({ block: "center", behavior: "instant" });
        element.click();
        return true;
      }
    }
    return false;
  })()`;
}

/** 页面处理器没响应时，直接调用 Boss 自己的 Detail.startChat（同样走页面 jQuery，带齐风控头）。 */
export function bossDirectGreetScript() {
  return `(() => {
    if (!window.jQuery || !window.Detail || typeof window.Detail.startChat !== "function") return false;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelOf = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "").trim();
    for (const selector of ['a.btn-startchat', 'a.op-btn-chat', '[class*="btn-startchat"]', 'button[class*="startchat"]']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || !/立即沟通|继续沟通|打招呼/.test(labelOf(element))) continue;
        if (element.hasAttribute("disabled") || /btn-disabled|btn-loading/.test(String(element.className || ""))) return false;
        try {
          window.Detail.startChat(window.jQuery(element), "", { loginSuccess: function () {} });
          return true;
        } catch (error) {
          return false;
        }
      }
    }
    return false;
  })()`;
}

export function bossChatInputPresentScript() {
  return `(() => {
    const selectors = ${JSON.stringify(BOSS_CHAT_INPUT_SELECTORS)};
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const selector of selectors) {
      if ([...document.querySelectorAll(selector)].some(visible)) return selector;
    }
    return "";
  })()`;
}

export function bossInputTextScript() {
  return `(() => {
    const selectors = ${JSON.stringify(BOSS_CHAT_INPUT_SELECTORS)};
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        return "value" in element ? String(element.value ?? "") : String(element.innerText ?? element.textContent ?? "");
      }
    }
    return "";
  })()`;
}

/** 通用驱动没有剪贴板权限，这里用页面自己的输入框写入（与主进程的 fillInputScript 相同）。 */
export function bossFillInputScript(value: string) {
  return `(() => {
    const selectors = ${JSON.stringify(BOSS_CHAT_INPUT_SELECTORS)};
    const value = ${JSON.stringify(value)};
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        element.focus();
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(element, value); else element.value = value;
        } else {
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(range);
          const inserted = document.execCommand("insertText", false, value);
          if (!inserted) element.textContent = value;
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  })()`;
}

/** 聊天气泡里是否真的出现了这段招呼，不依赖输入框是否被清空。 */
export function bossSentBubbleScript(probe: string) {
  return `(() => {
    const probe = ${JSON.stringify(probe)};
    if (probe.length < 4) return false;
    const nodes = [...document.querySelectorAll("[class*='message'], [class*='msg'], [class*='chat-content'], [class*='chat-item']")];
    return nodes.some((element) => String(element.textContent || "").replace(/\\s+/g, "").includes(probe));
  })()`;
}

export const BOSS_SEND_BUTTON_SELECTORS = [
  'button[type="send"]',
  ".send-message",
  '[class*="send-btn"]',
  '[class*="btn-send"]',
  '[class*="send-button"]',
];

export const BOSS_IMAGE_SELECTORS = [
  '[aria-label="发送图片"]',
  '[aria-label*="图片"]',
  '[title*="图片"]',
  '[class*="send-image"]',
  '[class*="btn-image"]',
  '[class*="toolbar"] [class*="image"]',
];

export const BOSS_IMAGE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"][accept*="png"]',
  'input[type="file"][accept*="jpg"]',
  'input[type="file"]',
];
