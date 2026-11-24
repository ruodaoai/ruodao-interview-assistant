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
import { companyNameKey, isAnonymousCompany } from "../auto-apply/company-key";
import type { AutoApplyJob } from "../auto-apply/types";

export type BossChatIdentity = {
  name: string;
  company: string;
  title: string;
};

export type BossChatContact = {
  /** 列表项原始文本，保留给模型复核。 */
  raw: string;
  /** 招聘者，例如「黄女士」。 */
  name: string;
  /** 公司名，列表里可能只显示简称。 */
  company: string;
  /** 岗位名。 */
  title: string;
  /** 时间原文，例如「15:09」「昨天」「09-12」。 */
  timeText: string;
  /** 消息摘要，通常是招呼正文的开头。 */
  snippet: string;
  /** 已读 / 未读 / 送达等状态字样。 */
  status: string;
  /** 解析出的消息时间戳；0 表示时间格式不认识。 */
  at: number;
  /** 姓名连写无法唯一切分时（例如「陈丹华大智造HRBP」），保留其他拆分供匹配使用。 */
  identities?: BossChatIdentity[];
};

export type BossChatReadResult = {
  ok: boolean;
  state: "ok" | "closed" | "blocked" | "failed";
  /** 给用户看的说明：为什么没读到、读到了多少条。 */
  message: string;
  url: string;
  contacts: BossChatContact[];
  /** 列表是否已经覆盖到 since 之前：只有 true 时「没找到」才能当作「没发送」。 */
  complete: boolean;
  /** 本次捕获到的最早一条消息时间；0 表示没有可解析的时间。 */
  oldestAt: number;
  capturedAt: number;
  /** 页面被登录 / 人机验证挡住时带出类型。 */
  blocked: "login" | "verification" | "";
};

export type BossChatMatch = {
  verdict: "sent" | "not_sent" | "ambiguous";
  contactIndex: number;
  score: number;
  confidence: number;
  reason: string;
};

export type BossChatMatchInput = {
  job: Pick<AutoApplyJob, "company" | "title" | "recruiter" | "city" | "companyAnonymous">;
  contacts: BossChatContact[];
  /** 列表是否覆盖到本批开始之前。 */
  complete: boolean;
  /** 本批开始时间减去少量时钟误差后的下界。 */
  since: number;
  /** 我们实际发出（或准备发出）的招呼正文，用于和消息摘要比对。 */
  greetingHint?: string;
};

export type BossChatAiItem = {
  id: string;
  company: string;
  title: string;
  recruiter: string;
  city: string;
  /** 岗位页的最终状态：needs_user / failed。 */
  state: string;
  message: string;
  processedAt: number;
  /** 公司名是「某大型公司」这类匿名写法：不能据此判定没发送。 */
  anonymous: boolean;
  greetingHint: string;
};

export type BossChatAiVerdict = {
  id: string;
  verdict: "sent" | "not_sent" | "uncertain";
  contactIndex: number;
  confidence: number;
  reason: string;
};

const COMPANY_HINT = /(公司|集团|科技|网络|信息|数据|智能|软件|电子|银行|保险|证券|医疗|医院|教育|学校|大学|传媒|文化|广告|咨询|贸易|实业|控股|工作室|研究院|研究所|中心|有限|股份|企业|工厂|门店|餐饮|酒店|物流|地产|置业|投资|资产|人力|劳务)/;
const TITLE_HINT = /(工程师|开发|经理|主管|专员|助理|顾问|架构师|分析师|设计师|运营|产品|测试|销售|总监|实习|专家|leader|负责人|主任|文员|客服|会计|财务|法务|招聘|HR|BD|CTO|CEO|COO)/i;
const RECRUITER_HINT = /(女士|先生|小姐|老师|HR|招聘者|boss)$/i;
const STATUS_WORD = "(?:已读|未读|已送达|送达|发送失败|新招呼|对方正在输入|在线|刚刚活跃|活跃|沟通中)";
const STATUS_HINT = new RegExp(`^${STATUS_WORD}$`);
/**
 * Boss 会把送达状态直接拼在消息摘要前面（截图里的「[送达]您好，我对这个岗位很感兴趣」）。
 * 只剥离「消息送达 / 已读」一类前缀，不碰「在线教育」这种正常公司名。
 */
