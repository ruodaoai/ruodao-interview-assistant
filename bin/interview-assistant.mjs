#!/usr/bin/env node
/**
 * Ruodao 面试助手（电话面试实时应答）
 *
 * 流水线：ffmpeg 采集麦克风 → OpenAI 兼容 STT 转写问题 → OpenAI 兼容 LLM 生成答案
 * 零第三方依赖，Node >= 18。
 *
 * 环境变量：
 *   RUODAO_AUDIO_DEVICE       Windows dshow 音频设备名（如 "麦克风 (Realtek Audio)"）；
 *                             缺省时 doctor 会列出可选设备。
 *   RUODAO_CAPTURE_SECONDS    每次录音时长，默认 10 秒。
 *   RUODAO_STT_BASE_URL       OpenAI 兼容 STT 根地址，如 https://api.openai.com/v1
 *   RUODAO_STT_API_KEY        STT API Key
 *   RUODAO_STT_MODEL          转写模型，默认 whisper-1
 *   RUODAO_LLM_BASE_URL       OpenAI 兼容 Chat 根地址（可与 STT 相同）
 *   RUODAO_LLM_API_KEY        LLM API Key
 *   RUODAO_LLM_MODEL          对话模型，默认 gpt-4o-mini
 *   RUODAO_JOB_ROLE           目标岗位，用于答案措辞（可选）
 *   RUODAO_ANSWER_STYLE       answer | points | both，默认 both
 *
 * 输出（stdout，JSON）：Host 会把 stdout 记入 pluginExecutionResults。
 *   { "state": "succeeded", "question": "...", "answer": "...", "points": [...], "latencyMs": n }
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const env = (k, d = "") => (process.env[k] ?? d).trim();

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); }
      catch { resolve({ prompt: data.trim() }); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  process.exit(1);
}

function run(cmd, args, { capture = true, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("killed"); resolve({ code: 124, stdout, stderr: stderr + "\ntimeout" }); } }, timeoutMs);
    if (capture) child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); } });
  });
}

/* ---------------- doctor ---------------- */

async function doctor() {
  const report = { state: "succeeded", checks: {} };
  const ffmpeg = await run("ffmpeg", ["-version"], { timeoutMs: 8000 });
  report.checks.ffmpeg = { ok: ffmpeg.code === 0, hint: ffmpeg.code === 0 ? "found" : "请安装 ffmpeg 并加入 PATH（https://ffmpeg.org）" };
  const devices = ffmpeg.code === 0 ? await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { timeoutMs: 10000 }) : { stderr: "" };
  const audioDevices = [...devices.stderr.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
  report.checks.audioDevices = audioDevices;
  report.checks.audioDeviceConfigured = env("RUODAO_AUDIO_DEVICE")
    ? { ok: audioDevices.length === 0 || audioDevices.includes(env("RUODAO_AUDIO_DEVICE")), value: env("RUODAO_AUDIO_DEVICE") }
    : { ok: false, hint: "未设置 RUODAO_AUDIO_DEVICE，请从 audioDevices 列表中选择并设置" };
  report.checks.stt = {
    ok: Boolean(env("RUODAO_STT_BASE_URL") && env("RUODAO_STT_API_KEY")),
    baseUrl: env("RUODAO_STT_BASE_URL") || "(未设置)",
    model: env("RUODAO_STT_MODEL", "whisper-1"),
  };
  report.checks.llm = {
    ok: Boolean(env("RUODAO_LLM_BASE_URL") && env("RUODAO_LLM_API_KEY")),
    baseUrl: env("RUODAO_LLM_BASE_URL") || "(未设置)",
    model: env("RUODAO_LLM_MODEL", "gpt-4o-mini"),
  };
  report.ok = report.checks.ffmpeg.ok && report.checks.stt.ok && report.checks.llm.ok;
  emit(report);
}

/* ---------------- audio capture ---------------- */

