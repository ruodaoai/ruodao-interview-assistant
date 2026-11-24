import type { JobSiteId } from "./job-sites/types";

export function extractionScript(site: JobSiteId) {
  return `(() => {
    const siteId = ${JSON.stringify(site)};
    const clean = (value, max = 300) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, max);
    const attrText = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const value = clean(node?.textContent, 200);
        if (value) return value;
      }
      return "";
    };
    const collected = [];
    // 平台卡片会写「3 天前发布 / 更新于 2026-09-12」，但 class 每天在变：
    // 统一按文案特征取，取到就带上，取不到留空（不能编一个日期）。
    const postedOf = (value) => {
      const matched = String(value || "").replace(/\s+/g, " ").match(/(?:发布|更新|刷新)(?:时间|日期|于)?\s*[：:]?\s*(?:\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?|今天|今日|昨天|昨日|前天|刚刚|\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前))/);
      if (matched) return matched[0].slice(0, 40);
      const trailing = String(value || "").replace(/\s+/g, " ").match(/\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)(?:发布|更新|刷新)/);
      return trailing ? trailing[0].slice(0, 40) : "";
    };
    const push = (raw) => {
      if (!raw.title || raw.title.length < 2 || /登录|注册|下载APP/.test(raw.title)) return;
      collected.push(raw);
    };

    if (siteId === "boss") {
      const cards = [...document.querySelectorAll("li.job-card-box, .job-card-wrapper, .job-card-box")];
      for (const card of cards) {
        const link = card.querySelector('a.job-name[href*="/job_detail/"], a[href*="/job_detail/"]');
        const title = clean(link?.textContent) || attrText(card, [".job-name", ".job-title"]);
        const tags = [...card.querySelectorAll(".tag-list li, [class*='tag-list'] li, .job-tags span")]
          .map((node) => clean(node.textContent, 40)).filter(Boolean);
        push({
          title,
          // 当前 Boss 卡片把公司名放在 span.boss-name，城市在 span.company-location。
          company: attrText(card, ["span.boss-name", ".boss-name", ".company-name", ".company-info h3", "[class*='company-name']"]),
          city: attrText(card, ["span.company-location", ".job-area", "[class*='job-area']"]),
          salary: attrText(card, [".salary", "[class*='salary']"]),
          url: link?.getAttribute("href") || "",
          tags,
          // 列表卡片通常不展示 HR 姓名，公司名不能再误填到招聘者一栏。
          recruiter: attrText(card, [".info-public em", "[class*='info-public'] em"]),
          recruiterActive: attrText(card, [".boss-active-time", "[class*='active-time']", "[class*='boss-active']"]),
          postedText: postedOf(card.textContent),
          extra: clean(card.textContent, 500),
        });
      }
      return collected;
    }

    if (siteId === "liepin") {
      const cards = [...document.querySelectorAll('div[class*="jobCardPcContainer"]')];
      for (const card of cards) {
        const link = card.querySelector('a[data-nick="job-detail-job-info"], a[href*="/job/"]');
        const title = clean(link?.querySelector(".ellipsis-1")?.textContent) || clean(link?.textContent);
        const bodyText = clean(card.textContent, 800);
        const active = bodyText.match(/当前在线|今日活跃|刚刚活跃|\\d+\\s*小时前(?:在线|活跃)|\\d+\\s*天前(?:在线|活跃)|本周活跃|本月活跃|半年前活跃|\\d+\\s*个?月前活跃|\\d+\\s*年前活跃/)?.[0] ?? "";
        const tags = [...card.querySelectorAll('[class*="labels"] span, [class*="tags"] span, .tag-list span')]
          .map((node) => clean(node.textContent, 40)).filter(Boolean);
        const city = bodyText.match(/【([^】]+)】/)?.[1] ?? attrText(card, ["[class*='job-dq']", "[class*='address']"]);
        push({
          title,
          company: attrText(card, ["[class*='companyName']", "[class*='company-name']"]),
          city,
          salary: attrText(card, ["[class*='job-salary']", "[class*='salary']"]) || bodyText.match(/\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?\\s*[kK万](?:·\\d+薪)?/)?.[0] || "",
          url: link?.getAttribute("href") || "",
          tags,
          recruiter: attrText(card, ["[class*='recruiterName']", "[class*='recruiter-name']"]),
          recruiterActive: active,
          postedText: postedOf(bodyText),
          extra: bodyText,
        });
      }
      return collected;
    }

    if (siteId === "job51") {
      const cards = [...document.querySelectorAll(".joblist-item")];
      // 卡片里唯一带 href 的链接是公司主页（a.comp → jobs.51job.com/all/coXXXX.html），
      // 岗位标题只是 span.jname。卡片的「投递」按钮跳转的才是 jobs.51job.com/{city}/{id}.html，
      // 那条地址页面接口里有、DOM 里没有，所以这里只把职位号带出去交给 service 层补齐。
      const companyHref = (href) => /\\/all\\/co|\\/pc\\/comp|\\/company|jobs\\.51job\\.com\\/all\\//i.test(String(href || ""));
      const jobHrefOf = (card) => {
        for (const anchor of card.querySelectorAll("a[href]")) {
          const href = anchor.getAttribute("href") || "";
          if (!href || companyHref(href)) continue;
          if (/jobs\\.51job\\.com\\/[a-z0-9-]+\\/\\d{5,}\\.html/i.test(href)) return href;
        }
        return "";
      };
      for (const card of cards) {
        let data = {};
        const nodes = [card, ...card.querySelectorAll("[sensorsdata]")];
        for (const node of nodes) {
          try {
            const parsed = JSON.parse(node.getAttribute("sensorsdata") || "null");
            if (parsed && typeof parsed === "object") {
              data = parsed;
              break;
            }
          } catch { /* 有些节点带非 JSON 埋点 */ }
        }
        const jobId = clean(data.jobId || data.jobid || card.getAttribute("data-jobid"));
        const url = jobHrefOf(card);
        // 既没有岗位详情地址、又没有职位号的卡片没法投，直接丢；
        // 只有职位号的保留，service 层会用页面接口返回的 jobHref 补成真实详情页。
        if (!url && !jobId) continue;
        const companyLink = card.querySelector("a.comp, .comp");
        const industry = [...card.querySelectorAll(".comp .dc")].map((node) => clean(node.textContent, 60)).filter(Boolean);
        const tags = [...card.querySelectorAll(".tag, [class*='tag'] span")]
          .map((node) => clean(node.textContent, 40)).filter(Boolean);
        push({
          jobId,
          title: clean(data.jobTitle || data.jobName || data.title) || attrText(card, [".jname", ".job-title", "[class*='jobTitle']"]),
          company: clean(data.companyName || data.company) || attrText(card, [".cname", "a.comp .cname", "[class*='cname']"]),
          city: clean(data.jobArea || data.area),
          salary: clean(data.jobSalary || data.salary),
          url,
          tags,
          recruiter: attrText(card, [".hr-name", "[class*='hr-name']"]),
          recruiterActive: "",
          companyIndustry: industry[0] || "",
          companyScale: industry.find((entry) => /人$|以上/.test(entry)) || "",
          postedText: postedOf(card.textContent),
          extra: clean(companyLink?.textContent, 300) + " " + clean(card.textContent, 400),
        });
      }
      return collected;
    }

    const cards = [...document.querySelectorAll(".job-card, div[class*='joblist-box__item'], .joblist-box__item")];
    for (const card of cards) {
      // 新版智联卡片既没有岗位链接、薪资也是「**-**元」掩码；
      // 明文数据挂在卡片的 __vue__.$props.job 上，优先用它，DOM 只做兜底。
      const job = card.__vue__?.$props?.job || {};
      const detail = job.jobDetailData?.position || {};
      const desc = detail.desc || {};
      const staff = job.staffCard || {};
      const date = detail.date || {};
      const link = card.querySelector('a[href*="/jobdetail/"], a[href*="jobs.zhaopin.com"], a[class*="jobinfo__name"]');
      const tags = [
        ...(Array.isArray(desc.labels) ? desc.labels : []),
        ...(Array.isArray(job.jobSkillTags) ? job.jobSkillTags.map((entry) => entry?.name || entry) : []),
        ...(Array.isArray(job.welfareLabel) ? job.welfareLabel : []),
        clean(job.education, 40),
        clean(job.workingExp, 40),
      ].map((entry) => clean(entry, 40)).filter(Boolean);
      push({
        jobId: clean(job.number),
        title: clean(job.name) || clean(link?.textContent) || attrText(card, ["[class*='jobinfo__name']", "[class*='job-title']", ".job-card__title-main"]),
        company: clean(job.companyName) || attrText(card, ["[class*='companyinfo__name']", "[class*='company-name']", ".job-card__company-name"]),
        city: [
          clean(job.workCity, 40),
          clean(job.cityDistrict, 40),
          clean(job.tradingArea, 40),
        ].filter(Boolean).join("·") || attrText(card, ["[class*='jobinfo__other-info-item']", "[class*='job-area']", ".job-card__location"]),
        salary: clean(job.salary60) || attrText(card, ["[class*='jobinfo__salary']", "[class*='salary']", ".job-card__salary"]),
        url: clean(job.positionURL || job.positionUrl) || link?.getAttribute("href") || "",
        tags,
        recruiter: clean(staff.staffName) || attrText(card, ["[class*='companyinfo__staff-name']", "[class*='recruiter']", "[class*='hr-name']"]),
        recruiterActive: clean(staff.hrStateInfo) || attrText(card, ["[class*='companyinfo__staff-state']"]),
        recruiterTitle: clean(staff.hrJob),
        companyIndustry: clean(job.industryName),
        companyScale: clean(job.companySize),
        companyStage: clean(job.financingStage),
        postedText: clean(date.positionUpdateTimeText) || postedOf(card.textContent),
        extra: [
          clean(job.industryName, 80),
          clean(job.companySize, 40),
          clean(job.jobDescription, 500),
        ].filter(Boolean).join(" "),
      });
    }
    return collected;
  })()`;
}

