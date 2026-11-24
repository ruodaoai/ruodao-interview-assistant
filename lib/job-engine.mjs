import { randomUUID } from "node:crypto";
//#region ../../plugins/interview-assistant/engine/driver.ts
function createBrowserDriver(hostCall) {
	const call = (method, params, timeoutMs) => hostCall(method, params, timeoutMs);
	const site = (value) => ({ site: value });
	return {
		call: hostCall,
		async statusAll() {
			const result = await call("browser.statusAll", {}, 2e4);
			return Array.isArray(result?.items) ? result.items : [];
		},
		status: (value) => call("browser.status", site(value), 2e4),
		isClosed: (value, tab) => call("browser.isClosed", {
			...site(value),
			tab
		}, 2e4),
		tokenState: (value) => call("browser.tokenState", site(value), 2e4),
		open: (value) => call("browser.open", site(value), 3e5),
		close: (value) => call("browser.close", site(value), 3e4),
		async refresh() {
			const result = await call("browser.refresh", {}, 9e4);
			return Array.isArray(result?.items) ? result.items : [];
		},
		async openAux(value) {
			await call("browser.openAux", site(value), 3e4);
		},
		async closeAux(value) {
			await call("browser.closeAux", site(value), 3e4);
		},
		goto: (value, url, options = {}) => call("browser.goto", {
			...site(value),
			url,
			tab: options.tab,
			attempts: options.attempts
		}, 21e4),
		evaluate: (value, code, timeoutMs = 8e3, tab) => call("browser.evaluate", {
			...site(value),
			code,
			timeoutMs,
			tab
		}, timeoutMs + 15e3),
		waitContent: (value, timeoutMs = 12e3, tab) => call("browser.waitContent", {
			...site(value),
			timeoutMs,
			tab
		}, timeoutMs + 15e3),
		async captureStart(value, pattern, tab) {
			const result = await call("browser.capture.start", {
				...site(value),
				pattern,
				tab
			}, 3e4);
			return String(result?.token ?? "");
		},
		async captureStop(token, timeoutMs = 2500) {
			if (!token) return [];
			const result = await call("browser.capture.stop", {
				token,
				timeoutMs
			}, timeoutMs + 2e4);
			return Array.isArray(result?.payloads) ? result.payloads : [];
		},
		blocker: (value, options = {}) => call("browser.blocker", {
			...site(value),
			ignoreLoginText: options.ignoreLoginText === true
		}, 3e4),
		loginState: (value) => call("browser.loginState", site(value), 3e4),
		openLogin: (value) => call("browser.openLogin", site(value), 6e4),
		hasLoginDialog: (value) => call("browser.hasLoginDialog", site(value), 2e4),
		body: (value, tab) => call("browser.body", {
			...site(value),
			tab
		}, 3e4).then((text) => String(text ?? "")),
		url: (value, tab) => call("browser.url", {
			...site(value),
			tab
		}, 2e4).then((url) => String(url ?? "")),
		async title(value, textValue) {
			await call("browser.title", {
				...site(value),
				text: textValue
			}, 2e4);
		},
		async reveal(value, mode) {
			await call("browser.reveal", {
				...site(value),
				mode
			}, 2e4);
		},
		click: (value, selectors, label = "", options = {}) => call("browser.click", {
			...site(value),
			selectors,
			label,
			labelSelectors: options.labelSelectors,
			scriptFallback: options.scriptFallback === true
		}, 3e4),
		fill: (value, selectors, textValue, options = {}) => call("browser.fill", {
			...site(value),
			selectors,
			value: textValue,
			enter: options.enter === true
		}, 3e4),
		async pressKey(value, key) {
			await call("browser.pressKey", {
				...site(value),
				key
			}, 2e4);
		},
		upload: (value, selectors, files) => call("browser.upload", {
			...site(value),
			selectors,
			files
		}, 3e4),
		chooseFile: (value, selectors, file) => call("browser.chooseFile", {
			...site(value),
			selectors,
			file
		}, 3e4),
		async screenshot(value, file) {
			const result = await call("browser.screenshot", {
				...site(value),
				file
			}, 9e4);
			return result?.ok === true ? String(result.file ?? "") : "";
		}
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/boss-api.ts
/**
* Boss 的搜索列表 DOM 会对薪资做字体混淆，公司/城市选择器也随前端版本变化。
* 页面自己请求的 joblist.json / detail.json 里是明文数据，这里只做结构兼容映射，
* 不额外发请求，也不绕过登录或风控。
*/
function text$7(value, max = 400) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function firstText$2(...values) {
	for (const value of values) {
		const result = text$7(value, 400);
		if (result) return result;
	}
	return "";
}
function asList$2(value) {
	return Array.isArray(value) ? value : [];
}
function dataOf(payload) {
	return payload?.zpData ?? payload?.data ?? payload ?? {};
}
function bossJobListItems(payload) {
	const data = dataOf(payload);
	return asList$2(data?.jobList ?? data?.jobListData ?? data?.list ?? data?.jobs).filter((entry) => entry && typeof entry === "object");
}
function flag(value) {
	return value === true || Number(value) === 1 || value === "1";
}
function jobStatusOf(value) {
	if (value === void 0 || value === null || value === "") return {
		jobStatus: "",
		jobStatusText: ""
	};
	if (Number(value) === 1 || value === "1" || value === true) return {
		jobStatus: "open",
		jobStatusText: "平台标记在招"
	};
	if (Number(value) === 0 || value === "0" || value === false) return {
		jobStatus: "closed",
		jobStatusText: "平台标记已关闭"
	};
	return {
		jobStatus: "",
		jobStatusText: ""
	};
}
function jobUrl(jobId) {
	return jobId ? `https://www.zhipin.com/job_detail/${encodeURIComponent(jobId)}.html` : "";
}
/**
* Boss 搜索列表接口的表单体。
*
* Boss 的搜索页是 SPA：URL 上的 `page` 参数不会传给接口（实测无论 page=N 都发 page=1），
* 所以翻页必须在页面上下文里按同一套参数自己发。pageSize 平台固定截回 15。
*/
function bossSearchForm(input) {
	return new URLSearchParams({
		page: String(Math.max(1, Math.round(Number(input.page) || 1))),
		pageSize: String(15),
		city: String(input.cityCode ?? ""),
		expectInfo: "",
		query: String(input.keyword ?? ""),
		multiSubway: "",
		multiBusinessDistrict: "",
		position: "",
		jobType: "",
		salary: "",
		experience: "",
		degree: "",
		industry: "",
		scale: String(input.scale ?? ""),
		stage: "",
		scene: "1",
		encryptExpectId: ""
	}).toString();
}
/** 解析列表接口的外层状态：翻页时要区分「没有更多」和「登录/风控拦截」。 */
function bossPageInfo(payload) {
	const data = dataOf(payload);
	const rawCode = payload && typeof payload === "object" ? Number(payload.code) : 0;
	return {
		code: Number.isFinite(rawCode) ? rawCode : 0,
		message: firstText$2(payload?.message, payload?.msg, data?.message, data?.msg),
		total: Math.max(0, Math.round(Number(data?.totalCount ?? data?.total ?? 0) || 0)),
		count: bossJobListItems(payload).length
	};
}
/**
* Boss 列表接口非 0 返回码的分类。
*
* code 37「您的环境存在异常」是连续翻页触发的临时频控（未登录时更容易出现）：
* 搜索页本身完全正常，没有任何验证界面。以前按「异常」二字判成人机验证，
* 用户会被指去一个不存在的验证页面。
*/
function classifyBossPageFailure(code, message) {
	const value = text$7(message, 200);
	if (code === 0) return {
		blocked: "",
		stop: false,
		note: ""
	};
	if (/登录|login/i.test(value)) return {
		blocked: "login",
		stop: false,
		note: ""
	};
	if (/人机验证|滑块验证|请完成验证|按住滑块|拖动到最右边|图形验证码|验证码|Security Verification|正在验证连接安全性|Protected by Tencent Cloud EdgeOne|verify you are human|checking your browser/i.test(value)) return {
		blocked: "verification",
		stop: false,
		note: ""
	};
	if (code === 37 || /环境存在异常|访问过于频繁|操作过于频繁|请求过于频繁|访问频繁|稍后再试/i.test(value)) return {
		blocked: "",
		stop: true,
		note: `Boss 暂时限制了连续翻页${value ? `（平台提示：${value}）` : ""}；已加载的岗位都保留，等 1-2 分钟再点「继续加载」，或直接在 Boss 窗口里手动翻页。`
	};
	return {
		blocked: "",
		stop: true,
		note: `Boss 列表接口返回 code=${code}${value ? `：${value}` : ""}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`
	};
}
function mapBossListItem(item) {
	if (!item || typeof item !== "object") return null;
	const title = firstText$2(item.jobName, item.jobTitle, item.title);
	if (!title) return null;
	const jobId = firstText$2(item.encryptJobId, item.encryptJobID, item.jobId);
	const salary = firstText$2(item.salaryDesc, item.salary, item.salaryName);
	const city = [firstText$2(item.cityName, item.city), firstText$2(item.areaDistrict, item.area)].filter(Boolean).join("·");
	const recruiter = firstText$2(item.bossName, item.bossNickName, item.recruiterName);
	const recruiterTitle = firstText$2(item.bossTitle, item.bossPosition, item.recruiterTitle);
	const recruiterActive = firstText$2(item.bossActiveTimeDesc, item.activeTimeDesc, item.bossActiveDesc) || (flag(item.bossOnline) ? "当前在线" : "");
	const status = jobStatusOf(item.jobValidStatus);
	const companyIndustry = firstText$2(item.brandIndustry, item.industryName, item.companyIndustry);
	const companyStage = firstText$2(item.brandStageName, item.stageName);
	const companyScale = firstText$2(item.brandScaleName, item.scaleName);
	const tags = [
		...asList$2(item.jobLabels),
		...asList$2(item.skills),
		...asList$2(item.welfareList),
		flag(item.goldHunter) ? "猎头职位" : "",
		flag(item.proxyJob) ? "代招" : ""
	].map((entry) => text$7(entry, 40)).filter(Boolean);
	return {
		title,
		company: firstText$2(item.brandName, item.brandShortName, item.companyName),
		city,
		salary,
		url: jobUrl(jobId),
		tags,
		recruiter,
		recruiterActive,
		recruiterTitle,
		jobId,
		jobStatus: status.jobStatus,
		jobStatusText: status.jobStatusText,
		companyIndustry,
		companyStage,
		companyScale,
		anonymous: flag(item.anonymous),
		headhunter: flag(item.goldHunter),
		proxy: flag(item.proxyJob),
		extra: [
			companyIndustry,
			companyStage,
			companyScale,
			firstText$2(item.brandLabels?.join?.(" "))
		].filter(Boolean).join(" ").slice(0, 500)
	};
}
function stripHtml(value) {
	return String(value ?? "").replace(/<\s*br\s*\/?\s*>/gi, "\n").replace(/<\s*\/\s*(p|div|li)\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/g, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\u0000/g, "").trim();
}
function mapBossDetail(payload) {
	const data = dataOf(payload);
	const info = data?.jobInfo ?? data?.job ?? {};
	const boss = data?.bossInfo ?? data?.boss ?? {};
	const brand = data?.brandComInfo ?? data?.brand ?? {};
	const description = stripHtml(info.postDescription ?? info.description ?? data?.jobDetail?.description ?? data?.description);
	if (!info.jobName && !description) return null;
	const statusText = firstText$2(info.jobStatusDesc, info.jobStatusText, data?.jobStatusDesc);
	const status = jobStatusOf(info.jobValidStatus ?? data?.jobValidStatus);
	const inferredStatus = status.jobStatus || (/停止招聘|已关闭|已下线|暂停招聘|职位已失效/.test(statusText) ? "closed" : /在招|招聘中|热招/.test(statusText) ? "open" : "");
	const city = firstText$2(info.locationName) || [firstText$2(info.cityName, info.city), firstText$2(info.areaDistrict, info.area)].filter(Boolean).join("·");
	const salaryLabel = firstText$2(info.salaryDesc, info.salary);
	const salary = /^\d/.test(salaryLabel) ? parseSalary$1(salaryLabel) : {
		min: null,
		max: null,
		unit: ""
	};
	return {
		description,
		recruiter: firstText$2(boss.name, boss.bossName, boss.recruiterName),
		recruiterTitle: firstText$2(boss.title, boss.bossTitle, boss.position),
		recruiterActive: firstText$2(boss.activeTimeDesc, boss.bossActiveTimeDesc, boss.activeDesc),
		company: firstText$2(brand.brandName, brand.companyName, data?.brandName),
		companyIndustry: firstText$2(brand.industryName, brand.industry, data?.industryName),
		companyStage: firstText$2(brand.stageName, data?.stageName),
		companyScale: firstText$2(brand.scaleName, data?.scaleName),
		city,
		salaryLabel,
		salaryMin: salary.min,
		salaryMax: salary.max,
		salaryUnit: salary.unit,
		jobStatus: inferredStatus,
		jobStatusText: statusText || status.jobStatusText,
		jobId: firstText$2(info.encryptJobId, info.encryptId, info.jobId, data?.encryptJobId)
	};
}
function parseSalary$1(label) {
	const range = label.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)/);
	const numbers = range ? [Number(range[1]), Number(range[2])] : [];
	if (!numbers.length) return {
		min: null,
		max: null,
		unit: ""
	};
	const unit = /元\s*\/\s*(天|日)/.test(label) ? "元/天" : /(万|w)\s*\/?\s*年|年薪/.test(label) ? "万/年" : /[kK]|千/.test(label) ? "K/月" : /万|w/i.test(label) ? "万/月" : Math.max(...numbers) >= 1e3 ? "元/月" : "K/月";
	return {
		min: Math.min(...numbers),
		max: Math.max(...numbers),
		unit
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/blocker.ts
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
var VERIFY_PATTERN = /Security Verification|正在验证连接安全性|Protected by Tencent Cloud EdgeOne|人机验证|滑块验证|请完成验证|按住滑块|拖动到最右边|访问验证|访问过于频繁|checking your browser|verify you are human|图形验证码|请输入验证码后继续/i;
var LOGIN_URL_PATTERN = /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i;
/** 登录墙文案：登录浮层里的「短信验证码 / 发送验证码」属于登录，不是人机验证。 */
var LOGIN_TEXT_PATTERN = /扫码登录|手机号登录|密码登录|账号登录|短信验证码登录|发送验证码|登录后查看|登录后继续|请先登录|请登录后|登录\/注册|立即登录/;
function classifyBlocked(url, body, options = {}) {
	if (VERIFY_PATTERN.test(body)) return "verification";
	if (LOGIN_URL_PATTERN.test(url)) return "login";
	if (!options.ignoreLoginText && LOGIN_TEXT_PATTERN.test(body)) return "login";
	if (/验证码/.test(body) && !/登录|注册/.test(body)) return "verification";
	return "";
}
/**
* 从投递结果的原因反推平台阻断类型。
*
* 只有明确提到登录 / 人机验证才算「撞墙」。像「未检测到发送成功提示」这种
* 单条没拿到回执的情况必须返回空字符串——把它当成登录墙会让状态栏一直谎报
* 「需要登录」，用户去登录又发现本来就是登录的（用户 11-01 反馈）。
*/
function blockedKindFromReason(reason) {
	const value = String(reason ?? "");
	if (/人机验证|验证码|滑块|滑动验证|安全验证|请完成验证|拖动.*验证/.test(value)) return "verification";
	if (/需要登录|未登录|登录态|登录后|请先登录|请登录/.test(value)) return "login";
	return "";
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/dates.ts
/**
* 平台「发布时间 / 更新时间」解析。
*
* 这一层只做纯字符串换算，不发请求、不猜岗位状态：招聘平台的发布时间本身也可能是
* 「刷新续命」的结果，所以置信度由调用方（trust.ts）和本地首见时间交叉判断。
*/
var DAY$1 = 864e5;
var EMPTY = {
	at: null,
	label: ""
};
function startOfDay(timestamp) {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
function clamp$1(value, now) {
	return value > now ? startOfDay(now) : value;
}
/**
* 从「发布于 2026-09-12」「3 天前更新」「今天 10:23 刷新」「昨天」这类文案里取时间戳。
* 取不到就返回 at=null，绝不猜一个近似值。
*/
function parsePostedAt(raw, now = Date.now()) {
	const value = String(raw ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
	if (!value) return EMPTY;
	const scoped = value.match(/(?:发布|更新|刷新)(?:时间|日期|于)?\s*[：:]?\s*([^|，,；;]{1,24})/)?.[1]?.trim() ?? "";
	const head = /^(?:\d{4}\s*[-/年.]\s*\d{1,2}|今天|今日|昨天|昨日|前天|刚刚)/.test(value) ? value : "";
	const tail = value.match(/\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)(?:发布|更新|刷新)?/)?.[0] ?? "";
	const source = scoped || head || tail;
	if (!source) return EMPTY;
	if (/刚刚|秒前/.test(source)) return {
		at: now,
		label: value
	};
	if (/今天|今日/.test(source)) {
		const hm = source.match(/(\d{1,2})\s*[:点时]\s*(\d{1,2})/);
		if (hm) {
			const date = new Date(now);
			date.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
			return {
				at: clamp$1(date.getTime(), now),
				label: value
			};
		}
		return {
			at: startOfDay(now),
			label: value
		};
	}
	if (/昨天|昨日/.test(source)) return {
		at: startOfDay(now) - DAY$1,
		label: value
	};
	if (/前天/.test(source)) return {
		at: startOfDay(now) - 2 * DAY$1,
		label: value
	};
	const relative = source.match(/(\d{1,4})\s*(分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)/);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2];
		return {
			at: clamp$1(now - amount * (unit === "分钟" ? 6e4 : unit === "小时" ? 36e5 : unit === "天" ? DAY$1 : unit === "周" ? 7 * DAY$1 : unit === "年" ? 365 * DAY$1 : 30 * DAY$1), now),
			label: value
		};
	}
	const absolute = source.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
	if (absolute) {
		const date = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]));
		if (!Number.isNaN(date.getTime())) return {
			at: clamp$1(date.getTime(), now),
			label: value
		};
	}
	const monthDay = source.match(/^(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
	if (monthDay) {
		const month = Number(monthDay[1]);
		const day = Number(monthDay[2]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			const date = new Date(now);
			date.setMonth(month - 1, day);
			date.setHours(0, 0, 0, 0);
			if (Number.isNaN(date.getTime())) return EMPTY;
			if (date.getTime() > now + DAY$1) date.setFullYear(date.getFullYear() - 1);
			return {
				at: clamp$1(date.getTime(), now),
				label: value
			};
		}
	}
	return EMPTY;
}
/** 挂出天数：取整到天，未来时间归零。 */
function postedDays(at, now = Date.now()) {
	if (!at || !Number.isFinite(Number(at))) return null;
	return Math.max(0, Math.floor((now - Number(at)) / DAY$1));
}
/**
* 列表卡片文本里找「发布时间 / 更新时间」片段。
* 平台卡片结构经常变，用文案特征比用 class 更稳；找不到就返回空字符串。
*/
function extractPostedText(...values) {
	for (const value of values) {
		const body = String(value ?? "").replace(/\s+/g, " ");
		if (!body) continue;
		const after = body.match(/(?:发布|更新|刷新)(?:时间|日期|于)?\s*[：:]?\s*(?:\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日|今天|今日|昨天|昨日|前天|刚刚|\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前))/);
		if (after) return after[0].slice(0, 40);
		const before = body.match(/\d{1,4}\s*(?:分钟|小时|天|周|个?月|年)\s*(?:前|以前|之前)(?:发布|更新|刷新)/);
		if (before) return before[0].slice(0, 40);
	}
	return "";
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/job51-api.ts
/**
* 前程无忧（51job）列表旁路数据。
*
* 搜索卡片 DOM 里唯一带 href 的链接是**公司主页**（a.comp → jobs.51job.com/all/coXXXX.html），
* 岗位标题只是 span.jname。早先按「we.51job.com/pc/jobdetail?jobId=」去还原岗位页，
* 但那条是未登录会被踢到登录页、登录后也常常空白的前端路由，投递必然失败。
*
* 页面自己请求的 `/api/job/search-pc` 里每个岗位都带 `jobHref`
* （形如 https://jobs.51job.com/shenzhen-lgq/173482791.html），
* 这才是平台真正的服务端渲染详情页，也是「立即投递」按钮所在的页面。
* 这里只做结构兼容映射，不额外发请求，也不绕过登录或风控。
*/
function text$6(value, max = 400) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function asList$1(value) {
	return Array.isArray(value) ? value : [];
}
function firstText$1(...values) {
	for (const value of values) {
		const result = text$6(value, 400);
		if (result) return result;
	}
	return "";
}
function itemsOf(payload) {
	return asList$1((payload?.resultbody?.job ?? payload?.result?.job ?? payload?.data?.job ?? payload?.job)?.items ?? payload?.resultbody?.items ?? payload?.items).filter((entry) => entry && typeof entry === "object");
}
function job51SearchItems(payload) {
	return itemsOf(payload);
}
function job51PageInfo(payload) {
	const body = payload?.resultbody ?? payload?.result ?? payload?.data ?? payload ?? {};
	const job = body?.job ?? {};
	return {
		status: text$6(payload?.status ?? body?.status, 40),
		message: firstText$1(payload?.message, body?.message, payload?.msg),
		total: Math.max(0, Math.round(Number(job?.totalcount ?? job?.totalCount ?? 0) || 0)),
		count: job51SearchItems(payload).length,
		requestId: firstText$1(body?.requestId, payload?.requestId)
	};
}
/**
* 前程无忧第 2 页起的列表接口地址。
*
* 搜索页是 SPA，URL 里的 `pageNum` 只影响页面初始状态（前端固定从第 1 页开始），
* 直接重新打开 `we.51job.com/pc/search?...&pageNum=N` 永远返回第 1 页。
* 页面自己翻页时请求的是 `/api/job/search-pc`，这里用同一组分页参数在
* 已打开的前程无忧页面里请求；登录、验证码仍由页面自己上报。
*/
function job51SearchApiUrl(input) {
	return `https://we.51job.com/api/job/search-pc?${new URLSearchParams({
		api_key: "51job",
		timestamp: String(Math.floor(Date.now() / 1e3)),
		keyword: String(input.keyword ?? ""),
		searchType: "2",
		function: "",
		industry: "",
		jobArea: input.areaCode || "000000",
		jobArea2: "",
		landmark: "",
		metro: "",
		salary: "",
		workYear: "",
		degree: "",
		companyType: "",
		companySize: text$6(input.companySize, 10),
		jobType: "",
		issueDate: "",
		sortType: String(input.sortType ?? 0),
		pageNum: String(Math.max(1, Math.round(Number(input.page) || 1))),
		pageSize: "20",
		source: "1",
		pageCode: "sou|sou|soulb",
		scene: "7",
		accountId: "",
		requestId: text$6(input.requestId, 120)
	}).toString()}`;
}
/** 平台职位号：优先接口字段，其次从详情页地址里取。 */
function job51JobIdOf(value) {
	const raw = text$6(value, 300);
	if (/^\d{5,20}$/.test(raw)) return raw;
	const fromPath = raw.match(/\/(\d{5,20})\.html/i)?.[1] ?? "";
	if (fromPath) return fromPath;
	return raw.match(/[?&]jobId=(\d{5,20})/i)?.[1] ?? "";
}
/**
* 是否已经是 jobs.51job.com 的岗位详情页（服务端渲染、带「立即投递」按钮）。
* 公司主页（/all/coXXXX.html）、we.51job.com 前端路由都不算。
*/
function isJob51DetailUrl(value) {
	const raw = text$6(value, 500);
	if (!/^https?:\/\/jobs\.51job\.com\//i.test(raw)) return false;
	return /^https?:\/\/jobs\.51job\.com\/(?!all\/)[a-z0-9-]+\/\d{5,}\.html/i.test(raw);
}
/** 统一去掉跟踪参数，只留可长期复用的岗位地址；不是详情页时返回空字符串。 */
function normalizeJob51DetailUrl(value) {
	const raw = text$6(value, 500);
	if (!isJob51DetailUrl(raw)) return "";
	const match = raw.match(/^https?:\/\/jobs\.51job\.com\/([a-z0-9-]+)\/(\d{5,})\.html/i);
	return match ? `https://jobs.51job.com/${match[1].toLowerCase()}/${match[2]}.html` : raw;
}
/**
* 只有职位号、没有平台给的详情页地址时的兜底：用接口里的 hrefAreaPinYin 拼城市段。
* 城市段只影响面包屑，但 `/all/` 路径会被 51job 的访问验证拦住，所以宁可拼不出来
* 也不要用 all 去撞风控。
*/
function job51DetailUrl(jobId, areaPinYin) {
	const id = job51JobIdOf(jobId);
	const area = text$6(areaPinYin, 40).toLowerCase().replace(/[^a-z0-9-]/g, "");
	if (!id || !area || area === "all") return "";
	return `https://jobs.51job.com/${area}/${id}.html`;
}
function mapJob51ListItem(item) {
	if (!item || typeof item !== "object") return null;
	const title = firstText$1(item.jobName, item.jobTitle, item.title);
	const jobId = firstText$1(item.jobId, item.jobid);
	if (!title) return null;
	const href = normalizeJob51DetailUrl(item.jobHref) || job51DetailUrl(jobId, item.hrefAreaPinYin);
	if (!href) return null;
	const areaPinYin = text$6(item.hrefAreaPinYin, 40);
	const city = firstText$1(item.jobAreaString, item.jobArea, item.jobAreaLevelDetail?.cityString);
	const salary = firstText$1(item.provideSalaryString, item.jobSalaryString, item.jobSalary);
	const industry = firstText$1(item.industryType1Str, item.coIndustryText, item.companyIndustryType1Str);
	const tags = [
		...asList$1(item.jobTags),
		...asList$1(item.jobTagsForOrder),
		text$6(item.workYearString, 40),
		text$6(item.degreeString, 40)
	].map((entry) => text$6(entry, 40)).filter(Boolean);
	const online = item.hrIsOnline === true || item.isOnline === true || text$6(item.hrOnlineLabelStatus, 40);
	return {
		title,
		company: firstText$1(item.fullCompanyName, item.companyName, item.customerName),
		city: city || "",
		salary,
		url: href,
		tags: [...new Set(tags)].slice(0, 16),
		recruiter: firstText$1(item.hrName),
		recruiterTitle: firstText$1(item.hrPosition),
		recruiterActive: online ? firstText$1(item.hrOnlineLabelStatus) || "当前在线" : "",
		jobId: job51JobIdOf(jobId),
		jobStatus: item.isExpire === true || Number(item.isExpire) === 1 ? "closed" : "",
		jobStatusText: item.isExpire === true || Number(item.isExpire) === 1 ? "平台标记已关闭" : "",
		companyIndustry: industry,
		companyScale: firstText$1(item.companySizeString),
		companyStage: firstText$1(item.companyTypeString),
		postedText: firstText$1(item.issueDateString, item.updateDateTime),
		extra: [
			industry,
			text$6(item.companySizeString, 40),
			text$6(item.companyTypeString, 40),
			text$6(item.jobDescribe, 300),
			areaPinYin
		].filter(Boolean).join(" ").slice(0, 500)
	};
}
/** 按职位号反查详情页地址的接口（在已登录的 we.51job.com 搜索页里同源执行）。 */
function job51LookupScript(jobId) {
	return `(async () => {
    const jobId = ${JSON.stringify(String(jobId).replace(/\D/g, ""))};
    if (!jobId) return "";
    const url = "https://we.51job.com/api/job/search-pc?api_key=51job&timestamp=" + Date.now()
      + "&jobId=" + encodeURIComponent(jobId) + "&pageNum=1&pageSize=20&searchType=2&source=1";
    const read = async () => {
      try {
        const response = await fetch(url, { credentials: "include" });
        const body = await response.text();
        // 风控把接口拦成 HTML 验证页时不带任何岗位数据，直接当没拿到。
        if (!body.trimStart().startsWith("{")) return "";
        const payload = JSON.parse(body);
        const items = payload?.resultbody?.job?.items ?? [];
        const hit = items.find((entry) => String(entry?.jobId ?? "") === jobId) ?? items[0];
        return String(hit?.jobHref ?? "");
      } catch {
        return "";
      }
    };
    const first = await read();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return await read();
  })()`;
}
//#endregion
//#region ../../plugins/interview-assistant/engine/auto-apply/outsource.ts
var OUTSOURCE_TERMS = [
	"外包",
	"驻场",
	"外派",
	"派遣",
	"外协",
	"劳务",
	"人力资源服务",
	"人力资源外包",
	"招聘服务",
	"服务外包",
	"众包",
	"bpo"
];
function outsourceMatch(job) {
	const haystack = [
		job.title,
		job.company,
		job.companyIndustry,
		job.description,
		job.requirements,
		job.responsibilities,
		(job.tags ?? []).join(" "),
		job.skills.join(" ")
	].join(" ").toLowerCase();
	for (const term of OUTSOURCE_TERMS) {
		if (term === "bpo") {
			if (/(^|[^a-z])bpo([^a-z]|$)/.test(haystack)) return "BPO";
			continue;
		}
		if (haystack.includes(term)) return term;
	}
	return "";
}
function isOutsourceJob(job) {
	return outsourceMatch(job) !== "";
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/job51-cities.ts
var JOB51_CITY_CODES = {
	"北京": "010000",
	"上海": "020000",
	"广东省": "030000",
	"广州": "030200",
	"惠州": "030300",
	"汕头": "030400",
	"珠海": "030500",
	"佛山": "030600",
	"中山": "030700",
	"东莞": "030800",
	"韶关": "031400",
	"江门": "031500",
	"湛江": "031700",
	"肇庆": "031800",
	"清远": "031900",
	"潮州": "032000",
	"河源": "032100",
	"揭阳": "032200",
	"茂名": "032300",
	"汕尾": "032400",
	"梅州": "032600",
	"开平": "032700",
	"阳江": "032800",
	"云浮": "032900",
	"深圳": "040000",
	"天津": "050000",
	"重庆": "060000",
	"江苏省": "070000",
	"南京": "070200",
	"苏州": "070300",
	"无锡": "070400",
	"常州": "070500",
	"昆山": "070600",
	"常熟": "070700",
	"扬州": "070800",
	"南通": "070900",
	"镇江": "071000",
	"徐州": "071100",
	"连云港": "071200",
	"盐城": "071300",
	"张家港": "071400",
	"太仓": "071600",
	"泰州": "071800",
	"淮安": "071900",
	"宿迁": "072000",
	"浙江省": "080000",
	"杭州": "080200",
	"宁波": "080300",
	"温州": "080400",
	"绍兴": "080500",
	"金华": "080600",
	"嘉兴": "080700",
	"台州": "080800",
	"湖州": "080900",
	"丽水": "081000",
	"舟山": "081100",
	"衢州": "081200",
	"义乌": "081400",
	"海宁": "081600",
	"四川省": "090000",
	"成都": "090200",
	"绵阳": "090300",
	"乐山": "090400",
	"泸州": "090500",
	"德阳": "090600",
	"宜宾": "090700",
	"自贡": "090800",
	"内江": "090900",
	"攀枝花": "091000",
	"南充": "091100",
	"眉山": "091200",
	"广安": "091300",
	"资阳": "091400",
	"遂宁": "091500",
	"广元": "091600",
	"达州": "091700",
	"雅安": "091800",
	"西昌": "091900",
	"巴中": "092000",
	"甘孜": "092100",
	"阿坝": "092200",
	"凉山": "092300",
	"海南省": "100000",
	"海口": "100200",
	"三亚": "100300",
	"洋浦经济开发区": "100400",
	"文昌": "100500",
	"琼海": "100600",
	"万宁": "100700",
	"儋州": "100800",
	"东方": "100900",
	"五指山": "101000",
	"定安": "101100",
	"屯昌": "101200",
	"澄迈": "101300",
	"临高": "101400",
	"三沙": "101500",
	"琼中": "101600",
	"保亭": "101700",
	"白沙": "101800",
	"昌江": "101900",
	"乐东": "102000",
	"陵水": "102100",
	"福建省": "110000",
	"福州": "110200",
	"厦门": "110300",
	"泉州": "110400",
	"漳州": "110500",
	"莆田": "110600",
	"三明": "110700",
	"南平": "110800",
	"宁德": "110900",
	"龙岩": "111000",
	"山东省": "120000",
	"济南": "120200",
	"青岛": "120300",
	"烟台": "120400",
	"潍坊": "120500",
	"威海": "120600",
	"淄博": "120700",
	"临沂": "120800",
	"济宁": "120900",
	"东营": "121000",
	"泰安": "121100",
	"日照": "121200",
	"德州": "121300",
	"菏泽": "121400",
	"滨州": "121500",
	"枣庄": "121600",
	"聊城": "121700",
	"江西省": "130000",
	"南昌": "130200",
	"九江": "130300",
	"景德镇": "130400",
	"萍乡": "130500",
	"新余": "130600",
	"鹰潭": "130700",
	"赣州": "130800",
	"吉安": "130900",
	"宜春": "131000",
	"抚州": "131100",
	"上饶": "131200",
	"广西": "140000",
	"南宁": "140200",
	"桂林": "140300",
	"柳州": "140400",
	"北海": "140500",
	"玉林": "140600",
	"梧州": "140700",
	"防城港": "140800",
	"钦州": "140900",
	"贵港": "141000",
	"百色": "141100",
	"河池": "141200",
	"来宾": "141300",
	"崇左": "141400",
	"贺州": "141500",
	"安徽省": "150000",
	"合肥": "150200",
	"芜湖": "150300",
	"安庆": "150400",
	"马鞍山": "150500",
	"蚌埠": "150600",
	"阜阳": "150700",
	"铜陵": "150800",
	"滁州": "150900",
	"黄山": "151000",
	"淮南": "151100",
	"六安": "151200",
	"宣城": "151400",
	"池州": "151500",
	"宿州": "151600",
	"淮北": "151700",
	"亳州": "151800",
	"河北省": "160000",
	"雄安新区": "160100",
	"石家庄": "160200",
	"廊坊": "160300",
	"保定": "160400",
	"唐山": "160500",
	"秦皇岛": "160600",
	"邯郸": "160700",
	"沧州": "160800",
	"张家口": "160900",
	"承德": "161000",
	"邢台": "161100",
	"衡水": "161200",
	"燕郊开发区": "161300",
	"河南省": "170000",
	"郑州": "170200",
	"洛阳": "170300",
	"开封": "170400",
	"焦作": "170500",
	"南阳": "170600",
	"新乡": "170700",
	"周口": "170800",
	"安阳": "170900",
	"平顶山": "171000",
	"许昌": "171100",
	"信阳": "171200",
	"商丘": "171300",
	"驻马店": "171400",
	"漯河": "171500",
	"濮阳": "171600",
	"鹤壁": "171700",
	"三门峡": "171800",
	"济源": "171900",
	"邓州": "172000",
	"湖北省": "180000",
	"武汉": "180200",
	"宜昌": "180300",
	"黄石": "180400",
	"襄阳": "180500",
	"十堰": "180600",
	"荆州": "180700",
	"荆门": "180800",
	"孝感": "180900",
	"鄂州": "181000",
	"黄冈": "181100",
	"随州": "181200",
	"咸宁": "181300",
	"仙桃": "181400",
	"潜江": "181500",
	"天门": "181600",
	"神农架": "181700",
	"恩施": "181800",
	"湖南省": "190000",
	"长沙": "190200",
	"株洲": "190300",
	"湘潭": "190400",
	"衡阳": "190500",
	"岳阳": "190600",
	"常德": "190700",
	"益阳": "190800",
	"郴州": "190900",
	"邵阳": "191000",
	"怀化": "191100",
	"娄底": "191200",
	"永州": "191300",
	"张家界": "191400",
	"湘西": "191500",
	"陕西省": "200000",
	"西安": "200200",
	"咸阳": "200300",
	"宝鸡": "200400",
	"铜川": "200500",
	"延安": "200600",
	"渭南": "200700",
	"榆林": "200800",
	"汉中": "200900",
	"安康": "201000",
	"商洛": "201100",
	"杨凌": "201200",
	"山西省": "210000",
	"太原": "210200",
	"运城": "210300",
	"大同": "210400",
	"临汾": "210500",
	"长治": "210600",
	"晋城": "210700",
	"阳泉": "210800",
	"朔州": "210900",
	"晋中": "211000",
	"忻州": "211100",
	"吕梁": "211200",
	"黑龙江省": "220000",
	"哈尔滨": "220200",
	"伊春": "220300",
	"绥化": "220400",
	"大庆": "220500",
	"齐齐哈尔": "220600",
	"牡丹江": "220700",
	"佳木斯": "220800",
	"鸡西": "220900",
	"鹤岗": "221000",
	"双鸭山": "221100",
	"黑河": "221200",
	"七台河": "221300",
	"大兴安岭": "221400",
	"辽宁省": "230000",
	"沈阳": "230200",
	"大连": "230300",
	"鞍山": "230400",
	"营口": "230500",
	"抚顺": "230600",
	"锦州": "230700",
	"丹东": "230800",
	"葫芦岛": "230900",
	"本溪": "231000",
	"辽阳": "231100",
	"铁岭": "231200",
	"盘锦": "231300",
	"朝阳": "231400",
	"阜新": "231500",
	"吉林省": "240000",
	"长春": "240200",
	"吉林": "240300",
	"辽源": "240400",
	"通化": "240500",
	"四平": "240600",
	"松原": "240700",
	"延吉": "240800",
	"白山": "240900",
	"白城": "241000",
	"延边": "241100",
	"云南省": "250000",
	"昆明": "250200",
	"曲靖": "250300",
	"玉溪": "250400",
	"大理": "250500",
	"丽江": "250600",
	"红河州": "251000",
	"普洱": "251100",
	"保山": "251200",
	"昭通": "251300",
	"文山": "251400",
	"西双版纳": "251500",
	"德宏": "251600",
	"楚雄": "251700",
	"临沧": "251800",
	"怒江": "251900",
	"迪庆": "252000",
	"贵州省": "260000",
	"贵阳": "260200",
	"遵义": "260300",
	"六盘水": "260400",
	"安顺": "260500",
	"铜仁": "260600",
	"毕节": "260700",
	"黔西南": "260800",
	"黔东南": "260900",
	"黔南": "261000",
	"甘肃省": "270000",
	"兰州": "270200",
	"金昌": "270300",
	"嘉峪关": "270400",
	"酒泉": "270500",
	"天水": "270600",
	"武威": "270700",
	"白银": "270800",
	"张掖": "270900",
	"平凉": "271000",
	"定西": "271100",
	"陇南": "271200",
	"庆阳": "271300",
	"临夏": "271400",
	"甘南": "271500",
	"内蒙古": "280000",
	"呼和浩特": "280200",
	"赤峰": "280300",
	"包头": "280400",
	"通辽": "280700",
	"鄂尔多斯": "280800",
	"巴彦淖尔": "280900",
	"乌海": "281000",
	"呼伦贝尔": "281100",
	"乌兰察布": "281200",
	"兴安盟": "281300",
	"锡林郭勒盟": "281400",
	"阿拉善盟": "281500",
	"宁夏": "290000",
	"银川": "290200",
	"吴忠": "290300",
	"中卫": "290400",
	"石嘴山": "290500",
	"固原": "290600",
	"西藏": "300000",
	"拉萨": "300200",
	"日喀则": "300300",
	"林芝": "300400",
	"山南": "300500",
	"昌都": "300600",
	"那曲": "300700",
	"阿里": "300800",
	"新疆": "310000",
	"乌鲁木齐": "310200",
	"克拉玛依": "310300",
	"喀什地区": "310400",
	"伊犁": "310500",
	"阿克苏": "310600",
	"哈密": "310700",
	"石河子": "310800",
	"阿拉尔": "310900",
	"五家渠": "311000",
	"图木舒克": "311100",
	"昌吉": "311200",
	"阿勒泰": "311300",
	"吐鲁番": "311400",
	"塔城": "311500",
	"和田": "311600",
	"克孜勒苏柯尔克孜": "311700",
	"巴音郭楞": "311800",
	"博尔塔拉": "311900",
	"昆玉": "312000",
	"北屯": "312100",
	"铁门关": "312200",
	"可克达拉": "312300",
	"胡杨河": "312400",
	"双河": "312500",
	"新星": "312600",
	"青海省": "320000",
	"西宁": "320200",
	"海东": "320300",
	"海西": "320400",
	"海北": "320500",
	"黄南": "320600",
	"海南州": "320700",
	"果洛": "320800",
	"玉树": "320900",
	"香港": "330000",
	"澳门": "340000",
	"台湾": "350000",
	"国外": "360000"
};
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/sites.ts
var BOSS_CITIES = {
	全国: "100010000",
	北京: "101010100",
	上海: "101020100",
	天津: "101030100",
	重庆: "101040100",
	广州: "101280100",
	深圳: "101280600",
	杭州: "101210100",
	成都: "101270100",
	南京: "101190100",
	武汉: "101200100",
	苏州: "101190400",
	西安: "101110100",
	长沙: "101250100",
	郑州: "101180100",
	东莞: "101281600",
	佛山: "101280800",
	合肥: "101220100",
	宁波: "101210400",
	青岛: "101120200",
	厦门: "101230200",
	福州: "101230100",
	济南: "101120100",
	大连: "101070200",
	沈阳: "101070100",
	无锡: "101190200",
	珠海: "101280700",
	昆明: "101290100"
};
var LIEPIN_CITIES = {
	全国: "410",
	北京: "010",
	上海: "020",
	天津: "030",
	重庆: "040",
	广州: "050020",
	深圳: "050090",
	苏州: "060080",
	南京: "060020",
	杭州: "070020",
	大连: "210040",
	成都: "280020",
	武汉: "170020",
	西安: "270020"
};
var ZHAOPIN_CITIES = {
	全国: "0",
	北京: "530",
	上海: "538",
	广州: "763",
	深圳: "765",
	杭州: "653",
	成都: "801",
	南京: "635",
	武汉: "736",
	西安: "854",
	苏州: "639",
	天津: "531",
	重庆: "551",
	长沙: "749",
	郑州: "719",
	东莞: "768",
	佛山: "764",
	合肥: "664",
	宁波: "654",
	青岛: "702",
	厦门: "682",
	福州: "681",
	济南: "701",
	大连: "600",
	沈阳: "599",
	无锡: "636",
	珠海: "766",
	昆明: "831"
};
var CITY_SUFFIX = /(市|地区|自治州|特别行政区)$/;
function normalizeCityName(value) {
	return String(value ?? "").trim().replace(CITY_SUFFIX, "").trim();
}
var JOB_SITES = {
	boss: {
		id: "boss",
		label: "Boss直聘",
		short: "Boss",
		homeUrl: "https://www.zhipin.com/",
		loginUrl: "https://www.zhipin.com/web/user/?ka=header-login",
		searchUrl: (keyword, cityCode, page, variant) => `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${encodeURIComponent(cityCode || BOSS_CITIES.全国)}${variant?.scale ? `&scale=${encodeURIComponent(variant.scale)}` : ""}${page > 1 ? `&page=${page}` : ""}`,
		supportsGreet: true,
		supportsApply: false,
		supportsImageResume: true,
		note: "需要在打开的浏览器里扫码登录；登录状态会按网站要求保留在本机。",
		applyNote: "Boss 用「打招呼」把简历和一句话发给 HR，投递在聊天窗口完成。",
		cityCodes: BOSS_CITIES
	},
	liepin: {
		id: "liepin",
		label: "猎聘",
		short: "猎聘",
		homeUrl: "https://www.liepin.com/",
		loginUrl: "https://passport.liepin.com/",
		searchUrl: (keyword, cityCode, page) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&city=${encodeURIComponent(cityCode || LIEPIN_CITIES.全国)}&dq=${encodeURIComponent(cityCode || LIEPIN_CITIES.全国)}&currentPage=${Math.max(0, page - 1)}`,
		supportsGreet: false,
		supportsApply: true,
		supportsImageResume: false,
		note: "匿名即可搜索；投递简历和「聊一聊」需要先登录猎聘。",
		applyNote: "详情页有「立即投递」就直接投递（弹窗可补附件简历）；只有「聊一聊」的岗位发送开场话术打招呼。",
		cityCodes: LIEPIN_CITIES
	},
	zhaopin: {
		id: "zhaopin",
		label: "智联招聘",
		short: "智联",
		homeUrl: "https://www.zhaopin.com/",
		loginUrl: "https://www.zhaopin.com/?login=1",
		loginOnOpen: true,
		searchUrl: (keyword, cityCode, _page, variant) => {
			const code = cityCode || ZHAOPIN_CITIES.全国;
			const params = new URLSearchParams({
				kw: keyword,
				pageMode: "search"
			});
			if (code && code !== "0") params.set("jl", code);
			if (variant?.order) params.set("order", String(variant.order));
			if (variant?.salary) params.set("sl", variant.salary);
			if (variant?.scale) params.set("cs", variant.scale);
			return `https://www.zhaopin.com/jobs/?${params.toString()}`;
		},
		supportsGreet: false,
		supportsApply: true,
		supportsImageResume: false,
		note: "智联会触发腾讯云人机验证，需要在打开的窗口里手动完成验证后再搜索。",
		applyNote: "详情页有「立即申请」就直接投递（首次选简历 →「立即投递」，成功弹窗是「已向对方发送简历和打招呼语」；没抓到弹窗时重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递，按钮还在会自动再投一次）；只有「聊一聊」的岗位发送开场话术打招呼。部分账号会先要求人机验证。",
		cityCodes: ZHAOPIN_CITIES
	},
	job51: {
		id: "job51",
		label: "前程无忧",
		short: "51job",
		homeUrl: "https://we.51job.com/",
		loginUrl: "https://login.51job.com/login.php",
		searchUrl: (keyword, cityCode, page, variant) => `https://we.51job.com/pc/search?${cityCode ? `jobArea=${encodeURIComponent(cityCode)}&` : ""}keyword=${encodeURIComponent(keyword)}&searchType=2&sortType=${variant?.sortType ?? 0}${variant?.scale ? `&companySize=${encodeURIComponent(variant.scale)}` : ""}&pageNum=${Math.max(1, page)}`,
		supportsGreet: false,
		supportsApply: true,
		supportsImageResume: false,
		note: "匿名即可搜索；未填城市时按当前网络城市返回。投递需要先登录 51job。",
		applyNote: "打开岗位详情页（不是公司主页）：有「投递」按钮就投递（确认页选简历 →「申请」）；没有投递按钮就点「聊一聊」，把开场话术发过去。投递后重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递；按钮还在会自动再投一次。",
		cityCodes: JOB51_CITY_CODES
	}
};
/** 可搜索 / 可开窗的平台。猎聘已下线，只在历史投递记录里保留展示。 */
var JOB_SITE_IDS = [
	"boss",
	"zhaopin",
	"job51"
];
/** 能直接投递简历的平台（Boss 走聊天打招呼，不在其列）。 */
var APPLY_SITE_IDS = [
	"liepin",
	"zhaopin",
	"job51"
];
function supportsSiteApply(site) {
	return APPLY_SITE_IDS.includes(site);
}
function resolveCityCode(site, city) {
	const name = normalizeCityName(city);
	if (!name) return {
		code: "",
		mapped: true
	};
	const code = JOB_SITES[site].cityCodes[name];
	return code ? {
		code,
		mapped: true
	} : {
		code: "",
		mapped: false
	};
}
function jobSiteLabel(site) {
	return JOB_SITES[site]?.label ?? site;
}
/** 把界面传来的「从第几页开始 + 连续加载几页」收敛成合法区间。 */
function sitePageRange(start, pages) {
	const first = Math.max(1, Math.min(100, Math.round(Number(start) || 1)));
	const requested = Math.max(1, Math.min(20, Math.round(Number(pages) || 1)));
	const end = Math.min(100, first + requested - 1);
	return {
		start: first,
		end,
		count: end - first + 1
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/parse.ts
var BENEFIT_PATTERN = /五险一金|六险一金|年终奖|节日福利|带薪年假|带薪休假|弹性工作|周末双休|补充医疗|定期体检|员工旅游|餐补|交通补助|通讯补贴|零食|下午茶|绩效奖金|股票期权|免费班车|包吃|包住|住房补贴|生日福利|团建|晋升空间|岗位晋升|技能培训|扁平管理|领导好|氛围好|不加班|双休/i;
var HEADHUNTER_PATTERN$1 = /猎头|人力资源服务|人才服务|招聘服务/i;
function text$5(value, max = 400) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function parseSalaryText(raw) {
	const original = text$5(raw, 60);
	const label = original.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
	const empty = {
		min: null,
		max: null,
		unit: "",
		label: original !== label || /(?:^|\D)0{2,}\s*[-~—至到]\s*0{2,}|0\s*[-~—至到]\s*0\s*[kK]/.test(label) ? "" : label
	};
	if (!label || /面议|保密|不限/.test(label)) return empty;
	const range = label.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)/);
	const single = label.match(/\d+(?:\.\d+)?/)?.[0];
	const numbers = range ? [Number(range[1]), Number(range[2])] : single ? [Number(single)] : [];
	if (!numbers.length) return empty;
	if (numbers.every((value) => value === 0)) return {
		min: null,
		max: null,
		unit: "",
		label: ""
	};
	const min = Math.min(...numbers);
	const max = Math.max(...numbers);
	let unit = "";
	if (/元\s*\/\s*(天|日)/.test(label)) unit = "元/天";
	else if (/(万|w)\s*\/?\s*年|年薪/.test(label)) unit = "万/年";
	else if (/[kK]|千/.test(label)) unit = "K/月";
	else if (/万|w/i.test(label)) unit = "万/月";
	else if (max >= 1e3) unit = "元/月";
	else unit = "K/月";
	return {
		min,
		max,
		unit,
		label
	};
}
function parseActiveDays(raw) {
	const value = text$5(raw, 40);
	if (!value) return null;
	const hour = value.match(/(\d+)\s*小时/);
	if (hour) return Number(hour[1]) / 24;
	if (/在线|刚刚|今日活跃|刚刚活跃/.test(value)) return 0;
	const day = value.match(/(\d+)\s*天/);
	if (day) return Number(day[1]);
	const week = value.match(/(\d+)\s*周/);
	if (week) return Number(week[1]) * 7;
	const month = value.match(/(\d+)\s*个?月/);
	if (month) return Number(month[1]) * 30;
	const year = value.match(/(\d+)\s*年/);
	if (year) return Number(year[1]) * 365;
	if (/本周活跃/.test(value)) return 3;
	if (/本月活跃/.test(value)) return 15;
	if (/半年前/.test(value)) return 180;
	if (/年前/.test(value)) return 365;
	return null;
}
function isInactiveHr(raw) {
	const days = parseActiveDays(raw);
	return days !== null && days > 30;
}
function isHeadhunterJob(raw) {
	return [
		raw.company,
		raw.recruiter,
		...raw.tags ?? []
	].filter(Boolean).some((entry) => HEADHUNTER_PATTERN$1.test(String(entry)));
}
function looksLikeSkill(tag) {
	if (!tag || BENEFIT_PATTERN.test(tag)) return false;
	if (/[a-zA-Z][a-zA-Z0-9+#.-]*/.test(tag)) return tag.length <= 30;
	return /数据分析|产品设计|交互设计|视觉设计|算法|前端|后端|全栈|架构|测试|运维|运营|增长|项目管理|英语|日语|销售|财务|法务|招聘|品牌|市场|文案|剪辑|摄影|采购|供应链|风控|信贷|量化|投资|会计|审计/.test(tag);
}
function skillTags(tags) {
	return tags.filter(looksLikeSkill).slice(0, 12);
}
function inferRemoteType(value) {
	const source = text$5(value, 200);
	if (/远程|居家办公|在家办公/.test(source)) return "remote";
	if (/混合|弹性办公|hybrid/i.test(source)) return "hybrid";
	if (/现场|坐班|onsite/i.test(source)) return "onsite";
	return "";
}
function hash(value) {
	let result = 0;
	for (let index = 0; index < value.length; index += 1) result = (result << 5) - result + value.charCodeAt(index) | 0;
	return Math.abs(result).toString(36);
}
function safeUrl(raw, base) {
	const value = text$5(raw, 1e3);
	if (!value) return "";
	try {
		const url = new URL(value, base);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
	} catch {
		return "";
	}
}
function mapRawSiteJob(site, raw) {
	const title = text$5(raw.title, 160);
	const company = text$5(raw.company, 120);
	const sourceUrl = safeUrl(raw.url, site === "job51" ? "https://jobs.51job.com/" : `https://www.${site === "boss" ? "zhipin" : site === "liepin" ? "liepin" : "zhaopin"}.com/`);
	if (!title || !sourceUrl) return null;
	const salary = parseSalaryText(raw.salary);
	const tags = [...new Set((raw.tags ?? []).map((entry) => text$5(entry, 40)).filter(Boolean))].slice(0, 16);
	const city = text$5(raw.city, 60).replace(/^【|】$/g, "");
	const recruiterActive = text$5(raw.recruiterActive, 40);
	const jobStatus = raw.jobStatus === "open" || raw.jobStatus === "closed" ? raw.jobStatus : "";
	const postedText = text$5(raw.postedText, 40) || extractPostedText(raw.extra, title, tags.join(" "));
	const posted = parsePostedAt(postedText);
	return {
		id: `site-${site}-${hash(`${sourceUrl}|${title}`)}`,
		source: site,
		companyId: "",
		company: company || "企业名称未公开",
		companyIndustry: text$5(raw.companyIndustry, 80),
		careersUrl: "",
		title,
		roleFamily: "",
		seniority: "",
		city,
		remoteType: inferRemoteType(`${title} ${city} ${tags.join(" ")} ${raw.extra ?? ""}`),
		salaryMin: salary.min,
		salaryMax: salary.max,
		salaryUnit: salary.unit,
		salaryLabel: salary.label,
		description: "",
		requirements: "",
		responsibilities: "",
		skills: skillTags(tags),
		tags,
		recruiter: text$5(raw.recruiter, 60),
		recruiterActive,
		sourceUrl,
		matchScore: null,
		reasons: [],
		gaps: [],
		verdict: "",
		jobId: text$5(raw.jobId, 80),
		companyStage: text$5(raw.companyStage, 40),
		companyScale: text$5(raw.companyScale, 40),
		recruiterTitle: text$5(raw.recruiterTitle, 60),
		jobStatus,
		jobStatusText: text$5(raw.jobStatusText, 60),
		companyAnonymous: raw.anonymous === true || !company,
		activeDays: parseActiveDays(recruiterActive),
		listingDays: null,
		seenCount: 0,
		longTerm: false,
		postedAt: posted.at,
		postedLabel: posted.label || postedText,
		postedDays: postedDays(posted.at),
		refreshCount: 0,
		ageDays: postedDays(posted.at),
		trustScore: null,
		trustLevel: "",
		trustReasons: [],
		trustRisks: []
	};
}
/** 本地长期在招识别使用的稳定键：优先平台职位号，其次来源 + 标题 + 链接。 */
function jobHistoryKey(job) {
	const id = text$5(job.jobId, 80) || hash(`${job.sourceUrl}|${job.title}`);
	return `${job.source}:${id}`;
}
function dedupeSiteJobs(jobs) {
	return dedupeSiteJobsDetailed(jobs).items;
}
/** 去重时同时保留被丢弃的重复岗位，UI 可以看到「已过滤」里具体是哪些岗位。 */
function dedupeSiteJobsDetailed(jobs) {
	const seen = /* @__PURE__ */ new Set();
	const items = [];
	const duplicates = [];
	for (const job of jobs) {
		const key = job.sourceUrl || `${job.company}|${job.title}`;
		if (seen.has(key)) {
			duplicates.push(job);
			continue;
		}
		seen.add(key);
		items.push(job);
	}
	return {
		items,
		duplicates
	};
}
function matchesCity(job, city) {
	const needle = normalizeCityName(city);
	if (!needle) return true;
	return `${job.city} ${job.sourceUrl}`.includes(needle);
}
/** 挂岗天数：平台发布时间与本地首见时间取较大值，两个都没有返回 null。 */
function jobAgeDays(job) {
	const values = [
		job.ageDays,
		job.postedDays,
		job.listingDays
	].map((value) => value === null || value === void 0 ? null : Number(value)).filter((value) => value !== null && Number.isFinite(value));
	if (!values.length) return null;
	return Math.max(...values);
}
function staleDaysLimit(rules) {
	const configured = Number(rules.staleJobDays);
	return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 90;
}
function filterSiteJobs(jobs, rules, profile) {
	let filtered = 0;
	const rejected = [];
	const reject = (job, reason, category = "safety") => {
		filtered += 1;
		rejected.push({
			job,
			reason,
			category
		});
		return false;
	};
	const salaries = salaryBounds(rules);
	const myYears = profile ? parseYears(profile.years) : null;
	const myDegree = profile ? degreeRank(profile.degree) : null;
	return {
		items: jobs.filter((job) => {
			if (rules.filterHeadhunter && isHeadhunterJob(job)) return reject(job, "猎头 / 代招职位");
			if (rules.filterInactiveHr && isInactiveHr(job.recruiterActive)) return reject(job, `招聘者长期不活跃${job.recruiterActive ? `（${job.recruiterActive}）` : ""}`);
			if (rules.filterOutsource && isOutsourceJob(job)) return reject(job, "标题 / 公司 / 行业 / JD 命中外包或驻场字样", "outsource");
			if (rules.filterStaleJob) {
				const age = jobAgeDays(job);
				if (age !== null && age >= staleDaysLimit(rules)) return reject(job, `岗位已挂出 ${age} 天（超过 ${staleDaysLimit(rules)} 天）`);
			}
			if (salaries) {
				const range = monthlySalaryRange(job);
				if (range && (range.max < salaries.min || salaries.max > 0 && range.min > salaries.max)) return reject(job, `薪资 ${range.min}-${range.max}K/月 不在期望范围`, "salary");
			}
			if (rules.filterExperience && myYears !== null) {
				const required = jobExperienceMin(job);
				if (required !== null && required > myYears + 2) return reject(job, `经验要求 ${required} 年，高于你的 ${myYears} 年`);
			}
			if (rules.filterDegree && myDegree !== null) {
				const required = jobDegreeRank(job);
				if (required !== null && required > myDegree) return reject(job, "学历要求高于你的学历");
			}
			return true;
		}),
		filtered,
		rejected
	};
}
function monthlySalaryRange(job) {
	const rawMin = job.salaryMin === null || job.salaryMin === void 0 ? null : Number(job.salaryMin);
	const rawMax = job.salaryMax === null || job.salaryMax === void 0 ? null : Number(job.salaryMax);
	if ((rawMin === null || !Number.isFinite(rawMin)) && (rawMax === null || !Number.isFinite(rawMax))) return null;
	const min = rawMin !== null && Number.isFinite(rawMin) ? rawMin : rawMax;
	const max = rawMax !== null && Number.isFinite(rawMax) ? rawMax : rawMin;
	const unit = text$5(job.salaryUnit, 20);
	let factor = 1;
	if (unit === "万/年") factor = 10 / 12;
	else if (unit === "万/月") factor = 10;
	else if (unit === "元/月") factor = 1 / 1e3;
	else if (unit === "元/天") factor = 21.75 / 1e3;
	else if (!unit && max >= 1e3) factor = 1 / 1e3;
	const round = (value) => Math.round(value * factor * 10) / 10;
	return {
		min: round(min),
		max: round(max)
	};
}
function salaryBounds(rules) {
	const min = Math.max(0, Number(rules.salaryMin) || 0);
	const max = Math.max(0, Number(rules.salaryMax) || 0);
	return min > 0 || max > 0 ? {
		min,
		max
	} : null;
}
function hasKnownSalary(job) {
	if (monthlySalaryRange(job) !== null) return true;
	const label = text$5(job.salaryLabel, 60);
	return Boolean(label) && !/面议|保密|不限/.test(label);
}
/** 搜索结果里的薪资覆盖度：unknown 包含「面议」和平台没解析出来的薪资。 */
function salaryCoverage(jobs) {
	const total = jobs.length;
	const known = jobs.filter(hasKnownSalary).length;
	const unknown = total - known;
	return {
		total,
		known,
		unknown,
		unknownRatio: total ? unknown / total : 0
	};
}
/**
* 一页里至少 3 个、且一半以上的岗位都没有薪资时，通常是平台列表没把薪资带出来
* （反爬字体 / 页面没渲染完），需要重新搜索；一两个「面议」是正常情况，不触发重搜。
*/
function isSalarySparse(jobs) {
	const coverage = salaryCoverage(jobs);
	return coverage.total >= 3 && coverage.unknown >= 3 && coverage.unknown >= coverage.known;
}
function parseYears(raw) {
	const value = text$5(raw, 40);
	if (!value) return null;
	if (/应届|在校|无经验/.test(value)) return 0;
	const range = value.match(/(\d+(?:\.\d+)?)\s*[-~—至到]\s*(\d+(?:\.\d+)?)\s*年/);
	if (range) return Math.min(Number(range[1]), Number(range[2]));
	const single = value.match(/(\d+(?:\.\d+)?)\s*年/);
	return single ? Number(single[1]) : null;
}
function degreeRank(raw) {
	const value = text$5(raw, 60);
	if (!value) return null;
	if (/不限|无要求/.test(value)) return 0;
	if (/博士/.test(value)) return 4;
	if (/硕士|研究生/.test(value)) return 3;
	if (/本科/.test(value)) return 2;
	if (/大专|专科/.test(value)) return 1;
	return null;
}
function jobDegreeRank(job) {
	const source = `${job.title} ${(job.tags ?? []).join(" ")} ${text$5(job.requirements, 400)}`.replace(/(硕士|本科|博士|大专|专科|研究生)\s*(优先|加分|以上优先)/g, "");
	if (!/学历|本科|硕士|博士|大专|专科|研究生/.test(source)) return null;
	if (/学历不限|不限学历/.test(source)) return 0;
	return degreeRank(source);
}
function jobExperienceMin(job) {
	const source = `${job.title} ${(job.tags ?? []).join(" ")} ${text$5(job.requirements, 400)}`;
	const range = source.match(/(\d+)\s*[-~—至到]\s*\d+\s*年(?:以上)?/);
	if (range) return Number(range[1]);
	const above = source.match(/(\d+)\s*年(?:以上|及以上)/);
	if (above) return Number(above[1]);
	if (/经验不限|应届|在校/.test(source)) return 0;
	return null;
}
/**
* Boss 点「继续沟通 / 立即沟通」时会用账号里预设的招呼语直接发出，再弹「已向BOSS发送消息」。
* 这种情况下页面上不会再出现输入框，旧逻辑会误判成「没有沟通入口 → 需要本人处理」，
* 结果明明已经打过招呼却没有记录。这个提示本身就是平台给出的发送成功证据。
*/
function detectBossAutoGreet(body) {
	const value = String(body ?? "").replace(/\s+/g, "");
	if (/已向BOSS发送消息|已向BOSS打招呼|已发送职位邀请/i.test(value)) return true;
	return /留在此页/.test(value) && /继续沟通/.test(value);
}
/** 深度搜索最多翻到第几页（与 sites.ts 的 JOB_SITE_MAX_PAGE 保持一致）。 */
var DEEP_PAGE_LIMIT = 100;
/** 支持按公司规模轮换的平台；猎聘没有对应筛选，保持原样。 */
var JOB_SITE_SCALES = {
	boss: [
		{
			code: "301",
			label: "0-20人"
		},
		{
			code: "302",
			label: "20-99人"
		},
		{
			code: "303",
			label: "100-499人"
		},
		{
			code: "304",
			label: "500-999人"
		},
		{
			code: "305",
			label: "1000-9999人"
		},
		{
			code: "306",
			label: "10000人以上"
		}
	],
	zhaopin: [
		{
			code: "1",
			label: "20人以下"
		},
		{
			code: "2",
			label: "20-99人"
		},
		{
			code: "3",
			label: "100-299人"
		},
		{
			code: "8",
			label: "300-499人"
		},
		{
			code: "4",
			label: "500-999人"
		},
		{
			code: "5",
			label: "1000-9999人"
		},
		{
			code: "6",
			label: "10000人以上"
		}
	],
	job51: [
		{
			code: "1",
			label: "少于50人"
		},
		{
			code: "2",
			label: "50-150人"
		},
		{
			code: "3",
			label: "150-500人"
		},
		{
			code: "4",
			label: "500-1000人"
		},
		{
			code: "5",
			label: "1000-5000人"
		},
		{
			code: "6",
			label: "5000-10000人"
		},
		{
			code: "7",
			label: "10000人以上"
		}
	]
};
function siteScales(site) {
	return JOB_SITE_SCALES[site] ?? [];
}
function siteScaleLabel(site, code) {
	return siteScales(site).find((entry) => entry.code === String(code ?? "").trim())?.label ?? "";
}
/** 智联 order 参数对应的界面说法；未知值返回空串，避免把数字当标签展示。 */
function zhaopinOrderLabel(order) {
	if (order === 4) return "最新发布";
	if (order === 11) return "综合排序";
	if (order === 2) return "薪资最高";
	return "";
}
/** 前程无忧 sortType 参数对应的界面说法。 */
function job51SortLabel(sortType) {
	if (sortType === 0) return "综合排序";
	if (sortType === 1) return "最新优先";
	return "";
}
/** 智联 salaryType（"15001,25000"）转成「15-25K」；无效值返回空串。 */
function salaryRangeText(value) {
	const [min, max] = String(value ?? "").split(",").map((entry) => Math.round(Number(entry) || 0));
	if (min <= 0 || max <= min) return "";
	return `${Math.round(min / 1e3)}-${Math.round(max / 1e3)}K`;
}
/**
* 同义岗位改写表：平台对措辞很敏感，「Java」和「Spring Boot」经常返回完全不同的公司。
* 顺序按「和原关键词差异最大」优先，避免补进来的词只是原词加后缀、结果几乎重复。
* 每类多准备一些说法：轮次够多时仍能拿到没搜过的关键词，而不是很快绕回同一批。
*/
var ROLE_VARIANTS = [
	{
		match: /java/i,
		variants: [
			"Spring Boot",
			"微服务",
			"后端开发",
			"Java 架构师",
			"Java 开发工程师",
			"Java 工程师",
			"服务端开发",
			"分布式",
			"高并发",
			"中间件",
			"Spring Cloud",
			"MyBatis",
			"JVM",
			"全栈开发",
			"高级 Java",
			"资深 Java"
		]
	},
	{
		match: /ai\s*agent|智能体|\bagent\b/i,
		variants: [
			"大模型应用开发",
			"LLM 应用开发",
			"AI 应用开发",
			"RAG",
			"Agent 开发",
			"智能体开发",
			"AI Agent 工程师",
			"大模型工程师",
			"AI 工程师",
			"LangChain",
			"LangGraph",
			"MCP",
			"提示词工程",
			"AIGC",
			"大模型"
		]
	},
	{
		match: /全栈/i,
		variants: [
			"Node.js",
			"React",
			"TypeScript",
			"前端开发",
			"全栈工程师",
			"Web 全栈",
			"Java 全栈",
			"Vue"
		]
	},
	{
		match: /前端|web/i,
		variants: [
			"React",
			"Vue",
			"TypeScript",
			"Web 前端",
			"前端工程师",
			"H5 前端",
			"小程序开发",
			"Next.js"
		]
	},
	{
		match: /后端|服务端/i,
		variants: [
			"Java 后端",
			"微服务",
			"Python 后端",
			"Node.js",
			"Go 后端",
			"服务端开发",
			"分布式",
			"高并发"
		]
	},
	{
		match: /python/i,
		variants: [
			"FastAPI",
			"Django",
			"Python 后端",
			"AI 应用开发",
			"Python 开发",
			"数据开发",
			"爬虫"
		]
	},
	{
		match: /大模型|llm|aigc|生成式/i,
		variants: [
			"RAG",
			"Agent 开发",
			"LangChain",
			"AI 应用开发",
			"大模型应用",
			"LLM",
			"智能体",
			"MCP",
			"提示词工程",
			"大模型工程师"
		]
	},
	{
		match: /测试/i,
		variants: [
			"自动化测试",
			"测试开发",
			"性能测试",
			"接口测试",
			"QA 工程师"
		]
	},
	{
		match: /运维|devops/i,
		variants: [
			"DevOps",
			"Kubernetes",
			"SRE",
			"运维开发",
			"云原生",
			"Linux 运维"
		]
	},
	{
		match: /产品经理|产品/i,
		variants: [
			"AI 产品经理",
			"B 端产品经理",
			"高级产品经理",
			"产品经理",
			"产品设计"
		]
	},
	{
		match: /数据/i,
		variants: [
			"数据分析",
			"数据开发",
			"数据仓库",
			"大数据开发",
			"BI 工程师",
			"ETL"
		]
	},
	{
		match: /算法|机器学习|深度学习/i,
		variants: [
			"算法工程师",
			"机器学习",
			"深度学习",
			"推荐算法",
			"NLP 算法",
			"计算机视觉"
		]
	},
	{
		match: /大数据|hadoop|spark|flink/i,
		variants: [
			"大数据开发",
			"Hadoop",
			"Spark",
			"Flink",
			"数据仓库",
			"ETL"
		]
	},
	{
		match: /\bgo(?:lang)?\b/i,
		variants: [
			"Golang",
			"Go 后端",
			"高并发",
			"分布式",
			"云原生"
		]
	},
	{
		match: /c\+\+|cpp/i,
		variants: [
			"C++ 开发",
			"C++ 工程师",
			"图形开发",
			"嵌入式开发"
		]
	},
	{
		match: /android|安卓/i,
		variants: [
			"Android 开发",
			"安卓开发",
			"移动端开发",
			"Flutter"
		]
	},
	{
		match: /ios|苹果/i,
		variants: [
			"iOS 开发",
			"移动端开发",
			"Swift",
			"Flutter"
		]
	},
	{
		match: /node/i,
		variants: [
			"Node.js",
			"Node 开发",
			"前端开发",
			"全栈开发"
		]
	},
	{
		match: /react/i,
		variants: [
			"React",
			"React Native",
			"前端开发",
			"TypeScript"
		]
	},
	{
		match: /vue/i,
		variants: [
			"Vue",
			"前端开发",
			"TypeScript",
			"小程序开发"
		]
	},
	{
		match: /架构师/i,
		variants: [
			"系统架构师",
			"技术架构师",
			"平台架构",
			"微服务架构"
		]
	},
	{
		match: /技术经理|研发经理|技术负责人/i,
		variants: [
			"技术经理",
			"研发经理",
			"技术负责人",
			"研发总监"
		]
	},
	{
		match: /解决方案|售前/i,
		variants: [
			"解决方案工程师",
			"售前工程师",
			"技术支持",
			"实施工程师"
		]
	},
	{
		match: /项目经理|交付/i,
		variants: [
			"项目经理",
			"交付经理",
			"实施项目经理"
		]
	},
	{
		match: /运营/i,
		variants: [
			"新媒体运营",
			"用户运营",
			"内容运营",
			"产品运营"
		]
	},
	{
		match: /销售|客户经理/i,
		variants: [
			"销售经理",
			"客户经理",
			"大客户销售"
		]
	},
	{
		match: /ui|交互|视觉设计|设计师/i,
		variants: [
			"UI 设计师",
			"交互设计师",
			"视觉设计师"
		]
	},
	{
		match: /财务|会计/i,
		variants: [
			"财务经理",
			"会计",
			"财务分析"
		]
	},
	{
		match: /hr|人力|招聘/i,
		variants: [
			"招聘专员",
			"HRBP",
			"人力资源经理"
		]
	},
	{
		match: /客服/i,
		variants: ["客服专员", "客服主管"]
	},
	{
		match: /硬件|嵌入式|电子/i,
		variants: [
			"硬件工程师",
			"电子工程师",
			"嵌入式开发"
		]
	}
];
/** 只拿真正能当搜索词的技能去补关键词，避免把「团队管理」这类泛能力词丢给平台。 */
var SKILL_QUERY_KEEP = /java|python|go(?:lang)?|node|react|vue|angular|typescript|javascript|spring|mysql|redis|postgres|kafka|docker|kubernetes|微服务|全栈|前端|后端|大模型|智能体|ai|llm|rag|agent|langchain|fastapi|django|uniapp|solidity|netty|架构/i;
var SKILL_QUERY_STOP = /^(?:linux|eclipse|codex|git|office|excel|word|ppt)$/i;
var ZHAOPIN_SALARY_BANDS = [
	{
		min: 8001,
		max: 1e4,
		text: "8-10K"
	},
	{
		min: 10001,
		max: 15e3,
		text: "10-15K"
	},
	{
		min: 15001,
		max: 25e3,
		text: "15-25K"
	},
	{
		min: 25001,
		max: 35e3,
		text: "25-35K"
	},
	{
		min: 35001,
		max: 5e4,
		text: "35-50K"
	},
	{
		min: 50001,
		max: 9999999,
		text: "50K以上"
	}
];
function normalizeKeyword(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}
function uniqueKeywords(values) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const value of values) {
		const keyword = normalizeKeyword(value);
		const key = keyword.toLowerCase();
		if (!keyword || seen.has(key)) continue;
		seen.add(key);
		result.push(keyword);
	}
	return result;
}
function seedKeywords(base) {
	return uniqueKeywords(base).slice(0, 6);
}
function variantSlots(seedCount) {
	return Math.min(6, Math.max(0, 10 - seedCount));
}
function roleVariants(keyword) {
	const matched = ROLE_VARIANTS.filter((rule) => rule.match.test(keyword)).flatMap((rule) => rule.variants);
	if (matched.length) return uniqueKeywords(matched);
	if (/^[a-z0-9+#.\s-]{2,24}$/i.test(keyword)) return uniqueKeywords([`${keyword} 开发`, `${keyword} 工程师`]);
	return [];
}
function skillQuery(raw) {
	const value = normalizeKeyword(raw);
	if (!value || SKILL_QUERY_STOP.test(value) || !SKILL_QUERY_KEEP.test(value)) return "";
	return value.replace(/\s*(?:开发工程师|开发|工程师|架构)$/g, "").trim() || value;
}
/**
* 档案技能只有和本次搜索方向一致时才补进关键词。
* 搜「agent」时 Spring Boot / 全栈 / Java 这些技能不能混进来，否则会拿回一堆
* Java 运维、测试岗位，看起来像「搜 agent 出来 Java」。
* 英文按词边界比较，避免 java 命中 javascript；中文按包含关系比较。
*/
function sharesDirection(left, right) {
	const a = normalizeKeyword(left).toLowerCase();
	const b = normalizeKeyword(right).toLowerCase();
	if (!a || !b) return false;
	if (a === b) return true;
	const contains = (haystack, needle) => {
		if (/[\u3400-\u9fff]/.test(needle)) return haystack.includes(needle);
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
	};
	return contains(a, b) || contains(b, a);
}
/** 所有可轮换的扩展词（不含用户原词），顺序即轮换顺序。 */
function buildVariantPool(seeds, skills) {
	const seedKeys = new Set(seeds.map((keyword) => keyword.toLowerCase()));
	const seen = new Set(seedKeys);
	const pool = [];
	const push = (value) => {
		const keyword = normalizeKeyword(value);
		const key = keyword.toLowerCase();
		if (!keyword || seen.has(key)) return;
		seen.add(key);
		pool.push(keyword);
	};
	const perSeed = seeds.map((keyword) => roleVariants(keyword));
	const longest = Math.max(0, ...perSeed.map((list) => list.length));
	for (let index = 0; index < longest; index += 1) for (const list of perSeed) if (list[index]) push(list[index]);
	const directions = [...seeds, ...perSeed.flat()];
	for (const skill of skills) {
		const query = skillQuery(skill);
		if (query && directions.some((keyword) => sharesDirection(query, keyword))) push(query);
	}
	return pool;
}
/**
* 生成这一轮要搜的关键词：用户输入的原词永远排最前，后面补最多 6 个变体。
* 变体按轮次切片，保证每点一次搜索都换一批；轮完一轮后再从头循环。
*/
function expandSearchKeywords(base, skills = [], round = 0) {
	const seeds = seedKeywords(base);
	const slots = variantSlots(seeds.length);
	if (!slots) return seeds;
	const pool = buildVariantPool(seeds, skills);
	if (!pool.length) return seeds;
	const start = Math.max(0, Math.round(Number(round) || 0)) * slots % pool.length;
	const picked = [];
	for (let step = 0; step < pool.length && picked.length < slots; step += 1) {
		const keyword = pool[(start + step) % pool.length];
		if (!picked.includes(keyword)) picked.push(keyword);
	}
	return [...seeds, ...picked];
}
/**
* 关键词池轮完一圈需要几轮：Boss 没有排序参数，靠它决定什么时候把同一批关键词
* 往更深的页码翻（第 1 圈翻 1-3 页，第 2 圈翻 4-6 页……），避免每轮都只重复前几页。
*/
function keywordCycleLength(base, skills = []) {
	const seeds = seedKeywords(base);
	const slots = variantSlots(seeds.length);
	if (!slots) return 1;
	const pool = buildVariantPool(seeds, skills);
	return Math.max(1, Math.ceil(pool.length / slots));
}
/**
* 深度搜索的页码窗口：第 0 圈从第 1 页开始，之后每轮关键词池循环一圈，
* 就整体向深页推进一个窗口；到最后一页后回到前面。
*/
function deepPageWindow(round, pages, cycle, maxPage = DEEP_PAGE_LIMIT) {
	const safePages = Math.max(1, Math.min(maxPage, Math.round(Number(pages) || 1)));
	const safeCycle = Math.max(1, Math.round(Number(cycle) || 1));
	const depth = Math.floor(Math.max(0, Math.round(Number(round) || 0)) / safeCycle);
	if (depth <= 0) return {
		start: 1,
		end: safePages
	};
	const start = 1 + depth * safePages % maxPage;
	return {
		start,
		end: Math.min(maxPage, start + safePages - 1)
	};
}
function salaryBands(salaryMin, salaryMax) {
	const min = Math.max(0, Number(salaryMin) || 0) * 1e3;
	const max = Math.max(0, Number(salaryMax) || 0) * 1e3;
	if (!min && !max) return [];
	if (min > 0 && max > min) {
		const windows = [];
		const step = 5e3;
		for (let start = min; start < max; start += step) {
			const end = Math.min(max, start + step);
			windows.push({
				min: start + 1,
				max: end,
				text: `${Math.round(start / 1e3)}-${Math.round(end / 1e3)}K`
			});
		}
		windows.push({
			min: min + 1,
			max,
			text: `${Math.round(min / 1e3)}-${Math.round(max / 1e3)}K`
		});
		return windows;
	}
	return ZHAOPIN_SALARY_BANDS.filter((band) => {
		if (max > 0 && band.min >= max) return false;
		if (min > 0 && band.max <= min) return false;
		return true;
	});
}
/**
* 这一轮的平台取数变体。
*
* 智联匿名每个关键词只给前 20 条，换排序 / 换薪资区间等于换一批 20 条；
* 前程无忧的列表页支持 sortType，综合排序和最新优先的结果差异也很大。
* Boss 列表接口没有排序参数，靠扩展关键词和圈数翻深页（见 deepPageWindow）。
*/
function resolveSearchPlan(site, round, salaryMin = 0, salaryMax = 0) {
	const safeRound = Math.max(0, Math.round(Number(round) || 0));
	if (site === "zhaopin") {
		const variants = [
			{
				label: "最新发布",
				order: 4
			},
			{
				label: "综合排序",
				order: 11
			},
			{
				label: "薪资最高",
				order: 2
			}
		];
		for (const band of salaryBands(salaryMin, salaryMax)) {
			variants.push({
				label: `最新发布 · ${band.text}`,
				order: 4,
				salary: `${band.min},${band.max}`
			});
			variants.push({
				label: `薪资最高 · ${band.text}`,
				order: 2,
				salary: `${band.min},${band.max}`
			});
		}
		return {
			round: safeRound,
			...variants[safeRound % variants.length]
		};
	}
	if (site === "job51") {
		const variants = [{
			label: "综合排序",
			sortType: 0
		}, {
			label: "最新发布",
			sortType: 1
		}];
		return {
			round: safeRound,
			...variants[safeRound % variants.length]
		};
	}
	return {
		round: safeRound,
		label: ""
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/zhaopin-api.ts
/**
* 智联招聘新版列表（/jobs/）旁路数据。
*
* 智联在 2026-11 改版：旧地址 `/sou/jl<code>/p<n>?kw=` 会重定向到
* `/jobs/?jl=<code>&kw=<keyword>`，旧的 `.joblist-box__item` / `.jobinfo__*` 全部消失。
* 新版卡片是 `.job-card`，薪资 DOM 仍是 `**-**元` 掩码，岗位链接也不在 DOM 里——
* 标题、明文薪资、详情页地址、HR 信息都只在页面自己的 Vuex store（positionList）里。
*
* 这里只读取页面已经加载的数据，不额外请求接口，也不绕过登录或风控。
* 未登录时页面自己的 loadMoreJobList 会被 canLoadMoreJobList 拦住，每个关键词只给前 20 条，
* 这里如实反映 hasMore=false，由上层提示用户登录后再继续加载。
*/
function text$4(value, max = 400) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function asList(value) {
	return Array.isArray(value) ? value : [];
}
function firstText(...values) {
	for (const value of values) {
		const result = text$4(value, 400);
		if (result) return result;
	}
	return "";
}
/** 智联职位号形如 CC258672210J40854377816（companyNumber + J + jobId）。 */
function zhaopinJobIdOf(value) {
	const raw = text$4(value, 300);
	if (/^[A-Za-z0-9]{8,40}$/.test(raw)) return raw;
	return raw.match(/\/jobdetail\/([A-Za-z0-9]{6,40})\.htm/i)?.[1] ?? "";
}
/** 只认 www.zhaopin.com/jobdetail/<number>.htm；公司主页、列表页都不算详情页。 */
function normalizeZhaopinDetailUrl(value) {
	const matched = text$4(value, 500).match(/^https?:\/\/(?:[\w-]+\.)*zhaopin\.com\/jobdetail\/([A-Za-z0-9]{6,40})\.htm/i);
	return matched ? `https://www.zhaopin.com/jobdetail/${matched[1]}.htm` : "";
}
function zhaopinDetailUrl(value, jobId) {
	const normalized = normalizeZhaopinDetailUrl(value);
	if (normalized) return normalized;
	const id = zhaopinJobIdOf(jobId) || zhaopinJobIdOf(value);
	return id ? `https://www.zhaopin.com/jobdetail/${id}.htm` : "";
}
function mapZhaopinPosition(position) {
	if (!position || typeof position !== "object") return null;
	const title = text$4(position.name, 160);
	const url = zhaopinDetailUrl(position.url, position.number);
	if (!title || !url) return null;
	const tags = [...new Set([
		...asList(position.labels).map((entry) => text$4(entry, 40)),
		...asList(position.skills).map((entry) => text$4(entry, 40)),
		...asList(position.welfare).map((entry) => text$4(entry, 40)),
		text$4(position.education, 40),
		text$4(position.experience, 40)
	].filter(Boolean))].slice(0, 16);
	const industry = text$4(position.industry, 80);
	const scale = text$4(position.scale, 40);
	const stage = text$4(position.stage, 40);
	const description = text$4(position.description, 1500);
	return {
		title,
		company: text$4(position.company, 120),
		city: text$4(position.city, 60),
		salary: firstText(position.salary),
		url,
		tags,
		recruiter: text$4(position.recruiter, 60),
		recruiterActive: text$4(position.recruiterActive, 40) || (position.online ? "当前在线" : ""),
		recruiterTitle: text$4(position.recruiterTitle, 60),
		companyIndustry: industry,
		companyScale: scale,
		companyStage: stage,
		jobId: zhaopinJobIdOf(position.number) || zhaopinJobIdOf(url),
		jobStatus: "open",
		jobStatusText: "平台在招列表",
		proxy: position.proxy === true,
		postedText: firstText(position.publishText, position.publishTime),
		extra: [
			industry,
			scale,
			stage,
			description
		].filter(Boolean).join(" ").slice(0, 600)
	};
}
function zhaopinPageState(payload) {
	const source = payload && typeof payload === "object" ? payload : {};
	const positions = asList(source.positions).filter((entry) => entry && typeof entry === "object").map((entry) => entry);
	return {
		positions,
		loaded: Math.max(0, Math.round(Number(source.loaded) || 0)) || positions.length,
		pageIndex: Math.max(0, Math.round(Number(source.pageIndex) || 0)),
		pageSize: Math.max(1, Math.round(Number(source.pageSize) || 20)),
		hasMore: source.hasMore === true,
		loadingMore: source.loadingMore === true,
		positionCount: Math.max(0, Math.round(Number(source.positionCount) || 0)),
		loggedIn: source.loggedIn === true,
		url: text$4(source.url, 500),
		queryKeyword: text$4(source.queryKeyword, 80),
		searchKeyword: text$4(source.searchKeyword, 80),
		pageMode: text$4(source.pageMode, 20)
	};
}
/**
* 未登录时智联把每个关键词截在前 20 条（store.hasMore=false）。
* 这不是关键词真的没有岗位：登录后还能从下一页继续，分页游标不能推到本批末尾。
*/
function zhaopinLimitedByLogin(state) {
	return !state.loggedIn && state.loaded > 0 && state.hasMore !== true;
}
/**
* 智联分页结束 / 未登录截断时的说明。
*
* 智联把岗位按「关键词 + 排序 + 薪资区间 + 公司规模」拆成多个分片返回：
* 一个分片翻到底只有一两百个岗位，不代表该城市该关键词没有更多岗位。
* 不解释清楚，用户会以为「智联只有这么多岗位」，反复搜同一个词只能拿回同一批。
*/
function zhaopinSliceNote(input) {
	const loaded = Math.max(0, Math.round(Number(input.loaded) || 0));
	if (input.anonymous) return `智联未登录时每个关键词只展示前 ${Math.max(1, loaded)} 个岗位（平台限制，不是全部在招岗位）；登录智联后可以继续加载，勾选「深挖更多岗位」还能换关键词、排序、薪资区间和公司规模各取一批。`;
	const keyword = text$4(input.keyword, 60);
	const city = text$4(input.city, 40);
	const scope = [text$4(input.variant, 80), city ? `城市 ${city}` : ""].filter(Boolean).join(" · ");
	const target = [city, keyword].filter(Boolean).join(" / ");
	return `智联按「关键词 + 排序 + 薪资区间 + 公司规模」分片返回岗位：本批${scope ? `「${scope}」` : ""}已经翻到平台末尾（本批去重后 ${loaded} 个岗位）。这不是${target ? `「${target}」` : "该关键词"}的全部在招岗位；勾选「深挖更多岗位」再搜一批会自动换关键词、排序、薪资区间和公司规模，继续挖其他分片。`;
}
/** 页面当前生效的搜索词（小写）：优先取搜索引擎条件，其次取 queryParams.kw。 */
function zhaopinEffectiveKeyword(state) {
	return (text$4(state.searchKeyword, 80) || text$4(state.queryKeyword, 80)).toLowerCase();
}
function compactKeyword(value) {
	return String(value ?? "").replace(/[\s·・]+/g, "").toLowerCase();
}
function containsKeyword(haystack, needle) {
	if (!needle) return false;
	if (/^[a-z0-9+#.]+$/.test(needle)) {
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
	}
	return haystack.includes(needle);
}
/**
* 列表是否真的按这个关键词搜过。
*
* 地址栏 kw 只是请求参数：用户改了搜索框但没点搜索、或页面沿用了账号里的期望岗位，
* 列表会停在上一批结果，和地址栏完全对不上。这里只做口径判断，不绕过平台登录。
*/
function zhaopinKeywordApplied(state, keyword) {
	const requested = compactKeyword(keyword);
	if (!requested) return true;
	const effective = compactKeyword(zhaopinEffectiveKeyword(state));
	if (!effective) return false;
	return effective === requested || containsKeyword(requested, effective) || containsKeyword(effective, requested);
}
/** 岗位名里的职级/岗位后缀，去掉后才是核心技能词：「区块链开发」→「区块链」。 */
var KEYWORD_SUFFIX = /(?:开发工程师|开发|工程师|架构师|经理|主管|专员|总监|顾问|岗位|方向|应用|专家|助理|实习)$/;
function keywordTerms(keyword) {
	const raw = String(keyword ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return [];
	const terms = /* @__PURE__ */ new Set();
	const push = (value) => {
		const term = value.trim().toLowerCase();
		if (term.length >= 2) terms.add(term);
	};
	push(raw);
	const compact = raw.replace(/[\s·・]+/g, "");
	push(compact);
	for (const token of raw.match(/[a-z][a-z0-9+#.]{1,}/gi) ?? []) push(token);
	push(compact.replace(KEYWORD_SUFFIX, ""));
	return [...terms];
}
function keywordHit(haystack, term) {
	if (!term) return false;
	if (/^[a-z0-9+#.]+$/.test(term)) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(haystack);
	}
	return haystack.includes(term);
}
/**
* 智联搜索是全文匹配：JD / 公司介绍里出现过关键词的岗位都会返回，匿名时还会混入推荐岗位。
* 用户搜「区块链开发」要的是区块链岗位，不是 JD 里偶然提到一次的其他岗位，
* 所以只在岗位名和技能标签里核对关键词；命不中的由上层过滤并提示。
*/
function zhaopinKeywordRelevant(keyword, job) {
	const terms = keywordTerms(keyword);
	if (!terms.length) return true;
	const title = String(job?.title ?? "").toLowerCase();
	const tags = asList(job?.tags).map((tag) => String(tag ?? "")).join(" ").toLowerCase();
	return terms.some((term) => keywordHit(title, term) || keywordHit(tags, term));
}
/**
* 用页面自己的搜索框提交关键词。
*
* 只填输入框不会触发搜索：智联把关键词放在 Vue 的 queryParams 里，
* 必须走页面自己的搜索按钮（它内部会校验登录、人机验证和风控）。
*/
function zhaopinSubmitSearchScript(keyword) {
	return `(() => {
    const value = ${JSON.stringify(String(keyword ?? "").trim().slice(0, 60))};
    if (!value) return { ok: false, reason: "empty-keyword" };
    const input = document.querySelector("input.query-sug__input")
      || [...document.querySelectorAll("input")].find((element) => /搜索职位|搜索公司/.test(element.placeholder || ""));
    if (!input) return { ok: false, reason: "input-missing" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const button = document.querySelector("button.query-sug__button")
      || [...document.querySelectorAll("button")].find((element) => /^搜索$/.test(String(element.innerText || "").trim()));
    if (!button) return { ok: false, reason: "button-missing" };
    button.click();
    return { ok: true };
  })()`;
}
/**
* 在页面上下文里读新版列表状态。
*
* store 不存在时退回卡片上的 `__vue__.$props.job`（同一个数据源），
* 保证页面脚本版本变化时至少还能拿到第 1 页。
*/
function zhaopinPageStateScript(pageNumber) {
	return `(() => {
    const requested = Math.max(1, Math.round(Number(${JSON.stringify(pageNumber)}) || 1));
    const clean = (value, max = 400) => String(value ?? "").replace(/\\u0000/g, "").replace(/\\s+/g, " ").trim().slice(0, max);
    const asList = (value) => Array.isArray(value) ? value : [];
    const tagList = (value, max = 40) => asList(value).map((entry) => clean(
      entry && typeof entry === "object" ? (entry.name || entry.label || entry.tagName || "") : entry,
      max,
    )).filter(Boolean);
    const firstText = (...values) => {
      for (const value of values) {
        const result = clean(value, 400);
        if (result) return result;
      }
      return "";
    };
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    const state = (store && store.state) || window.__INITIAL_STATE__ || {};
    const cards = [...document.querySelectorAll(".job-card")];
    const cardJobs = cards
      .map((card) => card && card.__vue__ && card.__vue__.$props && card.__vue__.$props.job)
      .filter(Boolean);
    const source = asList(state.positionList).length ? asList(state.positionList) : cardJobs;
    const pageSize = Math.max(1, Number(state.pageSize) || 20);
    const start = (requested - 1) * pageSize;
    const pick = (position) => {
      const detail = position && position.jobDetailData && position.jobDetailData.position || {};
      const desc = detail.desc || {};
      const staff = position && position.staffCard || {};
      const date = detail.date || {};
      return {
        number: clean(position && position.number, 80),
        name: clean(position && position.name, 160),
        url: firstText(position && position.positionURL, position && position.positionUrl),
        salary: firstText(position && position.salary60, position && position.salaryReal, detail && detail.base && detail.base.salary),
        city: [
          clean(position && position.workCity, 40),
          clean(position && position.cityDistrict, 40),
          clean(position && position.tradingArea, 40),
        ].filter(Boolean).join("·"),
        education: clean(position && position.education, 40),
        experience: clean(position && position.workingExp, 40),
        company: clean(position && position.companyName, 120),
        industry: clean(position && position.industryName, 80),
        scale: clean(position && position.companySize, 40),
        stage: clean(position && position.financingStage, 40),
        recruiter: clean(staff.staffName, 60),
        recruiterTitle: clean(staff.hrJob, 60),
        recruiterActive: firstText(staff.hrStateInfo, staff.lastOnlineTimeText),
        online: Number(staff.hrOnlineIocState) === 1,
        skills: tagList(asList(position && position.jobSkillTags).map((skill) => skill && skill.name || skill)),
        labels: tagList(desc.labels),
        welfare: [...tagList(position && position.welfareLabel), ...tagList(desc.welfareLabel), ...tagList(desc.welfareTags)],
        publishText: clean(date.positionUpdateTimeText, 40),
        publishTime: firstText(position && position.publishTime, date.positionPublishTime, date.positionUpdateTime),
        description: clean(firstText(desc.description, position && position.jobDescription), 1500),
        proxy: Boolean(position && (position.rpoProxy === true || position.rpoProxied === true)),
      };
    };
    const user = state.user || {};
    const cookies = state.cookiesData || {};
    // 真正决定列表内容的搜索条件在 statBaseData.search_condition 里（JSON 字符串，
    // S_SOU_FULL_INDEX 就是提交给搜索引擎的词）；queryParams.kw 只是地址栏参数，
    // 改输入框不点搜索时两者会不一致，必须分开读。
    const conditionKeyword = (() => {
      const raw = state.statBaseData && state.statBaseData.search_condition;
      if (!raw) return "";
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return clean(parsed && (parsed.S_SOU_FULL_INDEX || parsed.kw || parsed.keyword), 80);
      } catch (error) {
        return clean(String(raw).replace(/^S_SOU_[A-Z_]*[:_]?/i, ""), 80);
      }
    })();
    return {
      positions: source.slice(start, start + pageSize).map(pick),
      loaded: source.length,
      pageIndex: Math.max(0, Number(state.pageIndex) || (source.length ? Math.ceil(source.length / pageSize) : 0)),
      pageSize,
      hasMore: state.hasMore === true,
      loadingMore: state.loadingMore === true,
      positionCount: Math.max(0, Number(state.positionCount) || 0),
      loggedIn: Boolean(user.userId && cookies.at && cookies.rt),
      url: location.href,
      queryKeyword: clean(state.queryParams && state.queryParams.kw, 80),
      searchKeyword: conditionKeyword,
      pageMode: clean(state.pageMode, 20),
    };
  })()`;
}
/**
* 智联详情页头部的「消息」入口。
*
* 页头是 SPA 路由，anchor 的 href 常常直接指向首页（打开 /message/ 也会回首页），
* 所以这里只在 href 真的指向消息路由时才返回；否则由调用方直接点这个入口。
*/
function zhaopinMessageUrlScript() {
	return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (!visible(anchor)) continue;
      const label = String(anchor.innerText || anchor.textContent || "").replace(/\\s+/g, "").trim();
      // 页头入口是「消息」或「消息13」（未读角标拼在同一个节点里）。
      if (!/^消息\\d*\\+?$/.test(label)) continue;
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!/^https:\\/\\/(?:[\\w-]+\\.)*zhaopin\\.com\\//i.test(href)) continue;
      if (!/\\/message(?:[/?#]|$)/i.test(href)) continue;
      return href;
    }
    return "";
  })()`;
}
/**
* 智联投递弹窗里的简历选择。
*
* 第一次投递时平台会弹「选择简历」，不选中就点「立即投递」不会有任何反应；
* 选过一次之后平台会记住默认简历，这个脚本会直接返回 selected=false，不做多余点击。
* 只处理弹窗内部，且跳过成功弹窗和登录弹窗，避免把结果提示当成简历选项点掉。
*/
function zhaopinResumeSelectScript() {
	return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "");
    const areaOf = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const dialogs = [...document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"], [class*="popup"], [class*="pop"], [class*="drawer"], [class*="layer"]')]
      .filter(visible)
      .filter((element) => {
        const value = clean(element);
        if (!value || value.length > 600) return false;
        if (!/简历|投递|申请/.test(value)) return false;
        // 成功回执和登录浮层不是简历选择弹窗。
        if (/已向对方发送简历|投递成功|申请成功|已投递过|登录|手机号|验证码/.test(value)) return false;
        return true;
      })
      .sort((left, right) => areaOf(left) - areaOf(right));
    const dialog = dialogs[0];
    if (!dialog) return { found: false, selected: false };
    const checked = [...dialog.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"]')]
      .some((element) => element.checked === true
        || element.getAttribute("aria-checked") === "true"
        || /checked|selected|active/i.test(String(element.className || "")));
    if (checked) return { found: true, selected: false };
    const options = [...dialog.querySelectorAll('label, li, [class*="resume"], [class*="radio"], [class*="select"], [class*="option"], [class*="check"], [role="radio"]')]
      .filter(visible)
      .filter((element) => /简历|在线简历|附件/.test(clean(element)))
      .sort((left, right) => areaOf(left) - areaOf(right));
    let target = options[0];
    if (!target) {
      // 实在找不到带类名的选项时，退回「弹窗里写着简历的最小节点」，点它最近的选项容器。
      const leaf = [...dialog.querySelectorAll("div, span, p, strong")]
        .filter(visible)
        .filter((element) => {
          const value = clean(element);
          return value.length > 0 && value.length <= 30 && /在线简历|附件简历|简历/.test(value);
        })
        .sort((left, right) => areaOf(left) - areaOf(right))[0];
      target = leaf?.closest('label, li, [role="radio"], [class*="item"], [class*="option"]') || leaf?.parentElement || leaf;
    }
    if (!target) return { found: true, selected: false };
    target.click();
    return { found: true, selected: true };
  })()`;
}
/** 消息列表页的可见文案 + 会话条目；条目文本用于把「投递回执」和具体岗位绑在一起。 */
function zhaopinMessageProbeScript() {
	return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
    const items = [];
    for (const element of document.querySelectorAll('li, [class*="message"], [class*="chat"], [class*="session"], [class*="conversation"], [class*="contact"], [class*="item"], [class*="card"]')) {
      if (!visible(element)) continue;
      const value = textOf(element);
      if (value.length >= 6 && value.length <= 400) items.push(value);
    }
    return {
      url: location.href,
      items: [...new Set(items)].slice(0, 120),
      body: String(document.body?.innerText || "").slice(0, 20000),
    };
  })()`;
}
/**
* 在消息列表里找「这个岗位刚投出去」的回执。
*
* 智联投递后会在消息列表留一条会话，副标题是「您已投递的 <岗位名>」或
* 「已发送附件简历」。必须同时看到岗位名（和公司名，如果有）才算，
* 不能只看整页有没有「已投递」——同一个账号里还有别的岗位的历史记录。
*/
function zhaopinMessageRecord(probe, job) {
	const source = probe && typeof probe === "object" ? probe : null;
	if (!source) return "";
	const compact = (value) => String(value ?? "").replace(/\s+/g, "");
	const title = compact(job.title);
	const company = compact(job.company);
	if (title.length < 2 && company.length < 2) return "";
	const receipt = /已投递|已发送附件简历|投递成功|已发送简历|投递了/;
	const matches = (value) => {
		const text = compact(value);
		if (!text || !receipt.test(text)) return false;
		const hasTitle = title.length >= 2 && text.includes(title);
		const hasCompany = company.length >= 2 && text.includes(company);
		return company.length >= 2 ? hasTitle && hasCompany : hasTitle;
	};
	for (const item of Array.isArray(source.items) ? source.items : []) if (matches(item)) return compact(item).slice(0, 80);
	const body = compact(source.body);
	for (const key of [title, company]) {
		if (key.length < 2) continue;
		const index = body.indexOf(key);
		if (index < 0) continue;
		if (matches(body.slice(Math.max(0, index - 80), index + key.length + 160))) return key;
	}
	return "";
}
/**
* 让页面自己的搜索 action 拉取指定页。
*
* 智联首屏是 SSR，`hasMore` 可能在页面水合完成前固定成 false（或者沿用缓存的匿名页），
* 此时 `loadMoreJobList` 会被这个旧标记挡住，但窗口里手动下滑却能继续加载。
* 这里复用页面自己的 `fetchSearchList`：它按当前 queryParams 请求下一页、追加列表并重算
* hasMore；action 内部仍会校验登录，不会绕过平台限制。
*/
function zhaopinFetchSearchPageScript(pageIndex) {
	return `(() => {
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    if (!store || typeof store.dispatch !== "function") return Promise.resolve({ ok: false, reason: "store-missing" });
    const index = Math.max(1, Math.round(Number(${JSON.stringify(pageIndex)}) || 1));
    return store.dispatch("fetchSearchList", { pageIndex: index, skipKeywordCompanySearch: true })
      .then((list) => ({ ok: Array.isArray(list) && list.length > 0, length: Array.isArray(list) ? list.length : 0 }))
      .catch((error) => ({ ok: false, reason: String(error && error.message || error).slice(0, 200) }));
  })()`;
}
/** 调用页面自己的「加载更多」；未登录 / 没有更多时按平台规则直接返回 false。 */
function zhaopinLoadMoreScript() {
	return `(() => {
    const root = document.getElementById("root");
    const store = root && root.__vue__ && root.__vue__.$store;
    if (!store || typeof store.dispatch !== "function") return { ok: false, reason: "store-missing" };
    const state = store.state || {};
    if (state.loadingMore === true) return { ok: false, reason: "loading" };
    if (state.hasMore !== true) return { ok: false, reason: "no-more" };
    try {
      const result = store.dispatch("loadMoreJobList");
      if (result && typeof result.then === "function") {
        return result.then(() => ({ ok: true })).catch((error) => ({
          ok: false,
          reason: String(error && error.message || error).slice(0, 200),
        }));
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error).slice(0, 200) };
    }
  })()`;
}
//#endregion
//#region ../../plugins/interview-assistant/engine/scripts.ts
function extractionScript(site) {
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
function probeScript(site) {
	return `(() => {
    const selectors = ${JSON.stringify({
		boss: [
			"li.job-card-box",
			".job-card-wrapper",
			".job-card-box"
		],
		liepin: ["div[class*=\"jobCardPcContainer\"]"],
		zhaopin: [
			".job-card",
			"div[class*=\"joblist-box__item\"]",
			".joblist-box__item"
		],
		job51: [".joblist-item"]
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
function detailScript(site) {
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
function postedScript() {
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
function bossApiFetchScript(form) {
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
function job51ApiFetchScript(url) {
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
//#endregion
//#region ../../plugins/interview-assistant/engine/search.ts
var RESULT_WAIT_MS = 3e4;
var EVAL_TIMEOUT_MS = 8e3;
/** 与主进程保持一致：Boss 翻页接口之间的间隔，避免连续请求触发风控。 */
var BOSS_PAGE_PAUSE_MS = 1600;
var DEEP_SEARCH_BUDGET_MS = 12e4;
var CLOSED_WINDOW_NOTE = "招聘窗口已关闭，已加载的岗位都保留；重新打开窗口后可以继续搜索";
function text$3(value, max = 1e3) {
	return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}
function sleep$2(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}
function isHttpUrl$1(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function normalizeKeywords(input) {
	const values = [...Array.isArray(input.keywords) ? input.keywords : [], input.keyword ?? ""].flatMap((entry) => text$3(entry, 80).split(/[|,，、;；\n]/)).map((entry) => entry.trim()).filter(Boolean);
	return [...new Set(values)].slice(0, 10);
}
/**
* 招聘平台搜索 / 详情读取引擎。
*
* 业务逻辑（关键词扩展、公司规模轮换、逐站翻页方式、结果去重、薪资回补）
* 全部在插件这一侧；宿主只执行页面脚本、导航和接口旁路监听。
*/
var JobSiteSearchEngine = class {
	deps;
	runtimes = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	get driver() {
		return this.deps.driver;
	}
	log(line) {
		this.deps.log?.(`[job-engine] ${line}`);
	}
	runtime(site) {
		let runtime = this.runtimes.get(site);
		if (!runtime) {
			runtime = {
				site,
				blocked: "",
				loginState: "",
				message: JOB_SITES[site].note,
				lastSearchAt: 0,
				lastCheckedAt: 0
			};
			this.runtimes.set(site, runtime);
		}
		return runtime;
	}
	/** 投递 / 打招呼流程也共用同一份窗口状态，登录墙与验证码要显示在同一个状态条里。 */
	markBlocked(site, blocked, message) {
		const runtime = this.runtime(site);
		runtime.blocked = blocked;
		runtime.lastCheckedAt = Date.now();
		if (message) runtime.message = message;
	}
	runtimeMessage(site) {
		return this.runtime(site).message;
	}
	/** 打招呼流程自己判出登录态（Boss 匿名页没有登录墙文案，只能看登录入口）时同步给状态条。 */
	markLoginState(site, loginState) {
		const runtime = this.runtime(site);
		runtime.loginState = loginState;
		runtime.lastCheckedAt = Date.now();
	}
	async statuses() {
		const base = await this.driver.statusAll().catch(() => []);
		const bySite = new Map((Array.isArray(base) ? base : []).map((entry) => [String(entry?.site ?? ""), entry]));
		return JOB_SITE_IDS.map((site) => {
			const open = Boolean(bySite.get(site)?.open);
			const runtime = this.runtimes.get(site);
			if (!runtime) return bySite.get(site) ?? {
				site,
				label: jobSiteLabel(site),
				open: false,
				loginState: "",
				blocked: "",
				message: JOB_SITES[site].note,
				lastSearchAt: 0,
				lastCheckedAt: 0
			};
			return {
				site,
				label: jobSiteLabel(site),
				open,
				loginState: open ? runtime.loginState : "",
				blocked: open ? runtime.blocked : "",
				message: open ? runtime.message : JOB_SITES[site].note,
				lastSearchAt: open ? runtime.lastSearchAt : 0,
				lastCheckedAt: open ? runtime.lastCheckedAt : 0
			};
		});
	}
	async open(site) {
		const status = await this.driver.open(site);
		const runtime = this.runtime(site);
		runtime.loginState = status?.loginState ?? runtime.loginState;
		runtime.blocked = status?.blocked ?? "";
		runtime.message = status?.message ?? JOB_SITES[site].note;
		runtime.lastCheckedAt = Date.now();
		return status;
	}
	async close(site) {
		await this.driver.close(site);
		const runtime = this.runtime(site);
		runtime.blocked = "";
		runtime.message = JOB_SITES[site].note;
		return { closed: true };
	}
	async refresh() {
		const items = await this.driver.refresh().catch(() => []);
		for (const entry of Array.isArray(items) ? items : []) {
			const site = entry?.site;
			if (!JOB_SITE_IDS.includes(site)) continue;
			const runtime = this.runtime(site);
			if (!entry.open) continue;
			runtime.loginState = entry.loginState ?? runtime.loginState;
			runtime.blocked = entry.blocked ?? "";
			runtime.message = String(entry.message ?? runtime.message);
			runtime.lastCheckedAt = Number(entry.lastCheckedAt) || Date.now();
		}
		return this.statuses();
	}
	async waitForResults(site, timeoutMs = RESULT_WAIT_MS) {
		const deadline = Date.now() + timeoutMs;
		let last = {
			cards: 0,
			body: "",
			url: "",
			title: "",
			blocked: ""
		};
		while (Date.now() < deadline) {
			if (await this.driver.isClosed(site).catch(() => true)) break;
			const probe = await this.driver.evaluate(site, probeScript(site), EVAL_TIMEOUT_MS).catch(() => void 0);
			if (probe) last = {
				...probe,
				blocked: ""
			};
			const blocked = classifyBlocked(last.url, last.body, { ignoreLoginText: site === "boss" });
			if (blocked === "verification") return {
				...last,
				blocked
			};
			if (last.cards > 0) {
				await sleep$2(800);
				return {
					...last,
					blocked: ""
				};
			}
			if (blocked === "login") {
				this.log(`${site} blocked=login url=${text$3(last.url, 160)}`);
				return {
					...last,
					blocked
				};
			}
			await sleep$2(1200);
		}
		return {
			...last,
			blocked: classifyBlocked(last.url, last.body, { ignoreLoginText: site === "boss" })
		};
	}
	async searchOne(site, keyword, city, code, pageNumber, expectedTotal = 0, plan) {
		const first = await this.searchOnePage(site, keyword, city, code, pageNumber, expectedTotal, plan);
		if (first.blocked || site === "boss" && pageNumber > 1 || !isSalarySparse(first.items)) return first;
		const firstCoverage = salaryCoverage(first.items);
		this.log(`${site} "${keyword}" salary sparse (${firstCoverage.unknown}/${firstCoverage.total}), retrying once`);
		await sleep$2(site === "job51" ? 5e3 : 1500);
		const retry = await this.searchOnePage(site, keyword, city, code, pageNumber, expectedTotal, plan);
		if (retry.blocked) return {
			...first,
			salaryNote: `本页薪资几乎全是「面议」，自动重搜时平台要求${retry.blocked === "verification" ? "人机验证" : "先登录"}；这里先展示重搜前的结果，处理好后可以再搜一次。`
		};
		const retryCoverage = salaryCoverage(retry.items);
		if (retryCoverage.known > firstCoverage.known) {
			this.log(`${site} "${keyword}" salary retry recovered ${retryCoverage.known}/${retryCoverage.total}`);
			return {
				...retry,
				salaryNote: `第一次搜索的薪资几乎全是「面议」，已自动重搜，恢复了 ${retryCoverage.known} 个带薪资的岗位${retryCoverage.unknown ? `，另有 ${retryCoverage.unknown} 个仍为面议` : ""}。`
			};
		}
		return {
			...first,
			salaryNote: `本页 ${first.items.length} 个岗位里有 ${firstCoverage.unknown} 个薪资显示「面议」，可能是平台没把薪资带出来；已自动重搜一次仍未改善，建议重新搜索或换关键词。`
		};
	}
	/** Boss 第 2 页起：在页面上下文里请求列表接口（与页面自己的翻页参数一致）。 */
	async searchBossApiPage(keyword, city, code, pageNumber, expectedTotal = 0, scale = "") {
		const site = "boss";
		if (await this.driver.isClosed(site).catch(() => true)) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: CLOSED_WINDOW_NOTE
		};
		const currentUrl = await this.driver.url(site).catch(() => "");
		if (!/(^|\.)zhipin\.com$/i.test(hostOf(currentUrl))) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: CLOSED_WINDOW_NOTE
		};
		await this.driver.title(site, `${jobSiteLabel(site)} · 正在加载第 ${pageNumber} 页`).catch(() => void 0);
		this.log(`boss api page ${pageNumber} "${keyword}" city=${city || "全国"}`);
		const form = bossSearchForm({
			keyword,
			cityCode: code,
			page: pageNumber,
			scale
		});
		const response = await this.driver.evaluate(site, bossApiFetchScript(form), 15e3).catch(() => void 0);
		if (!response) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			note: `Boss 第 ${pageNumber} 页在预期时间内没有返回，可能是网络波动；稍后可以再点一次继续加载。`
		};
		const info = bossPageInfo(response.json);
		if (!response.ok || !response.json) {
			const failure = classifyBossPageFailure(info.code || response.status, info.message);
			const pageBlocked = failure.blocked ? "" : await this.driver.blocker(site).catch(() => "");
			const blocked = failure.blocked || (pageBlocked === "verification" || pageBlocked === "login" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl) ? pageBlocked : "") || (response.status === 401 || response.status === 403 ? "login" : "");
			if (blocked) {
				this.log(`boss api page ${pageNumber} blocked=${blocked} status=${response.status}`);
				return {
					items: [],
					rawCount: 0,
					cards: 0,
					blocked
				};
			}
			this.log(`boss api page ${pageNumber} failed status=${response.status} ${text$3(info.message || response.raw, 120)}`);
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "",
				stop: true,
				note: `「${keyword}」第 ${pageNumber} 页：${failure.note || `Boss 列表接口返回 HTTP ${response.status}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`}`
			};
		}
		if (info.code !== 0) {
			const failure = classifyBossPageFailure(info.code, info.message);
			const pageBlocked = failure.blocked ? "" : await this.driver.blocker(site).catch(() => "");
			if (pageBlocked === "verification" || pageBlocked === "login" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl)) {
				this.log(`boss api page ${pageNumber} code=${info.code} pageBlocked=${pageBlocked}`);
				return {
					items: [],
					rawCount: 0,
					cards: 0,
					blocked: pageBlocked
				};
			}
			this.log(`boss api page ${pageNumber} code=${info.code} message=${text$3(info.message, 120)} blocked=${failure.blocked || "-"} stop=${failure.stop}`);
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: failure.blocked,
				stop: failure.stop,
				note: failure.note ? `「${keyword}」第 ${pageNumber} 页：${failure.note}` : ""
			};
		}
		const rawItems = bossJobListItems(response.json).map((entry) => mapBossListItem(entry)).filter((entry) => Boolean(entry));
		if (!rawItems.length) {
			const loginState = await this.driver.loginState(site).catch(() => "");
			const runtime = this.runtime(site);
			if (loginState === "out") runtime.loginState = "out";
			if (loginState === "out" && /\/login|\/signin|\/passport|\/sso|web\/user\/?\?|login\./i.test(currentUrl)) return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "login"
			};
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "",
				hasMore: false,
				total: info.total,
				limitedByLogin: loginState === "out",
				note: loginState === "out" ? `Boss 第 ${pageNumber} 页起需要登录后才能继续加载；已加载的岗位都保留，登录后可以再点「继续加载」。` : expectedTotal > pageNumber * 15 ? `Boss 显示还有更多岗位，但第 ${pageNumber} 页没有返回数据；可能是平台限制，建议在窗口里确认登录状态后再试。` : ""
			};
		}
		const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob("boss", entry)).filter((entry) => Boolean(entry)));
		return {
			items: !resolveCityCode("boss", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs,
			rawCount: rawItems.length,
			cards: rawItems.length,
			blocked: "",
			total: info.total
		};
	}
	/** 前程无忧第 2 页起：在页面上下文里请求列表接口。 */
	async searchJob51ApiPage(keyword, city, code, pageNumber, plan) {
		const site = "job51";
		if (await this.driver.isClosed(site).catch(() => true)) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: CLOSED_WINDOW_NOTE
		};
		const currentUrl = await this.driver.url(site).catch(() => "");
		if (!/(^|\.)51job\.com$/i.test(hostOf(currentUrl))) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: `「${keyword}」第 ${pageNumber} 页：招聘窗口已经离开前程无忧搜索页，请回到岗位池重新搜索。`
		};
		await this.driver.title(site, `${jobSiteLabel(site)} · 正在加载第 ${pageNumber} 页`).catch(() => void 0);
		this.log(`job51 api page ${pageNumber} "${keyword}" city=${city || "全国"}`);
		const url = job51SearchApiUrl({
			keyword,
			areaCode: code,
			page: pageNumber,
			sortType: plan.sortType,
			requestId: this.runtime(site).job51RequestId,
			companySize: plan.scale
		});
		const response = await this.driver.evaluate(site, job51ApiFetchScript(url), 15e3).catch(() => void 0);
		if (!response) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			note: `「${keyword}」第 ${pageNumber} 页在预期时间内没有返回，可能是网络波动；稍后可以再点一次「继续加载」。`
		};
		const info = job51PageInfo(response.json);
		if (!response.ok || !response.json) {
			const blocked = await this.driver.blocker(site).catch(() => "") || (response.status === 401 || response.status === 403 ? "login" : "");
			if (blocked) {
				this.log(`job51 api page ${pageNumber} blocked=${blocked} status=${response.status}`);
				return {
					items: [],
					rawCount: 0,
					cards: 0,
					blocked
				};
			}
			this.log(`job51 api page ${pageNumber} failed status=${response.status} ${text$3(response.raw, 120)}`);
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "",
				stop: true,
				note: `「${keyword}」第 ${pageNumber} 页：前程无忧列表接口返回 HTTP ${response.status}，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`
			};
		}
		if (info.status && info.status !== "1") {
			if (/登录|login/i.test(info.message)) return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "login"
			};
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "",
				stop: true,
				note: `「${keyword}」第 ${pageNumber} 页：前程无忧返回「${info.message || info.status}」，本批翻页已停止；已加载的岗位都保留，稍后可以再点「继续加载」。`
			};
		}
		const rawItems = job51SearchItems(response.json).map((entry) => mapJob51ListItem(entry)).filter((entry) => Boolean(entry));
		const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob("job51", entry)).filter((entry) => Boolean(entry)));
		return {
			items: !resolveCityCode("job51", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs,
			rawCount: rawItems.length,
			cards: rawItems.length,
			blocked: "",
			total: info.total || void 0
		};
	}
	/**
	* 智联新版搜索：翻页交给页面自己的 loadMoreJobList / fetchSearchList。
	* SSR 首屏的 hasMore 可能停在水合前的旧值，不能当成「没有下一页」；
	* 登录态下先用页面自己的 fetchSearchList 重算，只有列表真的不再增长才判定结束。
	*/
	async searchZhaopinPage(keyword, city, code, pageNumber, plan) {
		const site = "zhaopin";
		if (await this.driver.isClosed(site).catch(() => true)) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: CLOSED_WINDOW_NOTE
		};
		const url = JOB_SITES.zhaopin.searchUrl(keyword, code, pageNumber, plan);
		await this.driver.title(site, `${jobSiteLabel(site)} · 正在搜索 ${keyword}`).catch(() => void 0);
		this.log(`search zhaopin "${keyword}" city=${city || "全国"} page=${pageNumber} variant=${plan.label || "-"}`);
		const currentUrl = await this.driver.url(site).catch(() => "");
		const sameQuery = (() => {
			try {
				const current = new URL(currentUrl);
				const target = new URL(url);
				return /(^|\.)zhaopin\.com$/i.test(current.hostname) && current.pathname.startsWith("/jobs") && current.searchParams.get("kw") === target.searchParams.get("kw") && (current.searchParams.get("jl") ?? "") === (target.searchParams.get("jl") ?? "") && (current.searchParams.get("order") ?? "") === (target.searchParams.get("order") ?? "") && (current.searchParams.get("sl") ?? "") === (target.searchParams.get("sl") ?? "") && (current.searchParams.get("cs") ?? "") === (target.searchParams.get("cs") ?? "");
			} catch {
				return false;
			}
		})();
		if (pageNumber <= 1 || !sameQuery) {
			await this.driver.goto(site, url, { attempts: 1 }).catch((error) => {
				this.log(`zhaopin search slow: ${text$3(error?.message ?? error, 120)}`);
			});
			const waited = await this.waitForResults("zhaopin", pageNumber > 1 ? 15e3 : RESULT_WAIT_MS);
			if (waited.blocked) return {
				items: [],
				rawCount: 0,
				cards: waited.cards,
				blocked: waited.blocked
			};
		}
		let state = zhaopinPageState(await this.driver.evaluate(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
		const cookieLoggedIn = await this.driver.tokenState(site).catch(() => "") === "in";
		const pageLoggedIn = state.loggedIn || cookieLoggedIn;
		const runtime = this.runtime(site);
		if (pageLoggedIn && (runtime.loginState !== "in" || runtime.blocked === "login")) {
			runtime.loginState = "in";
			runtime.blocked = "";
			runtime.lastCheckedAt = Date.now();
			runtime.message = `${jobSiteLabel(site)}已登录，浏览器窗口可以继续搜索或投递`;
		}
		if (!zhaopinKeywordApplied(state, keyword)) {
			this.log(`zhaopin keyword mismatch want="${text$3(keyword, 40)}" got="${text$3(zhaopinEffectiveKeyword(state), 40)}" loaded=${state.loaded}`);
			const submitted = await this.driver.evaluate(site, zhaopinSubmitSearchScript(keyword), EVAL_TIMEOUT_MS).catch(() => void 0);
			if (submitted?.ok) {
				const waited = await this.waitForResults("zhaopin", RESULT_WAIT_MS);
				if (waited.blocked) return {
					items: [],
					rawCount: 0,
					cards: waited.cards,
					blocked: waited.blocked
				};
				const keywordDeadline = Date.now() + 12e3;
				while (Date.now() < keywordDeadline) {
					state = zhaopinPageState(await this.driver.evaluate(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
					if (zhaopinKeywordApplied(state, keyword)) break;
					await sleep$2(600);
				}
			}
			this.log(`zhaopin keyword submit ok=${zhaopinKeywordApplied(state, keyword) ? 1 : 0} got="${text$3(zhaopinEffectiveKeyword(state), 40)}" loaded=${state.loaded}${submitted?.ok ? "" : ` reason=${text$3(submitted?.reason, 60) || "eval-error"}`}`);
		}
		let primed = false;
		if (pageLoggedIn && state.hasMore !== true && state.pageIndex <= 1) {
			const refreshed = await this.driver.evaluate(site, zhaopinFetchSearchPageScript(1), 25e3).catch(() => void 0);
			primed = refreshed?.ok === true;
			this.log(`zhaopin prime hasMore ok=${primed ? 1 : 0} length=${refreshed?.length ?? 0} loaded=${state.loaded} count=${state.positionCount || "-"} page=${pageNumber}${refreshed?.reason ? ` reason=${text$3(refreshed.reason, 80)}` : ""}`);
			if (primed) {
				await sleep$2(600);
				state = zhaopinPageState(await this.driver.evaluate(site, zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
			}
		}
		const remainingPages = Math.max(0, pageNumber - state.pageIndex);
		const deadline = Date.now() + Math.min(18e4, 3e4 + remainingPages * 1e4);
		let grewAny = false;
		while (state.pageIndex < pageNumber && pageLoggedIn && Date.now() < deadline) {
			const previous = state.loaded;
			const dispatched = await this.driver.evaluate(site, zhaopinLoadMoreScript(), 2e4).catch(() => void 0);
			let via = "loadMore";
			if (!dispatched?.ok) {
				if (dispatched?.reason === "loading") {
					state = await this.waitForZhaopinState(pageNumber, previous);
					continue;
				}
				const nextPage = Math.max(1, Math.min(pageNumber, state.pageIndex + 1));
				via = "fetch";
				const fetched = await this.driver.evaluate(site, zhaopinFetchSearchPageScript(nextPage), 25e3).catch(() => void 0);
				if (!fetched?.ok) {
					this.log(`zhaopin paging stopped page=${nextPage} loadMore=${dispatched?.reason || "error"} fetch=${fetched?.reason || "empty"}`);
					break;
				}
			}
			state = await this.waitForZhaopinState(pageNumber, previous);
			if (state.loaded <= previous) {
				this.log(`zhaopin paging no growth page=${pageNumber} via=${via} loaded=${state.loaded} index=${state.pageIndex} hasMore=${state.hasMore ? 1 : 0}`);
				break;
			}
			grewAny = true;
		}
		const parsedItems = state.positions.map((entry) => mapZhaopinPosition(entry)).filter((entry) => Boolean(entry));
		const rawItems = parsedItems.filter((entry) => zhaopinKeywordRelevant(keyword, {
			title: entry.title,
			tags: entry.tags
		}));
		const keywordFiltered = parsedItems.length - rawItems.length;
		const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob("zhaopin", entry)).filter((entry) => Boolean(entry)));
		const items = !resolveCityCode("zhaopin", city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs;
		const reached = state.pageIndex >= pageNumber;
		const hasMore = reached && (state.hasMore === true || grewAny);
		this.log(`zhaopin state page=${pageNumber} loaded=${state.loaded} index=${state.pageIndex} size=${state.pageSize} count=${state.positionCount || "-"} hasMore=${state.hasMore ? 1 : 0} prime=${primed ? 1 : 0} grew=${grewAny ? 1 : 0} login=${pageLoggedIn ? 1 : 0}`);
		let note = "";
		const limitedByLogin = zhaopinLimitedByLogin({
			...state,
			loggedIn: pageLoggedIn
		});
		if (!reached && pageNumber > 1) note = limitedByLogin ? `「${keyword}」第 ${pageNumber} 页：智联新版列表需要登录后才能继续加载；已加载的前 ${state.loaded} 个岗位都保留，登录后可以再点「继续加载」。` : hasMore ? `「${keyword}」第 ${pageNumber} 页：智联没有返回更多岗位，稍后可以再点「继续加载」。` : `「${keyword}」第 ${pageNumber} 页：平台没有更多岗位了。`;
		else if (!pageLoggedIn && state.loaded) note = zhaopinSliceNote({
			keyword,
			loaded: state.loaded || state.pageSize,
			anonymous: true
		});
		return {
			items,
			rawCount: parsedItems.length,
			cards: state.loaded,
			blocked: "",
			hasMore,
			limitedByLogin,
			keywordFiltered,
			note
		};
	}
	async waitForZhaopinState(pageNumber, previousLoaded) {
		const deadline = Date.now() + 15e3;
		let state = zhaopinPageState(await this.driver.evaluate("zhaopin", zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
		while (Date.now() < deadline) {
			if (await this.driver.isClosed("zhaopin").catch(() => true)) return state;
			if (state.pageIndex >= pageNumber || state.loaded >= pageNumber * state.pageSize) return state;
			if (state.loaded > previousLoaded && !state.loadingMore) return state;
			if (!state.loadingMore && !state.hasMore) return state;
			await sleep$2(400);
			state = zhaopinPageState(await this.driver.evaluate("zhaopin", zhaopinPageStateScript(pageNumber), EVAL_TIMEOUT_MS).catch(() => null) ?? null);
		}
		return state;
	}
	async searchOnePage(site, keyword, city, code, pageNumber, expectedTotal = 0, plan) {
		if (site === "zhaopin") return this.searchZhaopinPage(keyword, city, code, pageNumber, plan);
		if (site === "boss" && pageNumber > 1) return this.searchBossApiPage(keyword, city, code, pageNumber, expectedTotal, plan.scale);
		if (site === "job51" && pageNumber > 1) return this.searchJob51ApiPage(keyword, city, code, pageNumber, plan);
		if (await this.driver.isClosed(site).catch(() => true)) return {
			items: [],
			rawCount: 0,
			cards: 0,
			blocked: "",
			stop: true,
			note: CLOSED_WINDOW_NOTE
		};
		const url = JOB_SITES[site].searchUrl(keyword, code, pageNumber, plan);
		await this.driver.title(site, `${jobSiteLabel(site)} · 正在搜索 ${keyword}`).catch(() => void 0);
		this.log(`search ${site} "${keyword}" city=${city || "全国"}`);
		let waited = {
			cards: 0,
			body: "",
			url: "",
			title: "",
			blocked: ""
		};
		let bossPayloads = [];
		let job51Payloads = [];
		if (site === "boss" || site === "job51") {
			if (site === "job51") this.runtime(site).job51RequestId = "";
			const token = await this.driver.captureStart(site, site === "boss" ? "/\\/wapi\\/zpgeek\\/search\\/joblist\\.json/i" : "/\\/api\\/job\\/search-pc/i").catch(() => "");
			try {
				await this.driver.goto(site, url, { attempts: 1 }).catch((error) => {
					this.log(`${site} search slow: ${text$3(error?.message ?? error, 120)}`);
				});
				waited = await this.waitForResults(site, pageNumber > 1 ? 15e3 : RESULT_WAIT_MS);
				await sleep$2(site === "job51" ? 5e3 : 1e3);
			} finally {
				const payloads = token ? await this.driver.captureStop(token, 2500).catch(() => []) : [];
				if (site === "boss") bossPayloads = payloads;
				else job51Payloads = payloads;
			}
		} else {
			await this.driver.goto(site, url, { attempts: 1 }).catch((error) => {
				this.log(`${site} search slow: ${text$3(error?.message ?? error, 120)}`);
			});
			waited = await this.waitForResults(site, pageNumber > 1 ? 15e3 : RESULT_WAIT_MS);
		}
		if (waited.blocked) return {
			items: [],
			rawCount: 0,
			cards: waited.cards,
			blocked: waited.blocked
		};
		if (site === "boss" && !waited.cards && await this.driver.hasLoginDialog(site).catch(() => false)) {
			this.log("boss search page shows a login dialog");
			return {
				items: [],
				rawCount: 0,
				cards: 0,
				blocked: "login"
			};
		}
		const apiItems = bossPayloads.flatMap((payload) => bossJobListItems(payload)).map((entry) => mapBossListItem(entry)).filter((entry) => Boolean(entry));
		const job51Items = job51Payloads.flatMap((payload) => job51SearchItems(payload));
		if (site === "job51") {
			const requestId = job51Payloads.map((payload) => job51PageInfo(payload).requestId).find(Boolean);
			if (requestId) this.runtime(site).job51RequestId = requestId;
		}
		let rawItems = apiItems.length ? apiItems : await (async () => {
			for (let round = 0; round < 2; round += 1) {
				await this.driver.evaluate(site, `(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()`, EVAL_TIMEOUT_MS).catch(() => void 0);
				await sleep$2(1200);
			}
			return await this.driver.evaluate(site, extractionScript(site), EVAL_TIMEOUT_MS).catch(() => []) ?? [];
		})();
		if (site === "job51") {
			const hrefById = /* @__PURE__ */ new Map();
			for (const item of job51Items) {
				const id = job51JobIdOf(item?.jobId);
				const href = normalizeJob51DetailUrl(item?.jobHref);
				if (id && href) hrefById.set(id, href);
			}
			if (!rawItems.length && job51Items.length) rawItems = job51Items.map((item) => mapJob51ListItem(item)).filter((entry) => Boolean(entry));
			else if (hrefById.size) rawItems = rawItems.map((entry) => {
				const id = job51JobIdOf(entry.jobId) || job51JobIdOf(entry.url);
				const href = id ? hrefById.get(id) ?? "" : "";
				return href ? {
					...entry,
					url: href,
					jobId: id
				} : entry;
			});
		}
		const jobs = dedupeSiteJobs(rawItems.map((entry) => mapRawSiteJob(site, entry)).filter((entry) => Boolean(entry)));
		const bossTotal = site === "boss" && apiItems.length ? Math.max(0, ...bossPayloads.map((payload) => bossPageInfo(payload).total)) : 0;
		return {
			items: !resolveCityCode(site, city).mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs,
			rawCount: rawItems.length,
			cards: waited.cards,
			blocked: "",
			total: bossTotal || void 0
		};
	}
	async search(raw) {
		if (!JOB_SITE_IDS.includes(raw?.site)) throw new Error("不支持的招聘平台");
		const site = raw.site;
		const baseKeywords = normalizeKeywords(raw);
		if (!baseKeywords.length) throw new Error("请输入搜索关键词，例如：前端 / Java / 产品经理");
		const round = Math.max(0, Math.round(Number(raw.round) || 0));
		const plan = resolveSearchPlan(site, round, Number(raw.salaryMin) || 0, Number(raw.salaryMax) || 0);
		const keywords = raw.extend ? expandSearchKeywords(baseKeywords, raw.skills ?? [], round) : baseKeywords;
		const city = normalizeCityName(raw.city);
		const baseRange = sitePageRange(raw.page, raw.pages);
		const deepRange = raw.extend && site === "boss" && round > 0 && baseRange.start === 1 ? deepPageWindow(round, baseRange.count, keywordCycleLength(baseKeywords, raw.skills ?? [])) : null;
		const range = deepRange ? {
			start: deepRange.start,
			end: deepRange.end,
			count: deepRange.end - deepRange.start + 1
		} : baseRange;
		const { code, mapped } = resolveCityCode(site, city);
		const runtime = this.runtime(site);
		if (await this.driver.isClosed(site).catch(() => true)) await this.driver.open(site).catch(() => void 0);
		else await this.driver.reveal(site, "visible").catch(() => void 0);
		let scale = "";
		const requestedScale = siteScaleLabel(site, text$3(raw.scale, 12)) ? text$3(raw.scale, 12) : "";
		if (range.start > 1 && raw.extend !== true) {
			scale = requestedScale;
			if (scale) {
				plan.scale = scale;
				plan.label = [plan.label, `公司规模 ${siteScaleLabel(site, scale)}`].filter(Boolean).join(" · ");
			}
		} else if (raw.scaleMode === "fixed" && requestedScale) {
			scale = requestedScale;
			plan.scale = scale;
			plan.label = [plan.label, `公司规模 ${siteScaleLabel(site, scale)}`].filter(Boolean).join(" · ");
		}
		let sortMode = "auto";
		if (site !== "boss") {
			if (raw.sortMode === "default") {
				sortMode = "default";
				plan.order = void 0;
				plan.sortType = void 0;
				plan.salary = void 0;
				plan.label = "平台默认排序";
			} else {
				const order = site === "zhaopin" && typeof raw.order === "number" && Number.isFinite(raw.order) ? Math.round(raw.order) : void 0;
				const sortType = site === "job51" && typeof raw.sortType === "number" && Number.isFinite(raw.sortType) ? Math.round(raw.sortType) : void 0;
				if (order !== void 0 || sortType !== void 0) {
					sortMode = "fixed";
					plan.order = order;
					plan.sortType = sortType;
					plan.salary = text$3(raw.salary, 32) || void 0;
					plan.label = [site === "zhaopin" ? zhaopinOrderLabel(order) : job51SortLabel(sortType), salaryRangeText(plan.salary)].filter(Boolean).join(" · ");
				}
			}
		}
		const variant = plan.label || (raw.extend ? "扩展关键词" : "");
		const collected = [];
		const keywordCounts = [];
		const salaryNotes = [];
		const pagingNotes = [];
		const keywordTotals = /* @__PURE__ */ new Map();
		let blocked = "";
		let rawTotal = 0;
		let cards = 0;
		let fetchCount = 0;
		let lastPageLoaded = 0;
		let exhaustedKeywords = 0;
		let stopPaging = false;
		let stopPage = 0;
		let budgetStop = false;
		let keywordFilteredTotal = 0;
		const deepBudgetMs = raw.extend ? DEEP_SEARCH_BUDGET_MS : 0;
		const deepStartedAt = Date.now();
		const overBudget = () => deepBudgetMs > 0 && Date.now() - deepStartedAt >= deepBudgetMs;
		const budgetNote = `本次深挖已到 ${Math.round(DEEP_SEARCH_BUDGET_MS / 1e3)} 秒上限，先返回已加载的岗位；再点一次「深挖一批」会换下一批关键词继续。`;
		for (const [index, keyword] of keywords.entries()) {
			if (index > 0 && overBudget()) {
				budgetStop = true;
				pagingNotes.push(budgetNote);
				break;
			}
			let keywordTotal = 0;
			let keywordBlocked = false;
			let keywordExhausted = false;
			let keywordLimitedByLogin = false;
			const seenPageSignatures = /* @__PURE__ */ new Set();
			for (let page = range.start; page <= range.end; page += 1) {
				if (page > range.start && overBudget()) {
					budgetStop = true;
					pagingNotes.push(budgetNote);
					break;
				}
				const one = await this.searchOne(site, keyword, city, code, page, keywordTotals.get(keyword) ?? 0, plan);
				fetchCount += 1;
				rawTotal += one.rawCount;
				cards += one.cards;
				if (one.keywordFiltered) keywordFilteredTotal += one.keywordFiltered;
				if (one.note) pagingNotes.push(one.note);
				if (one.total) keywordTotals.set(keyword, Math.max(keywordTotals.get(keyword) ?? 0, one.total));
				if (one.blocked) {
					blocked = one.blocked;
					keywordBlocked = true;
					break;
				}
				if (one.stop) {
					stopPaging = true;
					stopPage = page;
					break;
				}
				if (one.salaryNote) salaryNotes.push(one.salaryNote);
				const pageSignature = one.items.map((job) => job.sourceUrl || job.id).sort().join("\n");
				if (pageSignature && seenPageSignatures.has(pageSignature)) {
					keywordExhausted = true;
					pagingNotes.push(`「${keyword}」从第 ${page} 页起重复返回已加载过的岗位，已自动停止翻页；可以换关键词或城市继续搜。`);
					break;
				}
				if (pageSignature) seenPageSignatures.add(pageSignature);
				collected.push(...one.items);
				keywordTotal += one.items.length;
				if (one.items.length || one.rawCount) lastPageLoaded = Math.max(lastPageLoaded, page);
				if (!one.items.length && !one.rawCount) {
					keywordExhausted = true;
					keywordLimitedByLogin = one.limitedByLogin === true;
					break;
				}
				if (one.hasMore === false) {
					keywordExhausted = true;
					keywordLimitedByLogin = one.limitedByLogin === true;
					break;
				}
				const total = keywordTotals.get(keyword) ?? 0;
				if (total > 0 && total <= page * 15) {
					keywordExhausted = true;
					break;
				}
				if (page < range.end) await sleep$2(site === "boss" ? BOSS_PAGE_PAUSE_MS : site === "job51" ? 6e3 : 1800);
			}
			if (keywordExhausted && !keywordLimitedByLogin) exhaustedKeywords += 1;
			keywordCounts.push({
				keyword,
				total: keywordTotal
			});
			if (keywordBlocked || stopPaging || budgetStop) break;
			if (index < keywords.length - 1) await sleep$2(site === "job51" ? 6e3 : 1800);
		}
		const exhaustedAll = !blocked && !stopPaging && !budgetStop && keywords.length > 0 && exhaustedKeywords === keywords.length;
		const pageLoaded = exhaustedAll ? range.end : budgetStop ? Math.max(range.start, lastPageLoaded) : stopPaging ? Math.max(0, stopPage - 1) : lastPageLoaded || range.start;
		if (keywordFilteredTotal > 0) pagingNotes.push(`智联按全文匹配返回的岗位里有 ${keywordFilteredTotal} 个岗位名和技能标签都不含搜索词，已过滤；想放宽时可以换更宽的关键词再搜。`);
		const deduped = dedupeSiteJobsDetailed(collected);
		const jobs = deduped.items;
		if (exhaustedAll) {
			if (site === "zhaopin") pagingNotes.push(zhaopinSliceNote({
				keyword: baseKeywords.join(" / "),
				variant,
				city,
				loaded: jobs.length
			}));
			else if (pageLoaded > lastPageLoaded) pagingNotes.push(`第 ${Math.max(range.start, lastPageLoaded + 1)} 页起没有更多岗位了，可以换个关键词或城市继续搜。`);
		}
		const filteredJobs = !mapped && city ? jobs.filter((job) => matchesCity(job, city)) : jobs;
		const cityKeys = new Set(filteredJobs.map((job) => job.sourceUrl || `${job.company}|${job.title}`));
		const duplicateCount = Math.max(0, rawTotal - jobs.length);
		const cityCount = Math.max(0, jobs.length - filteredJobs.length);
		const salaryNote = [...new Set(salaryNotes)].join(" ") || void 0;
		const duplicateItems = deduped.duplicates.map((job) => ({
			job,
			reason: "与前面岗位重复（多个关键词搜到同一岗位）",
			category: "duplicate"
		}));
		const cityItems = city && !mapped ? jobs.filter((job) => !cityKeys.has(job.sourceUrl || `${job.company}|${job.title}`)).map((job) => ({
			job,
			reason: `城市不匹配（搜索城市：${city}）`,
			category: "city"
		})) : [];
		const filteredItems = [...duplicateItems, ...cityItems].slice(0, 80);
		const pagingNote = [...new Set(pagingNotes)].join(" ") || void 0;
		const keptItems = filteredJobs;
		const keptNote = keptItems.length ? `（已保留本次加载的 ${keptItems.length} 个岗位）` : "";
		const blockedDetail = {
			duplicate: duplicateCount,
			city: cityCount,
			safety: 0,
			outsource: 0,
			salary: 0,
			score: 0
		};
		if (blocked === "verification") {
			runtime.blocked = "verification";
			runtime.lastCheckedAt = Date.now();
			runtime.message = `${jobSiteLabel(site)}要求人机验证，请在打开的浏览器窗口里完成验证，然后回到这里重新搜索${keptNote}`;
			return {
				site,
				items: keptItems,
				total: keptItems.length,
				message: runtime.message,
				blocked,
				pagesScanned: fetchCount,
				filtered: Math.max(0, rawTotal - filteredJobs.length),
				filteredDetail: blockedDetail,
				filteredItems,
				page: pageLoaded,
				city,
				searchedAt: Date.now(),
				keywords,
				keywordCounts,
				salaryNote,
				pagingNote,
				round,
				variant,
				scale: scale || void 0,
				sortMode,
				order: plan.order,
				sortType: plan.sortType,
				salary: plan.salary
			};
		}
		if (blocked === "login") {
			runtime.blocked = "login";
			runtime.lastCheckedAt = Date.now();
			runtime.message = `${jobSiteLabel(site)}需要先登录，请在打开的浏览器窗口里完成登录，然后回到这里重新搜索${keptNote}`;
			return {
				site,
				items: keptItems,
				total: keptItems.length,
				message: runtime.message,
				blocked,
				pagesScanned: fetchCount,
				filtered: Math.max(0, rawTotal - filteredJobs.length),
				filteredDetail: blockedDetail,
				filteredItems,
				page: pageLoaded,
				city,
				searchedAt: Date.now(),
				keywords,
				keywordCounts,
				salaryNote,
				pagingNote,
				round,
				variant,
				scale: scale || void 0,
				sortMode,
				order: plan.order,
				sortType: plan.sortType,
				salary: plan.salary
			};
		}
		runtime.blocked = "";
		runtime.lastSearchAt = Date.now();
		runtime.lastCheckedAt = Date.now();
		const countText = keywordCounts.length > 1 ? keywordCounts.map((entry) => `${entry.keyword} ${entry.total}`).join(" · ") : "";
		runtime.message = filteredJobs.length ? `${jobSiteLabel(site)}返回 ${filteredJobs.length} 个岗位${stopPaging ? "（平台暂时限制了继续翻页）" : ""}` : pagingNotes[pagingNotes.length - 1] || `没有在${jobSiteLabel(site)}解析到岗位。如果页面正常但列表为空，请尝试更换关键词，或在该窗口中登录后再搜索`;
		this.log(`${site} keywords=${keywords.length} round=${round} extend=${raw.extend ? 1 : 0} skills=${(raw.skills ?? []).length} variant=${variant || "-"} scale=${scale || "-"} pages=${range.start}-${pageLoaded} cards=${cards} parsed=${rawTotal} kept=${filteredJobs.length}${stopPaging ? " stopped-by-rate-limit" : ""}`);
		return {
			site,
			items: filteredJobs,
			total: filteredJobs.length,
			message: filteredJobs.length ? `${jobSiteLabel(site)}搜索到 ${filteredJobs.length} 个岗位${keywordCounts.length > 1 ? `（${countText}）` : ""}${!mapped && city ? `，已按「${city}」筛选` : ""}` : runtime.message,
			blocked: "",
			pagesScanned: fetchCount,
			filtered: Math.max(0, rawTotal - filteredJobs.length),
			filteredDetail: {
				duplicate: duplicateCount,
				city: cityCount,
				safety: 0,
				outsource: 0,
				salary: 0,
				score: 0
			},
			filteredItems,
			page: pageLoaded,
			city,
			searchedAt: Date.now(),
			keywords,
			keywordCounts,
			salaryNote,
			pagingNote,
			exhausted: exhaustedAll || void 0,
			round,
			variant,
			scale: scale || void 0,
			sortMode,
			order: plan.order,
			sortType: plan.sortType,
			salary: plan.salary
		};
	}
	/** 单岗核实：另开隐藏窗口读详情页（不打扰用户的搜索窗口），接口旁路补全薪资/在招状态。 */
	async enrich(job) {
		if (!JOB_SITE_IDS.includes(job.source)) return null;
		if (!job.sourceUrl || !isHttpUrl$1(job.sourceUrl)) return null;
		const site = job.source;
		const token = site === "boss" ? await this.driver.captureStart(site, "/\\/wapi\\/zpgeek\\/job\\/detail\\.json/i", "aux").catch(() => "") : "";
		try {
			await this.driver.openAux(site);
			await this.driver.goto(site, job.sourceUrl, {
				tab: "aux",
				attempts: 1
			}).catch((error) => {
				this.log(`${site} enrich slow: ${text$3(error?.message ?? error, 120)}`);
			});
			await sleep$2(800);
			if (await this.driver.blocker(site).catch(() => "")) return null;
			const posted = parsePostedAt(extractPostedText(await this.driver.evaluate(site, postedScript(), EVAL_TIMEOUT_MS, "aux").catch(() => "") ?? ""));
			if (token) {
				const details = (await this.driver.captureStop(token, 5e3).catch(() => [])).map((payload) => mapBossDetail(payload)).filter((entry) => entry !== null);
				const detail = details.find((entry) => entry.description) ?? details[0];
				if (detail) {
					let description = detail.description;
					let domRecruiter = "";
					let domActive = "";
					if (!description) {
						const dom = await this.driver.evaluate(site, detailScript(site), EVAL_TIMEOUT_MS, "aux").catch(() => null);
						if (dom?.text && dom.text.length >= 30) description = dom.text;
						domRecruiter = dom?.recruiter ?? "";
						domActive = dom?.active ?? "";
					}
					return {
						description: description || job.description,
						postedAt: posted.at ?? job.postedAt ?? null,
						postedLabel: posted.at ? posted.label : job.postedLabel ?? "",
						postedDays: posted.at ? postedDays(posted.at) : job.postedDays ?? null,
						recruiter: detail.recruiter || domRecruiter || job.recruiter,
						recruiterTitle: detail.recruiterTitle || job.recruiterTitle || "",
						recruiterActive: detail.recruiterActive || domActive || job.recruiterActive,
						company: detail.company || job.company,
						companyIndustry: detail.companyIndustry || job.companyIndustry,
						companyStage: detail.companyStage || job.companyStage || "",
						companyScale: detail.companyScale || job.companyScale || "",
						city: detail.city || job.city,
						salaryLabel: detail.salaryLabel || job.salaryLabel,
						salaryMin: detail.salaryMin ?? job.salaryMin ?? null,
						salaryMax: detail.salaryMax ?? job.salaryMax ?? null,
						salaryUnit: detail.salaryUnit || job.salaryUnit,
						jobStatus: detail.jobStatus || job.jobStatus || "",
						jobStatusText: detail.jobStatusText || job.jobStatusText || "",
						jobId: detail.jobId || job.jobId || "",
						companyAnonymous: detail.company ? false : job.companyAnonymous === true
					};
				}
			}
			const detail = await this.driver.evaluate(site, detailScript(site), EVAL_TIMEOUT_MS, "aux").catch(() => null);
			if (!detail?.text || detail.text.length < 30) return null;
			return {
				description: detail.text,
				postedAt: posted.at ?? job.postedAt ?? null,
				postedLabel: posted.at ? posted.label : job.postedLabel ?? "",
				postedDays: posted.at ? postedDays(posted.at) : job.postedDays ?? null,
				recruiter: detail.recruiter || job.recruiter,
				recruiterActive: detail.active || job.recruiterActive
			};
		} catch (error) {
			this.log(`${site} enrich failed: ${text$3(error?.message ?? error, 160)}`);
			return null;
		} finally {
			if (token) await this.driver.captureStop(token, 0).catch(() => []);
			await this.driver.closeAux(site).catch(() => void 0);
		}
	}
};
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/apply.ts
/**
* 招聘平台「直接投递简历」执行器。
*
* 和 Boss 打招呼的区别：这三个平台的投递是「详情页按钮 → 确认弹窗 → 投递成功提示」，
* 用的是平台里的在线简历（部分平台弹窗里还能加附件简历）。所以这里不复用聊天输入框逻辑，
* 只做三件事：找到投递入口、把弹窗确认掉、拿到页面级成功证据。
*
* 硬性约束（与插件技能一致）：
* - 没有看到「投递成功 / 已投递」证据就不算成功，返回 needs_user 交给本人核对。
* - 遇到登录 / 人机验证立刻停下，不做任何绕过。
* - 岗位已关闭、已投递过，不重复点，直接给出结论。
*/
var APPLY_SUCCESS_PATTERN = /投递成功|申请成功|简历投递成功|简历已发送|发送简历成功|申请已提交|投递已提交|已成功投递|投递完成|简历投递完成|已成功申请|您的简历已投递|申请职位成功|投递简历成功|已向对方发送简历|简历和打招呼语已发送/;
var APPLY_ALREADY_PATTERN = /(?:今日|已)投递过|已投递该职位|您已投递|已申请该职位|已应聘该职位|重复投递|已投递此职位|已申请过/;
var APPLY_CLOSED_PATTERN = /职位已关闭|职位已下线|该职位已失效|停止招聘|已停止招聘|岗位已关闭|职位不存在|该职位已过期|已招满|暂无该职位|职位信息不存在|该职位不存在|哦哦！没有职位/;
/**
* 前程无忧投递成功页。
*
* 51job 投递成功后不写「投递成功」字样，而是跳到 applysuccess.php，页面只显示
* 「使用微信扫码与HR沟通，获取面试机会吧」；底部同时渲染通用空状态
* 「哦哦！没有职位不要怕…」。只按正文判定会被 APPLY_CLOSED_PATTERN 误判成岗位已关闭
* （用户 11-05 截图：社会申请里已显示投递成功，队列却记成跳过）。
*/
function isJob51ApplySuccessUrl(url) {
	return /jobs\.51job\.com\/applysuccess\.php/i.test(String(url ?? ""));
}
var CONFIRM_SELECTORS = [
	"[class*=\"dialog\"] button",
	"[class*=\"modal\"] button",
	"[role=\"dialog\"] button",
	"[class*=\"popup\"] button"
];
/** 没有投递按钮时的「聊一聊」兜底：三个平台共用一套入口与输入框探测。 */
var CHAT_GREETING = {
	entrySelectors: [
		"button[class*=\"chat\"]",
		"[class*=\"chat-btn\"]",
		"[class*=\"communicate\"]",
		"[class*=\"contact\"] button",
		"a[class*=\"chat\"]"
	],
	entryLabels: "^(去聊聊|聊一聊|立即沟通|和TA聊聊|跟TA聊聊|在线沟通)$",
	entryLabelSelectors: [
		"button",
		"a",
		"[role=\"button\"]",
		"[class*=\"btn\"]",
		"[class*=\"chat\"]",
		"div",
		"span"
	],
	inputSelectors: [
		"[class*=\"chat\"] textarea",
		"[class*=\"chat\"] [contenteditable=\"true\"]",
		"textarea[placeholder*=\"消息\"]",
		"textarea[placeholder*=\"输入\"]",
		"textarea[placeholder*=\"说\"]",
		"[contenteditable=\"true\"][data-placeholder]",
		"div[contenteditable=\"true\"]",
		"textarea"
	],
	sendSelectors: ["button[class*=\"send\"]", "[class*=\"send\"]"],
	sendLabels: "^(发送|发送消息)$"
};
var SITE_APPLY_PROFILES = {
	liepin: {
		site: "liepin",
		entrySelectors: [
			"[class*=\"apply\"] button",
			"[class*=\"job-apply\"]",
			"button[class*=\"resume\"]",
			"[class*=\"btn-apply\"]"
		],
		entryLabels: "^(立即投递|投递简历|应聘职位|申请职位|一键投递|立即应聘)$",
		confirmSelectors: CONFIRM_SELECTORS,
		confirmLabels: "^(确认投递|确认申请|立即投递|立即应聘|确定投递|投递|确定)$",
		fileInputSelectors: [
			"input[type=\"file\"][accept*=\"pdf\"]",
			"input[type=\"file\"][accept*=\"doc\"]",
			"input[type=\"file\"]"
		],
		supportsAttachment: true,
		chatGreeting: CHAT_GREETING,
		note: "猎聘详情页有「立即投递」就直接投递（弹窗可补附件简历）；只有「聊一聊」的岗位发送开场话术打招呼。"
	},
	zhaopin: {
		site: "zhaopin",
		entrySelectors: [
			"[class*=\"job-detail-summary__apply\"]",
			"a[class*=\"apply\"]",
			"[class*=\"apply\"] button",
			"button[class*=\"apply\"]",
			"[class*=\"btn-apply\"]"
		],
		entryLabels: "^(立即申请|投递简历|申请职位|立即投递)$",
		confirmSelectors: CONFIRM_SELECTORS,
		confirmLabels: "^(立即投递|确认投递|确认申请|确定投递|投递|申请|确定|下一步)$",
		fileInputSelectors: ["input[type=\"file\"][accept*=\"pdf\"]", "input[type=\"file\"]"],
		supportsAttachment: true,
		chatGreeting: CHAT_GREETING,
		note: "智联详情页有「立即申请」就直接投递（首次选简历 →「立即投递」，成功弹窗是「已向对方发送简历和打招呼语」；没抓到弹窗时重新打开岗位页，投递按钮消失并出现「继续沟通」即已投递，按钮还在会自动再投一次）；只有「聊一聊」的岗位发送开场话术打招呼。可能先要过腾讯云人机验证。"
	},
	job51: {
		site: "job51",
		entrySelectors: [
			"button.btn.apply",
			".btn.apply",
			"[class*=\"apply\"] button",
			"button[class*=\"apply\"]",
			"[class*=\"btn-apply\"]",
			"[class*=\"apply-btn\"]",
			".job-apply"
		],
		entryLabels: "^(投递|投递简历|立即投递|在线投递|申请该职位|申请职位|立即申请|立即申请该职位|一键投递)$",
		confirmSelectors: [
			...CONFIRM_SELECTORS,
			"[class*=\"send\"] button",
			"[class*=\"dialog\"] [class*=\"btn\"]"
		],
		confirmLabels: "^(发送求职申请|确认投递|立即投递|申请|投递|确定|确认)$",
		chatGreeting: CHAT_GREETING,
		fileInputSelectors: ["input[type=\"file\"][accept*=\"pdf\"]", "input[type=\"file\"]"],
		supportsAttachment: true,
		note: "前程无忧有「投递」按钮就直接投递（确认页选简历 →「申请」）；没有投递按钮的岗位点「聊一聊」把开场话术发过去。投递后重新打开岗位页，投递按钮消失并出现「继续沟通」才算成功；按钮还在会自动再投一次。"
	}
};
/** 空白页 / 失败说明页的探针：窗口里贴了「页面没有加载出来」时带这个标记。 */
var NOTICE_PROBE = `(() => {
  const body = document.body;
  if (!body) return "blank";
  if (body.getAttribute("data-ruodao-notice") === "load-failed") return "load-failed";
  // 真正空白的 SPA 壳里只有 #app 和几个 script：正文为 0、节点数极少。
  // 正常页面（哪怕是「该职位已关闭」这种短提示页）都有一整套布局节点，不会命中。
  const text = String(body.innerText || "").replace(/\\s+/g, "");
  const nodes = body.querySelectorAll("*").length;
  return text.length < 20 && nodes <= 6 ? "blank" : "";
})()`;
function pageNotReadyResult(driver, screenshots, blockedReason) {
	return {
		state: "needs_user",
		message: blockedReason === "页面没有加载出来" ? "岗位页没有加载出来，窗口里已经写明原因并给了「重新加载」按钮。可能是网络、登录态失效或平台风控拦住了，也可以直接在窗口里手投" : "岗位页是空白的，页面上什么都没有。请在窗口里刷新后手动确认，别把这个岗位当成已投递",
		screenshots,
		blockedReason,
		successText: "",
		finalUrl: driver.currentUrl(),
		entryText: ""
	};
}
/**
* 真正要打开的岗位详情页地址。
*
* 51job 只有 `jobs.51job.com/{city}/{jobId}.html` 是服务端渲染的岗位详情页，
* 「立即投递」按钮就在这一页。卡片里的 a.comp 是**公司主页**（jobs.51job.com/all/coXXXX.html），
* 早前拼的 `we.51job.com/pc/jobdetail?jobId=` 是前端路由：未登录会被踢到登录页，
* 登录后也经常整页空白，投递必然失败。
*
* 这条详情页地址只有平台接口（search-pc 的 jobHref）知道，所以这里只做「是否已经是详情页」的判定；
* 拿不到详情页地址时返回空字符串，由 job-sites service 在投递前用职位号换一次，
* 换不到就明确告诉本人重新搜索，绝不拿公司页或前端路由去点按钮。
*
* 不要再兜底到 `we.51job.com/pc/jobdetail?jobId=`：未登录会跳登录页，
* 登录后整页空白（用户 11-04 截图），投递链路会在空白页上白等。
*/
function resolveApplyUrl(job) {
	const raw = String(job.sourceUrl ?? "").trim();
	if (job.source !== "job51") return raw;
	return normalizeJob51DetailUrl(raw);
}
/** 公司主页 / 站点导航页的特征：出现在这里说明打开的页面不是岗位详情页。 */
function isCompanyPageUrl(url) {
	return /\/all\/co|\/pc\/comp|jobs\.51job\.com\/all\//i.test(String(url ?? ""));
}
async function waitFor(driver, probe, timeoutMs, intervalMs = 500) {
	const now = () => driver.now?.() ?? Date.now();
	const deadline = now() + timeoutMs;
	let last = null;
	while (now() < deadline) {
		last = await probe();
		if (last !== null) return last;
		await driver.sleep(intervalMs);
	}
	return last;
}
function normalizeBody(value) {
	return String(value ?? "").replace(/\s+/g, "");
}
/**
* 登录墙的提示语。
*
* 前程无忧搜索页（we.51job.com）和岗位详情页（jobs.51job.com）是两套登录态，
* 第一次投递要在详情页单独登录一次；51job 登录后会带着原岗位地址跳回来，
* 所以这里要告诉用户「登录后回到这个岗位页再点投递」，而不是让他去重新搜岗位。
*/
function loginWallMessage(site, siteLabel) {
	if (site === "job51") return "前程无忧的岗位详情页要单独登录一次（搜索页和详情页的登录态不通用），这次没有提交简历。在这个窗口登录后会自动回到这个岗位页，再点「投递」即可，之后不用重复登录";
	return `${siteLabel}岗位页没有登录态，点了「投递」只弹出了登录框，这次没有提交简历。请在窗口里登录后再投递`;
}
function visibleButtonsScript() {
	return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labels = [];
    for (const element of document.querySelectorAll("button, a, [role='button'], [class*='btn']")) {
      if (!visible(element)) continue;
      const label = String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
      if (label && label.length <= 16) labels.push(label);
    }
    return [...new Set(labels)].slice(0, 24);
  })()`;
}
/** 已投递 / 已沟通的按钮文案：类名不变、只换文案时不能再算成投递入口。 */
var APPLIED_LABEL_PATTERN = /^(继续沟通|已投递|已申请|已投递该职位|已申请该职位)$/;
/**
* 非 Boss 平台详情页的投递状态探针（只看页面，不点按钮）。
*
* 用户 11-04 实测（前程无忧）、11-05 实测（智联）：投递成功后重新打开岗位页，
* 投递按钮会消失并出现「继续沟通」；按钮还在就说明没投出去。
* 推荐位 / 相似职位卡片里也有同名按钮，这些不属于当前岗位，必须排除，
* 否则成功页会被误判成「还没投」。
*/
function siteDetailStateScript(profile) {
	return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, "").trim();
    const labelOf = (element) => clean(element) || String(element.getAttribute("aria-label") || element.getAttribute("title") || "").replace(/\\s+/g, "").trim();
    const applyPattern = new RegExp(${JSON.stringify(profile.entryLabels)});
    const applySelectors = ${JSON.stringify(profile.entrySelectors)};
    const extra = (element) => Boolean(element.closest('[class*="recommend"], [class*="similar"], [class*="related"], [class*="hotjob"], [class*="guess"], [class*="job-list"]'));
    const controls = [...document.querySelectorAll("button, a, [role='button'], [class*='btn'], [class*='apply'], [class*='chat'], [class*='communicate'], [class*='contact']")].filter(visible);
    const labels = controls.map(clean);
    // 智联 / 前程无忧的入口常常是「外层 div 里包一个纯文字节点」，控件扫描漏掉时再看叶子节点；
    // 这只认正文恰好是「继续沟通」的节点，不会把岗位描述里的文字当成按钮。
    let continueVisible = controls.some((element) => !extra(element) && labelOf(element) === "继续沟通");
    if (!continueVisible) {
      continueVisible = [...document.querySelectorAll("span, div, p, strong")]
        .filter((element) => element.children.length === 0 && visible(element))
        .some((element) => !extra(element) && clean(element) === "继续沟通");
    }
    const doneVisible = controls.some((element) => !extra(element) && /^(已投递|已申请|已投递该职位|已申请该职位)$/.test(labelOf(element)));
    let applyVisible = controls.some((element) => {
      const label = labelOf(element);
      return !extra(element) && label.length <= 16 && applyPattern.test(label);
    });
    if (!applyVisible) {
      const appliedLabel = ${JSON.stringify(APPLIED_LABEL_PATTERN.source)};
      for (const selector of applySelectors) {
        try {
          if ([...document.querySelectorAll(selector)].some((element) => {
            if (!visible(element) || extra(element)) return false;
            // 平台可能把同一个「立即申请」元素直接改成「继续沟通」：类名还在，但已经不是投递入口。
            return !new RegExp(appliedLabel).test(labelOf(element));
          })) {
            applyVisible = true;
            break;
          }
        } catch {}
      }
    }
    return { applyVisible, doneVisible, continueVisible, buttons: [...new Set(labels.filter(Boolean))].slice(0, 24) };
  })()`;
}
/** 等页面把「投递 / 继续沟通 / 已投递」任一状态画出来再下结论，避免慢网下把未渲染当成未投递。 */
async function readSiteDetailState(driver, profile, timeoutMs = 5e3) {
	try {
		return await waitFor(driver, async () => {
			const next = await driver.evaluate(siteDetailStateScript(profile)) ?? {};
			return next.applyVisible === true || next.continueVisible === true || next.doneVisible === true ? next : null;
		}, timeoutMs, 700) ?? {};
	} catch {
		return {};
	}
}
function inputValueScript(selectors) {
	return `(() => {
    const selectors = ${JSON.stringify(selectors)};
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
/**
* 没有投递按钮时的兜底：点「去聊聊 / 聊一聊」→ 把开场话术填进聊天框 → 发送 → 确认消息真的出现。
*
* 只有确认页面里出现了刚发送的话术才当成功；输入框遇到登录 / 手机端沟通的情况不硬闯，
* 直接交回本人处理并说明卡在哪一步。
*/
async function greetThroughChat(driver, chat, options, shot, screenshots) {
	if (!await driver.click(chat.entrySelectors, chat.entryLabels, { labelSelectors: chat.entryLabelSelectors })) return null;
	driver.log("没有投递按钮，已点「聊一聊」，准备把开场话术发过去");
	await driver.sleep(2200);
	const fail = async (label, state, message, blockedReason) => {
		await shot(label);
		return {
			state,
			message,
			screenshots,
			blockedReason,
			successText: "",
			finalUrl: driver.currentUrl(),
			entryText: ""
		};
	};
	let greeting = "";
	try {
		greeting = String(await options.greeting?.() ?? "").trim();
	} catch {
		greeting = "";
	}
	if (!greeting) return fail("chat-no-greeting", "needs_user", "这个岗位没有投递按钮，聊一聊已经打开，但没有可发送的开场话术。请在窗口里手动把话术发过去", "没有可用话术");
	if (!await driver.type(chat.inputSelectors, greeting)) return fail("chat-no-input", "needs_user", "这个岗位没有投递按钮，已点「聊一聊」，但聊天输入框没有出现（可能需要先登录，或平台要求在手机端沟通）。请在窗口里手动发送话术", "聊天输入框未出现");
	driver.log("已把开场话术填入聊天框，正在发送");
	await driver.sleep(500);
	if (!await driver.click(chat.sendSelectors, chat.sendLabels)) await driver.type(chat.inputSelectors, greeting, { enter: true });
	const probe = greeting.replace(/\s+/g, "").slice(0, 10);
	if (await waitFor(driver, async () => {
		const body = normalizeBody(await driver.bodyText());
		const left = String(await driver.evaluate(inputValueScript(chat.inputSelectors)) ?? "").replace(/\s+/g, "");
		return probe.length >= 4 && body.includes(probe) && !left.trim() ? "sent" : null;
	}, 12e3, 700)) {
		await shot("chat-sent");
		return {
			state: "submitted",
			message: "这个岗位没有投递按钮，已点「聊一聊」把开场话术发给了招聘者",
			screenshots,
			blockedReason: "",
			successText: "聊天窗口已出现刚发送的话术",
			finalUrl: driver.currentUrl(),
			entryText: "聊一聊 + 开场话术"
		};
	}
	return fail("chat-unconfirmed", "needs_user", "已点「聊一聊」并填好话术，但页面上没有确认到消息记录。请在浏览器窗口里核对是否已发出，再回工作台标记", "未检测到消息发送成功");
}
/**
* 智联投递后的第二重核对：打开消息列表，找这个岗位的投递会话。
*
* 智联的成功弹窗有时几秒就消失，光等页面正文会漏掉；而消息列表会长期保留
* 「您已投递的 <岗位名>」/「已发送附件简历」这条记录。只有岗位名（和公司名）
* 与投递回执出现在同一条会话里才算成功，避免被别的岗位历史记录误导。
*
* 页头的「消息」是 SPA 路由，anchor 的 href 常常就是首页（实测打开 /message/ 会回首页），
* 所以这里直接点入口，不再按地址打开。
*/
async function verifyZhaopinMessageRecord(driver, job, shot, screenshots) {
	driver.log("页面没有出现投递回执，正在打开智联消息列表核对投递记录");
	if (!await driver.click([], "^消息\\d*\\+?$", { labelSelectors: [
		"a",
		"button",
		"[role='button']",
		"div",
		"span"
	] })) return null;
	await driver.sleep(2200);
	if (await driver.blocker()) return null;
	const matched = await waitFor(driver, async () => {
		const probe = await driver.evaluate(zhaopinMessageProbeScript());
		if (!probe) return null;
		return zhaopinMessageRecord(probe, job) || null;
	}, 1e4, 800);
	await shot(matched ? "apply-message-record" : "apply-message-unconfirmed");
	if (!matched) return null;
	return {
		state: "submitted",
		message: `页面没有抓到投递成功弹窗，但在智联消息列表里找到了这个岗位的投递记录（${matched}）`,
		screenshots,
		blockedReason: "",
		successText: "消息列表显示已投递",
		finalUrl: driver.currentUrl(),
		entryText: "详情页投递按钮"
	};
}
/**
* 投递一个岗位。返回值里的 state 与 Boss 打招呼保持一致，便于上层复用投递记录与批量队列。
*/
async function submitResume(driver, job, options = {}) {
	const site = job.source;
	const profile = SITE_APPLY_PROFILES[site];
	const screenshots = [];
	const base = {
		state: "failed",
		message: "",
		screenshots,
		blockedReason: "",
		successText: "",
		finalUrl: "",
		entryText: ""
	};
	if (!profile) return {
		...base,
		message: `${job.source} 暂不支持自动投递简历`
	};
	if (!/^https?:/i.test(String(job.sourceUrl || ""))) return {
		...base,
		message: "岗位链接无效，无法打开详情页"
	};
	const shot = async (label) => {
		const file = await driver.shot(label).catch(() => "");
		if (file) screenshots.push(file);
	};
	const targetUrl = resolveApplyUrl(job);
	if (!targetUrl) {
		await shot("apply-bad-url");
		return {
			...base,
			state: "needs_user",
			message: site === "job51" ? "这条岗位记录里没有前程无忧的岗位详情页地址（只有公司主页或搜索页链接），打开也点不到「立即投递」。请在招聘窗口里重新搜索一次这个岗位再投递" : "这条岗位记录里的链接不是岗位详情页，打开也点不到投递按钮。请在平台上重新搜索一次这个岗位再投递",
			blockedReason: "岗位链接不是详情页",
			finalUrl: driver.currentUrl()
		};
	}
	await driver.load(targetUrl);
	await driver.sleep(1200);
	const siteLabel = site === "zhaopin" ? "智联招聘" : site === "liepin" ? "猎聘" : "前程无忧";
	const softLogin = site === "job51";
	const blocked = await driver.blocker({ ignoreLoginText: softLogin });
	if (blocked) {
		await shot(`apply-${blocked}`);
		return {
			...base,
			state: "blocked",
			message: blocked === "verification" ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试` : loginWallMessage(site, siteLabel),
			blockedReason: blocked === "verification" ? "需要人机验证" : "需要登录",
			finalUrl: driver.currentUrl()
		};
	}
	if (site === "job51" && isCompanyPageUrl(driver.currentUrl())) {
		await shot("apply-company-page");
		return {
			...base,
			state: "needs_user",
			message: "打开的页面是公司主页而不是岗位详情页，找不到投递按钮。请在平台上重新搜索这个岗位再投递",
			blockedReason: "打开的是公司主页",
			finalUrl: driver.currentUrl()
		};
	}
	if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) {
		await shot("apply-success");
		return {
			...base,
			state: "submitted",
			message: "已提交简历（前程无忧跳转到投递成功页，可用微信扫码与 HR 沟通）",
			successText: "前程无忧投递成功页",
			finalUrl: driver.currentUrl()
		};
	}
	const before = normalizeBody(await driver.bodyText());
	const notReady = await driver.evaluate(NOTICE_PROBE);
	if (notReady === "load-failed" || notReady === "blank") {
		await shot(notReady === "load-failed" ? "apply-load-failed" : "apply-blank");
		return pageNotReadyResult(driver, screenshots, notReady === "load-failed" ? "页面没有加载出来" : "页面空白");
	}
	if (APPLY_SUCCESS_PATTERN.test(before)) return {
		...base,
		state: "submitted",
		message: "页面显示投递成功，没有重复投递",
		successText: before.match(APPLY_SUCCESS_PATTERN)?.[0] ?? "投递成功",
		finalUrl: driver.currentUrl()
	};
	if (APPLY_ALREADY_PATTERN.test(before)) {
		await shot("apply-already");
		return {
			...base,
			state: "already",
			message: "页面上已经显示投递过这个岗位，没有重复投递",
			successText: "页面显示已投递",
			finalUrl: driver.currentUrl()
		};
	}
	if (APPLY_CLOSED_PATTERN.test(before)) {
		await shot("apply-closed");
		return {
			...base,
			state: "failed",
			message: "这个岗位在平台上已关闭 / 停止招聘，没有投递",
			blockedReason: "岗位已关闭",
			finalUrl: driver.currentUrl()
		};
	}
	let continueVisibleBefore = false;
	if (site === "job51" || site === "zhaopin") {
		const detail = await readSiteDetailState(driver, profile, 2500);
		continueVisibleBefore = detail.continueVisible === true;
		if (detail.applyVisible !== true && (detail.continueVisible === true || detail.doneVisible === true)) {
			await shot("apply-already");
			return {
				...base,
				state: "already",
				message: `岗位页的投递按钮已经消失（页面显示「继续沟通」或「已投递」），说明之前已经投递过，没有重复投递`,
				successText: detail.continueVisible === true ? "投递按钮已消失，页面显示「继续沟通」" : "页面显示已投递",
				finalUrl: driver.currentUrl()
			};
		}
	}
	driver.log(`正在查找${profile.site === "liepin" ? "猎聘" : profile.site === "zhaopin" ? "智联" : "51job"}的投递入口`);
	/**
	* 智联 / 前程无忧投递后最可靠的信号：入口从「立即申请 / 立即投递」变成「继续沟通」。
	* 成功弹窗经常被平台自动关掉，页面里根本没有文字回执；读按钮状态反而更快更稳。
	* 连续确认两次，避免选简历弹窗弹开的瞬间按钮暂时消失被误判成已投递。
	*/
	const appliedLabelNow = async () => {
		if (site !== "zhaopin" && site !== "job51") return "";
		const read = async () => await driver.evaluate(siteDetailStateScript(profile)) ?? {};
		const state = await read();
		if (state.applyVisible === true) return "";
		if (state.continueVisible !== true && state.doneVisible !== true) return "";
		await driver.sleep(500);
		const again = await read();
		if (again.applyVisible === true) return "";
		if (!continueVisibleBefore && again.continueVisible === true) return "继续沟通";
		if (again.doneVisible === true) return "已投递";
		return "";
	};
	const attemptApply = async () => {
		const loginDialogBefore = await driver.hasLoginDialog?.() === true;
		const entryHit = await driver.click(profile.entrySelectors, profile.entryLabels, { scriptFallback: true });
		if (!entryHit) return {
			entryHit,
			wall: "",
			wallAfter: "entry",
			confirmed: false,
			outcome: null
		};
		await driver.sleep(900);
		const wall = await waitFor(driver, async () => {
			const kind = await driver.blocker({ ignoreLoginText: softLogin });
			if (kind) return kind;
			return await driver.hasLoginDialog?.() === true && !loginDialogBefore ? "login" : null;
		}, site === "zhaopin" ? 3e3 : 6e3, 700);
		if (wall) return {
			entryHit,
			wall,
			wallAfter: "entry",
			confirmed: false,
			outcome: null
		};
		let rounds = 0;
		let confirmed = false;
		let attached = false;
		let waitedDialog = false;
		while (rounds < 4) {
			rounds += 1;
			await driver.sleep(rounds === 1 ? 900 : 700);
			if (!attached && options.resumeFilePath && profile.supportsAttachment) {
				attached = await driver.upload(profile.fileInputSelectors, [options.resumeFilePath]).catch(() => false);
				if (attached) {
					driver.log("已选择附件简历");
					await driver.sleep(800);
				}
			}
			if (site === "zhaopin") {
				if ((await driver.evaluate(zhaopinResumeSelectScript()))?.selected === true) driver.log("已在投递弹窗里选中简历");
			}
			if (await driver.click(profile.confirmSelectors, profile.confirmLabels)) {
				confirmed = true;
				await driver.sleep(1200);
				if (await appliedLabelNow()) break;
				continue;
			}
			if (site === "zhaopin" && !confirmed && !waitedDialog) {
				waitedDialog = true;
				if (await appliedLabelNow()) break;
				await waitFor(driver, async () => {
					return (await driver.evaluate(zhaopinResumeSelectScript()))?.found === true ? true : null;
				}, 4e3, 400);
				continue;
			}
			break;
		}
		if (await driver.hasLoginDialog?.() && !loginDialogBefore) return {
			entryHit,
			wall: "login",
			wallAfter: "confirm",
			confirmed,
			outcome: null
		};
		const outcome = await waitFor(driver, async () => {
			if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) return {
				kind: "success-page",
				text: "前程无忧投递成功页"
			};
			const body = normalizeBody(await driver.bodyText());
			const success = body.match(APPLY_SUCCESS_PATTERN)?.[0] ?? "";
			if (success) return {
				kind: "success",
				text: success
			};
			if (APPLY_ALREADY_PATTERN.test(body)) return {
				kind: "success",
				text: "已投递"
			};
			const done = (await driver.evaluate(visibleButtonsScript()) ?? []).find((label) => /^(已投递|已申请|已投递该职位|已申请该职位)$/.test(String(label).replace(/\s+/g, "")));
			if (done) return {
				kind: "success",
				text: done
			};
			const applied = await appliedLabelNow();
			if (applied) return {
				kind: "applied",
				text: applied
			};
			if (APPLY_CLOSED_PATTERN.test(body)) return {
				kind: "closed",
				text: "职位不存在"
			};
			return null;
		}, site === "zhaopin" ? 6e3 : 2e4, 700);
		return {
			entryHit,
			wall: "",
			wallAfter: "confirm",
			confirmed,
			outcome
		};
	};
	const attempt = await attemptApply();
	const entryText = attempt.entryHit ? "详情页投递按钮" : "";
	if (attempt.wall) {
		await shot("apply-login-dialog");
		return {
			...base,
			state: "blocked",
			message: attempt.wall === "verification" ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试` : attempt.wallAfter === "confirm" ? `${siteLabel}要求先登录才能提交简历，这次没有提交成功。请在窗口里登录后重新投递` : loginWallMessage(site, siteLabel),
			blockedReason: attempt.wall === "verification" ? "需要人机验证" : "需要登录",
			entryText,
			finalUrl: driver.currentUrl()
		};
	}
	if (!attempt.entryHit) {
		const greeted = await greetThroughChat(driver, profile.chatGreeting, options, shot, screenshots);
		if (greeted) return greeted;
		const buttons = await driver.evaluate(visibleButtonsScript()) ?? [];
		await shot("apply-no-entry");
		return {
			...base,
			state: "needs_user",
			message: profile.chatGreeting ? `这个岗位页既没有投递按钮，也没有「聊一聊」入口${buttons.length ? `（页面可见按钮：${buttons.slice(0, 8).join(" / ")}）` : ""}。可能是岗位已下线、需要登录，或平台还没把页面渲染完，请在窗口里刷新后手动处理` : buttons.length ? `没有找到投递按钮（页面可见按钮：${buttons.slice(0, 10).join(" / ")}）。可能是岗位已下线、需要登录，或平台改了按钮文案，请在窗口里手动投递` : "没有找到投递按钮，岗位可能已下线或页面还没渲染完，请在窗口里刷新后手动确认",
			blockedReason: "未找到投递入口",
			finalUrl: driver.currentUrl()
		};
	}
	await shot(attempt.outcome ? attempt.outcome.kind === "closed" ? "apply-closed" : "apply-success" : "apply-unconfirmed");
	const finalUrl = driver.currentUrl();
	if (attempt.outcome?.kind === "closed") return {
		...base,
		state: "failed",
		message: "点了投递之后，页面变成「职位不存在 / 已下线」的空状态，这个岗位已经投不了了。请回到岗位池重新搜索一个新岗位",
		blockedReason: "岗位已关闭",
		entryText,
		finalUrl
	};
	if (attempt.outcome?.kind === "success-page") return {
		...base,
		state: "submitted",
		message: `已提交简历（前程无忧跳转到投递成功页，可用微信扫码与 HR 沟通${attempt.confirmed ? "，弹窗已确认" : ""}）`,
		successText: attempt.outcome.text,
		entryText,
		finalUrl
	};
	if (attempt.outcome?.kind === "applied") return {
		...base,
		state: "submitted",
		message: `已提交简历（投递后页面按钮变成「${attempt.outcome.text}」${attempt.confirmed ? "，弹窗已确认" : ""}）`,
		successText: `投递后页面显示「${attempt.outcome.text}」`,
		entryText,
		finalUrl
	};
	if (attempt.outcome?.kind === "success") return {
		...base,
		state: "submitted",
		message: `已提交简历（页面提示「${attempt.outcome.text}」${attempt.confirmed ? "，弹窗已确认" : ""}）`,
		successText: attempt.outcome.text,
		entryText,
		finalUrl
	};
	/**
	* 前程无忧 / 智联点了投递却没有任何回执时，用「重新打开岗位页后的按钮状态」下结论：
	* - 投递按钮消失、出现「继续沟通」→ 已经投递成功（用户 11-05 对智联的明确要求）；
	* - 投递按钮还在 → 上次没投成，直接自动再点一次（不再让用户确认）；
	* - 两次都没有回执且按钮仍在 → 明确记为失败，批量结束时会再读平台记录核对/补投。
	* 智联重开页面后既没有投递按钮也没有「继续沟通」时，再读一次消息记录，仍找不到才交给本人。
	*/
	const recheckAfterAttempt = async (options) => {
		const readPage = async () => {
			try {
				await driver.load(targetUrl);
			} catch {
				return { kind: "load-error" };
			}
			await driver.sleep(900);
			const wall = await driver.blocker({ ignoreLoginText: softLogin });
			if (wall) return {
				kind: "blocked",
				wall
			};
			if (site === "job51" && isJob51ApplySuccessUrl(driver.currentUrl())) return { kind: "success-page" };
			const notReady = String(await driver.evaluate(NOTICE_PROBE) ?? "");
			if (notReady === "load-failed" || notReady === "blank") return {
				kind: "not-ready",
				notReady
			};
			return {
				kind: "state",
				state: await readSiteDetailState(driver, profile, 3500)
			};
		};
		const blockedResult = async (wall) => {
			await shot("apply-login-dialog");
			return {
				...base,
				state: "blocked",
				message: wall === "verification" ? `${siteLabel}要求人机验证，请在浏览器窗口里完成验证后重试` : loginWallMessage(site, siteLabel),
				blockedReason: wall === "verification" ? "需要人机验证" : "需要登录",
				entryText,
				finalUrl: driver.currentUrl()
			};
		};
		const appliedResult = (message, state) => ({
			...base,
			state: "already",
			message,
			successText: state.continueVisible === true ? "投递按钮已消失，页面显示「继续沟通」" : "页面显示已投递",
			entryText,
			finalUrl: driver.currentUrl()
		});
		const isApplied = (state) => state.applyVisible !== true && (state.continueVisible === true || state.doneVisible === true);
		driver.log(`页面没有出现投递成功提示，正在重新打开${siteLabel}岗位页核对投递状态`);
		const currentState = await readSiteDetailState(driver, profile, 800);
		if (!continueVisibleBefore && isApplied(currentState)) {
			await shot("apply-already");
			return appliedResult("页面没有出现文字回执，但投递按钮已经消失、出现「继续沟通」，确认这个岗位已经投递成功，没有重复投递", currentState);
		}
		let page = await readPage();
		if (page.kind === "blocked") return blockedResult(page.wall);
		if (page.kind === "load-error") return {
			...base,
			state: "failed",
			message: `第一次点击后没有回执，重新打开${siteLabel}岗位页也失败了；这个岗位没有确认投出去，可以稍后重新投递`,
			blockedReason: "重新打开详情页失败",
			entryText,
			finalUrl: driver.currentUrl()
		};
		if (page.kind === "not-ready") {
			await shot(page.notReady === "load-failed" ? "apply-load-failed" : "apply-blank");
			return {
				...base,
				state: "failed",
				message: page.notReady === "load-failed" ? `第一次点击后没有回执，重新打开${siteLabel}岗位页时页面没有加载出来，无法确认这次投递；可以稍后重新投递这个岗位` : `第一次点击后没有回执，重新打开${siteLabel}岗位页只看到空白页，无法确认这次投递；可以稍后重新投递这个岗位`,
				blockedReason: page.notReady === "load-failed" ? "页面没有加载出来" : "页面空白",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (page.kind === "success-page") {
			await shot("apply-success");
			return {
				...base,
				state: "submitted",
				message: "第一次点击后没有文字回执；重新打开时页面停在投递成功页，确认这个岗位已经投递成功，没有重复投递",
				successText: "前程无忧投递成功页",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (isApplied(page.state)) {
			await shot("apply-already");
			return appliedResult("第一次点击后页面没有回执；重新打开岗位页时投递按钮已经消失、出现「继续沟通」，确认这个岗位已经投递成功，没有重复投递", page.state);
		}
		if (page.state.applyVisible !== true) {
			await shot("apply-unconfirmed");
			return {
				...base,
				state: options.unknownOutcome,
				message: "第一次点击后没有回执；重新打开岗位页既没有找到投递按钮，也没有出现「继续沟通」，无法确认这次投递",
				blockedReason: "未检测到投递按钮或继续沟通",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		driver.log("重新打开岗位页后投递按钮仍在，说明上一次没有投递成功，正在自动补投一次");
		await shot("apply-retry");
		const retry = await attemptApply();
		if (retry.wall) return blockedResult(retry.wall);
		if (retry.outcome?.kind === "applied") {
			await shot("apply-success");
			return {
				...base,
				state: "submitted",
				message: `第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（投递后页面按钮变成「${retry.outcome.text}」）`,
				successText: `投递后页面显示「${retry.outcome.text}」`,
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (retry.outcome?.kind === "success") {
			await shot("apply-success");
			return {
				...base,
				state: "submitted",
				message: `第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（页面提示「${retry.outcome.text}」）`,
				successText: retry.outcome.text,
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (retry.outcome?.kind === "success-page") {
			await shot("apply-success");
			return {
				...base,
				state: "submitted",
				message: "第一次点击后没有回执；重新打开岗位页确认投递按钮还在，已自动补投成功（前程无忧跳转到投递成功页）",
				successText: retry.outcome.text,
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (retry.outcome?.kind === "closed") {
			await shot("apply-closed");
			return {
				...base,
				state: "failed",
				message: "自动补投时页面变成「职位不存在 / 已下线」的空状态，这个岗位已经投不了了。请回到岗位池重新搜索一个新岗位",
				blockedReason: "岗位已关闭",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		driver.log("自动补投后仍没有成功提示，再次重新打开岗位页核对");
		page = await readPage();
		if (page.kind === "blocked") return blockedResult(page.wall);
		if (page.kind === "load-error" || page.kind === "not-ready") {
			await shot(page.kind === "not-ready" && page.notReady === "blank" ? "apply-blank" : "apply-load-failed");
			return {
				...base,
				state: "failed",
				message: `自动补投后重新打开${siteLabel}岗位页失败，无法确认这次投递是否成功；可以稍后重新投递这个岗位`,
				blockedReason: "重新核对页面失败",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (page.kind === "success-page") {
			await shot("apply-success");
			return {
				...base,
				state: "submitted",
				message: "自动补投后重新打开页面停在投递成功页，确认这个岗位已经投递成功",
				successText: "前程无忧投递成功页",
				entryText,
				finalUrl: driver.currentUrl()
			};
		}
		if (isApplied(page.state)) {
			await shot("apply-already");
			return appliedResult("自动补投后重新打开岗位页，投递按钮已经消失并出现「继续沟通」，确认这个岗位已经投递成功", page.state);
		}
		await shot("apply-unconfirmed");
		return {
			...base,
			state: page.state.applyVisible === true ? "failed" : options.unknownOutcome,
			message: page.state.applyVisible === true ? "自动补投两次后，重新打开岗位页仍能看到投递按钮，说明这次没有投递成功；可以稍后在工作台重新投递这个岗位" : "自动补投后重新打开岗位页，既没有投递按钮也没有「继续沟通」，无法确认这次投递",
			blockedReason: page.state.applyVisible === true ? "未检测到投递成功提示" : "未检测到投递按钮或继续沟通",
			entryText,
			finalUrl: driver.currentUrl()
		};
	};
	if (site === "job51") return recheckAfterAttempt({ unknownOutcome: "failed" });
	if (site === "zhaopin") {
		const rechecked = await recheckAfterAttempt({ unknownOutcome: "needs_user" });
		if (rechecked.state !== "needs_user" || rechecked.blockedReason !== "未检测到投递按钮或继续沟通") return rechecked;
		const verified = await verifyZhaopinMessageRecord(driver, job, shot, screenshots);
		if (verified) return verified;
		return {
			...rechecked,
			message: `${rechecked.message}；智联消息列表里也暂时没有核对到这条记录，请打开智联消息页核对是否已投递`,
			finalUrl: driver.currentUrl()
		};
	}
	return {
		...base,
		state: "needs_user",
		message: attempt.confirmed || entryText ? "已点击投递并确认，但页面没有出现投递成功提示。请在浏览器窗口里核对是否已投递，再回工作台标记" : "没有点成投递，请在浏览器窗口里手动投递",
		blockedReason: "未检测到投递成功提示",
		entryText,
		finalUrl
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/apply.ts
var ABORT_MESSAGE$1 = "投递任务已停止，本次操作已中止";
function text$2(value, max = 1e3) {
	return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}
function sleep$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeName$1(value) {
	return String(value ?? "shot").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
}
/**
* 把浏览器的异步动作适配成 `submitResume` 需要的 ApplyDriver。
*
* 原来的驱动把 `currentUrl()` 设计成同步取值（主进程直接读 BrowserWindow），
* 插件这边只能走 RPC，所以缓存一份地址，并在每次可能发生跳转的动作后刷新：
* 加载、等待、脚本、点击、输入、阻断检查、读正文之后都重新取一次。
*/
function createApplyDriver(options) {
	const { driver, site, evidenceDir, log, signal } = options;
	let currentUrl = "";
	const refreshUrl = async () => {
		const next = await driver.url(site).catch(() => "");
		if (next) currentUrl = next;
		return currentUrl;
	};
	const aborted = () => signal?.aborted === true;
	const guard = () => {
		if (aborted()) throw new Error(ABORT_MESSAGE$1);
	};
	const shot = async (label) => {
		const file = `${String(evidenceDir).replace(/[\\/]+$/, "")}/${Date.now()}-${safeName$1(label)}.png`;
		return await driver.screenshot(site, file).catch(() => "");
	};
	return {
		applyDriver: {
			load: async (url) => {
				guard();
				const result = await driver.goto(site, url, { attempts: 1 }).catch(() => ({
					ok: false,
					url: ""
				}));
				await refreshUrl();
				log(result?.ok ? "岗位页已加载" : "岗位页没有加载出来（白屏），已在窗口里写明原因");
			},
			sleep: async (ms) => {
				guard();
				await sleep$1(ms);
				await refreshUrl();
			},
			evaluate: (code) => driver.evaluate(site, code, 8e3),
			click: async (selectors, label, clickOptions) => {
				guard();
				const hit = await driver.click(site, selectors, label ?? "", {
					labelSelectors: clickOptions?.labelSelectors ?? [],
					scriptFallback: clickOptions?.scriptFallback === true
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
				driver.title(site, `若道 · ${jobSiteLabel(site)}｜${text$2(message, 36)}`).catch(() => void 0);
			}
		},
		lastUrl: () => currentUrl
	};
}
/**
* 前程无忧投递前把岗位地址校正成真正的详情页（jobs.51job.com/{city}/{jobId}.html）。
*
* 卡片 DOM 里只有公司主页链接，`we.51job.com/pc/jobdetail?jobId=` 是前端路由，
* 未登录会被踢到登录页、登录后也经常整页空白。这里在已登录的 we.51job.com
* 页面里用职位号问一次平台接口，换到 jobHref 再打开。
*/
async function resolveJob51ApplyJob(driver, job, log) {
	const direct = normalizeJob51DetailUrl(job.sourceUrl);
	if (direct) return direct === job.sourceUrl ? job : {
		...job,
		sourceUrl: direct
	};
	const jobId = job51JobIdOf(job.jobId) || job51JobIdOf(job.sourceUrl);
	if (!jobId) return null;
	if (await driver.isClosed("job51").catch(() => true)) return null;
	const current = await driver.url("job51").catch(() => "");
	if (!/^https?:\/\/we\.51job\.com\//i.test(current)) {
		const searchUrl = JOB_SITES.job51.searchUrl(text$2(job.title, 20) || "java", "", 1);
		await driver.goto("job51", searchUrl, { attempts: 1 }).catch((error) => {
			log(`打开前程无忧搜索页失败：${text$2(error?.message ?? error, 120)}`);
		});
		await driver.waitContent("job51", 8e3).catch(() => false);
	}
	const href = normalizeJob51DetailUrl(await driver.evaluate("job51", job51LookupScript(jobId), 14e3).catch(() => ""));
	if (!href) {
		log(`没有换到岗位 ${jobId} 的详情页地址`);
		return null;
	}
	log(`已换成前程无忧岗位详情页：${href}`);
	return {
		...job,
		jobId,
		sourceUrl: href
	};
}
/**
* 在猎聘 / 智联 / 前程无忧 详情页直接投递平台在线简历。
*
* 业务判断全部留在插件：入口探测、确认弹窗、附件简历、聊一聊兜底、
* 投递后的按钮状态复核都在 `submitResume` 里；这里只负责窗口状态与结果收口。
*/
async function applyJobSite(engine, driver, input) {
	const site = input.job.source;
	if (!supportsSiteApply(site)) throw new Error(`${jobSiteLabel(site)} 不支持直接投递简历`);
	const screenshots = [];
	if (await driver.isClosed(site).catch(() => true)) return {
		state: "failed",
		message: "招聘平台窗口已关闭，无法继续投递。重新打开窗口后可重试",
		screenshots,
		blockedReason: "窗口已关闭",
		successText: "",
		finalUrl: "",
		entryText: ""
	};
	await driver.reveal(site, input.reveal ?? "focus").catch(() => void 0);
	const { applyDriver, lastUrl } = createApplyDriver({
		driver,
		site,
		evidenceDir: input.evidenceDir,
		log: input.log,
		signal: input.signal
	});
	try {
		input.log(`正在打开${jobSiteLabel(site)}岗位页投递`);
		const job = site === "job51" ? await resolveJob51ApplyJob(driver, input.job, input.log) : input.job;
		if (!job) {
			const file = await applyDriver.shot("apply-bad-url").catch(() => "");
			if (file) screenshots.push(file);
			const blocked = await driver.blocker(site).catch(() => "");
			if (blocked) {
				engine.markBlocked(site, blocked, blocked === "verification" ? "前程无忧要求人机验证，请在招聘窗口里完成验证后重试投递" : "前程无忧岗位详情页没有登录态，本次没有提交简历");
				await driver.reveal(site, "focus").catch(() => void 0);
				const opened = blocked === "login" ? await driver.openLogin(site).catch(() => false) : false;
				input.log(blocked === "verification" ? "岗位页要求人机验证，已把窗口显示到前台" : "岗位页没有登录态，已把窗口显示到前台");
				return {
					state: "blocked",
					message: blocked === "verification" ? "前程无忧要求人机验证，请在招聘窗口里完成验证后重试投递" : `前程无忧登录态已失效，没有提交简历。${opened ? "已经把窗口显示到前台并打开登录入口，" : "已经把这个窗口显示到前台，"}登录完成后回到岗位池重新点「投递」`,
					screenshots,
					blockedReason: blocked === "verification" ? "需要人机验证" : "需要登录",
					successText: "",
					finalUrl: await driver.url(site).catch(() => lastUrl()),
					entryText: ""
				};
			}
			return {
				state: "needs_user",
				message: "没能拿到这个岗位的前程无忧详情页地址（记录里只有公司主页或搜索页链接）。请在招聘窗口里重新搜索一次这个岗位，再点投递",
				screenshots,
				blockedReason: "岗位链接不是详情页",
				successText: "",
				finalUrl: await driver.url(site).catch(() => lastUrl()),
				entryText: ""
			};
		}
		const result = await submitResume(applyDriver, job, {
			resumeFilePath: input.resumeFilePath,
			greeting: input.greeting
		});
		screenshots.push(...result.screenshots);
		if (input.signal?.aborted) return {
			...result,
			state: "failed",
			message: "投递已中止（批量任务被停止，或招聘窗口被关闭）",
			screenshots,
			blockedReason: "已中止"
		};
		if (result.blockedReason === "需要登录") {
			await driver.reveal(site, "focus").catch(() => void 0);
			const opened = await driver.openLogin(site).catch(() => false);
			input.log(opened ? "岗位页没有登录态，已把窗口显示到前台并打开登录入口" : "岗位页没有登录态，已把窗口显示到前台，请登录后重试");
			const file = await applyDriver.shot("apply-login-wall").catch(() => "");
			if (file) screenshots.push(file);
			engine.markBlocked(site, "login", `${jobSiteLabel(site)}岗位详情页没有登录态，本次没有提交简历`);
			const next = site === "job51" ? "登录后会回到这个岗位页，重新点「投递」就能继续" : "登录完成后回到岗位池重新点「投递」";
			return {
				...result,
				state: "blocked",
				message: `${result.message}。${opened ? "已经把窗口显示到前台并打开登录入口。" : "已经把这个窗口显示到前台。"}${next}；如果是批量投递，这一批已经停下来了，登录后点「继续」就能接着投剩下的岗位`,
				screenshots,
				blockedReason: "需要登录",
				finalUrl: await driver.url(site).catch(() => lastUrl())
			};
		}
		if (result.state === "blocked") {
			engine.markBlocked(site, blockedKindFromReason(result.blockedReason) || "login", result.message);
			await driver.reveal(site, "focus").catch(() => void 0);
			input.log("本次投递被平台阻断，已把窗口显示到前台，请处理后重试");
		} else engine.markBlocked(site, "", result.message);
		return {
			...result,
			screenshots
		};
	} catch (error) {
		const aborted = input.signal?.aborted === true;
		return {
			state: aborted ? "needs_user" : "failed",
			message: aborted ? "投递已中止（批量任务被停止，或招聘窗口被关闭），请到平台确认是否已投出" : `${jobSiteLabel(site)}投递失败：${text$2(error?.message ?? error, 300)}`,
			screenshots,
			blockedReason: aborted ? "已中止" : text$2(error?.message ?? error, 200),
			successText: "",
			finalUrl: await driver.url(site).catch(() => lastUrl()),
			entryText: ""
		};
	}
}
//#endregion
//#region ../../plugins/interview-assistant/engine/boss-scripts.ts
/**
* Boss 打招呼流程用到的页面脚本。
*
* 与主进程旧引擎保持一致：入口状态、开聊接口探针、输入框读写、气泡确认。
* 这些脚本只观察和操作页面自己的控件，不额外发请求。
*/
/** Boss 聊天输入框选择器：新版「立即沟通」弹窗的输入框既没有 chat-input 类也不叫「消息」。 */
var BOSS_CHAT_INPUT_SELECTORS = [
	"#chat-input",
	"textarea[class*=\"chat-input\"]",
	"div[contenteditable=\"true\"][class*=\"chat-input\"]",
	".chat-input[contenteditable=\"true\"]",
	".chat-editor [contenteditable=\"true\"]",
	"textarea[placeholder*=\"消息\"]",
	"[contenteditable=\"true\"][data-placeholder*=\"消息\"]",
	".startchat-dialog textarea.input-area",
	".startchat-dialog .input-area",
	".startchat-dialog [contenteditable=\"true\"]"
];
/** 一次读全 Boss 沟通入口需要的页面状态；只认真正的沟通入口，不碰页头「消息」链接。 */
function bossChatStateScript() {
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
function bossGreetProbeInstallScript() {
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
function bossGreetProbeReadScript() {
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
function bossDomGreetScript() {
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
function bossDirectGreetScript() {
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
function bossInputTextScript() {
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
function bossFillInputScript(value) {
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
function bossSentBubbleScript(probe) {
	return `(() => {
    const probe = ${JSON.stringify(probe)};
    if (probe.length < 4) return false;
    const nodes = [...document.querySelectorAll("[class*='message'], [class*='msg'], [class*='chat-content'], [class*='chat-item']")];
    return nodes.some((element) => String(element.textContent || "").replace(/\\s+/g, "").includes(probe));
  })()`;
}
var BOSS_SEND_BUTTON_SELECTORS = [
	"button[type=\"send\"]",
	".send-message",
	"[class*=\"send-btn\"]",
	"[class*=\"btn-send\"]",
	"[class*=\"send-button\"]"
];
var BOSS_IMAGE_SELECTORS = [
	"[aria-label=\"发送图片\"]",
	"[aria-label*=\"图片\"]",
	"[title*=\"图片\"]",
	"[class*=\"send-image\"]",
	"[class*=\"btn-image\"]",
	"[class*=\"toolbar\"] [class*=\"image\"]"
];
var BOSS_IMAGE_INPUT_SELECTORS = [
	"input[type=\"file\"][accept*=\"image\"]",
	"input[type=\"file\"][accept*=\"png\"]",
	"input[type=\"file\"][accept*=\"jpg\"]",
	"input[type=\"file\"]"
];
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/boss-chat.ts
/**
* Boss 沟通入口的纯判定逻辑。
*
* 2026-11-02 从真实岗位页采集：点「立即沟通」后 Boss 会直接用账号里预设的招呼语发出消息，
* 再弹 `.greet-boss-pop`（标题「已向BOSS发送消息」+ 招呼正文 + 「留在此页 / 继续沟通」）。
* 页面不会出现聊天输入框，所以「只等输入框」必然超时，把已经发出的招呼记成「没有找到入口」，
* 用户看到的就是「处理中 / 实际上没打招呼」。
*
* 这套判定必须能被单元测试直接覆盖，不能埋在 Electron 窗口代码里。
*/
function normalizeBossChatLabel(value) {
	return String(value ?? "").replace(/\s+/g, "").trim();
}
/** 从「已向BOSS发送消息」确认框里取出平台实际发出的招呼正文。 */
function extractBossAutoGreeting(body) {
	const value = String(body ?? "").replace(/\r/g, "");
	const start = value.indexOf("已向BOSS发送消息");
	if (start < 0) return "";
	let rest = value.slice(start + 10);
	const end = rest.search(/如需修改打招呼内容|留在此页|继续沟通/);
	if (end >= 0) rest = rest.slice(0, end);
	return rest.replace(/\s+/g, " ").trim().slice(0, 500);
}
function readBossChatSignal(input) {
	const before = normalizeBossChatLabel(input.beforeLabel);
	const current = normalizeBossChatLabel(input.currentLabel);
	const body = String(input.body ?? "");
	const autoSent = detectBossAutoGreet(body);
	const alreadyChatted = /继续沟通/.test(before);
	const labelConfirmed = !alreadyChatted && /立即沟通/.test(before) && /继续沟通/.test(current);
	return {
		autoSent,
		labelConfirmed,
		alreadyChatted,
		chatOpen: input.hasInput === true,
		greeting: autoSent || labelConfirmed ? extractBossAutoGreeting(body) : ""
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/boss-greet.ts
var EMPTY_VERDICT = {
	kind: "pending",
	message: "",
	greeting: "",
	blockedReason: ""
};
var GREET_API = /\/wapi\/zpgeek\/friend\/(add|continuechat)\.json/i;
var CONFIG_API = /\/wapi\/zpchat\/config\/get/i;
function normalize$1(value) {
	return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function clamp(value, max = 120) {
	const text = normalize$1(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
function callDetail(call) {
	return normalize$1(call.remindContent) || normalize$1(call.message);
}
function verdict(kind, message, extra = {}) {
	return {
		kind,
		message,
		greeting: extra.greeting ?? "",
		blockedReason: extra.blockedReason ?? ""
	};
}
/**
* 把一次点击后的接口回包 / 页面提示翻译成结论。
*
* `config/get` 只作为「页面处理器确实被点到了」的证据，不参与成功判定。
*/
function interpretBossGreetProbe(snapshot) {
	if (!snapshot) return EMPTY_VERDICT;
	const sentText = normalize$1(snapshot.sentText);
	const remindText = normalize$1(snapshot.remindText);
	const calls = Array.isArray(snapshot.calls) ? snapshot.calls : [];
	const greetCalls = calls.filter((call) => GREET_API.test(call.api));
	const call = greetCalls[greetCalls.length - 1];
	if (call) {
		if (!call.endedAt) return verdict("pending", "Boss 已收到招呼请求，正在等待平台返回");
		if (!call.status) return verdict("refused", "Boss 接口没有返回，可能被网络或平台拦截", { blockedReason: "Boss 接口无响应" });
		const code = typeof call.code === "number" ? call.code : null;
		if (code === 0) {
			const greeting = normalize$1(call.greeting) || sentText;
			if (greeting) return verdict("sent", "Boss 已确认发出招呼", { greeting });
			return verdict("chat", "Boss 已接受沟通请求，正在进入聊天窗口");
		}
		if (code === 7 || code === 1011) return verdict("login", "需要登录 Boss 直聘", { blockedReason: "需要登录 Boss 直聘" });
		if (code === 24) return verdict("user", "Boss 要求先到 App 切换到牛人身份后再试", { blockedReason: "Boss 要求切换牛人身份" });
		if (code === 25) return verdict("user", "Boss 要求先补充在线简历，请在 Boss 页面按提示处理", { blockedReason: "Boss 要求补充资料" });
		if (code === 1) {
			if (call.bizCode === 1) return verdict("limit", `Boss 限制本次沟通：${clamp(callDetail(call)) || remindText || "Boss 提示当前沟通次数受限"}`, { blockedReason: "沟通次数已达上限" });
			if (call.bizCode === 2) return verdict("refused", "Boss 提示该职位当前无法投递", { blockedReason: "Boss 提示职位无法投递" });
			return verdict("refused", clamp(callDetail(call)) || remindText || "Boss 拒绝了这个岗位的沟通请求", { blockedReason: "Boss 拒绝沟通" });
		}
		return verdict("refused", clamp(call.message) || `Boss 返回错误码 ${code ?? "未知"}`, { blockedReason: "Boss 拒绝沟通" });
	}
	if (sentText) return verdict("sent", "Boss 弹窗里已经显示招呼发送成功", { greeting: sentText });
	if (snapshot.chatRemind) return verdict("limit", `Boss 提示沟通受限：${clamp(remindText) || "请按页面提示处理"}`, { blockedReason: "沟通次数已达上限" });
	if (snapshot.startchatOpen) return verdict("chat", "Boss 已打开开聊弹窗，正在等待发送结果");
	if (calls.some((entry) => CONFIG_API.test(entry.api))) return verdict("pending", "Boss 已响应点击，正在打开沟通入口");
	return EMPTY_VERDICT;
}
/** 点击后是否已经有「平台在处理」的迹象（用于判断要不要补一次点击）。 */
function bossGreetHasActivity(snapshot) {
	if (!snapshot) return false;
	return snapshot.calls.length > 0 || snapshot.chatRemind || snapshot.startchatOpen || Boolean(normalize$1(snapshot.sentText));
}
//#endregion
//#region ../../plugins/interview-assistant/engine/greet.ts
var ABORT_MESSAGE = "投递任务已停止，本次操作已中止";
/** 沟通入口的选择器：与主进程旧引擎一致，只认真正的「立即沟通 / 继续沟通」。 */
var BOSS_ENTRY_SELECTORS = [
	"a.btn-startchat",
	"a.op-btn-chat",
	"[class*=\"btn-startchat\"]",
	"button[class*=\"startchat\"]"
];
var BOSS_ENTRY_LABELS = "^(立即沟通|继续沟通|打招呼)$";
function text$1(value, max = 1e3) {
	return String(value ?? "").replace(/[^\S\n]+/g, " ").trim().slice(0, max);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function isHttpUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function safeName(value) {
	return String(value ?? "shot").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
}
var EMPTY_CHAT_STATE = {
	label: "",
	point: null,
	hasInput: false,
	text: "",
	ready: false,
	entry: null,
	hitEntry: false,
	startchatOpen: false,
	sentText: "",
	remindText: ""
};
async function readBossChatState(driver) {
	return await driver.evaluate("boss", bossChatStateScript()).catch(() => void 0) ?? EMPTY_CHAT_STATE;
}
async function readBossGreetProbe(driver) {
	return await driver.evaluate("boss", bossGreetProbeReadScript(), 4e3).catch(() => null) ?? null;
}
/**
* 打开 Boss 聊天，并识别平台「自动打招呼」行为。
*
* 按「等脚本就位 → 可信点击 → 页面内点击 → 直接调用 Detail.startChat」逐级兜底，
* 并用页面请求探针读出平台回包（已发送 / 登录 / 次数上限 / 职位不可投 / 需本人处理）。
*/
async function openChat(driver, log, signal, options = {}) {
	const empty = (reason = "", extra = {}) => ({
		opened: false,
		autoSent: false,
		greeting: "",
		alreadyChatted: false,
		reason,
		blocked: "",
		blockedReason: "",
		...extra
	});
	let state = await readBossChatState(driver);
	if (state.hasInput) return {
		...empty(),
		opened: true
	};
	const initial = readBossChatSignal({
		beforeLabel: "",
		currentLabel: state.label,
		body: state.text,
		hasInput: state.hasInput
	});
	if (initial.autoSent) return {
		...empty(),
		autoSent: true,
		greeting: initial.greeting
	};
	for (let index = 0; index < 15 && !state.label && !state.hasInput; index += 1) {
		if (signal?.aborted) return empty();
		await sleep(400);
		state = await readBossChatState(driver);
	}
	if (signal?.aborted) return empty();
	if (state.hasInput) return {
		...empty(),
		opened: true
	};
	const before = state.label;
	if (!before) return empty("没有找到「立即沟通」入口。岗位可能已下线，或页面还没加载完，请在浏览器窗口中确认");
	if (/继续沟通/.test(before) && options.repeat !== true) return {
		...empty(),
		alreadyChatted: true
	};
	if (!state.ready) for (let index = 0; index < 20 && !state.ready; index += 1) {
		if (signal?.aborted) return empty();
		await sleep(400);
		state = await readBossChatState(driver);
	}
	if (!state.label) return empty("没有找到「立即沟通」入口，岗位可能已下线");
	const scriptReady = state.ready;
	await driver.evaluate("boss", bossGreetProbeInstallScript(), 4e3).catch(() => false);
	if (!state.hitEntry) log("「立即沟通」入口被页面浮层遮挡，改用页面内点击");
	if (await driver.click("boss", BOSS_ENTRY_SELECTORS, BOSS_ENTRY_LABELS).catch(() => false)) log("正在打开与招聘者的聊天窗口");
	let domClicked = false;
	let directCalled = false;
	for (let index = 0; index < 32; index += 1) {
		await sleep(500);
		if (signal?.aborted) return empty();
		const current = await readBossChatState(driver);
		const probe = await readBossGreetProbe(driver);
		const verdict = interpretBossGreetProbe(probe);
		if (verdict.kind === "sent") return {
			...empty(),
			autoSent: true,
			greeting: verdict.greeting
		};
		if (verdict.kind === "login") return empty("Boss 需要重新登录，请在浏览器窗口里扫码登录后重试", {
			blocked: "login",
			blockedReason: "需要登录 Boss 直聘"
		});
		if (verdict.kind === "limit" || verdict.kind === "user" || verdict.kind === "refused") return empty(verdict.message, { blockedReason: verdict.blockedReason });
		if (verdict.kind === "chat" && current.hasInput) {
			if (current.startchatOpen) {
				await sleep(700);
				const late = interpretBossGreetProbe(await readBossGreetProbe(driver));
				if (late.kind === "sent") return {
					...empty(),
					autoSent: true,
					greeting: late.greeting
				};
			}
			return {
				...empty(),
				opened: true
			};
		}
		const signalState = readBossChatSignal({
			beforeLabel: before,
			currentLabel: current.label,
			body: current.text,
			hasInput: current.hasInput
		});
		if (signalState.autoSent) return {
			...empty(),
			opened: signalState.chatOpen,
			autoSent: true,
			greeting: signalState.greeting
		};
		if (signalState.chatOpen) return {
			...empty(),
			opened: true
		};
		if (signalState.labelConfirmed) return {
			...empty(),
			autoSent: true,
			greeting: signalState.greeting
		};
		const blocked = classifyBlocked(await driver.url("boss").catch(() => ""), current.text);
		if (blocked) return {
			...empty(),
			blocked
		};
		const activity = bossGreetHasActivity(probe);
		if (!domClicked && !activity && index >= 5) {
			domClicked = await driver.evaluate("boss", bossDomGreetScript()).catch(() => false) === true;
			if (domClicked) log("「立即沟通」没有触发平台响应，已直接用页面按钮重新触发");
			continue;
		}
		if (domClicked && !directCalled && !activity && index >= 11) {
			directCalled = await driver.evaluate("boss", bossDirectGreetScript()).catch(() => false) === true;
			if (directCalled) log("页面按钮仍未响应，已改用 Boss 页面自己的开聊接口");
		}
	}
	const last = interpretBossGreetProbe(await readBossGreetProbe(driver));
	if (last.kind === "sent") return {
		...empty(),
		autoSent: true,
		greeting: last.greeting
	};
	if (last.kind === "limit" || last.kind === "user" || last.kind === "refused") return empty(last.message, { blockedReason: last.blockedReason });
	if (directCalled) return empty("已直接调用 Boss 开聊接口，但平台没有返回结果。请到 Boss 消息页核对是否已发出");
	if (!scriptReady) return empty("Boss 岗位页脚本没有加载完成（可能被网络或平台风控拦住），本次没有发出。请在浏览器窗口中刷新后重试");
	return empty("点击「立即沟通」后页面没有出现聊天窗口或发送提示");
}
async function fillGreeting(driver, greeting) {
	await driver.fill("boss", BOSS_CHAT_INPUT_SELECTORS, greeting).catch(() => false);
	const probe = greeting.replace(/\s+/g, "").slice(0, 24);
	if (String(await driver.evaluate("boss", bossInputTextScript()).catch(() => "") ?? "").replace(/\s+/g, "").includes(probe)) return true;
	await driver.evaluate("boss", bossFillInputScript(greeting)).catch(() => false);
	await sleep(300);
	return String(await driver.evaluate("boss", bossInputTextScript()).catch(() => "") ?? "").replace(/\s+/g, "").includes(probe);
}
async function clickSend(driver, log) {
	for (const selector of BOSS_SEND_BUTTON_SELECTORS) if (await driver.click("boss", [selector]).catch(() => false)) return true;
	if (await driver.click("boss", [], "^发送$").catch(() => false)) return true;
	log("未找到发送按钮，使用回车发送");
	await driver.pressKey("boss", "Enter");
	return true;
}
async function sendImageResume(driver, imagePath, log) {
	let attached = await driver.upload("boss", BOSS_IMAGE_INPUT_SELECTORS, [imagePath]).catch(() => false);
	if (!attached) attached = await driver.chooseFile("boss", BOSS_IMAGE_SELECTORS, imagePath).catch(() => false);
	if (!attached) {
		log("没有找到可用的图片上传入口，图片简历未自动发送");
		return false;
	}
	await sleep(1200);
	log("已选择图片简历，正在确认发送");
	await driver.click("boss", ["[class*=\"dialog\"] button", "[class*=\"modal\"] button"], "^发送$").catch(() => false);
	await sleep(1200);
	return true;
}
/**
* Boss 打招呼：打开岗位页 → 立即沟通 → 填入话术发送 → 确认消息出现在聊天里。
*
* 平台会自动用账号预设招呼语发出并弹「已向BOSS发送消息」，这已经是成功发送；
* 只有确认页面出现了刚发送的话术才算 sent，其余情况交回本人处理。
*/
async function greetBoss(engine, driver, input) {
	const screenshots = [];
	const evidenceDir = input.evidenceDir;
	const signal = input.signal;
	const checkAbort = () => {
		if (signal?.aborted) throw new Error(ABORT_MESSAGE);
	};
	if (await driver.isClosed("boss").catch(() => true)) return {
		state: "failed",
		message: "Boss 窗口已关闭，无法继续投递。重新打开窗口后可重试",
		screenshots,
		blockedReason: "窗口已关闭",
		successText: "",
		finalUrl: ""
	};
	const abortedResult = () => ({
		state: "failed",
		message: "投递已中止（批量任务被停止，或 Boss 窗口被关闭）",
		screenshots,
		blockedReason: "已中止",
		successText: "",
		finalUrl: ""
	});
	await driver.reveal("boss", input.reveal ?? "focus").catch(() => void 0);
	const shot = async (label) => {
		const file = `${String(evidenceDir).replace(/[\\/]+$/, "")}/${Date.now()}-${safeName(label)}.png`;
		const saved = await driver.screenshot("boss", file).catch(() => "");
		if (saved) screenshots.push(saved);
	};
	const finalUrl = () => driver.url("boss").catch(() => "");
	const fail = async (state, message, blockedReason = "") => {
		const wall = state === "failed" ? "" : blockedKindFromReason(blockedReason);
		engine.markBlocked("boss", wall || (state === "blocked" ? "verification" : ""), message);
		if (wall) {
			await driver.reveal("boss", "focus").catch(() => void 0);
			input.log(`${wall === "verification" ? "需要人机验证" : "需要登录"}，已把 ${jobSiteLabel("boss")} 窗口显示到前台`);
		}
		await shot(state);
		return {
			state,
			message,
			screenshots,
			blockedReason,
			successText: "",
			finalUrl: await finalUrl()
		};
	};
	try {
		if (!isHttpUrl(input.job.sourceUrl)) return await fail("failed", "岗位链接无效，无法打开 Boss 岗位页");
		checkAbort();
		await driver.goto("boss", input.job.sourceUrl, { attempts: 1 }).catch((error) => {
			input.log(`页面加载较慢或超时：${text$1(error?.message ?? error, 120)}`);
		});
		await sleep(1200);
		checkAbort();
		const blocked = await driver.blocker("boss").catch(() => "");
		if (blocked) return await fail("needs_user", blocked === "verification" ? "Boss直聘要求人机验证，请在浏览器窗口里完成验证后回到工作台重试" : "Boss直聘需要先登录，请在浏览器窗口里扫码登录后回到工作台重试", blocked === "verification" ? "需要人机验证" : "需要登录 Boss 直聘");
		if (await driver.loginState("boss").catch(() => "") === "out") {
			engine.markLoginState("boss", "out");
			await driver.openLogin("boss").catch((error) => {
				input.log(`打开 Boss 登录入口失败：${text$1(error?.message ?? error, 120)}`);
			});
			return await fail("needs_user", "Boss 直聘当前未登录，请在浏览器窗口里扫码登录后回到工作台点「继续」，登录态会保存在这个窗口里", "需要登录 Boss 直聘");
		}
		checkAbort();
		const autoGreetSent = async () => detectBossAutoGreet(await driver.body("boss").catch(() => ""));
		const recordAutoGreet = async (greetingText = "") => {
			const sentText = text$1(greetingText, 300);
			input.log(sentText ? `Boss 已自动发出预设招呼语：${sentText}` : "Boss 已自动发出预设招呼语（页面提示「已向BOSS发送消息」）");
			await shot("greet-auto-sent");
			engine.markBlocked("boss", "", "Boss 已自动发送招呼");
			return {
				state: "sent",
				message: sentText ? `Boss 已自动发出预设招呼语：「${sentText}」，已记录为已投递` : "Boss 已自动发出预设招呼语（页面提示「已向BOSS发送消息」），已记录为已投递",
				screenshots,
				blockedReason: "",
				successText: "页面提示「已向BOSS发送消息」",
				greeting: sentText,
				greetingSource: "auto",
				finalUrl: await finalUrl()
			};
		};
		const chat = await openChat(driver, input.log, signal, { repeat: input.allowRepeatChat === true });
		checkAbort();
		if (chat.autoSent) return await recordAutoGreet(chat.greeting);
		if (chat.alreadyChatted) {
			await shot("greet-already");
			engine.markBlocked("boss", "", "Boss 显示这个岗位已经沟通过");
			return {
				state: "sent",
				message: "Boss 聊天入口显示「继续沟通」，说明这个岗位之前已经打过招呼；本次没有重复发送，已补记到已投递名单",
				screenshots,
				blockedReason: "",
				successText: "Boss 入口显示「继续沟通」",
				greeting: "",
				greetingSource: "already",
				finalUrl: await finalUrl()
			};
		}
		if (!chat.opened) {
			checkAbort();
			if (await autoGreetSent()) return await recordAutoGreet();
			const lateBlock = chat.blocked || await driver.blocker("boss").catch(() => "");
			if (lateBlock) return await fail("needs_user", lateBlock === "login" ? "需要先登录 Boss 直聘，请在浏览器窗口里完成登录后重试" : "Boss直聘要求人机验证，请在浏览器窗口里完成验证后重试", lateBlock === "login" ? "需要登录 Boss 直聘" : "需要人机验证");
			const pageBody = await driver.body("boss").catch(() => "");
			if (/职位已关闭|已下线|停止招聘|职位已失效|该职位不存在/.test(pageBody)) return await fail("failed", "岗位已关闭或已下线，本次没有发出", "岗位已关闭");
			if (/点击「立即沟通」后页面没有出现/.test(chat.reason)) return await fail("needs_user", "点击了「立即沟通」，但页面没有出现发送回执。消息可能已经发出；批量结束后会自动核对 Boss 消息记录", "沟通入口无响应（待消息记录核对）");
			return await fail("needs_user", chat.reason || "没有找到「立即沟通」入口，本次没有发出，请在浏览器窗口中确认", chat.blockedReason || "未找到沟通入口");
		}
		checkAbort();
		if (await autoGreetSent()) return await recordAutoGreet();
		const greeting = text$1(input.greeting, 500);
		if (!greeting) return await fail("failed", "打招呼内容为空");
		checkAbort();
		if (!await fillGreeting(driver, greeting)) return await fail("needs_user", "聊天窗口已打开，但没有成功填入招呼语。请在浏览器中手动发送这段文字", "输入框未能写入");
		input.log("已填入打招呼内容，正在发送");
		checkAbort();
		await clickSend(driver, input.log);
		let seen = false;
		let toast = false;
		for (let index = 0; index < 12; index += 1) {
			await sleep(500);
			checkAbort();
			const rawBody = await driver.body("boss").catch(() => "");
			const body = rawBody.replace(/\s+/g, "");
			const currentInput = String(await driver.evaluate("boss", bossInputTextScript()).catch(() => "") ?? "").replace(/\s+/g, "");
			const probe = greeting.replace(/\s+/g, "").slice(0, 10);
			const inputEmpty = !currentInput.trim();
			seen = probe.length >= 4 && await driver.evaluate("boss", bossSentBubbleScript(probe)).catch(() => false) === true || inputEmpty && probe.length >= 4 && body.includes(probe);
			toast = detectBossAutoGreet(rawBody) || inputEmpty && /发送成功|消息已发送|已发送/.test(body);
			if (seen || toast) break;
		}
		let imageNote = "";
		if (input.imagePath) {
			checkAbort();
			const sentImage = await sendImageResume(driver, input.imagePath, input.log).catch(() => false);
			imageNote = sentImage ? "图片简历已提交到聊天窗口" : "图片简历未自动发送，可在聊天窗口补发";
			if (!sentImage) input.log("图片简历没有自动发送，可稍后在聊天窗口补发");
		}
		await sleep(600);
		await shot(seen || toast ? "greet-sent" : "greet-unconfirmed");
		engine.markBlocked("boss", "", "Boss 打招呼已执行");
		if (seen || toast) return {
			state: "sent",
			message: imageNote ? `已发送打招呼消息（${imageNote}）` : "已发送打招呼消息",
			screenshots,
			blockedReason: "",
			successText: "打招呼消息已出现在聊天窗口",
			greeting,
			greetingSource: "typed",
			finalUrl: await finalUrl()
		};
		return {
			state: "needs_user",
			message: "已尝试发送，但没有在页面上确认到消息记录。请在浏览器窗口中核对是否已发出，再回工作台标记",
			screenshots,
			blockedReason: "未检测到发送成功提示",
			successText: "",
			greeting,
			greetingSource: "typed",
			finalUrl: await finalUrl()
		};
	} catch (error) {
		if (signal?.aborted) return abortedResult();
		return await fail("failed", `Boss 打招呼失败：${text$1(error?.message ?? error, 300)}`);
	}
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/trust.ts
var DAY = 864e5;
var HEADHUNTER_PATTERN = /猎头|人力资源服务|人才服务|招聘服务/;
/**
* 可解释的「真实招聘」判断：只用页面上能拿到的信号，不猜测、不访问外部数据。
* 分数只用于排序和提示，不能替代本人核实。
*/
function assessJobTrust(job, sighting, now = Date.now()) {
	const reasons = [];
	const risks = [];
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
	const salaryKnown = job.salaryMin !== null && job.salaryMin !== void 0 && Number(job.salaryMin) > 0 || job.salaryMax !== null && job.salaryMax !== void 0 && Number(job.salaryMax) > 0;
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
	const activeDays = job.activeDays === null || job.activeDays === void 0 ? parseActiveDays(job.recruiterActive) : Number(job.activeDays);
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
	let listingDays = null;
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
	const refreshCount = Math.max(Math.round(Number(job.refreshCount) || 0), Math.round(Number(sighting?.refreshCount) || 0));
	const ageCandidates = [postedDays, listingDays].filter((value) => value !== null);
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
		if (refreshCount >= 2 && ageDays >= 30) {
			score -= 8;
			risks.push(`平台已把发布时间改过 ${refreshCount} 次，但岗位连续在池 ${ageDays} 天`);
		}
	} else risks.push("平台未展示发布时间，也没有本地首见记录");
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
	let level = score >= 75 ? "high" : score >= 55 ? "medium" : score >= 35 ? "low" : "suspect";
	if (status === "closed") level = "suspect";
	else if (level === "high" && (anonymous || !salaryKnown || !recruiter || headhunter || taggedHeadhunter)) level = "medium";
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
		longTerm: ageDays !== null && ageDays >= 30
	};
}
function applyJobTrust(job, sighting, now = Date.now()) {
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
		trustRisks: trust.risks
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/auto-apply/matcher.ts
var LATIN_STOP = /* @__PURE__ */ new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"this",
	"that",
	"you",
	"your",
	"are",
	"our",
	"will",
	"have",
	"has",
	"job",
	"role",
	"team",
	"work"
]);
function normalize(value) {
	return String(value ?? "").toLowerCase().replace(/[，。；、！？：""''（）【】《》,.;:!?"'()]/g, " ").replace(/\s+/g, " ").trim();
}
function terms(value) {
	const text = normalize(value);
	const result = /* @__PURE__ */ new Set();
	const latin = text.match(/[a-z][a-z0-9+#.-]{1,30}/g) ?? [];
	for (const word of latin) if (!LATIN_STOP.has(word)) result.add(word);
	const cjk = text.match(/[\u3400-\u9fff]+/g) ?? [];
	for (const run of cjk) {
		if (run.length === 1) result.add(run);
		for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
	}
	return result;
}
function dice(a, b) {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return 2 * shared / (a.size + b.size);
}
function containsLoose(haystack, needle) {
	const left = normalize(haystack);
	const right = normalize(needle);
	if (!right) return false;
	return left.includes(right) || right.includes(left) && right.length >= 3;
}
function parseSalary(value) {
	const numbers = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
	if (!numbers.length) return null;
	const min = Math.min(...numbers);
	const max = Math.max(...numbers);
	if (numbers.length === 1) return [min, min];
	return [min, max];
}
function salaryOverlap(profile, job) {
	if (job.salaryMin === null && job.salaryMax === null) return null;
	const expected = parseSalary(profile.salary);
	if (!expected) return null;
	const jobMin = job.salaryMin ?? job.salaryMax ?? 0;
	return !((job.salaryMax ?? job.salaryMin ?? 0) < expected[0] || jobMin > expected[1]);
}
function roleMatch(profile, job) {
	if (!profile.targetRoles.length) return .55;
	const haystack = `${job.title} ${job.roleFamily} ${job.skills.join(" ")}`;
	return profile.targetRoles.some((role) => containsLoose(haystack, role)) ? 1 : 0;
}
function cityMatch(profile, job) {
	if (job.remoteType === "remote" && profile.remote === "远程") return 1;
	if (!profile.targetCities.length) return .6;
	const city = job.city || "";
	return profile.targetCities.some((target) => city.includes(target) || target.includes(city) && city.length >= 2) ? 1 : 0;
}
function scoreJob(profile, job, resumeText = "") {
	const profileText = [
		profile.summary,
		profile.skills.join(" "),
		resumeText
	].filter(Boolean).join("\n");
	const jobText = [
		job.title,
		job.description,
		job.requirements,
		job.responsibilities,
		job.skills.join(" "),
		job.roleFamily
	].filter(Boolean).join("\n");
	const similarity = dice(terms(profileText), terms(jobText));
	const matchedSkills = job.skills.filter((skill) => containsLoose(profileText, skill));
	const missingSkills = job.skills.filter((skill) => !matchedSkills.includes(skill));
	const skillRatio = job.skills.length ? matchedSkills.length / job.skills.length : .5;
	const role = roleMatch(profile, job);
	const city = cityMatch(profile, job);
	const salary = salaryOverlap(profile, job);
	let score = Math.round(similarity * 42 + skillRatio * 30 + role * 18 + city * 10);
	if (salary === true) score += 4;
	if (salary === false) score -= 6;
	if (profile.remote === "远程" && job.remoteType === "remote") score += 3;
	score = Math.max(0, Math.min(100, score));
	const reasons = [];
	if (matchedSkills.length) reasons.push(`技能命中：${matchedSkills.slice(0, 4).join(" / ")}`);
	if (role === 1) reasons.push(`岗位方向与目标一致：${profile.targetRoles.slice(0, 2).join(" / ")}`);
	if (city === 1) reasons.push(job.remoteType === "remote" && profile.remote === "远程" ? "支持远程，符合你的偏好" : `工作城市匹配：${job.city || "不限"}`);
	if (salary === true) reasons.push("薪资区间与期望有交集");
	if (!reasons.length) reasons.push("岗位描述与你的经历有部分关键词重合，建议人工再确认");
	const gaps = missingSkills.slice(0, 6);
	return {
		score,
		reasons,
		gaps,
		matchedSkills,
		missingSkills,
		verdict: score >= 78 ? "strong" : score >= 60 ? "worth" : "skip"
	};
}
function withLocalScore(profile, job, resumeText = "") {
	const result = scoreJob(profile, job, resumeText);
	return {
		...job,
		matchScore: result.score,
		reasons: result.reasons,
		gaps: result.gaps,
		verdict: result.verdict
	};
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/job51-records.ts
var DATE_PATTERN = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/;
var COMPANY_HINT$1 = /公司|集团|银行|学院|大学|研究院|研究所|中心|工作室|事务所|医院|酒店|工厂|有限|股份|科技|信息|网络|软件|传媒|教育|咨询/;
var NOISE_LINE = /^(查看|删除|再次投递|再投递|收藏|取消收藏|立即投递|投递简历|申请职位|已投递|已申请|投递成功|申请成功|展开|收起)$/;
function text(value, max = 400) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function compactKey(value) {
	return text(value, 400).replace(/[\s·|,，。:：;；()（）【】\[\]-]+/g, "").toLowerCase();
}
function parseAppliedAt(value) {
	const match = text(value, 900).match(DATE_PATTERN);
	if (!match) return 0;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!year || month < 1 || month > 12 || day < 1 || day > 31) return 0;
	return new Date(year, month - 1, day).getTime();
}
function looksLikeTitleLine(line) {
	const value = text(line, 200);
	if (!value || NOISE_LINE.test(value)) return false;
	if (DATE_PATTERN.test(value)) return false;
	if (/^(社会申请|校园申请|申请记录|我的申请|投递记录|职位名称|公司名称|申请时间|状态)$/.test(value)) return false;
	if (/^[\d\s./-]+$/.test(value)) return false;
	return true;
}
/** 从一行行文本里猜岗位名和公司名；只在没有职位号、需要标题+公司兜底匹配时使用。 */
function guessIdentity(item) {
	const lines = item.lines.map((line) => text(line, 200)).filter(Boolean);
	const anchor = text(item.anchorText, 200);
	const title = (anchor && looksLikeTitleLine(anchor) ? anchor : "") || lines.find(looksLikeTitleLine) || "";
	return {
		title,
		company: lines.find((line) => line !== title && line !== anchor && !NOISE_LINE.test(line) && !DATE_PATTERN.test(line) && COMPANY_HINT$1.test(line)) || lines.find((line) => line !== title && line !== anchor && looksLikeTitleLine(line)) || ""
	};
}
function parseJob51AppliedRecords(rawItems, _now = Date.now()) {
	const records = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of Array.isArray(rawItems) ? rawItems : []) {
		if (!item || typeof item !== "object") continue;
		const url = text(item.url, 320);
		const body = text(item.text || (Array.isArray(item.lines) ? item.lines.join(" | ") : ""), 900);
		if (!body) continue;
		const jobId = job51JobIdOf(url);
		const identity = guessIdentity(item);
		const appliedAt = parseAppliedAt(body);
		const key = jobId ? `id:${jobId}` : `text:${compactKey(`${identity.company}|${identity.title}|${body}`)}`;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		records.push({
			jobId,
			url,
			title: text(identity.title, 160),
			company: text(identity.company, 160),
			appliedAt,
			text: body
		});
		if (records.length >= 120) break;
	}
	return records;
}
/**
* 把岗位和申请记录对上：优先职位号，其次「岗位名 + 公司名」同时命中。
* 只有岗位名相同、公司对不上（或岗位匿名）时不确认，避免同名岗位误判。
*/
function matchJob51AppliedRecord(job, records) {
	const list = Array.isArray(records) ? records : [];
	const jobId = job51JobIdOf(job.jobId) || job51JobIdOf(job.sourceUrl);
	if (jobId) {
		const index = list.findIndex((record) => record.jobId === jobId);
		if (index >= 0) return {
			matched: true,
			index,
			reason: `前程无忧申请记录里有同一岗位（职位号 ${jobId}${list[index].appliedAt ? `，投递于 ${formatClock(list[index].appliedAt)}` : ""}）`
		};
	}
	const title = compactKey(job.title);
	const company = compactKey(job.company);
	if (!title) return {
		matched: false,
		index: -1,
		reason: "岗位标题为空，无法匹配申请记录"
	};
	let titleOnly = -1;
	for (let index = 0; index < list.length; index += 1) {
		const record = list[index];
		const recordTitle = compactKey(record.title);
		if (!(recordTitle ? recordTitle.includes(title) || title.includes(recordTitle) : compactKey(record.text).includes(title))) continue;
		if (!company) {
			if (titleOnly < 0) titleOnly = index;
			continue;
		}
		const recordCompany = compactKey(record.company);
		if (!(recordCompany ? recordCompany.includes(company) || company.includes(recordCompany) : compactKey(record.text).includes(company))) continue;
		return {
			matched: true,
			index,
			reason: `前程无忧申请记录里有「${text(job.title, 60)}」（${text(job.company, 60)}${record.appliedAt ? `，投递于 ${formatClock(record.appliedAt)}` : ""}）`
		};
	}
	return {
		matched: false,
		index: -1,
		reason: titleOnly >= 0 ? "申请记录里只有同名岗位，公司名对不上" : "申请记录里没有找到这家公司的这个岗位"
	};
}
function formatClock(at) {
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/**
* 在申请记录页里抓列表项。
*
* 个人中心不是标准 SPA，也没保证 DOM class：优先顺着岗位详情链接向上找「一条记录」，
* 找不到链接时再按「表格行 / 列表项 + 日期」兜底。只读 innerText，不点任何按钮。
*/
function job51RecordsScript() {
	return `(() => {
    const clean = (value) => String(value ?? "").replace(/\\r/g, "").trim();
    const normalize = (value) => clean(value).replace(/\\s+/g, " ").trim();
    const docs = [];
    const collectDocs = (doc, depth) => {
      if (!doc || depth > 2) return;
      docs.push(doc);
      for (const frame of doc.querySelectorAll("iframe")) {
        try {
          const inner = frame.contentDocument;
          if (inner) collectDocs(inner, depth + 1);
        } catch { /* 跨域 iframe 读不到，跳过 */ }
      }
    };
    collectDocs(document, 0);
    const jobUrlRe = /jobs\\.51job\\.com\\/[a-z0-9-]+\\/\\d{5,}\\.html|[?&]jobId=\\d{5,}/i;
    const dateRe = /(20\\d{2})[-/.年](\\d{1,2})[-/.月](\\d{1,2})/;
    const items = [];
    const seen = new Set();
    const linesOf = (element) => {
      const raw = String(element?.innerText || element?.textContent || "");
      const direct = raw.split(/\\n+/).map(normalize).filter(Boolean);
      if (direct.length >= 2) return direct;
      // 行内 span / a 不会在 innerText 里产生换行：按直接子元素拆开，
      // 否则「岗位名 + 公司 + 日期」会粘成一行，既认不出公司也容易把整块列表当成一条。
      const parts = [];
      for (const child of element?.children || []) {
        const value = normalize(child.innerText || child.textContent || "");
        if (value) parts.push(value);
      }
      return parts.length >= 2 ? parts : direct;
    };
    const push = (lines, url, anchorText) => {
      const list = lines.map(normalize).filter(Boolean).slice(0, 20);
      if (list.length < 2) return;
      const body = list.join(" | ").slice(0, 900);
      if (body.length < 8) return;
      const key = body.replace(/\\s+/g, "");
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        url: String(url || "").slice(0, 320),
        anchorText: normalize(anchorText).slice(0, 160),
        lines: list,
        text: body,
      });
    };
    const anchors = [];
    for (const doc of docs) {
      for (const anchor of doc.querySelectorAll("a[href]")) {
        const href = String(anchor.href || anchor.getAttribute("href") || "");
        if (jobUrlRe.test(href)) anchors.push(anchor);
      }
    }
    for (const anchor of anchors) {
      const href = String(anchor.href || anchor.getAttribute("href") || "");
      let node = anchor.parentElement;
      let best = null;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const lines = linesOf(node);
        const joined = lines.join(" ");
        if (joined.length >= 6 && joined.length <= 900 && lines.length >= 2) {
          best = { lines, url: href };
          if (joined.length <= 320) break;
        }
        node = node.parentElement;
      }
      if (best) push(best.lines, best.url, anchor.innerText || anchor.textContent || "");
    }
    if (!items.length) {
      const selectors = ['table tbody tr', '.e', 'ul li', 'ol li', '[class*="list"] li', '[class*="item"]', '[class*="record"]'];
      for (const doc of docs) {
        for (const element of doc.querySelectorAll(selectors.join(","))) {
          const lines = linesOf(element);
          if (lines.length < 2 || lines.length > 20) continue;
          const joined = lines.join(" ");
          if (joined.length < 8 || joined.length > 900) continue;
          if (!dateRe.test(joined) && !/申请|投递|应聘/.test(joined)) continue;
          const link = element.querySelector("a[href]");
          const href = link ? String(link.href || link.getAttribute("href") || "") : "";
          push(lines, href, link ? (link.innerText || link.textContent || "") : "");
        }
      }
    }
    const bodyText = docs.map((doc) => String(doc.body?.innerText || "")).join("\\n");
    return {
      items: items.slice(0, 120),
      pageText: normalize(bodyText).slice(0, 1600),
      listFound: items.length > 0,
      debug: { anchors: anchors.length, records: items.length, url: location.href, title: document.title, docs: docs.length },
    };
  })()`;
}
//#endregion
//#region ../../plugins/interview-assistant/engine/auto-apply/company-key.ts
/**
* 公司名归一化：与 lib/company-key.mjs / 宿主 / 后端 CompanyNameKey 保持同一套规则，
* 否则同一家公司会在投递台账、公司情报和云端反馈之间分裂成多条。
*/
function companyNameKey(name) {
	let text = String(name ?? "").trim().toLowerCase();
	if (!text) return "";
	text = text.replace(/[\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~，。、；：！？“”‘’（）【】·—－_]+/g, "");
	const suffixes = [
		"股份有限公司",
		"有限责任公司",
		"有限公司",
		"集团有限公司",
		"集团",
		"分公司",
		"公司",
		"总部"
	];
	let changed = true;
	while (changed) {
		changed = false;
		for (const suffix of suffixes) if (text.endsWith(suffix) && text.length > suffix.length + 1) {
			text = text.slice(0, -suffix.length);
			changed = true;
		}
	}
	return text.slice(0, 200);
}
var ANONYMOUS = /未公开|匿名|保密公司|某公司/;
function isAnonymousCompany(name) {
	const value = String(name ?? "").trim();
	return !value || ANONYMOUS.test(value);
}
//#endregion
//#region ../../plugins/interview-assistant/engine/job-sites/boss-chat-list.ts
/**
* Boss「消息」页的联系人列表解析与匹配。
*
* 背景（用户 11-02 反馈）：岗位页上点完「立即沟通」后，平台有时没有任何回执，
* 但消息其实已经发到 Boss 的聊天列表里。只靠岗位页判断永远会漏掉这种情况。
* 因此批量结束后要能读一次消息列表，用「公司 + 招聘者 + 岗位 + 时间」把招呼记录
* 对应回岗位；只有确实找不到、且列表已经覆盖整批时间范围时，才允许判定「没发出」。
*
* 这套解析必须能单元测试直接覆盖，不能埋在 Electron 窗口代码里。
*/
var COMPANY_HINT = /(公司|集团|科技|网络|信息|数据|智能|软件|电子|银行|保险|证券|医疗|医院|教育|学校|大学|传媒|文化|广告|咨询|贸易|实业|控股|工作室|研究院|研究所|中心|有限|股份|企业|工厂|门店|餐饮|酒店|物流|地产|置业|投资|资产|人力|劳务)/;
var TITLE_HINT = /(工程师|开发|经理|主管|专员|助理|顾问|架构师|分析师|设计师|运营|产品|测试|销售|总监|实习|专家|leader|负责人|主任|文员|客服|会计|财务|法务|招聘|HR|BD|CTO|CEO|COO)/i;
var RECRUITER_HINT = /(女士|先生|小姐|老师|HR|招聘者|boss)$/i;
var STATUS_HINT = new RegExp(`^(?:已读|未读|已送达|送达|发送失败|新招呼|对方正在输入|在线|刚刚活跃|活跃|沟通中)$`);
/**
* Boss 会把送达状态直接拼在消息摘要前面（截图里的「[送达]您好，我对这个岗位很感兴趣」）。
* 只剥离「消息送达 / 已读」一类前缀，不碰「在线教育」这种正常公司名。
*/
var STATUS_PREFIX = /^(?:[\[【(（]\s*(?:已读|未读|已送达|送达|发送失败|新招呼)\s*[\]】)）]\s*|(?:已读|未读|已送达|送达|发送失败|新招呼)\s*[:：]?\s*)+/;
var GREETING_HINT = /^(您好|你好|hi|hello|您好[，,]|你好[，,])/i;
var CITY_WORD = /^(北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|青岛|厦门|福州|济南|合肥|宁波|东莞|佛山|珠海|无锡|常州|大连|沈阳|哈尔滨|昆明|贵阳|南宁|海口|石家庄|太原|南昌|兰州|乌鲁木齐|呼和浩特|银川|西宁|拉萨|香港|澳门|台北)$/;
var CITY_PREFIX = /^(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|青岛|厦门|福州|济南|合肥|宁波|东莞|佛山|珠海|无锡|常州|大连|沈阳|哈尔滨|昆明|贵阳|南宁|海口|石家庄|太原|南昌|兰州|乌鲁木齐|呼和浩特|银川|西宁|拉萨|香港|澳门|台北)(?:市|省|特别行政区)?/;
var TIME_TOKEN = /(刚刚|\d{1,2}:\d{2}|昨天|昨日|前天|今天|今日|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,3}\s*(?:分钟|小时|天|周|个月|年)\s*(?:前|以前|之前))/;
/**
* Boss 求职者消息页的真实列表项是「姓名 + 公司 + 招聘者头衔」连在一行、没有分隔符：
* 「郑女士通达致远HR」「叶亮亮金信捷总经理」「马女士深圳瑞太信息技术Recruiter」。
* 姓名长度只能靠「常见姓 + 头衔后缀」推断；推断不唯一时保留候选，匹配阶段再按岗位公司名选。
*/
var SURNAME_CHARS = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封储靳焦牧山谷车侯全班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎蓟薄印宿白怀蒲邰鄂索咸赖卓蔺屠蒙池乔胥苍闻党翟谭贡劳逄姬申冉郦雍桑桂濮牛寿边扈燕冀浦尚农温别庄晏柴瞿阎慕连茹习艾鱼容向古易慎戈廖庾暨居衡步都耿满弘匡国文寇广阙东欧沃利蔚越隆师巩聂晁勾敖冷訾辛阚那简饶空曾沙养鞠丰巢关蒯相查后荆红游竺权逯盖益桓公";
var COMPOUND_SURNAMES = [
	"欧阳",
	"太史",
	"端木",
	"上官",
	"司马",
	"东方",
	"独孤",
	"南宫",
	"夏侯",
	"诸葛",
	"尉迟",
	"赫连",
	"皇甫",
	"慕容",
	"公孙",
	"长孙",
	"宇文",
	"司徒",
	"司空",
	"令狐",
	"轩辕",
	"百里",
	"呼延",
	"第五",
	"西门",
	"南门",
	"东郭"
];
/** 常见名字用字：连写时用来判断被公司名「吞掉」的那个字更像人名还是公司名。 */
var GIVEN_NAME_HINT = "伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂华玉兰萍红娥玲芬燕彬鹏辉进宝生荣树森志建国建军晓东文博宇航子轩浩然欣怡梓涵雨桐诗涵梦琪思远晨曦嘉怡佳琪雅静可欣亮晶珊榕耀毓男丹琪琳璐瑶婷妍倩颖慧洁琼琦琴";
/** 连写行末尾的招聘者头衔；只认明确像头衔的后缀，避免把公司名当岗位。 */
var ROLE_TAIL = /^(?:高级|资深|首席|初级|中级|实习|兼职|全职|AI|HR|BD|Java|Python|Golang|Go|C\+\+)*(?:HRBP|HRD|HR|Recruiter|Talent\s*Manager|招聘者|招聘专员|招聘经理|招聘主管|招聘专家|招聘顾问|招聘HR|招聘|人事经理|人事主管|人事专员|人事HRBP|人事HR|人事|人才经理|人才|总经理|副总经理|创始人|合伙人|部门负责人|负责人|高级技术经理|技术经理|产品经理|项目经理|运营经理|开发经理|算法工程师|软件开发工程师|开发工程师|测试工程师|前端工程师|后端工程师|全栈工程师|数据工程师|架构师|工程师|经理助理|经理|主管|总监|专员|助理|顾问|实习生|boss|CEO|CTO|COO|CFO)$/i;
var PURE_COMPANY_WORD = /^(?:技术|科技|信息|网络|智能|数据|软件|电子|公司|集团|有限|股份|中心|研究院|工作室|银行|保险|医疗|教育|文化|传媒|广告|咨询|贸易|实业|控股|人力|人力资源)$/;
function isChineseName(value) {
	if (!/^[\u4e00-\u9fa5]{2,4}$/.test(value)) return false;
	if (CITY_WORD.test(value) || STATUS_HINT.test(value) || TIME_TOKEN.test(value)) return false;
	if (COMPOUND_SURNAMES.includes(value.slice(0, 2))) return value.length >= 3;
	return SURNAME_CHARS.includes(value[0]);
}
/** 把「公司名 + 招聘者头衔」拆开；头衔是行尾的连续角色词。 */
function splitCompanyRole(value) {
	const text = cleanLine(value);
	if (text.length < 4) return null;
	for (let index = 1; index <= text.length - 2; index += 1) {
		const company = text.slice(0, index).trim();
		const title = text.slice(index).trim();
		if (company.length < 2 || title.length < 2 || title.length > 30) continue;
		if (CITY_WORD.test(company) || STATUS_HINT.test(company) || TIME_TOKEN.test(company)) continue;
		if (PURE_COMPANY_WORD.test(company)) continue;
		if (!ROLE_TAIL.test(title)) continue;
		return {
			company,
			title
		};
	}
	return null;
}
function nameSplitScore(name, split) {
	const company = split.company;
	let score = name.length === 3 ? 4 : name.length === 2 ? 2 : 0;
	if (COMPOUND_SURNAMES.some((surname) => name.startsWith(surname))) score += 6;
	score += Math.min(company.length, 8) * 2;
	if (COMPANY_HINT.test(company)) score += 2;
	if (/^[A-Za-z]/.test(company) || /[（(]/.test(company)) score += 1;
	if (company[0] === name[name.length - 1]) score -= 5;
	if (GIVEN_NAME_HINT.includes(company[0])) score -= 4;
	if (company.length <= 2 && !COMPANY_HINT.test(company)) score -= 1;
	return score;
}
/**
* 解析一行里连写的「姓名 + 公司 + 头衔」。
* 返回按可信度排序的全部候选：第一个用于展示，其余供 matchBossContact 对照岗位公司名选择。
*/
function parseBossChatLineIdentities(line) {
	const value = cleanLine(line);
	if (!value || value.length > 60) return [];
	const honorific = /^([\u4e00-\u9fa5]{1,3}(?:女士|先生|小姐))(.+)$/.exec(value);
	if (honorific) {
		const name = honorific[1];
		const rest = honorific[2].trim();
		if (rest.length < 2) return [];
		if (GREETING_HINT.test(rest) || /[，。！？,.!?]/.test(rest) || TIME_TOKEN.test(rest) || STATUS_HINT.test(rest)) return [];
		const split = splitCompanyRole(rest);
		if (split) return [{
			name,
			...split
		}];
		if (!looksLikeCompany(rest)) return [];
		return [{
			name,
			company: rest,
			title: ""
		}];
	}
	const candidates = [];
	for (const length of [
		2,
		3,
		4
	]) {
		if (value.length <= length + 1) continue;
		const name = value.slice(0, length);
		if (!isChineseName(name)) continue;
		const split = splitCompanyRole(value.slice(length));
		if (!split) continue;
		candidates.push({
			identity: {
				name,
				...split
			},
			score: nameSplitScore(name, split)
		});
	}
	const seen = /* @__PURE__ */ new Set();
	return candidates.sort((a, b) => b.score - a.score).filter((entry) => {
		const key = `${entry.identity.name}|${entry.identity.company}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, 4).map((entry) => entry.identity);
}
/** 去掉消息摘要前的送达 / 已读状态，返回真正的消息正文。 */
function stripBossChatStatus(value) {
	return cleanLine(value).replace(STATUS_PREFIX, "").trim();
}
/** 从一行文本里提取夹带的状态标记（例如「[送达]您好…」里的「送达」）。 */
function bossChatStatusOf(value) {
	const match = STATUS_PREFIX.exec(cleanLine(value));
	return match ? match[0].replace(/[\[\]【】()（）:：\s]/g, "") : "";
}
function cleanLine(value) {
	return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}
/** 去掉空白与常见标点，保留中文品牌差异；只用于「包含」比较。 */
function normalizeChatText(value) {
	return String(value ?? "").toLowerCase().replace(/[\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~，。、；：！？“”‘’（）【】《》·—－_\-]+/g, "").trim();
}
/**
* 把「15:09」「昨天」「09-12」这类列表时间还原成时间戳。
* 列表只显示到分钟，所以结果天然有最多一分钟误差；调用方比较时要留余量。
*/
function parseBossChatTime(value, now = Date.now()) {
	const text = cleanLine(value);
	if (!text) return 0;
	const base = new Date(now);
	const at = (year, month, day, hour = 12, minute = 0) => {
		const date = new Date(year, month - 1, day, hour, minute, 0, 0);
		return Number.isFinite(date.getTime()) ? date.getTime() : 0;
	};
	if (/刚刚/.test(text)) return now;
	const relative = /(\d{1,3})\s*(分钟|小时|天|周|个月|年)\s*(?:前|以前|之前)/.exec(text);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2];
		return now - amount * (unit === "分钟" ? 6e4 : unit === "小时" ? 36e5 : unit === "天" ? 864e5 : unit === "周" ? 6048e5 : unit === "个月" ? 2592e6 : 31536e6);
	}
	if (/昨天|昨日/.exec(text)) {
		const clock = /(\d{1,2}):(\d{2})/.exec(text);
		const date = new Date(now);
		date.setDate(date.getDate() - 1);
		if (clock) return at(date.getFullYear(), date.getMonth() + 1, date.getDate(), Number(clock[1]), Number(clock[2]));
		date.setHours(20, 0, 0, 0);
		return date.getTime();
	}
	if (/前天/.exec(text)) {
		const clock = /(\d{1,2}):(\d{2})/.exec(text);
		const date = new Date(now);
		date.setDate(date.getDate() - 2);
		if (clock) return at(date.getFullYear(), date.getMonth() + 1, date.getDate(), Number(clock[1]), Number(clock[2]));
		date.setHours(20, 0, 0, 0);
		return date.getTime();
	}
	const weekday = /(?:星期|周)([一二三四五六日天])/.exec(text);
	if (weekday) {
		const target = {
			一: 1,
			二: 2,
			三: 3,
			四: 4,
			五: 5,
			六: 6,
			日: 0,
			天: 0
		}[weekday[1]];
		const date = new Date(now);
		let delta = date.getDay() - target;
		if (delta < 0) delta += 7;
		if (delta === 0) delta = 7;
		date.setDate(date.getDate() - delta);
		date.setHours(20, 0, 0, 0);
		return date.getTime();
	}
	const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2}))?/.exec(text);
	if (full) return at(Number(full[1]), Number(full[2]), Number(full[3]), full[4] ? Number(full[4]) : 12, full[5] ? Number(full[5]) : 0);
	const monthDay = /(?:^|\s)(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2}))?/.exec(text);
	if (monthDay) {
		const month = Number(monthDay[1]);
		const day = Number(monthDay[2]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			let result = at(base.getFullYear(), month, day, monthDay[3] ? Number(monthDay[3]) : 12, monthDay[4] ? Number(monthDay[4]) : 0);
			if (result > now + 864e5) result = at(base.getFullYear() - 1, month, day, monthDay[3] ? Number(monthDay[3]) : 12, monthDay[4] ? Number(monthDay[4]) : 0);
			return result;
		}
	}
	const clock = /(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/.exec(text);
	if (clock) {
		let result = at(base.getFullYear(), base.getMonth() + 1, base.getDate(), Number(clock[1]), Number(clock[2]));
		if (result > now + 3e5) result -= 864e5;
		return result;
	}
	return 0;
}
function looksLikeRecruiter(line) {
	const value = cleanLine(line);
	if (!value) return false;
	if (RECRUITER_HINT.test(value) && value.length <= 12) return true;
	return /^[\u4e00-\u9fa5·]{2,4}$/.test(value) && !CITY_WORD.test(value) && !COMPANY_HINT.test(value) && !TITLE_HINT.test(value);
}
/**
* 姓名和公司写在同一行时（例如「阮雪 雷特科技」）单独取姓名。
* 只接受「2-4 个汉字 + 分隔符 + 像公司/岗位的后半段」，避免把城市或公司简称当成人名。
*/
function inlineRecruiter(line) {
	const value = cleanLine(line);
	if (!value || value.length > 40) return "";
	const match = /^([\u4e00-\u9fa5·]{2,4})\s*(?:[·|｜/]|\s)\s*(.{2,40})$/.exec(value);
	if (!match) return "";
	const name = match[1];
	const rest = match[2].trim();
	if (CITY_WORD.test(name) || COMPANY_HINT.test(name) || TITLE_HINT.test(name)) return "";
	if (/^(招聘者|人事|HR|boss)$/i.test(name)) return "";
	return looksLikeCompany(rest) || looksLikeTitle(rest) ? name : "";
}
function looksLikeCompany(line) {
	const value = cleanLine(line);
	if (!value || value.length > 40) return false;
	const body = stripBossChatStatus(value);
	if (!body || TIME_TOKEN.test(body) || STATUS_HINT.test(body)) return false;
	return COMPANY_HINT.test(body) || body.length >= 3 && !TITLE_HINT.test(body) && !GREETING_HINT.test(body);
}
function looksLikeTitle(line) {
	const value = cleanLine(line);
	if (!value || value.length > 80) return false;
	const body = stripBossChatStatus(value);
	if (!body || TIME_TOKEN.test(body) || STATUS_HINT.test(body)) return false;
	return TITLE_HINT.test(body);
}
/**
* 把一条联系人列表项的 innerText 拆成字段。
* Boss 的类名经常变，所以按「行内容特征」解析，不依赖具体 class。
*/
function parseBossChatContact(raw, now = Date.now()) {
	const value = String(raw ?? "").replace(/\r/g, "").trim();
	let lines = value.split(/\n+/).map(cleanLine).filter(Boolean);
	if (lines.length <= 1) {
		const spaced = value.split(/\s{2,}|\t+/).map(cleanLine).filter(Boolean);
		if (spaced.length > 1) lines = spaced;
	}
	const timeIndex = lines.findIndex((line) => TIME_TOKEN.test(line) && parseBossChatTime(line, now) > 0);
	const timeText = timeIndex >= 0 ? lines[timeIndex] : "";
	const at = timeText ? parseBossChatTime(timeText, now) : 0;
	const before = timeIndex >= 0 ? lines.slice(0, timeIndex) : lines;
	const after = timeIndex >= 0 ? lines.slice(timeIndex + 1) : [];
	const status = [...new Set(lines.flatMap((line) => {
		if (STATUS_HINT.test(line)) return [line];
		const inline = bossChatStatusOf(line);
		return inline ? [inline] : [];
	}))].join(" ");
	const identityEntries = lines.map((line) => ({
		line,
		identities: parseBossChatLineIdentities(line)
	})).filter((entry) => entry.identities.length > 0);
	const identityLineSet = new Set(identityEntries.map((entry) => entry.line));
	const greetingLine = lines.filter((line) => {
		if (identityLineSet.has(line)) return false;
		const body = stripBossChatStatus(line);
		return Boolean(body) && !TIME_TOKEN.test(body) && !STATUS_HINT.test(body) && (GREETING_HINT.test(body) || body.length >= 12 && /(简历|岗位|应聘|沟通|感兴趣|期待|回复|贵司|贵公司|面试|介绍|您好|你好)/.test(body));
	})[0] ?? "";
	const greetingIndex = greetingLine ? lines.indexOf(greetingLine) : -1;
	const snippet = greetingLine ? stripBossChatStatus(greetingLine).slice(0, 300) : "";
	const contentLines = lines.filter((_, index) => index !== greetingIndex && index !== timeIndex);
	const identityEntry = identityEntries.find((entry) => contentLines.includes(entry.line));
	const beforeContent = before.filter((line) => line !== greetingLine);
	const afterContent = after.filter((line) => line !== greetingLine);
	const restOfInline = (line) => {
		const inline = inlineRecruiter(line);
		if (!inline) return line;
		return cleanLine(line.slice(line.indexOf(inline) + inline.length).replace(/^[\s·|｜/]+/, ""));
	};
	let name = beforeContent.find(looksLikeRecruiter) ?? "";
	if (!name) name = contentLines.map(inlineRecruiter).find(Boolean) ?? "";
	if (!name) name = lines.find((line) => RECRUITER_HINT.test(line)) ?? "";
	let company = beforeContent.filter((line) => line !== name).map(restOfInline).find(looksLikeCompany) ?? "";
	if (!company) company = afterContent.map(restOfInline).find(looksLikeCompany) ?? "";
	if (!company) company = contentLines.filter((line) => line !== name && line !== timeText).map(restOfInline).find((line) => line !== snippet && looksLikeCompany(line)) ?? "";
	if (!company && name) company = contentLines.find((line) => line !== name && line !== timeText && /^[\u4e00-\u9fa5A-Za-z0-9]{2}$/.test(line) && !CITY_WORD.test(line) && !STATUS_HINT.test(line) && !RECRUITER_HINT.test(line) && !TITLE_HINT.test(line)) ?? "";
	let title = afterContent.map(restOfInline).find((line) => line !== company && looksLikeTitle(line)) ?? "";
	if (!title) title = beforeContent.map(restOfInline).find((line) => line !== company && line !== name && looksLikeTitle(line)) ?? "";
	if (company && !title) {
		const parts = company.split(/\s*[·|｜/]\s*/).filter(Boolean);
		if (parts.length >= 2) {
			company = parts[0];
			title = parts.slice(1).join(" ");
		}
	}
	if (company && !title) {
		const match = /^(.{2,30}?)\s+(.{2,50})$/.exec(company);
		if (match && looksLikeTitle(match[2])) {
			company = match[1];
			title = match[2];
		}
	}
	if (company && TITLE_HINT.test(company) && !COMPANY_HINT.test(company)) {
		title = title || company;
		company = "";
	}
	const structured = Boolean(name && company) && name.length <= 12 && !COMPANY_HINT.test(name) && !TITLE_HINT.test(name) && normalizeChatText(company) !== normalizeChatText(name);
	if (identityEntry && !structured) {
		const best = identityEntry.identities[0];
		const extraTitle = contentLines.filter((line) => line !== identityEntry.line).find((line) => looksLikeTitle(line) && !looksLikeCompany(line)) ?? "";
		return {
			raw: value.slice(0, 1200),
			name: best.name.slice(0, 40),
			company: best.company.slice(0, 120),
			title: (best.title || extraTitle).slice(0, 120),
			timeText: timeText.slice(0, 40),
			snippet: snippet.slice(0, 300),
			status: status.slice(0, 40),
			at,
			identities: identityEntry.identities.slice(0, 4).map((identity) => ({
				name: identity.name.slice(0, 40),
				company: identity.company.slice(0, 120),
				title: identity.title.slice(0, 120)
			}))
		};
	}
	return {
		raw: value.slice(0, 1200),
		name: name.slice(0, 40),
		company: company.slice(0, 120),
		title: title.slice(0, 120),
		timeText: timeText.slice(0, 40),
		snippet: snippet.slice(0, 300),
		status: status.slice(0, 40),
		at
	};
}
/** 批量解析并去掉重复项（列表滚动时同一项会被多次抓到）。 */
function parseBossChatContacts(rawItems, now = Date.now()) {
	const seen = /* @__PURE__ */ new Set();
	const contacts = [];
	for (const raw of rawItems) {
		const contact = parseBossChatContact(raw, now);
		const key = normalizeChatText(contact.raw).slice(0, 200);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		contacts.push(contact);
	}
	return contacts;
}
/** 去掉城市前缀后的品牌核心：列表常写「深圳市海柔创新科技」，岗位全称是「海柔创新科技有限公司」。 */
function brandKeyOf(value) {
	return companyNameKey(value).replace(CITY_PREFIX, "");
}
/** 公司名可能是简称（编程猫）或全称（深圳点猫科技有限公司），双向包含就算同一家。 */
function companyMatches(company, contactText, contactCompany = "") {
	const key = companyNameKey(company);
	const text = normalizeChatText(contactText);
	const listed = normalizeChatText(contactCompany);
	if (!key || !text) return {
		score: 0,
		strong: false,
		exact: false
	};
	const brandKey = brandKeyOf(company);
	const listedBrand = brandKeyOf(contactCompany);
	if (listed) {
		if (listed === key) return {
			score: 60,
			strong: true,
			exact: true
		};
		if (listed.startsWith(key) || key.startsWith(listed)) return {
			score: 55,
			strong: true,
			exact: false
		};
		if (listed.length >= 3 && (listed.includes(key) || key.includes(listed))) return {
			score: 52,
			strong: true,
			exact: false
		};
	}
	if (brandKey && listedBrand) {
		if (brandKey === listedBrand) return {
			score: 62,
			strong: true,
			exact: true
		};
		if (brandKey.startsWith(listedBrand) || listedBrand.startsWith(brandKey)) return {
			score: 58,
			strong: true,
			exact: false
		};
	}
	if (text.includes(key)) return {
		score: key.length >= 4 ? 55 : 45,
		strong: key.length >= 3,
		exact: text === key
	};
	if (brandKey.length >= 3 && text.includes(brandKey)) return {
		score: 56,
		strong: true,
		exact: false
	};
	if (brandKey.length >= 3 && listedBrand && (listedBrand.includes(brandKey) || brandKey.includes(listedBrand))) return {
		score: 54,
		strong: true,
		exact: false
	};
	if (text.length >= 3 && key.includes(text)) return {
		score: 40,
		strong: true,
		exact: false
	};
	for (let length = key.length - 1; length >= 4; length -= 1) if (text.includes(key.slice(0, length))) return {
		score: 42,
		strong: true,
		exact: false
	};
	return {
		score: 0,
		strong: false,
		exact: false
	};
}
function recruiterMatches(recruiter, contact) {
	const value = normalizeChatText(recruiter);
	if (!value) return {
		score: 0,
		matched: false,
		penalize: false
	};
	const name = normalizeChatText(contact.name);
	const raw = normalizeChatText(contact.raw);
	if (name && (name === value || name.includes(value) || value.includes(name))) return {
		score: 30,
		matched: true,
		penalize: false
	};
	if (raw.includes(value)) return {
		score: 22,
		matched: true,
		penalize: false
	};
	return {
		score: 0,
		matched: false,
		penalize: true
	};
}
function titleMatches(title, contact) {
	const value = normalizeChatText(title);
	if (!value || value.length < 3) return 0;
	const raw = normalizeChatText(contact.raw);
	if (raw.includes(value)) return 15;
	if (String(title).split(/[\s/·|｜()（）\-]+/).map(normalizeChatText).filter((entry) => entry.length >= 4).some((token) => raw.includes(token))) return 8;
	return 0;
}
function greetingMatches(greeting, contact) {
	const probe = normalizeChatText(greeting).slice(0, 12);
	if (probe.length < 5) return 0;
	return normalizeChatText(`${contact.snippet}${stripBossChatStatus(contact.raw)}`).includes(probe) ? 20 : 0;
}
/**
* 判断一条岗位在 Boss 消息列表里有没有对应记录。
* 只有在「列表完整覆盖本批时间」且「公司不匿名」时才允许 not_sent；其余一律交给 AI / 本人。
*/
function matchBossContact(input) {
	const job = input.job;
	const anonymous = job.companyAnonymous === true || isAnonymousCompany(job.company);
	const contacts = input.contacts ?? [];
	const scored = contacts.map((contact, index) => {
		const variants = contact.identities?.length ? contact.identities : [{
			name: contact.name,
			company: contact.company,
			title: contact.title
		}];
		let company = {
			score: 0,
			strong: false,
			exact: false
		};
		let recruiter = {
			score: 0,
			matched: false,
			penalize: false
		};
		let companyLabel = contact.company;
		for (const variant of variants) {
			const nextCompany = companyMatches(job.company, variant.company, variant.company);
			if (nextCompany.score > company.score) {
				company = nextCompany;
				companyLabel = variant.company;
			}
			const nextRecruiter = recruiterMatches(job.recruiter ?? "", {
				...contact,
				name: variant.name
			});
			if (nextRecruiter.score > recruiter.score) recruiter = nextRecruiter;
		}
		const fromRaw = companyMatches(job.company, contact.raw, contact.company);
		if (fromRaw.score > company.score) {
			company = fromRaw;
			companyLabel = contact.company;
		}
		const title = titleMatches(job.title ?? "", contact);
		const greeting = greetingMatches(input.greetingHint ?? "", contact);
		const fresh = contact.at > 0 && contact.at >= input.since;
		const stale = contact.at > 0 && contact.at < input.since;
		return {
			contact,
			index,
			score: company.score + recruiter.score + title + greeting + (fresh ? 10 : stale ? -25 : -5) - (recruiter.penalize && company.score > 0 ? 10 : 0),
			company,
			recruiter,
			title,
			greeting,
			fresh,
			stale,
			companyLabel
		};
	}).sort((a, b) => b.score - a.score);
	const best = scored[0];
	if (!best || best.score < 30) {
		if (!contacts.length) return {
			verdict: "ambiguous",
			contactIndex: -1,
			score: 0,
			confidence: 0,
			reason: "没有从 Boss 消息页读到联系人列表，无法判断"
		};
		if (!input.complete) return {
			verdict: "ambiguous",
			contactIndex: -1,
			score: 0,
			confidence: 0,
			reason: "Boss 消息列表还没有覆盖到本批开始时间，无法确认没发送"
		};
		if (anonymous) return {
			verdict: "ambiguous",
			contactIndex: -1,
			score: 0,
			confidence: 0,
			reason: "公司名是匿名写法，Boss 消息列表无法可靠对应"
		};
		return {
			verdict: "not_sent",
			contactIndex: -1,
			score: 0,
			confidence: .85,
			reason: "Boss 消息列表里没有找到这家公司的招呼记录"
		};
	}
	const second = scored[1];
	const unique = !second || best.score - second.score >= 10;
	const sentThreshold = best.contact.at > 0 ? 70 : 85;
	if (best.fresh && best.score >= sentThreshold && unique && best.company.strong) {
		const bits = [best.companyLabel || job.company, best.contact.timeText].filter(Boolean);
		return {
			verdict: "sent",
			contactIndex: best.index,
			score: best.score,
			confidence: Math.min(.98, Math.max(.7, best.score / 100)),
			reason: `Boss 消息记录里找到对应招呼${bits.length ? `（${bits.join(" · ")}）` : ""}`
		};
	}
	const why = best.stale ? `只找到 ${best.contact.timeText || "更早"} 的旧会话，不在本批时间范围内` : !best.company.strong ? "公司名对不上，可能是同名或简称不同" : !unique ? "Boss 消息列表里有多条相似联系人，无法确定是哪一条" : "招聘者 / 岗位信息对不上";
	return {
		verdict: "ambiguous",
		contactIndex: best.index,
		score: best.score,
		confidence: Math.max(0, Math.min(.6, best.score / 100)),
		reason: why
	};
}
/** 给 AI 的输入：只发列表原文与必要的岗位字段，不夹带简历等无关隐私。 */
function buildBossChatAiPrompt(input) {
	const now = input.now ?? Date.now();
	const clock = (at) => {
		if (!at) return "";
		const date = new Date(at);
		const pad = (value) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	};
	const system = [
		"你是招聘平台消息核对员。只根据用户给的 Boss 消息列表判断每条投递是否已经发出。",
		"严禁猜测：证据不足时必须返回 uncertain。",
		"返回严格 JSON，不要 Markdown，不要解释。",
		"JSON 结构：{\"verdicts\":[{\"id\":\"岗位ID\",\"verdict\":\"sent|not_sent|uncertain\",\"contactIndex\":0,\"confidence\":0.0,\"reason\":\"不超过60字\"}]}",
		"判定规则：",
		"1) sent：消息列表里有明确的同公司 + 同招聘者/同岗位记录，且消息时间在本批开始之后。",
		"2) not_sent：只有在 complete=true、公司名不是匿名、且列表里完全没有该公司记录时才允许。",
		"3) 其余全部 uncertain，包括公司名匿名、有多条相似记录、列表未覆盖本批时间。",
		"4) contactIndex 必须指向消息列表里的真实下标；sent 时必须给出。"
	].join("\n");
	const itemLines = input.items.map((item, index) => [
		`${index + 1}. id=${item.id}`,
		`公司=${item.company || "未知"}${item.anonymous ? "（匿名公司）" : ""}`,
		`岗位=${item.title || "未知"}`,
		`招聘者=${item.recruiter || "未知"}`,
		`城市=${item.city || "未知"}`,
		`岗位页状态=${item.state}`,
		`处理时间=${clock(item.processedAt)}`,
		item.message ? `页面提示=${item.message.slice(0, 160)}` : "",
		item.greetingHint ? `准备发送的招呼=${item.greetingHint.slice(0, 120)}` : ""
	].filter(Boolean).join("；"));
	const contactLines = input.contacts.map((contact, index) => {
		return `${index}. ${[
			contact.name ? `招聘者=${contact.name}` : "",
			contact.company ? `公司=${contact.company}` : "",
			contact.title ? `岗位=${contact.title}` : "",
			contact.timeText ? `时间=${contact.timeText}` : "",
			contact.status ? `状态=${contact.status}` : ""
		].filter(Boolean).join("；")}\n原文：${contact.raw.replace(/\n+/g, " / ").slice(0, 500)}${contact.snippet ? `\n摘要：${contact.snippet.slice(0, 160)}` : ""}`;
	});
	return {
		system,
		user: [
			`本批开始时间：${clock(input.batchStartedAt)}`,
			`消息列表是否已覆盖到本批开始之前：${input.complete ? "是" : "否"}`,
			`当前时间：${clock(now)}`,
			"",
			`待核对岗位（${input.items.length} 条）：`,
			...itemLines,
			"",
			`Boss 消息列表（${input.contacts.length} 条，contactIndex 从 0 开始）：`,
			...contactLines.length ? contactLines : ["（空）"]
		].join("\n")
	};
}
function number(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
/**
* 清洗模型输出：模型可以说「sent」，但必须指向一条真实联系人，且该联系人能和岗位对上；
* 否则降级为 uncertain。列表不完整或公司匿名时，永远不接受 not_sent。
*/
function sanitizeBossChatVerdicts(input) {
	const source = input.raw && typeof input.raw === "object" ? input.raw : {};
	const list = Array.isArray(source.verdicts) ? source.verdicts : [];
	const byId = new Map(input.items.map((item) => [item.id, item]));
	const output = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry;
		const id = String(record.id ?? "").trim();
		const item = byId.get(id);
		if (!item || seen.has(id)) continue;
		const verdict = record.verdict === "sent" || record.verdict === "not_sent" || record.verdict === "uncertain" ? record.verdict : "uncertain";
		const confidence = Math.max(0, Math.min(1, number(record.confidence, 0)));
		const reason = String(record.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
		const contactIndex = Math.round(number(record.contactIndex, -1));
		let next = {
			id,
			verdict,
			contactIndex,
			confidence,
			reason
		};
		if (verdict === "sent") {
			const contact = input.contacts[contactIndex];
			const support = contact ? matchBossContact({
				job: {
					company: item.company,
					title: item.title,
					recruiter: item.recruiter,
					city: item.city,
					companyAnonymous: item.anonymous
				},
				contacts: [contact],
				complete: input.complete,
				since: input.since,
				greetingHint: input.greetingHints?.[id] ?? item.greetingHint
			}) : null;
			const fresh = contact ? contact.at > 0 && contact.at >= input.since : false;
			const supported = Boolean(support) && (support.verdict === "sent" || fresh && support.score >= 55);
			if (!contact || confidence < .7 || !supported) next = {
				id,
				verdict: "uncertain",
				contactIndex,
				confidence,
				reason: reason || "模型给出的联系人无法和岗位对应，已降级为待确认"
			};
		}
		if (verdict === "not_sent") {
			const hasCandidate = input.contacts.some((contact) => {
				return matchBossContact({
					job: {
						company: item.company,
						title: item.title,
						recruiter: item.recruiter,
						city: item.city,
						companyAnonymous: item.anonymous
					},
					contacts: [contact],
					complete: input.complete,
					since: input.since,
					greetingHint: input.greetingHints?.[id] ?? item.greetingHint
				}).score >= 30;
			});
			if (!input.complete || item.anonymous || confidence < .8 || hasCandidate) next = {
				id,
				verdict: "uncertain",
				contactIndex,
				confidence,
				reason: reason || "消息列表不足以证明没有发送"
			};
		}
		seen.add(id);
		output.push(next);
	}
	for (const item of input.items) {
		if (seen.has(item.id)) continue;
		output.push({
			id: item.id,
			verdict: "uncertain",
			contactIndex: -1,
			confidence: 0,
			reason: "模型没有返回这条岗位的结论"
		});
	}
	return output;
}
/**
* 从 Boss 消息页抓联系人列表。
*
* 页面 class 经常变，因此先按常见容器取；取不到时退化成「左侧半屏、有姓名/时间/公司特征」的
* 最小容器。返回值只包含原始文本，结构化解析在 Node 侧做，方便测试和复用。
*/
function bossChatListScript(options = {}) {
	const scroll = options.scroll === true;
	const maxItems = Math.max(1, Math.min(120, options.maxItems ?? 60));
	return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (value) => String(value ?? "").replace(/\\r/g, "").trim();
    const normalize = (value) => clean(value).replace(/\\s+/g, " ").trim();
    const timeRe = ${TIME_TOKEN.toString()};
    const nameRe = /(女士|先生|小姐|老师|HR|人事|招聘者|经理|主管|总监)$/i;
    const companyRe = ${COMPANY_HINT.toString()};
    const titleRe = ${TITLE_HINT.toString()};
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const leftLimit = width * 0.55;
    const collected = [];
    const pushCandidate = (element) => {
      if (!element || !visible(element)) return;
      const rect = element.getBoundingClientRect();
      if (rect.left > leftLimit) return;
      if (rect.width < 100 || rect.width > Math.max(560, width * 0.62)) return;
      if (rect.height < 34 || rect.height > 190) return;
      const text = clean(element.innerText || element.textContent || "");
      const compact = normalize(text);
      if (compact.length < 6 || compact.length > 900) return;
      const lines = text.split(/\\n+/).map((line) => normalize(line)).filter(Boolean);
      if (!lines.length) return;
      const hasTime = lines.some((line) => timeRe.test(line));
      const hasName = lines.some((line) => nameRe.test(line));
      const hasCompany = lines.some((line) => companyRe.test(line));
      const hasTitle = lines.some((line) => titleRe.test(line));
      let score = (hasTime ? 3 : 0) + (hasName ? 2 : 0) + (hasCompany ? 1 : 0) + (hasTitle ? 1 : 0) + (lines.length >= 3 ? 1 : 0);
      if (!hasTime && !(hasName && (hasCompany || hasTitle))) score -= 3;
      if (score < 2) return;
      collected.push({ element, text, compact, rect, score, hasTime });
    };
    const selectors = [
      '.user-list li', '.user-list-content li', '.chat-user-list li', '.chat-list li',
      // 当前求职者消息页的列表项是 .user-list-content 下的 div，不是 li。
      '.user-list-content > div', '.user-list-content > a', '.user-list > div', '.user-list > a',
      '[class*="user-list"] > div', '[class*="user-list"] > a',
      '[class*="user-list"] [class*="item"]', '[class*="chat-user"]', '[class*="user-item"]',
      '[class*="chat-list"] > div', '[class*="chat-list"] > a',
      '[class*="contact-item"]', '[class*="friend-item"]', '[class*="geek-item"]', '[class*="session-item"]',
      '[class*="conversation"] [class*="item"]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) pushCandidate(element);
    }
    // 兜底：扫描左侧半屏的块级元素，用「时间 + 姓名 + 公司/岗位」特征挑出列表项。
    if (collected.length < 2) {
      for (const element of document.querySelectorAll('li, div, a, section, article')) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left > leftLimit || rect.width < 120 || rect.width > Math.max(600, width * 0.62)) continue;
        if (rect.height < 38 || rect.height > 190) continue;
        const text = clean(element.innerText || element.textContent || "");
        if (text.length < 6 || text.length > 900) continue;
        const lines = text.split(/\\n+/).map((line) => normalize(line)).filter(Boolean);
        if (lines.length < 2 || lines.length > 12) continue;
        const hasTime = lines.some((line) => timeRe.test(line));
        const hasName = lines.some((line) => nameRe.test(line));
        if (!hasTime && !hasName) continue;
        let score = (hasTime ? 3 : 0) + (hasName ? 2 : 0);
        if (lines.some((line) => companyRe.test(line))) score += 1;
        if (lines.some((line) => titleRe.test(line))) score += 1;
        // 品牌名（如「编程猫」）不一定命中公司关键词，有招聘者姓名就够候选资格。
        if (score < 3) continue;
        collected.push({ element, text, compact, rect, score, hasTime });
      }
    }
    // 同一个列表项会被父子元素重复抓到：优先保留面积最小、但仍含时间的那一层。
    collected.sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    const chosen = [];
    const seen = new Set();
    for (const entry of collected) {
      if (seen.has(entry.compact)) continue;
      const nested = chosen.some((other) => other.element.contains(entry.element) || entry.element.contains(other.element));
      if (nested && !entry.hasTime) continue;
      // 父元素包含子项时，如果父元素明显更大且子项已经有时间，保留子项。
      const parent = chosen.find((other) => other.element.contains(entry.element) && other.rect.height > entry.rect.height + 30);
      if (parent && entry.hasTime) {
        const index = chosen.indexOf(parent);
        if (index >= 0) chosen.splice(index, 1);
      }
      seen.add(entry.compact);
      chosen.push(entry);
      if (chosen.length >= ${maxItems}) break;
    }
    chosen.sort((a, b) => a.rect.top - b.rect.top);
    // 列表容器可能还没渲染出任何项（冷启动/还在加载）：也把它带回去，调用方才能区分
    // 「页面没打开」和「页面打开了但列表是空的 / 结构变了」。
    let listContainer = null;
    for (const selector of ['.user-list-content', '.user-list', '.chat-user-list', '.chat-list', '[class*="user-list"]', '[class*="chat-user"]', '[class*="chat-list"]']) {
      const element = document.querySelector(selector);
      if (!element || !visible(element)) continue;
      if (element.getBoundingClientRect().width < 100) continue;
      listContainer = element;
      break;
    }
    const findScroller = (start) => {
      let node = start;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20) return node;
        node = node.parentElement;
      }
      return null;
    };
    let scroller = listContainer ? findScroller(listContainer) : null;
    if (!scroller) {
      for (const entry of chosen) {
        scroller = findScroller(entry.element);
        if (scroller) break;
      }
    }
    const listText = ((scroller || listContainer) ? (scroller || listContainer).innerText : document.body?.innerText || '');
    const bottomReached = scroller ? (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24) : true;
    if (${scroll ? "true" : "false"} && scroller) {
      // 一次滚一屏而不是直接跳到底：虚拟列表跳到底会漏掉中间的联系人。
      const step = Math.max(420, Math.round(scroller.clientHeight * 0.85));
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
    }
    const classList = (element) => String(element?.className || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const candidateClasses = [...new Set(collected.map((entry) => classList(entry.element)).filter(Boolean))].slice(0, 12);
    const leftClasses = [...new Set([...document.querySelectorAll('div, li, a, section, article')].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.left <= leftLimit && rect.width >= 120 && rect.height >= 38 && rect.height <= 190;
    }).map(classList).filter(Boolean))].slice(0, 12);
    return {
      url: location.href,
      title: document.title,
      items: chosen.map((entry) => entry.text.slice(0, 1200)),
      listFound: chosen.length > 0,
      listContainer: Boolean(listContainer),
      listCount: listContainer ? listContainer.children.length : 0,
      bottomReached,
      scrolled: Boolean(scroller),
      pageText: String(listText || '').slice(0, 5000),
      bodyLength: String(document.body?.innerText || '').replace(/\\s+/g, '').length,
      debug: { containerClass: classList(listContainer), candidateClasses, leftClasses },
      capturedAt: Date.now(),
    };
  })()`;
}
//#endregion
//#region ../../plugins/interview-assistant/engine/auto-apply/batch.ts
var MAX_WAIT_CHUNK_MS = 6e4;
var DEFAULT_ITEM_TIMEOUT_MS = 24e4;
var DEFAULT_GATE_TIMEOUT_MS = 6e4;
var MAX_LOG_ENTRIES = 120;
/**
* 批量投递队列：顺序执行、可暂停/继续/停止。
* 真正的发送仍复用单条打招呼（含证据截图与成功校验），
* 这里只负责节奏、跳过规则和失败熔断。
*
* 关键约束：每一处 await 都可以被 stop() 打断。
* 之前 stop() 只是改状态位，正在执行的单条投递若卡在浏览器调用上，
* 队列就永远停在 running，用户再点开始只会得到「已有批量投递任务在执行」。
*/
var BatchApplyQueue = class {
	deps;
	status = emptyStatus();
	jobs = /* @__PURE__ */ new Map();
	paused = false;
	/** 是否还有一条岗位正在执行（gate/run/settle）；重新核对消息记录前必须等它收尾。 */
	processing = false;
	stopped = false;
	/** runLoop 是否还活着；用状态位判断会因为卡住的 await 永远为真。 */
	loopRunning = false;
	controller = null;
	wake = null;
	/**
	* 当前这一条的打断开关。窗口被关闭时浏览器调用可能一直不返回，
	* 只改暂停标志会让 runLoop 卡在 guard 里，用户点「继续」看起来毫无反应。
	* 这里只打断当前条目，整批仍保持暂停。
	*/
	itemController = null;
	/** 批次世代号：旧批次的收尾逻辑不许覆盖新批次的状态。 */
	runToken = 0;
	logs = [];
	constructor(deps) {
		this.deps = deps;
	}
	log(line) {
		this.deps.log?.(`[auto-apply-batch] ${line}`);
	}
	/** 写一条用户可见的实时日志（同时写系统日志）。 */
	pushLog(message, level = "info") {
		const text = String(message ?? "").trim();
		if (!text) return;
		this.logs.push({
			at: this.now(),
			level,
			message: text.slice(0, 300)
		});
		if (this.logs.length > MAX_LOG_ENTRIES) this.logs = this.logs.slice(-120);
		this.status.logs = this.logs;
		this.log(text);
	}
	now() {
		return this.deps.now?.() ?? Date.now();
	}
	get signal() {
		return this.controller?.signal;
	}
	sleep(ms) {
		const duration = Math.max(0, ms);
		this.deps.sleep;
		return new Promise((resolve) => {
			let done = false;
			const signal = this.signal;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				if (this.wake === finish) this.wake = null;
			};
			const finish = () => {
				if (done) return;
				done = true;
				cleanup();
				resolve();
			};
			const timer = setTimeout(finish, duration);
			signal?.addEventListener("abort", finish);
			this.wake = finish;
		});
	}
	notify() {
		this.status = {
			...this.status,
			items: this.status.items.map((item) => ({ ...item })),
			sentCount: this.status.items.filter((item) => item.state === "sent").length,
			totalCount: this.status.items.length,
			logs: this.logs
		};
		this.deps.persist?.(this.statusSnapshot());
	}
	/**
	* 启动时恢复上一批进度：用户重启应用后仍然能看到投了哪些、卡在哪一条。
	* 进程已经退出，队列不可能继续跑，所以运行中的批次一律降级为「已中断」，
	* 真正在处理的那一条按「需本人确认」保留，避免用户以为它没发出去而重复投递。
	*/
	hydrate(raw) {
		const status = normalizeStatus(raw);
		if (!status || !status.id) return;
		this.logs = status.logs;
		if (status.state === "running" || status.state === "paused" || status.state === "stopping") {
			status.state = "stopped";
			status.finishedAt = status.finishedAt || this.now();
			status.message = "上次批量投递在应用重启时中断；已发送的结果都已保留，没轮到的岗位可以重新勾选再投";
			status.live = {
				...status.live,
				phase: "idle",
				phaseText: "应用重启前的批次已中断",
				waitUntil: 0,
				waitReason: "",
				nextCompany: "",
				nextTitle: "",
				etaAt: 0
			};
			status.items = status.items.map((item) => {
				if (item.state === "running") return {
					...item,
					state: "needs_user",
					message: "应用重启前正在投这个岗位，请到 Boss 聊天窗口确认是否已发出"
				};
				if (item.state === "queued") return {
					...item,
					state: "skipped",
					message: "批次被中断，未执行"
				};
				return item;
			});
			this.logs.push({
				at: this.now(),
				level: "warn",
				message: "应用重启，上一批投递已标记为中断"
			});
			status.logs = this.logs;
		}
		this.status = status;
		this.notify();
		this.log(`hydrated ${status.id} ${status.state}`);
	}
	statusSnapshot() {
		return {
			...this.status,
			items: this.status.items.map((item) => ({ ...item })),
			live: {
				...this.status.live,
				etaAt: this.estimateEta()
			},
			logs: this.logs.map((entry) => ({ ...entry }))
		};
	}
	/** 还排在队里、可以被重新预检的岗位（带岗位详情，供上层重新跑一遍准入规则）。 */
	pending() {
		return this.status.items.filter((item) => item.state === "queued").map((item) => ({
			id: item.id,
			job: this.jobs.get(item.id)
		})).filter((entry) => Boolean(entry.job));
	}
	/** 队列里保存的岗位详情；应用重启后 this.jobs 为空，需要上层从投递记录补齐。 */
	jobFor(itemId) {
		return this.jobs.get(itemId);
	}
	/** 已结束批次里仍待本人确认 / 未发出的条目；重启后没有岗位详情时返回空。 */
	postRunCandidates() {
		if (this.active()) return [];
		return this.status.items.filter((item) => item.state === "needs_user" || item.state === "failed").map((item) => {
			const job = this.jobs.get(item.id);
			return job ? {
				id: item.id,
				job,
				state: item.state,
				message: item.message,
				updatedAt: item.updatedAt
			} : null;
		}).filter((item) => Boolean(item));
	}
	/** 手动重新核对只追加日志，不把「已完成」批次改回运行中，避免用户以为又在投递。 */
	reportVerification(message, level = "info") {
		this.pushLog(message, level);
	}
	/** 手动核对回写单条岗位状态（复用批量结束后的同一套回写与落盘）。 */
	applyVerification(updates) {
		this.applyPostRunUpdates(updates);
	}
	/**
	* 运行中重新预检：把已经注定被跳过的排队项标成跳过。
	* 批次开始后用户才屏蔽这家公司 / 把它标成外包时，队列不会自己变，用户会一直
	* 看到「排队中」，以为马上就要投出去。正在投的那一条不动（消息可能已经发出）。
	*/
	markSkipped(entries) {
		if (!entries.length) return 0;
		const reasons = new Map(entries.map((entry) => [entry.id, entry.reason]));
		let changed = 0;
		this.status.items = this.status.items.map((item) => {
			const reason = reasons.get(item.id);
			if (!reason || item.state !== "queued") return item;
			changed += 1;
			return {
				...item,
				state: "skipped",
				message: reason,
				updatedAt: this.now()
			};
		});
		if (changed) {
			this.pushLog(`队列更新：${changed} 个岗位不再投递（${[...new Set(entries.map((entry) => entry.reason))].join("；")}）`, "warn");
			this.notify();
		}
		return changed;
	}
	/** 估算整批完成时间：当前等待/处理结束点 + 剩余条数 × 平均间隔。 */
	estimateEta() {
		const live = this.status.live;
		if (!this.active()) return 0;
		const remaining = this.status.items.filter((item) => item.state === "queued").length;
		if (!remaining) return 0;
		const per = Math.max(1e3, Math.round(this.deps.estimateMsPerItem?.() ?? 6e4));
		return Math.max(this.now(), live.waitUntil || 0) + remaining * per;
	}
	setLive(patch) {
		this.status.live = {
			...this.status.live,
			...patch
		};
		this.notify();
	}
	/** 下一个还没处理的岗位，用于提前告诉用户「接下来投哪家」。 */
	nextPending(afterIndex) {
		for (let index = Math.max(0, afterIndex + 1); index < this.status.items.length; index += 1) {
			const item = this.status.items[index];
			if (item.state === "queued") return item;
		}
		return null;
	}
	active() {
		return this.status.state === "running" || this.status.state === "paused" || this.status.state === "stopping";
	}
	/** 队列是否还有活着的执行循环（停止后通常在一个 tick 内变 false）。 */
	busy() {
		return this.loopRunning;
	}
	/**
	* 是否停在可以读 Boss 消息记录的状态：已结束、已停止，或暂停且当前岗位已收尾。
	* 暂停时如果还有一条在 gate/run 里，读消息会把它的页面导航走，必须等它结束。
	*/
	idleForRecheck() {
		if (this.processing) return false;
		const state = this.status.state;
		return state === "done" || state === "stopped" || state === "paused";
	}
	resetRunState(startedAt) {
		this.paused = false;
		this.stopped = false;
		this.controller = new AbortController();
		this.status.startedAt = startedAt;
		this.status.finishedAt = 0;
	}
	/**
	* 入队时就已经确定会被跳过的岗位（公司冷却、已标记外包、已经打过招呼）由 skipped 传入，
	* 创建队列项时直接置为 skipped 并写清原因。
	*
	* 必须在启动执行循环之前带上：start 之后第一条会立刻被置为 running，
	* 事后再标记就会漏掉它。同时队列里的「排队中 N」也不会把注定不投的岗位算进去——
	* 用户看到「外企德科 排队中」却永远等不到它，就是因为它其实会被跳过。
	* 执行循环仍会对每一条再走一次准入检查，这里只负责提前把结论摆到界面上。
	*/
	async start(jobs, skipped = {}) {
		if (this.loopRunning) await this.waitForIdle(1500);
		if (this.loopRunning) throw new Error("已有批量投递任务在执行，请先停止当前任务");
		const list = jobs.filter((job) => job && job.sourceUrl);
		if (!list.length) throw new Error("请先选择至少一个岗位再开始批量投递");
		const startedAt = this.now();
		this.jobs = /* @__PURE__ */ new Map();
		this.logs = [];
		const preSkipped = list.filter((job) => skipped[job.sourceUrl]).length;
		this.status = {
			id: `batch-${randomUUID().slice(0, 12)}`,
			state: "running",
			items: list.map((job) => {
				const id = `bi-${randomUUID().slice(0, 12)}`;
				this.jobs.set(id, job);
				const reason = skipped[job.sourceUrl] ?? "";
				return {
					id,
					company: job.company || "未命名公司",
					title: job.title,
					sourceUrl: job.sourceUrl,
					city: job.city,
					state: reason ? "skipped" : "queued",
					message: reason,
					updatedAt: startedAt
				};
			}),
			startedAt,
			finishedAt: 0,
			message: "批量投递已开始，遇到登录或验证码会自动暂停",
			sentCount: 0,
			totalCount: list.length,
			live: {
				...emptyLive(),
				phase: "gate",
				phaseText: "准备开始",
				startedAt
			},
			logs: []
		};
		this.resetRunState(startedAt);
		this.runToken += 1;
		const token = this.runToken;
		this.pushLog(`批量投递开始，共 ${list.length} 个岗位`, "info");
		if (preSkipped) this.pushLog(`预检跳过 ${preSkipped} 个岗位：${[...new Set(list.map((job) => skipped[job.sourceUrl]).filter(Boolean))].join("；")}`, "warn");
		this.notify();
		this.runLoop(token);
		return this.statusSnapshot();
	}
	async waitForIdle(timeoutMs) {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (this.loopRunning && Date.now() < deadline) await this.sleep(50);
	}
	pause(message = "已暂停批量投递", options = {}) {
		if (this.status.state !== "running") return this.statusSnapshot();
		this.paused = true;
		this.status.state = "paused";
		this.status.message = message;
		this.status.live = {
			...this.status.live,
			phase: "waiting",
			phaseText: "已暂停",
			waitUntil: 0
		};
		this.pushLog(message, "warn");
		if (options.abortActive) this.itemController?.abort();
		this.interrupt();
		this.notify();
		return this.statusSnapshot();
	}
	/** 暂停期间更新提示文案（例如点「继续」时窗口重新打开失败）。 */
	updatePausedMessage(message) {
		if (this.status.state !== "paused") return;
		this.status.message = message;
		this.notify();
	}
	resume() {
		if (this.status.state !== "paused") return this.statusSnapshot();
		this.paused = false;
		this.stopped = false;
		if (!this.controller) this.controller = new AbortController();
		this.status.state = "running";
		this.status.message = "已继续批量投递";
		this.status.live = {
			...this.status.live,
			phase: "gate",
			phaseText: "已继续，正在检查投递条件",
			waitUntil: 0
		};
		this.pushLog("继续批量投递", "info");
		this.interrupt();
		if (!this.loopRunning) {
			const startIndex = this.status.items.findIndex((item) => item.state === "queued");
			if (startIndex >= 0) {
				this.runToken += 1;
				const token = this.runToken;
				this.pushLog("执行循环已退出，从剩余岗位重新开始", "warn");
				this.notify();
				this.runLoop(token, startIndex);
				return this.statusSnapshot();
			}
		}
		this.notify();
		return this.statusSnapshot();
	}
	stop(message = "已停止批量投递") {
		if (!this.active()) return this.statusSnapshot();
		this.stopped = true;
		this.paused = false;
		this.status.state = "stopped";
		this.status.message = message;
		this.status.finishedAt = this.now();
		this.status.live = {
			...this.status.live,
			phase: "idle",
			phaseText: "已停止",
			waitUntil: 0
		};
		this.pushLog(message, "warn");
		this.interrupt();
		this.controller?.abort();
		this.notify();
		return this.statusSnapshot();
	}
	/** 极端情况下强制把队列复位，允许用户重新开始（不会保留本批次结果）。 */
	reset(message = "已强制结束上一批任务") {
		const wasActive = this.active();
		this.stopped = true;
		this.paused = false;
		this.loopRunning = false;
		this.runToken += 1;
		this.controller?.abort();
		this.controller = null;
		this.jobs.clear();
		this.logs = [];
		this.status = {
			...emptyStatus(),
			message
		};
		this.notify();
		if (wasActive) this.finish(message);
		return this.statusSnapshot();
	}
	/** 通知调用方本批已结束（幂等由调用方判断，这里只负责投递事件）。 */
	finish(message = "") {
		if (!this.deps.onFinished) return;
		try {
			const status = {
				...this.statusSnapshot(),
				state: this.status.state === "idle" ? "stopped" : this.status.state,
				message: message || this.status.message
			};
			this.deps.onFinished(status);
		} catch (error) {
			this.log(`onFinished failed: ${String(error?.message ?? error).slice(0, 160)}`);
		}
	}
	interrupt() {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}
	update(index, patch) {
		const item = this.status.items[index];
		if (!item) return;
		this.status.items[index] = {
			...item,
			...patch,
			updatedAt: this.now()
		};
		this.notify();
	}
	/** 批量结束后的核对 / 补发回写条目状态；只改传进来的条目。 */
	applyPostRunUpdates(updates) {
		if (!updates.length) return;
		const patch = new Map(updates.map((entry) => [entry.id, entry]));
		let changed = 0;
		this.status.items = this.status.items.map((item) => {
			const next = patch.get(item.id);
			if (!next) return item;
			if (item.state === next.state && item.message === next.message) return item;
			changed += 1;
			return {
				...item,
				state: next.state,
				message: next.message.slice(0, 300),
				updatedAt: this.now()
			};
		});
		if (!changed) return;
		const first = updates[0]?.message ?? "";
		this.pushLog(updates.length === 1 ? `核对结果：${first}` : `核对结果：${updates.length} 个岗位状态已更新（${first}）`, "info");
		this.notify();
	}
	/** 结束文案统一在这里算，避免「成功 0 个」之类的状态漏报。 */
	summaryMessage() {
		const items = this.status.items;
		const sent = items.filter((item) => item.state === "sent").length;
		const skipped = items.filter((item) => item.state === "skipped").length;
		const pending = items.filter((item) => item.state === "needs_user").length;
		const failed = items.filter((item) => item.state === "failed").length;
		const bossVerified = items.filter((item) => item.state === "sent" && /Boss 消息记录/.test(item.message)).length;
		const job51Verified = items.filter((item) => item.state === "sent" && /前程无忧申请记录/.test(item.message)).length;
		const zhaopinVerified = items.filter((item) => item.state === "sent" && /智联消息记录/.test(item.message)).length;
		const verified = [
			bossVerified ? `${bossVerified} 个由 Boss 消息记录确认` : "",
			job51Verified ? `${job51Verified} 个由前程无忧申请记录确认` : "",
			zhaopinVerified ? `${zhaopinVerified} 个由智联消息记录确认` : ""
		].filter(Boolean).join("，");
		const bits = [`成功 ${sent} 个${verified ? `（其中 ${verified}）` : ""}`];
		if (skipped) bits.push(`跳过 ${skipped} 个`);
		if (pending) bits.push(`待确认 ${pending} 个`);
		if (failed) bits.push(`未发出 ${failed} 个`);
		return `批量投递结束：${bits.join("，")}`;
	}
	async waitWhilePaused() {
		while (this.paused && !this.stopped) await this.sleep(250);
	}
	async waitFor(ms) {
		const deadline = Date.now() + Math.max(0, ms);
		while (!this.stopped) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await this.sleep(Math.min(remaining, MAX_WAIT_CHUNK_MS));
			await this.waitWhilePaused();
		}
	}
	/**
	* 给任意异步任务套上「停止 / 窗口关闭 / 超时」三道闸门。
	* 底层 Promise 无法真正取消（Electron 的浏览器调用可能永远不返回），
	* 但队列不必陪着它一起卡死。
	*/
	guard(task, timeoutMs, pauseSignal) {
		const signal = this.signal;
		if (signal?.aborted) return Promise.resolve({ status: "aborted" });
		if (pauseSignal?.aborted) return Promise.resolve({ status: "paused" });
		return new Promise((resolve) => {
			let settled = false;
			let timer;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				pauseSignal?.removeEventListener("abort", onPause);
				resolve(result);
			};
			const onAbort = () => finish({ status: "aborted" });
			const onPause = () => finish({ status: "paused" });
			signal?.addEventListener("abort", onAbort);
			pauseSignal?.addEventListener("abort", onPause);
			if (timeoutMs > 0) timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
			task.then((value) => finish({
				status: "ok",
				value
			})).catch((error) => finish({
				status: "error",
				error
			}));
		});
	}
	freshItemSignal() {
		this.itemController = new AbortController();
		return this.itemController.signal;
	}
	async runLoop(token, startIndex = 0) {
		this.loopRunning = true;
		const itemTimeoutMs = Math.max(1e3, Math.round(this.deps.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS));
		const gateTimeoutMs = Math.max(1e3, Math.round(this.deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS));
		try {
			for (let index = startIndex; index < this.status.items.length; index += 1) {
				if (this.stopped) break;
				await this.waitWhilePaused();
				if (this.stopped) break;
				const summary = this.status.items[index];
				const job = this.jobs.get(summary.id);
				if (!job) continue;
				const context = {
					batchId: this.status.id,
					index,
					signal: this.signal ?? new AbortController().signal,
					report: (message) => {
						if (this.status.live.itemId !== summary.id) return;
						const detail = String(message ?? "").trim();
						if (!detail) return;
						this.status.live = {
							...this.status.live,
							phaseText: detail.slice(0, 120)
						};
						this.pushLog(detail);
						this.notify();
					}
				};
				const next = this.nextPending(index);
				const position = `${index + 1}/${this.status.items.length}`;
				this.setLive({
					index,
					itemId: summary.id,
					company: summary.company,
					title: summary.title,
					city: summary.city,
					phase: "gate",
					phaseText: "正在检查投递条件",
					startedAt: this.now(),
					waitUntil: 0,
					waitReason: "",
					nextCompany: next ? next.company : "",
					nextTitle: next ? next.title : ""
				});
				this.update(index, {
					state: "running",
					message: "正在检查投递条件"
				});
				this.pushLog(`第 ${position} 个：检查「${summary.company}」的投递条件`, "info");
				const gated = await this.guard(this.deps.gate(job, context), gateTimeoutMs, this.freshItemSignal());
				if (gated.status === "aborted") {
					this.update(index, {
						state: "skipped",
						message: "已停止，未投递"
					});
					break;
				}
				if (gated.status === "paused") {
					this.update(index, {
						state: "queued",
						message: "招聘窗口被关闭，已暂停；点「继续」会重新检查这个岗位"
					});
					index -= 1;
					continue;
				}
				if (gated.status === "timeout") {
					this.update(index, {
						state: "failed",
						message: "检查投递条件超时，已跳过这个岗位"
					});
					this.pushLog(`「${summary.company}」检查投递条件超时，已跳过`, "error");
					continue;
				}
				if (gated.status === "error") {
					const reason = String(gated.error?.message ?? gated.error).slice(0, 160);
					this.update(index, {
						state: "failed",
						message: `检查失败：${reason}`
					});
					this.pushLog(`「${summary.company}」检查失败：${reason}`, "error");
					continue;
				}
				const gate = gated.value;
				if (gate.skip) {
					this.update(index, {
						state: "skipped",
						message: gate.reason || "已跳过"
					});
					this.pushLog(`跳过「${summary.company}」：${gate.reason || "不满足投递条件"}`, "warn");
					continue;
				}
				if (!gate.allowed) {
					if (gate.waitMs && gate.waitMs > 0) {
						const waitUntil = this.now() + gate.waitMs;
						this.update(index, {
							state: "queued",
							message: gate.reason || "等待下一个投递窗口"
						});
						this.status.message = gate.reason || "等待投递窗口";
						this.setLive({
							phase: "waiting",
							phaseText: `按安全规则等待 ${formatDuration(gate.waitMs)}后自动继续`,
							waitUntil,
							waitReason: gate.reason || ""
						});
						this.pushLog(`等待 ${formatDuration(gate.waitMs)}后继续（${gate.reason || "投递间隔"}）`, "info");
						await this.waitFor(gate.waitMs);
						this.setLive({
							phase: "gate",
							phaseText: "等待结束，重新检查投递条件",
							waitUntil: 0,
							waitReason: ""
						});
						index -= 1;
						continue;
					}
					if (gate.retain) {
						this.update(index, {
							state: "queued",
							message: gate.reason || "已暂停，等待本人处理"
						});
						this.status.state = "paused";
						this.paused = true;
						this.status.message = `${gate.reason || "已暂停"}；处理好后点「继续」会重新投这个岗位`;
						this.status.live = {
							...this.status.live,
							phase: "waiting",
							phaseText: "已暂停，等待本人处理",
							waitUntil: 0
						};
						this.pushLog(`批量投递已暂停：${gate.reason || "需要本人处理"}（当前岗位保留，点「继续」会重新投它）`, "warn");
						this.notify();
						index -= 1;
						continue;
					}
					this.update(index, {
						state: "skipped",
						message: gate.reason || "不满足投递条件"
					});
					this.pushLog(`跳过「${summary.company}」：${gate.reason || "不满足投递条件"}`, "warn");
					if (gate.reason && /上限|暂停|屏蔽/.test(gate.reason) && !/冷却/.test(gate.reason)) {
						this.status.state = "paused";
						this.paused = true;
						this.status.message = gate.reason;
						this.status.live = {
							...this.status.live,
							phase: "waiting",
							phaseText: "已暂停",
							waitUntil: 0
						};
						this.pushLog(`批量投递已暂停：${gate.reason}`, "warn");
						this.notify();
					}
					continue;
				}
				this.update(index, {
					state: "running",
					message: "正在发送招呼"
				});
				this.setLive({
					phase: "sending",
					phaseText: "正在发送招呼",
					waitUntil: 0,
					waitReason: ""
				});
				this.pushLog(`正在向「${summary.company} · ${summary.title}」发送招呼`, "info");
				this.processing = true;
				const runTask = this.deps.run(job, context);
				runTask.finally(() => {
					this.processing = false;
				}).catch(() => void 0);
				const ran = await this.guard(runTask, itemTimeoutMs, this.freshItemSignal());
				if (ran.status === "aborted") {
					this.update(index, {
						state: "needs_user",
						message: "已停止本轮投递；如果 Boss 聊天窗口已经把消息发出去了，请到投递看板标记"
					});
					break;
				}
				if (ran.status === "paused") {
					this.update(index, {
						state: "needs_user",
						message: "发送过程中招聘窗口被关闭：如果这条已经发出去了，请在投递看板标记；点「继续」会从下一个岗位接着投"
					});
					this.pushLog(`「${summary.company}」发送过程中窗口被关闭，已暂停整批`, "warn");
					continue;
				}
				if (ran.status === "timeout") {
					this.update(index, {
						state: "needs_user",
						message: `超过 ${Math.round(itemTimeoutMs / 6e4)} 分钟没有完成，已暂停整批。请检查 Boss 窗口是否被关闭或卡住后再继续`
					});
					this.paused = true;
					this.status.state = "paused";
					this.status.message = "单条投递超时，已暂停，请检查 Boss 窗口后继续或停止";
					this.status.live = {
						...this.status.live,
						phase: "waiting",
						phaseText: "已暂停（单条投递超时）",
						waitUntil: 0
					};
					this.pushLog(`「${summary.company}」超过 ${Math.round(itemTimeoutMs / 6e4)} 分钟未完成，已暂停整批`, "error");
					this.notify();
					continue;
				}
				const result = ran.status === "ok" ? ran.value : {
					state: "failed",
					message: `投递失败：${String(ran.error?.message ?? ran.error).slice(0, 200)}`
				};
				this.update(index, {
					state: result.state,
					message: result.message
				});
				this.setLive({
					phase: "settling",
					phaseText: "正在保存投递结果",
					waitUntil: 0,
					lastSentAt: result.state === "sent" ? this.now() : this.status.live.lastSentAt
				});
				this.pushLog(`${result.state === "sent" ? "已发送" : result.state === "skipped" ? "已跳过" : result.state === "needs_user" ? "需要本人处理" : "失败"}「${summary.company}」：${result.message}`, result.state === "sent" ? "ok" : result.state === "skipped" ? "warn" : "error");
				const settled = await this.guard(this.deps.settle(job, result), gateTimeoutMs);
				if (settled.status === "error") this.log(`settle failed: ${String(settled.error?.message ?? settled.error).slice(0, 160)}`);
				if (result.pauseBatch) {
					this.status.state = "paused";
					this.paused = true;
					this.status.message = result.message || "需要本人处理登录或验证，批量投递已暂停";
					this.status.live = {
						...this.status.live,
						phase: "waiting",
						phaseText: "已暂停，等待本人处理",
						waitUntil: 0
					};
					this.pushLog(`批量投递已暂停：${this.status.message}`, "warn");
					this.notify();
				}
				if (this.stopped) break;
			}
		} catch (error) {
			const reason = String(error?.message ?? error).slice(0, 160);
			this.log(`batch loop crashed: ${reason}`);
			this.status.message = `批量投递异常中断：${reason}`;
			this.pushLog(`批量投递异常中断：${reason}`, "error");
		} finally {
			if (token !== this.runToken) return;
			const queued = this.status.items.some((item) => item.state === "queued");
			if (this.stopped) {
				this.status.state = "stopped";
				if (!this.status.message) this.status.message = "已停止批量投递";
			} else if (this.status.state === "paused" && queued) {} else if (this.status.state === "running" || this.status.state === "paused") this.status.state = "done";
			if (this.stopped) this.status.items = this.status.items.map((item) => item.state === "queued" ? {
				...item,
				state: "skipped",
				message: "本次投递已停止，未执行",
				updatedAt: this.now()
			} : item);
			if (!this.stopped && this.status.state === "done" && this.deps.postRun) {
				const candidates = this.status.items.filter((item) => item.state === "needs_user" || item.state === "failed").map((item) => {
					const job = this.jobs.get(item.id);
					return job ? {
						id: item.id,
						job,
						state: item.state,
						message: item.message,
						updatedAt: item.updatedAt
					} : null;
				}).filter((item) => Boolean(item));
				if (candidates.length) {
					this.status.state = "running";
					this.status.message = "批量投递已结束，正在核对平台投递记录";
					this.status.live = {
						...this.status.live,
						phase: "verifying",
						phaseText: "正在读取平台投递记录",
						waitUntil: 0,
						waitReason: "",
						nextCompany: "",
						nextTitle: ""
					};
					this.pushLog(`批量投递结束，开始核对 ${candidates.length} 个未确认岗位的投递记录`, "info");
					this.notify();
					try {
						await this.deps.postRun({
							status: this.statusSnapshot(),
							items: candidates,
							signal: this.signal,
							report: (message, phase = "verifying") => {
								if (token !== this.runToken) return;
								const detail = String(message ?? "").trim().slice(0, 160);
								if (!detail) return;
								this.status.live = {
									...this.status.live,
									phase,
									phaseText: detail,
									waitUntil: 0
								};
								this.pushLog(detail);
								this.notify();
							},
							update: (updates) => this.applyPostRunUpdates(updates)
						});
					} catch (error) {
						const reason = String(error?.message ?? error).slice(0, 160);
						this.log(`post run failed: ${reason}`);
						this.pushLog(`批量结束后的投递记录核对失败：${reason}，未确认的岗位已保留`, "warn");
					}
					if (token !== this.runToken) return;
					this.status.state = this.stopped ? "stopped" : "done";
				}
			}
			this.loopRunning = false;
			if (this.stopped) this.status.items = this.status.items.map((item) => item.state === "queued" ? {
				...item,
				state: "skipped",
				message: "本次投递已停止，未执行",
				updatedAt: this.now()
			} : item);
			this.status.finishedAt = this.now();
			if (this.status.state === "done") this.status.message = this.summaryMessage();
			this.status.live = {
				...this.status.live,
				phase: this.status.state === "paused" ? "waiting" : "idle",
				phaseText: this.status.state === "done" ? "已全部处理完" : this.status.state === "paused" ? "已暂停" : "已停止",
				waitUntil: 0,
				nextCompany: "",
				nextTitle: ""
			};
			this.pushLog(this.status.message, this.status.state === "done" ? "ok" : "warn");
			this.controller = null;
			this.notify();
			this.log(`batch ${this.status.id} ${this.status.state}`);
			this.finish();
		}
	}
};
function formatDuration(ms) {
	const total = Math.max(0, Math.round(ms / 1e3));
	if (total < 60) return `${total} 秒`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}
function emptyLive() {
	return {
		index: -1,
		itemId: "",
		company: "",
		title: "",
		city: "",
		phase: "idle",
		phaseText: "",
		startedAt: 0,
		waitUntil: 0,
		waitReason: "",
		nextCompany: "",
		nextTitle: "",
		lastSentAt: 0,
		etaAt: 0
	};
}
var ITEM_STATES = [
	"queued",
	"running",
	"sent",
	"needs_user",
	"skipped",
	"failed"
];
var BATCH_STATES = [
	"idle",
	"running",
	"paused",
	"stopping",
	"stopped",
	"done"
];
var PHASES = [
	"idle",
	"gate",
	"waiting",
	"sending",
	"settling",
	"verifying",
	"repairing"
];
var LOG_LEVELS = [
	"info",
	"ok",
	"warn",
	"error"
];
function pick(values, value, fallback) {
	return values.includes(value) ? value : fallback;
}
function time(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
/** 落盘文件可能被手工改过或来自旧版本：逐字段收口，坏数据宁可不显示也不能让页面崩。 */
function normalizeStatus(raw) {
	if (!raw || typeof raw !== "object") return null;
	const source = raw;
	const items = (Array.isArray(source.items) ? source.items : []).filter((item) => item && typeof item === "object").map((item) => ({
		id: String(item.id ?? "").slice(0, 40),
		company: String(item.company ?? "").slice(0, 200),
		title: String(item.title ?? "").slice(0, 200),
		sourceUrl: String(item.sourceUrl ?? "").slice(0, 1e3),
		city: String(item.city ?? "").slice(0, 80),
		state: pick(ITEM_STATES, item.state, "queued"),
		message: String(item.message ?? "").slice(0, 300),
		updatedAt: time(item.updatedAt)
	})).filter((item) => item.id);
	const liveSource = source.live && typeof source.live === "object" ? source.live : {};
	const logs = (Array.isArray(source.logs) ? source.logs : []).filter((entry) => entry && typeof entry === "object").slice(-120).map((entry) => ({
		at: time(entry.at),
		level: pick(LOG_LEVELS, entry.level, "info"),
		message: String(entry.message ?? "").slice(0, 300)
	})).filter((entry) => entry.message);
	return {
		id: String(source.id ?? "").slice(0, 60),
		state: pick(BATCH_STATES, source.state, "idle"),
		items,
		startedAt: time(source.startedAt),
		finishedAt: time(source.finishedAt),
		message: String(source.message ?? "").slice(0, 400),
		sentCount: items.filter((item) => item.state === "sent").length,
		totalCount: items.length,
		live: {
			...emptyLive(),
			index: Number.isFinite(Number(liveSource.index)) ? Number(liveSource.index) : -1,
			itemId: String(liveSource.itemId ?? "").slice(0, 40),
			company: String(liveSource.company ?? "").slice(0, 200),
			title: String(liveSource.title ?? "").slice(0, 200),
			city: String(liveSource.city ?? "").slice(0, 80),
			phase: pick(PHASES, liveSource.phase, "idle"),
			phaseText: String(liveSource.phaseText ?? "").slice(0, 160),
			startedAt: time(liveSource.startedAt),
			waitUntil: 0,
			waitReason: String(liveSource.waitReason ?? "").slice(0, 300),
			nextCompany: String(liveSource.nextCompany ?? "").slice(0, 200),
			nextTitle: String(liveSource.nextTitle ?? "").slice(0, 200),
			lastSentAt: time(liveSource.lastSentAt),
			etaAt: time(liveSource.etaAt)
		},
		logs
	};
}
function emptyStatus() {
	return {
		id: "",
		state: "idle",
		items: [],
		startedAt: 0,
		finishedAt: 0,
		message: "",
		sentCount: 0,
		totalCount: 0,
		live: emptyLive(),
		logs: []
	};
}
//#endregion
export { BatchApplyQueue, JOB_SITES, JOB_SITE_IDS, JobSiteSearchEngine, applyJobSite, applyJobTrust, blockedKindFromReason, bossChatListScript, buildBossChatAiPrompt, createBrowserDriver, filterSiteJobs, greetBoss, isCompanyPageUrl, isJob51ApplySuccessUrl, job51RecordsScript, jobHistoryKey, jobSiteLabel, matchBossContact, matchJob51AppliedRecord, parseBossChatContacts, parseJob51AppliedRecords, sanitizeBossChatVerdicts, supportsSiteApply, withLocalScore, zhaopinMessageProbeScript, zhaopinMessageRecord, zhaopinMessageUrlScript };