const STATUS_PREFIX = /^(?:[\[【(（]\s*(?:已读|未读|已送达|送达|发送失败|新招呼)\s*[\]】)）]\s*|(?:已读|未读|已送达|送达|发送失败|新招呼)\s*[:：]?\s*)+/;
const GREETING_HINT = /^(您好|你好|hi|hello|您好[，,]|你好[，,])/i;
const CITY_WORD = /^(北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|青岛|厦门|福州|济南|合肥|宁波|东莞|佛山|珠海|无锡|常州|大连|沈阳|哈尔滨|昆明|贵阳|南宁|海口|石家庄|太原|南昌|兰州|乌鲁木齐|呼和浩特|银川|西宁|拉萨|香港|澳门|台北)$/;
const CITY_PREFIX = /^(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|青岛|厦门|福州|济南|合肥|宁波|东莞|佛山|珠海|无锡|常州|大连|沈阳|哈尔滨|昆明|贵阳|南宁|海口|石家庄|太原|南昌|兰州|乌鲁木齐|呼和浩特|银川|西宁|拉萨|香港|澳门|台北)(?:市|省|特别行政区)?/;
const TIME_TOKEN = /(刚刚|\d{1,2}:\d{2}|昨天|昨日|前天|今天|今日|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,3}\s*(?:分钟|小时|天|周|个月|年)\s*(?:前|以前|之前))/;

/**
 * Boss 求职者消息页的真实列表项是「姓名 + 公司 + 招聘者头衔」连在一行、没有分隔符：
 * 「郑女士通达致远HR」「叶亮亮金信捷总经理」「马女士深圳瑞太信息技术Recruiter」。
 * 姓名长度只能靠「常见姓 + 头衔后缀」推断；推断不唯一时保留候选，匹配阶段再按岗位公司名选。
 */
const SURNAME_CHARS = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封储靳焦牧山谷车侯全班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎蓟薄印宿白怀蒲邰鄂索咸赖卓蔺屠蒙池乔胥苍闻党翟谭贡劳逄姬申冉郦雍桑桂濮牛寿边扈燕冀浦尚农温别庄晏柴瞿阎慕连茹习艾鱼容向古易慎戈廖庾暨居衡步都耿满弘匡国文寇广阙东欧沃利蔚越隆师巩聂晁勾敖冷訾辛阚那简饶空曾沙养鞠丰巢关蒯相查后荆红游竺权逯盖益桓公";
const COMPOUND_SURNAMES = ["欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "夏侯", "诸葛", "尉迟", "赫连", "皇甫", "慕容", "公孙", "长孙", "宇文", "司徒", "司空", "令狐", "轩辕", "百里", "呼延", "第五", "西门", "南门", "东郭"];
/** 常见名字用字：连写时用来判断被公司名「吞掉」的那个字更像人名还是公司名。 */
const GIVEN_NAME_HINT = "伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂华玉兰萍红娥玲芬燕彬鹏辉进宝生荣树森志建国建军晓东文博宇航子轩浩然欣怡梓涵雨桐诗涵梦琪思远晨曦嘉怡佳琪雅静可欣亮晶珊榕耀毓男丹琪琳璐瑶婷妍倩颖慧洁琼琦琴";
/** 连写行末尾的招聘者头衔；只认明确像头衔的后缀，避免把公司名当岗位。 */
const ROLE_TAIL = /^(?:高级|资深|首席|初级|中级|实习|兼职|全职|AI|HR|BD|Java|Python|Golang|Go|C\+\+)*(?:HRBP|HRD|HR|Recruiter|Talent\s*Manager|招聘者|招聘专员|招聘经理|招聘主管|招聘专家|招聘顾问|招聘HR|招聘|人事经理|人事主管|人事专员|人事HRBP|人事HR|人事|人才经理|人才|总经理|副总经理|创始人|合伙人|部门负责人|负责人|高级技术经理|技术经理|产品经理|项目经理|运营经理|开发经理|算法工程师|软件开发工程师|开发工程师|测试工程师|前端工程师|后端工程师|全栈工程师|数据工程师|架构师|工程师|经理助理|经理|主管|总监|专员|助理|顾问|实习生|boss|CEO|CTO|COO|CFO)$/i;
const PURE_COMPANY_WORD = /^(?:技术|科技|信息|网络|智能|数据|软件|电子|公司|集团|有限|股份|中心|研究院|工作室|银行|保险|医疗|教育|文化|传媒|广告|咨询|贸易|实业|控股|人力|人力资源)$/;

function isChineseName(value: string) {
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(value)) return false;
  if (CITY_WORD.test(value) || STATUS_HINT.test(value) || TIME_TOKEN.test(value)) return false;
  if (COMPOUND_SURNAMES.includes(value.slice(0, 2))) return value.length >= 3;
  return SURNAME_CHARS.includes(value[0]);
}

