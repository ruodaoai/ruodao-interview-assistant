import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = join(PLUGIN_DIR, "bin", "service.mjs");

export function tempUserData() {
  return mkdtempSync(join(tmpdir(), "interview-service-"));
}

/** 最小宿主客户端：发 init、解析一行一个 JSON、自动应答反向请求。 */
export function startService(userDataDir, options = {}) {
  const child = spawn(process.execPath, [SERVICE], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, RUODAO_USER_DATA_DIR: userDataDir, RUODAO_PLUGIN_VERSION: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const hostRequests = [];
  const events = [];
  let seq = 0;
  let buffer = "";
  let stderr = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === "ready") {
        resolveReady(message.payload);
        continue;
      }
      if (message.type === "response") {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error));
        continue;
      }
      if (message.type === "request") {
        hostRequests.push(message);
        const reply = (payload) => child.stdin.write(`${JSON.stringify({ type: "response", id: message.id, ...payload })}\n`);
        if (typeof options.onHostRequest === "function") {
          Promise.resolve()
            .then(() => options.onHostRequest(message))
            .then((result) => reply({ ok: true, result: result === undefined ? { ok: true } : result }))
            .catch((error) => reply({ ok: false, error: String(error?.message ?? error) }));
        } else {
          reply({ ok: true, result: { ok: true } });
        }
        continue;
      }
      if (message.type === "event") events.push(message);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("exit", () => {
    rejectReady(new Error(`service exited before ready: ${stderr}`));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`service exited: ${stderr}`));
    }
    pending.clear();
  });
  child.stdin.write(`${JSON.stringify({ type: "init", payload: {} })}\n`);

  function call(method, params = {}, timeoutMs = 10000) {
    const id = `c${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method} ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    await new Promise((resolve) => child.once("exit", resolve));
  }

  return { child, ready, call, close, hostRequests, events, stderr: () => stderr };
}
