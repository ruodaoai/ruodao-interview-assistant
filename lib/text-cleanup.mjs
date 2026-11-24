/**
 * 简历导入文本清洗：处理三类最常见的「看起来像换行」的噪声。
 *
 * 1. 字面量转义：从表格/网页复制时常见 `\n`、`\r\n`、`\t` 两个字符本身，
 *    用户期望它们是空格而不是新行（真实需求：粘贴的岗位描述里出现 `\n`）。
 * 2. PDF/DOCX 硬换行：一句话被排版切成多行，需要在段内合并，段间保留空行。
 * 3. 表格/分栏：制表符、项目符号、日期区间等行必须保留，不能被合并。
 */

const BULLET_PATTERN = /^(?:[-*•·▪◦●○◆◇■□➤►✓✔]|\d{1,2}[.、)）]|[（(]\d{1,2}[）)]|[一二三四五六七八九十]{1,3}[、.）)])\s*/;

const SECTION_HEADERS = new Set([
  "个人简历", "简历", "基本信息", "个人信息", "联系方式", "求职意向", "求职目标", "教育背景", "教育经历",
  "工作经历", "工作经验", "实习经历", "实习经验", "项目经历", "项目经验", "专业技能", "技能特长", "技能清单",
  "证书资质", "证书", "荣誉奖项", "荣誉", "获奖经历", "获奖情况", "自我评价", "个人简介", "自我介绍",
  "语言能力", "兴趣爱好", "作品集", "培训经历", "校园经历", "社会实践", "研究方向", "发表论文", "开源项目", "其他",
]);

const SENTENCE_END = /[。！？.!?；;：:]$/;

const CONTACT_LIKE = /[@／/]|https?:|www\.|\b\d{3,4}[- ]?\d{7,8}\b|\b1[3-9]\d{9}\b/;

const DATE_RANGE = /(?:\d{4}\s*[.\-/年]\s*\d{1,2}|\d{4}\s*[-–—~至]\s*(?:\d{4}|至今|今|现在)|至今)/;

function isCjk(char) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(char);
}

function isAsciiWord(char) {
  return /[A-Za-z0-9]/.test(char);
}

/**
 * 把字面量 `\n` / `\r\n` / `\t` 解码成空白。
 * 连续两个以上的字面量换行视为段落分隔；单个视为空格（用户明确要求）。
 * `C:\new` 这类盘符路径保持原样。
 */
export function decodeLiteralEscapes(input) {
  const source = String(input ?? "");
  if (!source.includes("\\")) return source;
  return source
    .replace(/(?:\\r\\n){2,}/g, "\n\n")
    .replace(/(?:\\n){2,}/g, "\n\n")
    .replace(/(?<![A-Za-z]:)\\r\\n/g, " ")
    .replace(/(?<![A-Za-z]:)\\n/g, " ")
    .replace(/\\t/g, " ");
}

function isBulletLine(line) {
  return BULLET_PATTERN.test(line);
}

function isSectionHeader(line) {
  const bare = line.replace(/^[【\[(（#\s]+|[】\])）\s]+$/g, "").replace(/[：:]\s*$/, "").trim();
  if (!bare) return false;
  if (SECTION_HEADERS.has(bare)) return true;
  return /^[A-Z][A-Z\s&/]{2,30}$/.test(bare);
}

function isStructuralLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[\s\t]/.test(line)) return true;
  if (isBulletLine(trimmed)) return true;
  if (isSectionHeader(trimmed)) return true;
  if (CONTACT_LIKE.test(trimmed)) return true;
  if (DATE_RANGE.test(trimmed) && trimmed.length <= 90) return true;
  if (trimmed.includes("|") || trimmed.includes("｜")) return true;
  if (trimmed.includes("\t")) return true;
  return false;
}

function looksLikeHeading(line) {
  const trimmed = line.trim();
  if (trimmed.length > 16) return false;
  return !/[，。；：、,.;:]/.test(trimmed);
}

function shouldJoin(previous, next, threshold) {
  const prev = previous.trim();
  const line = next.trim();
  if (!prev || !line) return false;
  if (prev.length < threshold) return false;
  if (SENTENCE_END.test(prev)) return false;
  if (isStructuralLine(next)) return false;
  if (looksLikeHeading(line)) return false;
  return true;
}

function mergeWrapped(previous, next) {
  const left = previous.replace(/\s+$/, "");
  const right = next.replace(/^\s+/, "");
  if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) return `${left.slice(0, -1)}${right}`;
  const last = left.slice(-1);
  const first = right.slice(0, 1);
  if (isAsciiWord(last) && isAsciiWord(first)) return `${left} ${right}`;
  if (isCjk(last) && isCjk(first)) return `${left}${right}`;
  // 中文与英文/数字直接相接；如果左侧是中文标点或空白，同样不加空格。
  return `${left}${right}`;
}

/**
 * 合并 PDF/DOCX 排版产生的段内换行。
 * 只有「上一行接近本页常见行宽」时才认为下一行是续行，
 * 这样表格、短标题、列表和联系方式都不会被误合并。
 */
export function joinSoftWrappedLines(input) {
  const source = String(input ?? "");
  if (!source.trim()) return source;
  const lines = source.split("\n");
  const widths = lines.map((line) => line.trim().length).filter((width) => width > 0);
  if (widths.length < 4) return source;
  const sorted = [...widths].sort((a, b) => a - b);
  const p80 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
  const threshold = Math.max(22, Math.round(p80 * 0.82));
  const out = [];
  for (const line of lines) {
    const at = out.length - 1;
    if (at >= 0 && shouldJoin(out[at], line, threshold)) out[at] = mergeWrapped(out[at], line);
    else out.push(line);
  }
  return out.join("\n");
}

/** 导入文本统一入口：归一空白 → 解码字面量转义 →（仅 PDF）合并硬换行 → 收敛空行。 */
export function normalizeImportedText(raw, options = {}) {
  const decoded = decodeLiteralEscapes(String(raw ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const joined = options.joinWrapped ? joinSoftWrappedLines(decoded) : decoded;
  return joined
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 200_000);
}

/**
 * 字段级归一：用于 AI 返回的单个字段。
 * 单行字段把换行压成空格；多行字段保留换行（bullet 结构）。
 * `literalNewlines` 区分两种来源：导入文本里的 `\n` 是噪声（转空格），
 * AI 改写结果里的 `\n` 通常是它想要的分行（转真换行）。
 */
export function normalizeFieldText(value, options = {}) {
  const source = String(value ?? "").replace(/\u0000/g, "");
  let out = (options.literalNewlines === "newline" ? source.replace(/(?:\\r\\n)+|\\n/g, "\n").replace(/\\t/g, " ") : decodeLiteralEscapes(source))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u3000]/g, " ");
  if (options.multiline) out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  else out = out.replace(/\s*\n+\s*/g, " ");
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  return typeof options.max === "number" ? out.slice(0, options.max) : out;
}
