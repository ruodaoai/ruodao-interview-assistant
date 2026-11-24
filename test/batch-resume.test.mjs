/**
 * 批量投递队列：招聘窗口被关闭后的暂停 / 继续回归。
 * 运行：node --test test/batch-resume.test.mjs
 *
 * 用户反馈「关了浏览器以后点继续没有用」：正在执行的浏览器调用不会返回，
 * 队列卡在 guard 里，只改暂停标志没有任何效果。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BatchApplyQueue } from "../lib/job-engine.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeJob(id, company) {
  return {
    id,
    company,
    title: "前端工程师",
    city: "上海",
    source: "boss",
    sourceUrl: `https://www.zhipin.com/job_detail/${id}.html`,
  };
}

function makeQueue(run) {
  return new BatchApplyQueue({
    gate: async () => ({ allowed: true }),
    run,
    settle: async () => {},
    now: () => 1_000_000,
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) await sleep(5);
}

test("关闭招聘窗口会立刻打断当前岗位，继续后从下一个岗位接着投", async () => {
  const ran = [];
  const queue = makeQueue(async (job) => {
    ran.push(job.id);
    // 窗口被关掉后，宿主的浏览器调用可能永远不返回。
    if (job.id === "a") return new Promise(() => {});
    return { state: "sent", message: "已发送" };
  });
  await queue.start([makeJob("a", "A 公司"), makeJob("b", "B 公司")]);
  await waitFor(() => ran.includes("a"));

  queue.pause("Boss 窗口被关闭，批量投递已暂停", { abortActive: true });
  await waitFor(() => queue.statusSnapshot().items[0].state === "needs_user");
  const paused = queue.statusSnapshot();
  assert.equal(paused.state, "paused");
  assert.equal(paused.items[0].state, "needs_user", "被打断的岗位可能已经发出，要记为待确认");
  await sleep(50);
  assert.deepEqual(ran, ["a"], "暂停期间不能继续投下一个岗位");

  queue.resume();
  await waitFor(() => queue.statusSnapshot().state === "done");
  const final = queue.statusSnapshot();
  assert.equal(final.state, "done");
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(final.items[1].state, "sent");
});

test("普通暂停不打断正在发送的岗位，继续后从下一个岗位接着走", async () => {
  const ran = [];
  let release;
  const queue = makeQueue(async (job) => {
    ran.push(job.id);
    if (job.id === "a") {
      return new Promise((resolve) => {
        release = () => resolve({ state: "sent", message: "已发送" });
      });
    }
    return { state: "sent", message: "已发送" };
  });
  await queue.start([makeJob("a", "A 公司"), makeJob("b", "B 公司")]);
  await waitFor(() => ran.includes("a"));

  queue.pause("手动暂停");
  await sleep(30);
  assert.equal(queue.statusSnapshot().items[0].state, "running", "普通暂停要等当前这条收尾");
  release();
  await waitFor(() => queue.statusSnapshot().state === "paused");
  assert.deepEqual(ran, ["a"]);

  queue.resume();
  await waitFor(() => queue.statusSnapshot().state === "done");
  assert.deepEqual(ran, ["a", "b"]);
});