export function probeScript(site: JobSiteId) {
  return `(() => {
    const selectors = ${JSON.stringify({
      boss: ["li.job-card-box", ".job-card-wrapper", ".job-card-box"],
      liepin: ['div[class*="jobCardPcContainer"]'],
      zhaopin: [".job-card", 'div[class*="joblist-box__item"]', ".joblist-box__item"],
      job51: [".joblist-item"],
    }[site])};
    let cards = 0;
    for (const selector of selectors) cards += document.querySelectorAll(selector).length;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  })()`;
}

export function detailScript(site: JobSiteId) {
  return `(() => {
    const siteId = ${JSON.stringify(site)};
    const selectors = {
      boss: [".job-sec-text", ".job-detail-section", ".job-detail"],
      liepin: [".job-intro-container", ".job-qualifications", "[class*='job-description']", "[class*='job-intro']"],
      zhaopin: ["[class*='describtion']", "[class*='job-detail']", "[class*='position-detail']", "[class*='job-description']", "[class*='jobdetail']"],
      job51: ["[class*='job-detail']", "[class*='jobDesc']", ".job-item-main"],
    }[siteId] || [];
    const clean = (value) => value.replace(/\\s+/g, " ").trim();
    const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const body = nodes.map((node) => clean(node.textContent ?? "")).filter((entry) => entry.length > 20).join("\\n");
    const fallback = clean(document.querySelector("main")?.textContent ?? "").slice(0, 8000);
    const recruiter = clean(document.querySelector('[class*="boss-info-attr"], [class*="recruiter-name"], [class*="hr-name"], [class*="boss-info"] .name')?.textContent ?? "").slice(0, 60);
    const active = clean(document.querySelector('[class*="active-time"], [class*="boss-active"]')?.textContent ?? "").slice(0, 40);
    const postedNode = [...document.querySelectorAll('[class*="publish"], [class*="update-time"], [class*="job-time"], [class*="pub-time"], [class*="refresh"], [class*="release"]')]
      .map((node) => clean(node.textContent ?? ""))
      .find((value) => value && value.length <= 60 && /(发布|更新|刷新)/.test(value));
    return { text: (body || fallback).slice(0, 12000), recruiter, active, posted: postedNode ?? "" };
  })()`;
}