/** 把「公司名 + 招聘者头衔」拆开；头衔是行尾的连续角色词。 */
function splitCompanyRole(value: string): { company: string; title: string } | null {
  const text = cleanLine(value);
  if (text.length < 4) return null;
  for (let index = 1; index <= text.length - 2; index += 1) {
    const company = text.slice(0, index).trim();
    const title = text.slice(index).trim();
    if (company.length < 2 || title.length < 2 || title.length > 30) continue;
    if (CITY_WORD.test(company) || STATUS_HINT.test(company) || TIME_TOKEN.test(company)) continue;
    if (PURE_COMPANY_WORD.test(company)) continue;
    if (!ROLE_TAIL.test(title)) continue;
    return { company, title };
  }
  return null;
}

function nameSplitScore(name: string, split: { company: string; title: string }) {
  const company = split.company;
  let score = name.length === 3 ? 4 : name.length === 2 ? 2 : 0;
  if (COMPOUND_SURNAMES.some((surname) => name.startsWith(surname))) score += 6;
  score += Math.min(company.length, 8) * 2;
  if (COMPANY_HINT.test(company)) score += 2;
  if (/^[A-Za-z]/.test(company) || /[（(]/.test(company)) score += 1;
  // 错误切分会把姓名的最后一个字甩进公司名：公司首字正好是名字尾字，或像常见名字用字。
  if (company[0] === name[name.length - 1]) score -= 5;
  if (GIVEN_NAME_HINT.includes(company[0])) score -= 4;
  if (company.length <= 2 && !COMPANY_HINT.test(company)) score -= 1;
  return score;
}

/**
 * 解析一行里连写的「姓名 + 公司 + 头衔」。
 * 返回按可信度排序的全部候选：第一个用于展示，其余供 matchBossContact 对照岗位公司名选择。
 */
export function parseBossChatLineIdentities(line: string): BossChatIdentity[] {
  const value = cleanLine(line);
  if (!value || value.length > 60) return [];
  const honorific = /^([\u4e00-\u9fa5]{1,3}(?:女士|先生|小姐))(.+)$/.exec(value);
  if (honorific) {
    const name = honorific[1];
    const rest = honorific[2].trim();
    if (rest.length < 2) return [];
    // 「张先生您好…」是消息正文，不是联系人身份行。
    if (GREETING_HINT.test(rest) || /[，。！？,.!?]/.test(rest) || TIME_TOKEN.test(rest) || STATUS_HINT.test(rest)) return [];
    const split = splitCompanyRole(rest);
    if (split) return [{ name, ...split }];
    if (!looksLikeCompany(rest)) return [];
    return [{ name, company: rest, title: "" }];
  }
  const candidates: { identity: BossChatIdentity; score: number }[] = [];
  for (const length of [2, 3, 4]) {
    if (value.length <= length + 1) continue;
    const name = value.slice(0, length);
    if (!isChineseName(name)) continue;
    const split = splitCompanyRole(value.slice(length));
    if (!split) continue;
    candidates.push({ identity: { name, ...split }, score: nameSplitScore(name, split) });
  }
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((entry) => {
      const key = `${entry.identity.name}|${entry.identity.company}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map((entry) => entry.identity);
}

/** 去掉消息摘要前的送达 / 已读状态，返回真正的消息正文。 */
export function stripBossChatStatus(value: unknown) {
  return cleanLine(value).replace(STATUS_PREFIX, "").trim();
}

/** 从一行文本里提取夹带的状态标记（例如「[送达]您好…」里的「送达」）。 */
export function bossChatStatusOf(value: unknown) {
  const match = STATUS_PREFIX.exec(cleanLine(value));
  return match ? match[0].replace(/[\[\]【】()（）:：\s]/g, "") : "";
}

/** 求职者消息页是 /web/geek/chat；/web/chat/index 是旧入口/招聘者侧，不能拿它等联系人列表。 */
export function isBossChatUrl(url: string) {
  return /zhipin\.com\/web\/(?:(?:geek|boss)\/chat|chat\/)/i.test(String(url ?? ""));
}

function cleanLine(value: unknown) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

/** 去掉空白与常见标点，保留中文品牌差异；只用于「包含」比较。 */
export function normalizeChatText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~，。、；：！？“”‘’（）【】《》·—－_\-]+/g, "")
    .trim();
}

/**
 * 把「15:09」「昨天」「09-12」这类列表时间还原成时间戳。
 * 列表只显示到分钟，所以结果天然有最多一分钟误差；调用方比较时要留余量。
 */
export function parseBossChatTime(value: string, now = Date.now()): number {
  const text = cleanLine(value);
  if (!text) return 0;
  const base = new Date(now);
  const at = (year: number, month: number, day: number, hour = 12, minute = 0) => {
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
  };
  if (/刚刚/.test(text)) return now;
  const relative = /(\d{1,3})\s*(分钟|小时|天|周|个月|年)\s*(?:前|以前|之前)/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "分钟" ? 60_000
      : unit === "小时" ? 3_600_000
        : unit === "天" ? 86_400_000
          : unit === "周" ? 7 * 86_400_000
            : unit === "个月" ? 30 * 86_400_000
              : 365 * 86_400_000;
    return now - amount * ms;
  }
  const yesterday = /昨天|昨日/.exec(text);
  if (yesterday) {
    const clock = /(\d{1,2}):(\d{2})/.exec(text);
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    if (clock) return at(date.getFullYear(), date.getMonth() + 1, date.getDate(), Number(clock[1]), Number(clock[2]));
    date.setHours(20, 0, 0, 0);
    return date.getTime();
  }
  const beforeYesterday = /前天/.exec(text);
  if (beforeYesterday) {
    const clock = /(\d{1,2}):(\d{2})/.exec(text);
    const date = new Date(now);
    date.setDate(date.getDate() - 2);
    if (clock) return at(date.getFullYear(), date.getMonth() + 1, date.getDate(), Number(clock[1]), Number(clock[2]));
    date.setHours(20, 0, 0, 0);
    return date.getTime();
  }
  const weekday = /(?:星期|周)([一二三四五六日天])/.exec(text);
  if (weekday) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[weekday[1]];
    const date = new Date(now);
    const current = date.getDay();
    let delta = current - target;
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
      if (result > now + 86_400_000) result = at(base.getFullYear() - 1, month, day, monthDay[3] ? Number(monthDay[3]) : 12, monthDay[4] ? Number(monthDay[4]) : 0);
      return result;
    }
  }
  const clock = /(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/.exec(text);
  if (clock) {
    let result = at(base.getFullYear(), base.getMonth() + 1, base.getDate(), Number(clock[1]), Number(clock[2]));
    // 列表不写日期时默认是今天；如果算出来「比现在还晚」，只能是昨天。
    if (result > now + 5 * 60_000) result -= 86_400_000;
    return result;
  }
  return 0;
}

/** 一行是不是列表时间（避免把「15:09」当成岗位名）。 */
export function isBossChatTimeLine(value: string) {
  return parseBossChatTime(value, Date.now()) > 0;
}

function looksLikeRecruiter(line: string) {
  const value = cleanLine(line);
  if (!value) return false;
  if (RECRUITER_HINT.test(value) && value.length <= 12) return true;
  return /^[\u4e00-\u9fa5·]{2,4}$/.test(value)
    && !CITY_WORD.test(value)
    && !COMPANY_HINT.test(value)
    && !TITLE_HINT.test(value);
}

/**
 * 姓名和公司写在同一行时（例如「阮雪 雷特科技」）单独取姓名。
 * 只接受「2-4 个汉字 + 分隔符 + 像公司/岗位的后半段」，避免把城市或公司简称当成人名。
 */
function inlineRecruiter(line: string) {
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

function looksLikeCompany(line: string) {
  const value = cleanLine(line);
  if (!value || value.length > 40) return false;
  const body = stripBossChatStatus(value);
  if (!body || TIME_TOKEN.test(body) || STATUS_HINT.test(body)) return false;
  return COMPANY_HINT.test(body) || (body.length >= 3 && !TITLE_HINT.test(body) && !GREETING_HINT.test(body));
}

function looksLikeTitle(line: string) {
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
export function parseBossChatContact(raw: string, now = Date.now()): BossChatContact {
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
  // 先识别「姓名 + 公司 + 头衔」连写行：这行本身不能被当成招呼正文。
  const identityEntries = lines
    .map((line) => ({ line, identities: parseBossChatLineIdentities(line) }))
    .filter((entry) => entry.identities.length > 0);
  const identityLineSet = new Set(identityEntries.map((entry) => entry.line));
  // 真正的消息摘要必须像一条消息：只按「长文本」判断会把公司 / 岗位行误当成招呼。
  const messageLines = lines.filter((line) => {
    if (identityLineSet.has(line)) return false;
    const body = stripBossChatStatus(line);
    return Boolean(body)
      && !TIME_TOKEN.test(body)
      && !STATUS_HINT.test(body)
      && (GREETING_HINT.test(body) || (body.length >= 12 && /(简历|岗位|应聘|沟通|感兴趣|期待|回复|贵司|贵公司|面试|介绍|您好|你好)/.test(body)));
  });
  const greetingLine = messageLines[0] ?? "";
  const greetingIndex = greetingLine ? lines.indexOf(greetingLine) : -1;
  const snippet = greetingLine ? stripBossChatStatus(greetingLine).slice(0, 300) : "";
  // 正文行不参与姓名 / 公司 / 岗位识别，避免把「[送达]您好…」当成公司名。
  const contentLines = lines.filter((_, index) => index !== greetingIndex && index !== timeIndex);
  const identityEntry = identityEntries.find((entry) => contentLines.includes(entry.line));
  const beforeContent = before.filter((line) => line !== greetingLine);
  const afterContent = after.filter((line) => line !== greetingLine);
  const restOfInline = (line: string) => {
    const inline = inlineRecruiter(line);
    if (!inline) return line;
    return cleanLine(line.slice(line.indexOf(inline) + inline.length).replace(/^[\s·|｜/]+/, ""));
  };
  let name = beforeContent.find(looksLikeRecruiter) ?? "";
  if (!name) name = contentLines.map(inlineRecruiter).find(Boolean) ?? "";
  if (!name) name = lines.find((line) => RECRUITER_HINT.test(line)) ?? "";
  let company = beforeContent
    .filter((line) => line !== name)
    .map(restOfInline)
    .find(looksLikeCompany) ?? "";
  if (!company) company = afterContent.map(restOfInline).find(looksLikeCompany) ?? "";
  if (!company) {
    company = contentLines
      .filter((line) => line !== name && line !== timeText)
      .map(restOfInline)
      .find((line) => line !== snippet && looksLikeCompany(line)) ?? "";
  }
  // 二字品牌（腾讯 / 华为 / 美团）单独占一行时不带公司关键词，接在招聘者后面就是公司名。
  if (!company && name) {
    company = contentLines.find((line) => line !== name
      && line !== timeText
      && /^[\u4e00-\u9fa5A-Za-z0-9]{2}$/.test(line)
      && !CITY_WORD.test(line)
      && !STATUS_HINT.test(line)
      && !RECRUITER_HINT.test(line)
      && !TITLE_HINT.test(line)) ?? "";
  }
  let title = afterContent.map(restOfInline).find((line) => line !== company && looksLikeTitle(line)) ?? "";
  if (!title) title = beforeContent.map(restOfInline).find((line) => line !== company && line !== name && looksLikeTitle(line)) ?? "";
  // 「公司 · 岗位」写在同一条时拆开，避免把整段当成公司名。
  if (company && !title) {
    const parts = company.split(/\s*[·|｜/]\s*/).filter(Boolean);
    if (parts.length >= 2) {
      company = parts[0];
      title = parts.slice(1).join(" ");
    }
  }
  // 公司行里夹着岗位的情况（例如「编程猫 Python开发」）：把后半段拆给 title。
  if (company && !title) {
    const match = /^(.{2,30}?)\s+(.{2,50})$/.exec(company);
    if (match && looksLikeTitle(match[2])) {
      company = match[1];
      title = match[2];
    }
  }
  if (company && TITLE_HINT.test(company) && !COMPANY_HINT.test(company)) {
    // 没有识别到公司、只抓到岗位时，宁可留空让匹配转为「待确认」，也不能编公司名。
    title = title || company;
    company = "";
  }
  // 消息页有两种结构：三行列表（姓名 / 公司 / 岗位）和单行连写（姓名+公司+头衔）。
  // 只有结构化字段拼不出来时才采用连写候选，否则「全栈开发工程师」会被当成「全栈 / 开发」。
  const structured = Boolean(name && company)
    && name.length <= 12
    && !COMPANY_HINT.test(name)
    && !TITLE_HINT.test(name)
    && normalizeChatText(company) !== normalizeChatText(name);
  if (identityEntry && !structured) {
    const best = identityEntry.identities[0];
    const extraTitle = contentLines
      .filter((line) => line !== identityEntry.line)
      .find((line) => looksLikeTitle(line) && !looksLikeCompany(line)) ?? "";
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
        title: identity.title.slice(0, 120),
      })),
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
    at,
  };
}

/** 批量解析并去掉重复项（列表滚动时同一项会被多次抓到）。 */
export function parseBossChatContacts(rawItems: string[], now = Date.now()): BossChatContact[] {
  const seen = new Set<string>();
  const contacts: BossChatContact[] = [];
  for (const raw of rawItems) {
    const contact = parseBossChatContact(raw, now);
    const key = normalizeChatText(contact.raw).slice(0, 200);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    contacts.push(contact);
  }
  return contacts;
}

function containsToken(haystack: string, needle: string) {
  if (!needle || needle.length < 2) return false;
  return haystack.includes(needle);
}

/** 去掉城市前缀后的品牌核心：列表常写「深圳市海柔创新科技」，岗位全称是「海柔创新科技有限公司」。 */
function brandKeyOf(value: string) {
  return companyNameKey(value).replace(CITY_PREFIX, "");
}

/** 公司名可能是简称（编程猫）或全称（深圳点猫科技有限公司），双向包含就算同一家。 */
export function companyMatches(company: string, contactText: string, contactCompany = "") {
  const key = companyNameKey(company);
  const text = normalizeChatText(contactText);
  const listed = normalizeChatText(contactCompany);
  if (!key || !text) return { score: 0, strong: false, exact: false };
  const brandKey = brandKeyOf(company);
  const listedBrand = brandKeyOf(contactCompany);
  // 列表里单独展示的公司字段最可靠：两个字（腾讯 / 华为 / 美团）也能确认。
  if (listed) {
    if (listed === key) return { score: 60, strong: true, exact: true };
    if (listed.startsWith(key) || key.startsWith(listed)) {
      return { score: 55, strong: true, exact: false };
    }
    if (listed.length >= 3 && (listed.includes(key) || key.includes(listed))) {
      return { score: 52, strong: true, exact: false };
    }
  }
  // Boss 列表常把公司名截短并去掉「市」：深圳市通达致远科技 / 通达致远。
  if (brandKey && listedBrand) {
    if (brandKey === listedBrand) return { score: 62, strong: true, exact: true };
    if (brandKey.startsWith(listedBrand) || listedBrand.startsWith(brandKey)) {
      return { score: 58, strong: true, exact: false };
    }
  }
  if (text.includes(key)) {
    // 共同前缀太短（例如只有「深圳」）不算，避免把同城任何一家都当成目标公司。
    return { score: key.length >= 4 ? 55 : 45, strong: key.length >= 3, exact: text === key };
  }
  // 联系人项里只显示品牌简称时，公司全称包含它也算；取去掉城市前缀后的品牌核心做启发。
  if (brandKey.length >= 3 && text.includes(brandKey)) return { score: 56, strong: true, exact: false };
  if (brandKey.length >= 3 && listedBrand && (listedBrand.includes(brandKey) || brandKey.includes(listedBrand))) {
    return { score: 54, strong: true, exact: false };
  }
  const tail = brandKey;
  if (text.length >= 3 && key.includes(text)) return { score: 40, strong: true, exact: false };
  // 列表里常把公司名截短（「深圳艾信迩信息」对应「深圳艾信迩信息技术有限公司」）：
  // 取和 key 共同前缀里最长的一段，长度至少 4 才算，避免「深圳」这种城市前缀乱匹配。
  for (let length = key.length - 1; length >= 4; length -= 1) {
    if (text.includes(key.slice(0, length))) return { score: 42, strong: true, exact: false };
  }
  return { score: 0, strong: false, exact: false };
}

function recruiterMatches(recruiter: string, contact: BossChatContact) {
  const value = normalizeChatText(recruiter);
  if (!value) return { score: 0, matched: false, penalize: false };
  const name = normalizeChatText(contact.name);
  const raw = normalizeChatText(contact.raw);
  if (name && (name === value || name.includes(value) || value.includes(name))) return { score: 30, matched: true, penalize: false };
  if (raw.includes(value)) return { score: 22, matched: true, penalize: false };
  return { score: 0, matched: false, penalize: true };
}

function titleMatches(title: string, contact: BossChatContact) {
  const value = normalizeChatText(title);
  if (!value || value.length < 3) return 0;
  const raw = normalizeChatText(contact.raw);
  if (raw.includes(value)) return 15;
  const tokens = String(title).split(/[\s/·|｜()（）\-]+/).map(normalizeChatText).filter((entry) => entry.length >= 4);
  if (tokens.some((token) => raw.includes(token))) return 8;
  return 0;
}

function greetingMatches(greeting: string, contact: BossChatContact) {
  // Boss 列表里的摘要会被截断（「您好，我对这个岗位很感兴趣，…」），探测串太长永远匹配不上。
  const probe = normalizeChatText(greeting).slice(0, 12);
  if (probe.length < 5) return 0;
  return normalizeChatText(`${contact.snippet}${stripBossChatStatus(contact.raw)}`).includes(probe) ? 20 : 0;
}

/**
 * 判断一条岗位在 Boss 消息列表里有没有对应记录。
 * 只有在「列表完整覆盖本批时间」且「公司不匿名」时才允许 not_sent；其余一律交给 AI / 本人。
 */
export function matchBossContact(input: BossChatMatchInput): BossChatMatch {
  const job = input.job;
  const anonymous = job.companyAnonymous === true || isAnonymousCompany(job.company);
  const contacts = input.contacts ?? [];
  const scored = contacts.map((contact, index) => {
    // 连写行（「陈丹华大智造HRBP」）的姓名 / 公司可能拆出多个候选：
    // 展示用第一个，匹配时逐个和岗位公司名对照，选证据最强的一组。
    const variants = contact.identities?.length
      ? contact.identities
      : [{ name: contact.name, company: contact.company, title: contact.title }];
    let company = { score: 0, strong: false, exact: false };
    let recruiter = { score: 0, matched: false, penalize: false };
    let companyLabel = contact.company;
    for (const variant of variants) {
      const nextCompany = companyMatches(job.company, variant.company, variant.company);
      if (nextCompany.score > company.score) {
        company = nextCompany;
        companyLabel = variant.company;
      }
      const nextRecruiter = recruiterMatches(job.recruiter ?? "", { ...contact, name: variant.name });
      if (nextRecruiter.score > recruiter.score) recruiter = nextRecruiter;
    }
    // 所有候选都拆错时，公司全称仍可能出现在整行原文里，作为兜底证据。
    const fromRaw = companyMatches(job.company, contact.raw, contact.company);
    if (fromRaw.score > company.score) {
      company = fromRaw;
      companyLabel = contact.company;
    }
    const title = titleMatches(job.title ?? "", contact);
    const greeting = greetingMatches(input.greetingHint ?? "", contact);
    const fresh = contact.at > 0 && contact.at >= input.since;
    const stale = contact.at > 0 && contact.at < input.since;
    const score = company.score + recruiter.score + title + greeting + (fresh ? 10 : stale ? -25 : -5) - (recruiter.penalize && company.score > 0 ? 10 : 0);
    return { contact, index, score, company, recruiter, title, greeting, fresh, stale, companyLabel };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 30) {
    if (!contacts.length) {
      return { verdict: "ambiguous", contactIndex: -1, score: 0, confidence: 0, reason: "没有从 Boss 消息页读到联系人列表，无法判断" };
    }
    if (!input.complete) {
      return { verdict: "ambiguous", contactIndex: -1, score: 0, confidence: 0, reason: "Boss 消息列表还没有覆盖到本批开始时间，无法确认没发送" };
    }
    if (anonymous) {
      return { verdict: "ambiguous", contactIndex: -1, score: 0, confidence: 0, reason: "公司名是匿名写法，Boss 消息列表无法可靠对应" };
    }
    return {
      verdict: "not_sent",
      contactIndex: -1,
      score: 0,
      confidence: 0.85,
      reason: "Boss 消息列表里没有找到这家公司的招呼记录",
    };
  }
  const second = scored[1];
  const unique = !second || best.score - second.score >= 10;
  const timeKnown = best.contact.at > 0;
  const sentThreshold = timeKnown ? 70 : 85;
  if (best.fresh && best.score >= sentThreshold && unique && best.company.strong) {
    const bits = [best.companyLabel || job.company, best.contact.timeText].filter(Boolean);
    return {
      verdict: "sent",
      contactIndex: best.index,
      score: best.score,
      confidence: Math.min(0.98, Math.max(0.7, best.score / 100)),
      reason: `Boss 消息记录里找到对应招呼${bits.length ? `（${bits.join(" · ")}）` : ""}`,
    };
  }
  const why = best.stale
    ? `只找到 ${best.contact.timeText || "更早"} 的旧会话，不在本批时间范围内`
    : !best.company.strong
      ? "公司名对不上，可能是同名或简称不同"
      : !unique
        ? "Boss 消息列表里有多条相似联系人，无法确定是哪一条"
        : "招聘者 / 岗位信息对不上";
  return { verdict: "ambiguous", contactIndex: best.index, score: best.score, confidence: Math.max(0, Math.min(0.6, best.score / 100)), reason: why };
}

/** 给 AI 的输入：只发列表原文与必要的岗位字段，不夹带简历等无关隐私。 */
export function buildBossChatAiPrompt(input: {
  items: BossChatAiItem[];
  contacts: BossChatContact[];
  complete: boolean;
  batchStartedAt: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const clock = (at: number) => {
    if (!at) return "";
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const system = [
    "你是招聘平台消息核对员。只根据用户给的 Boss 消息列表判断每条投递是否已经发出。",
    "严禁猜测：证据不足时必须返回 uncertain。",
    "返回严格 JSON，不要 Markdown，不要解释。",
    'JSON 结构：{"verdicts":[{"id":"岗位ID","verdict":"sent|not_sent|uncertain","contactIndex":0,"confidence":0.0,"reason":"不超过60字"}]}',
    "判定规则：",
    "1) sent：消息列表里有明确的同公司 + 同招聘者/同岗位记录，且消息时间在本批开始之后。",
    "2) not_sent：只有在 complete=true、公司名不是匿名、且列表里完全没有该公司记录时才允许。",
    "3) 其余全部 uncertain，包括公司名匿名、有多条相似记录、列表未覆盖本批时间。",
    "4) contactIndex 必须指向消息列表里的真实下标；sent 时必须给出。",
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
    item.greetingHint ? `准备发送的招呼=${item.greetingHint.slice(0, 120)}` : "",
  ].filter(Boolean).join("；"));
  const contactLines = input.contacts.map((contact, index) => {
    const parsed = [
      contact.name ? `招聘者=${contact.name}` : "",
      contact.company ? `公司=${contact.company}` : "",
      contact.title ? `岗位=${contact.title}` : "",
      contact.timeText ? `时间=${contact.timeText}` : "",
      contact.status ? `状态=${contact.status}` : "",
    ].filter(Boolean).join("；");
    return `${index}. ${parsed}\n原文：${contact.raw.replace(/\n+/g, " / ").slice(0, 500)}${contact.snippet ? `\n摘要：${contact.snippet.slice(0, 160)}` : ""}`;
  });
  const user = [
    `本批开始时间：${clock(input.batchStartedAt)}`,
    `消息列表是否已覆盖到本批开始之前：${input.complete ? "是" : "否"}`,
    `当前时间：${clock(now)}`,
    "",
    `待核对岗位（${input.items.length} 条）：`,
    ...itemLines,
    "",
    `Boss 消息列表（${input.contacts.length} 条，contactIndex 从 0 开始）：`,
    ...(contactLines.length ? contactLines : ["（空）"]),
  ].join("\n");
  return { system, user };
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 清洗模型输出：模型可以说「sent」，但必须指向一条真实联系人，且该联系人能和岗位对上；
 * 否则降级为 uncertain。列表不完整或公司匿名时，永远不接受 not_sent。
 */
export function sanitizeBossChatVerdicts(input: {
  raw: unknown;
  items: BossChatAiItem[];
  contacts: BossChatContact[];
  complete: boolean;
  since: number;
  greetingHints?: Record<string, string>;
}): BossChatAiVerdict[] {
  const source = input.raw && typeof input.raw === "object" ? input.raw as Record<string, unknown> : {};
  const list = Array.isArray(source.verdicts) ? source.verdicts : [];
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const output: BossChatAiVerdict[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    const verdict = record.verdict === "sent" || record.verdict === "not_sent" || record.verdict === "uncertain"
      ? record.verdict
      : "uncertain";
    const confidence = Math.max(0, Math.min(1, number(record.confidence, 0)));
    const reason = String(record.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const contactIndex = Math.round(number(record.contactIndex, -1));
    let next: BossChatAiVerdict = { id, verdict, contactIndex, confidence, reason };
    if (verdict === "sent") {
      const contact = input.contacts[contactIndex];
      const support = contact ? matchBossContact({
        job: {
          company: item.company,
          title: item.title,
          recruiter: item.recruiter,
          city: item.city,
          companyAnonymous: item.anonymous,
        },
        contacts: [contact],
        complete: input.complete,
        since: input.since,
        greetingHint: input.greetingHints?.[id] ?? item.greetingHint,
      }) : null;
      // 只有「本批时间内 + 规则也认为足够像」才接受模型的 sent：
      // 只靠一句通用招呼语匹配到 30 分不能算证据，否则会把别家岗位误标成已投。
      const fresh = contact ? contact.at > 0 && contact.at >= input.since : false;
      const supported = Boolean(support) && (support!.verdict === "sent" || (fresh && support!.score >= 55));
      if (!contact || confidence < 0.7 || !supported) {
        next = { id, verdict: "uncertain", contactIndex, confidence, reason: reason || "模型给出的联系人无法和岗位对应，已降级为待确认" };
      }
    }
    if (verdict === "not_sent") {
      const hasCandidate = input.contacts.some((contact) => {
        const match = matchBossContact({
          job: {
            company: item.company,
            title: item.title,
            recruiter: item.recruiter,
            city: item.city,
            companyAnonymous: item.anonymous,
          },
          contacts: [contact],
          complete: input.complete,
          since: input.since,
          greetingHint: input.greetingHints?.[id] ?? item.greetingHint,
        });
        return match.score >= 30;
      });
      if (!input.complete || item.anonymous || confidence < 0.8 || hasCandidate) {
        next = { id, verdict: "uncertain", contactIndex, confidence, reason: reason || "消息列表不足以证明没有发送" };
      }
    }
    seen.add(id);
    output.push(next);
  }
  for (const item of input.items) {
    if (seen.has(item.id)) continue;
    output.push({ id: item.id, verdict: "uncertain", contactIndex: -1, confidence: 0, reason: "模型没有返回这条岗位的结论" });
  }
  return output;
}

/**
 * 从 Boss 消息页抓联系人列表。
 *
 * 页面 class 经常变，因此先按常见容器取；取不到时退化成「左侧半屏、有姓名/时间/公司特征」的
 * 最小容器。返回值只包含原始文本，结构化解析在 Node 侧做，方便测试和复用。
 */
export function bossChatListScript(options: { scroll?: boolean; maxItems?: number } = {}) {
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
