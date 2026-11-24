import {
  bossChatListScript,
  job51RecordsScript,
  parseBossChatContacts,
  parseJob51AppliedRecords,
  zhaopinMessageProbeScript,
  zhaopinMessageUrlScript,
} from "./job-engine.mjs";

const BOSS_CHAT_URL = "https://www.zhipin.com/web/geek/chat";
const BOSS_CHAT_URL_FALLBACK = "https://www.zhipin.com/web/chat/index";
const JOB51_APPLY_RECORDS_URL = "https://i.51job.com/userset/my_apply.php?type=social";
const LOGIN_URL_PATTERN = /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function text(value, max = 1000) {
  return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}

/**
 * 平台投递记录读取（Boss 消息列表 / 前程无忧社会申请 / 智联消息）。
 *
 * 只用已经打开的窗口读页面，不新开窗口、不调接口、不绕过登录或人机验证；
 * 找不到时只返回「无法确认」，绝不反推「没投出去」。
 * 窗口打开与关闭仍由插件编排层按需调用 host 的通用浏览器能力。
 */
export function createMessageRecords(driver, log = () => {}) {
  async function readBossChatList(options = {}) {
    const capturedAt = Date.now();
    const result = (patch) => ({
      ok: false,
      state: "failed",
      message: "",
      url: "",
      contacts: [],
      complete: false,
      oldestAt: 0,
      capturedAt,
      blocked: "",
      ...patch,
    });
    const status = await driver.status("boss").catch(() => null);
    if (!status?.open) return result({ state: "closed", message: "Boss 窗口已经关闭，无法读取消息记录" });
    const urlOf = () => driver.url("boss").catch(() => "");
    const bodyOf = () => driver.body("boss").catch(() => "");
    const currentUrl = await urlOf();
    const currentBlocked = await driver.blocker("boss").catch(() => "");
    if (currentBlocked) {
      return result({
        state: "blocked",
        blocked: currentBlocked,
        url: currentUrl,
        message: currentBlocked === "login" ? "Boss 需要先登录才能读取消息记录" : "Boss 要求人机验证，无法读取消息记录",
      });
    }
    const isGeekChat = (url) => /zhipin\.com\/web\/geek\/chat/i.test(url);
    if (!isGeekChat(currentUrl)) {
      const loaded = await driver.goto("boss", BOSS_CHAT_URL, { attempts: 1 })
        .then((entry) => entry?.ok !== false)
        .catch((error) => {
          log(`boss chat list open failed: ${text(error?.message ?? error, 160)}`);
          return false;
        });
      if (!loaded) {
        const afterUrl = await urlOf();
        const blocked = await driver.blocker("boss").catch(() => "");
        if (blocked) {
          return result({
            state: "blocked",
            blocked,
            url: afterUrl,
            message: blocked === "login" ? "Boss 需要先登录才能读取消息记录" : "Boss 要求人机验证，无法读取消息记录",
          });
        }
        return result({ state: "failed", url: afterUrl, message: `Boss 求职者消息页没有加载出来（当前 ${String(afterUrl).split("?")[0].slice(0, 100)}）` });
      }
      await sleep(1_500);
    }
    const maxRounds = Math.max(1, Math.min(12, Math.round(options.maxRounds ?? 8)));
    const rawItems = [];
    const seen = new Set();
    let bottomReached = false;
    let pageText = "";
    let lastUrl = await urlOf();
    let stagnant = 0;
    let sawList = false;
    let sawContainer = false;
    let lastDebug = "";
    const collect = async (scroll) => {
      const probe = await driver.evaluate("boss", bossChatListScript({ scroll, maxItems: 120 })).catch(() => null);
      if (!probe) return null;
      lastUrl = probe.url || lastUrl;
      pageText = probe.pageText || pageText;
      sawList = sawList || probe.listFound;
      sawContainer = sawContainer || probe.listContainer;
      if (probe.debug) lastDebug = JSON.stringify(probe.debug).slice(0, 600);
      for (const item of Array.isArray(probe.items) ? probe.items : []) {
        const key = String(item ?? "").replace(/\s+/g, "").slice(0, 260);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rawItems.push(String(item));
      }
      bottomReached = probe.bottomReached === true;
      return probe;
    };
    const blockedBy = async (probe) => {
      const blocked = await driver.blocker("boss").catch(() => "");
      if (!blocked) return null;
      return result({
        state: "blocked",
        blocked,
        url: lastUrl,
        message: blocked === "login" ? "Boss 需要先登录才能读取消息记录" : "Boss 要求人机验证，无法读取消息记录",
      });
    };
    // 求职者消息页是 SPA：冷启动时先等列表容器出现，不能只睡 1.2 秒就断言没有联系人。
    for (let wait = 0; wait < 24; wait += 1) {
      const probe = await collect(false);
      if (!probe) {
        await sleep(750);
        continue;
      }
      const blockedResult = await blockedBy(probe);
      if (blockedResult) return blockedResult;
      if (sawList || sawContainer) break;
      await sleep(750);
    }
    if (!sawList && !sawContainer && isGeekChat(lastUrl)) {
      const fallbackLoaded = await driver.goto("boss", BOSS_CHAT_URL_FALLBACK, { attempts: 1 })
        .then((entry) => entry?.ok !== false)
        .catch((error) => {
          log(`boss chat list fallback open failed: ${text(error?.message ?? error, 160)}`);
          return false;
        });
      if (fallbackLoaded) {
        await sleep(1_500);
        for (let wait = 0; wait < 16; wait += 1) {
          const probe = await collect(false);
          if (!probe) {
            await sleep(750);
            continue;
          }
          const blockedResult = await blockedBy(probe);
          if (blockedResult) return blockedResult;
          if (sawList || sawContainer) break;
          await sleep(750);
        }
      }
    }
    for (let round = 0; round < maxRounds; round += 1) {
      if (await driver.isClosed("boss").catch(() => true)) {
        return result({ state: "closed", url: await urlOf(), message: "Boss 窗口在读取消息记录时被关闭" });
      }
      const before = rawItems.length;
      const probe = await collect(round < maxRounds - 1);
      if (!probe) {
        await sleep(700);
        continue;
      }
      const blockedResult = await blockedBy(probe);
      if (blockedResult) return blockedResult;
      const added = rawItems.length - before;
      stagnant = added > 0 ? 0 : stagnant + 1;
      if (bottomReached) break;
      if (!probe.scrolled) {
        bottomReached = true;
        break;
      }
      if (stagnant >= 2) break;
      await sleep(700);
    }
    const contacts = parseBossChatContacts(rawItems, capturedAt);
    const oldestAt = contacts.reduce((oldest, contact) => (
      contact.at > 0 && (!oldest || contact.at < oldest) ? contact.at : oldest
    ), 0);
    const since = Math.max(0, Number(options.since) || 0);
    const complete = bottomReached || (since > 0 && oldestAt > 0 && oldestAt <= since);
    if (!contacts.length) {
      const shortUrl = String(lastUrl).split("?")[0].slice(0, 100);
      const detail = `${shortUrl}，正文 ${pageText.length} 字${sawContainer ? "，列表容器存在但没有联系人项" : "，未找到联系人列表容器"}`;
      log(`boss chat list empty: ${detail} ${lastDebug}`);
      return result({
        state: "failed",
        url: lastUrl,
        complete,
        message: sawList
          ? "Boss 消息页列表里没有解析出联系人记录，页面结构可能变了"
          : `Boss 消息页没有读到联系人列表（${detail}）`,
      });
    }
    const message = `已读取 Boss 消息记录 ${contacts.length} 条${complete ? "" : "（列表未覆盖到本批开始时间）"}`;
    log(`read ${contacts.length} boss chat contacts (complete=${complete}, oldest=${oldestAt})`);
    return { ok: true, state: "ok", message, url: lastUrl, contacts, complete, oldestAt, capturedAt, blocked: "" };
  }

  async function readJob51AppliedRecords() {
    const capturedAt = Date.now();
    const result = (patch) => ({
      ok: false,
      state: "failed",
      message: "",
      url: "",
      records: [],
      capturedAt,
      blocked: "",
      ...patch,
    });
    const status = await driver.status("job51").catch(() => null);
    if (!status?.open) return result({ state: "closed", message: "前程无忧窗口已经关闭，无法读取申请记录" });
    const urlOf = () => driver.url("job51").catch(() => "");
    const currentUrl = await urlOf();
    if (LOGIN_URL_PATTERN.test(currentUrl)) {
      return result({ state: "blocked", blocked: "login", url: currentUrl, message: "前程无忧需要先登录才能读取申请记录" });
    }
    if (await driver.blocker("job51").catch(() => "") === "verification") {
      return result({ state: "blocked", blocked: "verification", url: currentUrl, message: "前程无忧要求人机验证，无法读取申请记录" });
    }
    const loaded = await driver.goto("job51", JOB51_APPLY_RECORDS_URL, { attempts: 1 })
      .then((entry) => entry?.ok !== false)
      .catch((error) => {
        log(`job51 apply records open failed: ${text(error?.message ?? error, 160)}`);
        return false;
      });
    if (!loaded) {
      const afterUrl = await urlOf();
      const blocked = await driver.blocker("job51").catch(() => "");
      if (blocked) {
        return result({
          state: "blocked",
          blocked,
          url: afterUrl,
          message: blocked === "login" ? "前程无忧需要先登录才能读取申请记录" : "前程无忧要求人机验证，无法读取申请记录",
        });
      }
      return result({ state: "failed", url: afterUrl, message: `前程无忧申请记录页没有加载出来（当前 ${String(afterUrl).split("?")[0].slice(0, 100)}）` });
    }
    await sleep(1_200);
    let probe = null;
    let lastUrl = await urlOf();
    let records = [];
    for (let round = 0; round < 14; round += 1) {
      if (await driver.isClosed("job51").catch(() => true)) {
        return result({ state: "closed", url: await urlOf(), message: "前程无忧窗口在读取申请记录时被关闭" });
      }
      probe = (await driver.evaluate("job51", job51RecordsScript()).catch(() => null)) ?? null;
      if (probe) {
        lastUrl = probe.debug?.url || lastUrl;
        records = parseJob51AppliedRecords(probe.items, capturedAt);
        const blocked = await driver.blocker("job51").catch(() => "");
        if (blocked === "verification") {
          return result({ state: "blocked", blocked: "verification", url: lastUrl, message: "前程无忧要求人机验证，无法读取申请记录" });
        }
        if (blocked === "login" && !records.length) {
          return result({ state: "blocked", blocked: "login", url: lastUrl, message: "前程无忧需要先登录才能读取申请记录" });
        }
        if (records.length) break;
        if (probe.listFound) break;
      }
      await sleep(700);
    }
    if (!records.length) {
      const shortUrl = String(lastUrl).split("?")[0].slice(0, 100);
      return result({
        state: "failed",
        url: lastUrl,
        message: probe?.listFound
          ? "前程无忧申请记录页里没有解析出投递记录，页面结构可能变了"
          : `前程无忧申请记录页没有读到投递记录（${shortUrl}）`,
      });
    }
    const message = `已读取前程无忧申请记录 ${records.length} 条`;
    log(`read ${records.length} job51 apply records`);
    return { ok: true, state: "ok", message, url: lastUrl, records, capturedAt, blocked: "" };
  }

  async function readZhaopinMessages() {
    const capturedAt = Date.now();
    const result = (patch) => ({
      ok: false,
      state: "failed",
      message: "",
      url: "",
      items: [],
      body: "",
      capturedAt,
      blocked: "",
      ...patch,
    });
    const status = await driver.status("zhaopin").catch(() => null);
    if (!status?.open) return result({ state: "closed", message: "智联窗口已经关闭，无法读取消息记录" });
    const urlOf = () => driver.url("zhaopin").catch(() => "");
    const currentUrl = await urlOf();
    const currentBlocked = await driver.blocker("zhaopin").catch(() => "");
    if (currentBlocked) {
      return result({
        state: "blocked",
        blocked: currentBlocked,
        url: currentUrl,
        message: currentBlocked === "login" ? "智联需要先登录才能读取消息记录" : "智联要求人机验证，无法读取消息记录",
      });
    }
    const isMessagePage = (url) => /zhaopin\.com\/(?:[^/?#]+\/)*message(?:[/?#]|$)/i.test(url);
    if (!isMessagePage(currentUrl)) {
      const fromNav = String(await driver.evaluate("zhaopin", zhaopinMessageUrlScript()).catch(() => "") ?? "").trim();
      const target = /^https:\/\/(?:[\w-]+\.)*zhaopin\.com\//i.test(fromNav) ? fromNav : "";
      if (target) {
        const loaded = await driver.goto("zhaopin", target, { attempts: 1 })
          .then((entry) => entry?.ok !== false)
          .catch((error) => {
            log(`zhaopin message open failed: ${text(error?.message ?? error, 160)}`);
            return false;
          });
        if (!loaded) {
          const afterUrl = await urlOf();
          const blocked = await driver.blocker("zhaopin").catch(() => "");
          if (blocked) {
            return result({
              state: "blocked",
              blocked,
              url: afterUrl,
              message: blocked === "login" ? "智联需要先登录才能读取消息记录" : "智联要求人机验证，无法读取消息记录",
            });
          }
          return result({ state: "failed", url: afterUrl, message: `智联消息页没有加载出来（当前 ${String(afterUrl).split("?")[0].slice(0, 100)}）` });
        }
      } else {
        // 页头「消息」是 SPA 路由，href 往往是首页；只能点入口。
        const clicked = await driver.click("zhaopin", [], "^消息\\d*\\+?$", {
          labelSelectors: ["a", "button", "[role='button']", "div", "span"],
        }).catch(() => false);
        if (!clicked) {
          return result({ state: "failed", url: currentUrl, message: "没能打开智联消息页（页头没有可点的「消息」入口）" });
        }
        log("zhaopin message entry clicked");
      }
      await sleep(1_800);
    }
    let lastUrl = await urlOf();
    let lastBody = "";
    let items = [];
    for (let round = 0; round < 16; round += 1) {
      if (await driver.isClosed("zhaopin").catch(() => true)) {
        return result({ state: "closed", url: await urlOf(), message: "智联窗口在读取消息记录时被关闭" });
      }
      const probe = await driver.evaluate("zhaopin", zhaopinMessageProbeScript()).catch(() => null);
      if (probe) {
        lastUrl = probe.url || lastUrl;
        lastBody = probe.body || lastBody;
        const seen = new Set();
        items = [];
        for (const raw of Array.isArray(probe.items) ? probe.items : []) {
          const value = String(raw ?? "").replace(/\s+/g, " ").trim();
          if (value.length < 6 || seen.has(value)) continue;
          seen.add(value);
          items.push(value);
          if (items.length >= 120) break;
        }
        const blocked = await driver.blocker("zhaopin").catch(() => "");
        if (blocked === "verification") {
          return result({ state: "blocked", blocked: "verification", url: lastUrl, message: "智联要求人机验证，无法读取消息记录" });
        }
        if (blocked === "login" && !items.length) {
          return result({ state: "blocked", blocked: "login", url: lastUrl, message: "智联需要先登录才能读取消息记录" });
        }
        if (items.length) break;
      }
      await sleep(800);
    }
    if (!items.length) {
      const shortUrl = String(lastUrl).split("?")[0].slice(0, 100);
      return result({
        state: "failed",
        url: lastUrl,
        body: lastBody,
        message: `智联消息页没有读到会话记录（${shortUrl}）`,
      });
    }
    const message = `已读取智联消息记录 ${items.length} 条`;
    log(`read ${items.length} zhaopin messages`);
    return { ok: true, state: "ok", message, url: lastUrl, items, body: lastBody, capturedAt, blocked: "" };
  }

  return { readBossChatList, readJob51AppliedRecords, readZhaopinMessages };
}