export function postedScript() {
  return `(() => {
    const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    for (const element of document.querySelectorAll('[class*="publish"], [class*="update-time"], [class*="job-time"], [class*="pub-time"], [class*="refresh"], [class*="release"]')) {
      const text = clean(element.textContent);
      if (text && text.length <= 60 && /(发布|更新|刷新)/.test(text)) return text;
    }
    const body = clean(document.body?.innerText ?? "");
    const matched = body.match(/(?:发布|更新|刷新)(?:时间|日期|于)?\\s*[：:]?\\s*(?:\\d{4}\\s*[-/年.]\\s*\\d{1,2}\\s*[-/月.]\\s*\\d{1,2}|\\d{1,4}\\s*(?:分钟|小时|天|周|个?月|年)\\s*(?:前|以前|之前))/);
    return matched ? matched[0].slice(0, 40) : "";
  })()`;
}

/**
 * 在 Boss 页面上下文里请求列表接口。
 *
 * 必须在页面里发：`__zp_stoken__` 等风控字段是页面脚本写入的，Node 侧直接请求会被判环境异常。
 * 只发与页面自身完全相同的一组表单参数，不添加任何未公开的排序 / 筛选参数。
 */
export function bossApiFetchScript(form: string) {
  return `(async () => {
    try {
      const response = await fetch("/wapi/zpgeek/search/joblist.json?_=" + Date.now(), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: ${JSON.stringify(form)},
      });
      const raw = await response.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* 非 JSON（登录页 HTML / 风控页） */ }
      return { status: response.status, ok: response.ok, json, raw: json ? "" : raw.slice(0, 300) };
    } catch (error) {
      return { status: 0, ok: false, json: null, raw: String((error && error.message) || error).slice(0, 300) };
    }
  })()`;
}

/**
 * 在前程无忧页面上下文里请求列表接口。
 *
 * 搜索页忽略 URL 里的 pageNum，页面自己的翻页按钮走的就是这个接口；
 * 这里在已打开的页面上用同一组分页参数请求，登录态和风控字段都由页面自己带。
 */
export function job51ApiFetchScript(url: string) {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, {
        method: "GET",
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      const raw = await response.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* 登录页 / 访问验证 HTML */ }
      return { status: response.status, ok: response.ok, json, raw: json ? "" : raw.slice(0, 300) };
    } catch (error) {
      return { status: 0, ok: false, json: null, raw: String((error && error.message) || error).slice(0, 300) };
    }
  })()`;
}