async function captureWav(seconds) {
  const dir = await mkdtemp(path.join(tmpdir(), "ruodao-interview-"));
  const file = path.join(dir, "question.wav");
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "dshow", "-i", `audio=${env("RUODAO_AUDIO_DEVICE")}`,
    "-t", String(seconds), "-ac", "1", "-ar", "16000",
    "-y", file,
  ];
  const rec = await run("ffmpeg", args, { capture: false, timeoutMs: (seconds + 15) * 1000 });
  if (rec.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    fail(`麦克风录音失败（exit ${rec.code}）：${rec.stderr.slice(-400)}`, {
      hint: "请运行『环境自检』确认 RUODAO_AUDIO_DEVICE 与设备名完全一致",
    });
  }
  const buf = await readFile(file);
  await rm(dir, { recursive: true, force: true });
  return buf;
}

/* ---------------- OpenAI-compatible calls ---------------- */

async function transcribe(wav) {
  const base = env("RUODAO_STT_BASE_URL").replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "question.wav");
  form.append("model", env("RUODAO_STT_MODEL", "whisper-1"));
  let res;
  try {
    res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RUODAO_STT_API_KEY")}` },
      body: form,
    });
  } catch (error) {
    fail(`STT 请求网络失败：${String(error?.cause?.message || error)}。请检查 RUODAO_STT_BASE_URL 是否可达`);
  }
  if (!res.ok) fail(`STT 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.text ?? "").trim();
}

function buildMessages(question) {
  const style = env("RUODAO_ANSWER_STYLE", "both");
  const role = env("RUODAO_JOB_ROLE", "技术岗位");
  const format = style === "points" ? "用不超过 6 条要点回答。"
    : style === "answer" ? "用一段 30 秒内可以说完的话回答。"
    : "先给一段 30 秒内可以说完的『口语答案』，再给不超过 6 条的『要点』（JSON 数组 points）。";
  return [
    { role: "system", content: `你是电话面试实时助手，目标岗位：${role}。面试官刚刚提问，你要帮助面试者快速作答。要求：${format}回答直接可说，不要客套、不要复述问题、不要 markdown 标记。同时以 JSON 字段 question 回显问题。只输出一个 JSON 对象：{"question":"...","answer":"...","points":["..."]}` },
    { role: "user", content: question },
  ];
}

async function generateAnswer(question) {
  const base = env("RUODAO_LLM_BASE_URL").replace(/\/+$/, "");
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("RUODAO_LLM_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env("RUODAO_LLM_MODEL", "gpt-4o-mini"),
        messages: buildMessages(question),
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: "json_object" },
      }),
    });
  } catch (error) {
    fail(`LLM 请求网络失败：${String(error?.cause?.message || error)}。请检查 RUODAO_LLM_BASE_URL 是否可达`);
  }
  if (!res.ok) fail(`LLM 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()); }
  catch { parsed = { answer: text.trim(), points: [] }; }
  return { ...parsed, latencyMs: Date.now() - started };
}

/* ---------------- commands ---------------- */

async function capture() {
  if (!env("RUODAO_AUDIO_DEVICE")) fail("缺少环境变量 RUODAO_AUDIO_DEVICE，请先运行环境自检查看设备列表");
  if (!env("RUODAO_STT_BASE_URL") || !env("RUODAO_STT_API_KEY")) fail("缺少 STT 配置（RUODAO_STT_BASE_URL / RUODAO_STT_API_KEY）");
  if (!env("RUODAO_LLM_BASE_URL") || !env("RUODAO_LLM_API_KEY")) fail("缺少 LLM 配置（RUODAO_LLM_BASE_URL / RUODAO_LLM_API_KEY）");
  const seconds = Math.min(Math.max(Number(env("RUODAO_CAPTURE_SECONDS", "10")) || 10, 3), 60);
  const started = Date.now();
  const wav = await captureWav(seconds);
  const question = await transcribe(wav);
  if (!question) fail("未能从音频中识别出问题（音频可能为空或太短）");
  const result = await generateAnswer(question);
  emit({ state: "succeeded", question, ...result, captureSeconds: seconds, totalLatencyMs: Date.now() - started });
}

async function answerText(stdin) {
  const question = (stdin.prompt || "").trim();
  if (!question) fail("没有检测到问题文本：请把面试官的问题填入 prompt");
  if (!env("RUODAO_LLM_BASE_URL") || !env("RUODAO_LLM_API_KEY")) fail("缺少 LLM 配置（RUODAO_LLM_BASE_URL / RUODAO_LLM_API_KEY）");
  const result = await generateAnswer(question);
  emit({ state: "succeeded", question, ...result });
}

