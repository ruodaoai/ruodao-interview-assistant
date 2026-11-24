/**
 * 面试助手插件本地验证脚本（零依赖）
 * 覆盖：doctor 命令、answer-text 命令（mock LLM）、capture 的错误路径、manifest 结构。
 * 运行：node test/plugin.test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "bin", "interview-assistant.mjs");

function runPlugin(args, { env = {}, stdin = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "", err = "";
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const llmPort = 18923;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    assert.match(req.url, /\/chat\/completions/);
    const payload = JSON.parse(body);
    assert.equal(payload.model, "mock-model");
    assert.ok(payload.messages.some((m) => m.role === "system" && m.content.includes("电话面试实时助手")));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        question: "请做一下自我介绍",
        answer: "面试官您好，我有五年后端开发经验……",
        points: ["五年后端经验", "主导过微服务改造"],
      }) } }],
    }));
  });
});
await new Promise((r) => server.listen(llmPort, r));

try {
  // 1. manifest 结构校验
  const manifest = JSON.parse(await readFile(path.join(root, "ruodao-plugin.json"), "utf8"));
  assert.equal(manifest.id, "com.ruodao.interview-assistant");
  assert.ok(manifest.apiVersion.includes("0.1.0"));
  assert.equal(manifest.requires.capabilities.required.commands, "0.1.0");
  assert.equal(manifest.requires.capabilities.required["code.execute"], "0.1.0");
  assert.ok(manifest.contributes.commands.length >= 3);
  for (const cmd of manifest.contributes.commands) {
    assert.equal(cmd.action.type, "process");
    assert.ok(cmd.action.timeoutMs > 0);
  }
  console.log("ok manifest");

  // 2. doctor：无 ffmpeg/配置也应输出合法 JSON 报告
  const doctor = await runPlugin(["doctor"], { stdin: "{}" });
  assert.equal(doctor.code, 0);
  const doctorReport = JSON.parse(doctor.out.trim());
  assert.equal(doctorReport.state, "succeeded");
  assert.ok("checks" in doctorReport && "ffmpeg" in doctorReport.checks);
  console.log("ok doctor");

  // 3. answer-text：mock LLM 端到端
  const answer = await runPlugin(["answer-text"], {
    env: {
      RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      RUODAO_LLM_API_KEY: "mock-key",
      RUODAO_LLM_MODEL: "mock-model",
    },
    stdin: JSON.stringify({ prompt: "请做一下自我介绍" }),
  });
  assert.equal(answer.code, 0);
  const parsed = JSON.parse(answer.out.trim());
  assert.equal(parsed.state, "succeeded");
  assert.equal(parsed.question, "请做一下自我介绍");
  assert.match(parsed.answer, /自我介绍|后端/);
  assert.ok(Array.isArray(parsed.points));
  console.log("ok answer-text (mock LLM e2e)");

  // 4. capture 缺配置时的明确错误路径
  const missing = await runPlugin(["capture"], { stdin: "{}" });
  assert.equal(missing.code, 1);
  const missingOut = JSON.parse(missing.out.trim());
  assert.equal(missingOut.state, "failed");
  assert.match(missingOut.error, /RUODAO_AUDIO_DEVICE/);
  console.log("ok capture error path");

  // 5. answer-text 空 prompt 错误路径
  const empty = await runPlugin(["answer-text"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "k" },
    stdin: "{}",
  });
  assert.equal(JSON.parse(empty.out.trim()).state, "failed");
  console.log("ok empty prompt path");

  console.log("ALL PASS");
} finally {
  server.close();
}