/* ---------------- 常见面试题库 ---------------- */

const QUESTION_BANK = [
  {
    category: "通用 / HR",
    questions: [
      "请用 1 分钟做一下自我介绍",
      "你为什么想加入我们公司？",
      "你最大的优点和缺点是什么？",
      "说一次你和同事发生分歧的经历，你是怎么处理的？",
      "你未来 3-5 年的职业规划是什么？",
      "你为什么从上一家公司离职？",
      "你的期望薪资是多少？",
      "你还有什么想问我们的吗？",
    ],
  },
  {
    category: "项目 / 经验",
    questions: [
      "介绍一个你最有挑战的项目，你负责了哪部分？",
      "这个项目最大的技术难点是什么，你是怎么解决的？",
      "如果重新做这个项目，你会做哪些改进？",
      "项目上线出过什么线上事故？你是怎么排查和复盘的？",
      "你在项目中如何做技术选型？",
      "你如何保证代码质量和团队协作效率？",
    ],
  },
  {
    category: "前端基础",
    questions: [
      "讲讲事件循环（Event Loop）以及宏任务和微任务的区别",
      "闭包是什么？有哪些实际应用和注意事项？",
      "原型和原型链是怎么工作的？",
      "CSS 的 flex 布局有哪些常用属性？",
      "浏览器从输入 URL 到页面展示发生了什么？",
      "讲讲浏览器渲染流程以及如何减少重排重绘",
      "防抖和节流的区别及实现",
      "前端如何做性能优化？",
    ],
  },
  {
    category: "框架 / 工程",
    questions: [
      "React 的虚拟 DOM 和 diff 算法是怎么工作的？",
      "useMemo 和 useCallback 的区别和使用场景？",
      "Vue 的响应式原理（Vue3 与 Vue2 的区别）？",
      "组件设计的原则是什么？举一个你设计过的公共组件",
      "Webpack 和 Vite 的区别？Vite 为什么快？",
      "如何设计前端微服务（微前端）方案？",
      "TypeScript 的泛型在哪些场景下解决了你的问题？",
    ],
  },
  {
    category: "网络 / 安全",
    questions: [
      "HTTP/1.1、HTTP/2、HTTP/3 的主要区别？",
      "讲讲 HTTPS 的握手过程和证书校验",
      "强缓存和协商缓存的区别？如何设计缓存策略？",
      "什么是 XSS 和 CSRF？前端如何防范？",
      "跨域是怎么产生的？有哪些解决方案？",
      "WebSocket 和轮询的取舍？",
    ],
  },
  {
    category: "算法 / 场景题",
    questions: [
      "现场实现：数组去重（要求时间复杂度 O(n)）",
      "现场实现：防抖函数 debounce",
      "现场实现：深拷贝一个对象（处理循环引用）",
      "场景题：页面首屏加载很慢，你的排查思路是什么？",
      "场景题：如何设计一个前端埋点和上报系统？",
      "场景题：如何实现一个大文件分片上传与断点续传？",
    ],
  },
];

async function questions() {
  emit({
    state: "succeeded",
    total: QUESTION_BANK.reduce((sum, group) => sum + group.questions.length, 0),
    groups: QUESTION_BANK,
    hint: "点击任意题目即可用当前 LLM 配置生成参考答案",
  });
}

/* ---------------- main ---------------- */

const stdin = await readStdin();
// 工作台 UI 会把用户在界面里保存的配置通过 stdin JSON 的 config 字段传进来，
// 覆盖同名环境变量；这样用户无需手动设置系统环境变量。
if (stdin.config && typeof stdin.config === "object") {
  for (const [key, value] of Object.entries(stdin.config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) process.env[key] = String(value).trim();
  }
}
const mode = process.argv[2] ?? "";
if (mode === "doctor") await doctor();
else if (mode === "capture") await capture();
else if (mode === "answer-text") await answerText(stdin);
else if (mode === "questions") await questions();
else fail(`未知模式：${mode}（支持 doctor / capture / answer-text / questions）`);
