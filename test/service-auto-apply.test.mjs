import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startService, tempUserData } from "./service-client.mjs";

function seedStore(userDataDir) {
  const root = join(userDataDir, "auto-apply");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "auto-apply.json"), JSON.stringify({
    profile: {},
    rules: {},
    applications: [{
      id: "app-test-1",
      job: {
        source: "boss",
        title: "前端工程师",
        company: "某公司",
        sourceUrl: "https://www.zhipin.com/job_detail/1.html",
      },
      status: "submitted",
      createdAt: 1,
      updatedAt: 1,
    }],
    lastRunAt: 123,
  }), "utf8");
}

test("常驻服务管理求职档案、安全规则、简历同步与岗位标签", async () => {
  const userDataDir = tempUserData();
  seedStore(userDataDir);
  const service = startService(userDataDir);
  const info = await service.ready;
  for (const method of ["autoApply.state", "autoApply.profile.save", "autoApply.rules.save", "autoApply.profile.sync", "autoApply.jobTags.list", "autoApply.jobTags.save"]) {
    assert.ok(info.methods.includes(method), method);
  }

  const resume = await service.call("resume.save", {
    document: {
      title: "张三的简历",
      basics: {
        name: "张三",
        phone: "13800000000",
        email: "zhang@example.com",
        city: "杭州",
        years: "5 年",
        degree: "本科",
        links: [{ label: "GitHub", url: "https://github.com/zhangsan" }],
      },
      intent: { role: "前端工程师 / React 开发", city: "杭州、上海", salary: "30-40K", available: "一个月内" },
      summary: "五年 Web 前端经验。",
      skills: "熟悉 TypeScript / React\n掌握 Node.js",
    },
  });

  const profile = await service.call("autoApply.profile.save", {
    profile: {
      name: "  李四  ",
      email: " li@example.com ",
      city: "上海",
      website: "javascript:alert(1)",
      targetRoles: ["前端", "前端", " 后端 "],
      skills: ["TS", "TS", "React"],
      remote: "远程",
      answerBank: [{ question: " 期望薪资 ", answer: "30k" }, { question: "", answer: "无效" }],
    },
  });
  assert.equal(profile.name, "李四");
  assert.equal(profile.email, "li@example.com");
  assert.equal(profile.website, "");
  assert.deepEqual(profile.targetRoles, ["前端", "后端"]);
  assert.deepEqual(profile.skills, ["TS", "React"]);
  assert.equal(profile.remote, "远程");
  assert.equal(profile.answerBank.length, 1);
  assert.ok(profile.updatedAt > 0);
  assert.ok(service.hostRequests.some((entry) => entry.method === "autoApply.changed" && entry.params?.scope === "profile"));

  let onDisk = JSON.parse(readFileSync(join(userDataDir, "auto-apply", "auto-apply.json"), "utf8"));
  assert.equal(onDisk.profile.name, "李四");
  assert.equal(onDisk.applications.length, 1);
  assert.equal(onDisk.applications[0].id, "app-test-1");
  assert.equal(onDisk.applications[0].job.company, "某公司");
  assert.equal(onDisk.lastRunAt, 123);

  const rules = await service.call("autoApply.rules.save", {
    rules: {
      dailyLimit: 20,
      dailyGreetLimit: 5,
      staleJobDays: 3,
      autoApplyWindow: "25:00-99:00",
      blockedCompanies: ["A", "A", "B"],
      blockedCompanyNotes: { A: "太远", C: "名单里没有" },
      requireConfirmation: false,
      blockedKeywords: ["外包", "外包"],
    },
  });
  assert.equal(rules.dailyLimit, 5);
  assert.equal(rules.staleJobDays, 7);
  assert.equal(rules.autoApplyWindow, "09:00-21:00");
  assert.deepEqual(rules.blockedCompanies, ["A", "B"]);
  assert.deepEqual(rules.blockedCompanyNotes, { A: "太远" });
  assert.equal(rules.requireConfirmation, true);
  assert.deepEqual(rules.blockedKeywords, ["外包"]);
  assert.ok(service.hostRequests.some((entry) => entry.method === "autoApply.changed" && entry.params?.scope === "rules"));

  // 清空姓名后再从简历同步：只补空字段，并挂上这份简历。
  await service.call("autoApply.profile.save", {
    profile: { ...profile, name: "", phone: "", email: "", resumeId: "" },
  });
  const synced = await service.call("autoApply.profile.sync", { input: { resumeId: resume.item.id, overwrite: false } });
  assert.equal(synced.profile.name, "张三");
  assert.equal(synced.profile.phone, "13800000000");
  assert.equal(synced.profile.email, "zhang@example.com");
  assert.equal(synced.profile.resumeId, resume.item.id);
  assert.equal(synced.resumeTitle, "张三的简历");
  assert.equal(synced.overwrite, false);
  assert.ok(synced.filled.includes("姓名"));
  assert.ok(synced.filled.includes("手机号"));
  assert.ok(service.hostRequests.some((entry) => entry.method === "autoApply.changed" && entry.params?.scope === "profile"));

  // 用户已经填过的字段在 fill-empty 模式下不被覆盖。
  const kept = await service.call("autoApply.profile.sync", { input: { resumeId: resume.item.id, overwrite: false } });
  assert.equal(kept.filled.length, 0);
  assert.equal(kept.profile.name, "张三");

  const tagged = await service.call("autoApply.jobTags.save", {
    job: { source: "boss", jobId: "job-1", company: "某公司", title: "前端工程师", city: "上海" },
    tags: ["已面过", "已面过", " 不合适 "],
  });
  assert.equal(tagged.entry.key, "boss:job-1");
  assert.deepEqual(tagged.entry.tags, ["已面过", "不合适"]);
  assert.equal(tagged.items.length, 1);
  assert.ok(service.hostRequests.some((entry) => entry.method === "autoApply.changed" && entry.params?.scope === "tags"));

  const listedTags = await service.call("autoApply.jobTags.list");
  assert.equal(listedTags.total, 1);
  assert.equal(listedTags.items[0].company, "某公司");

  const cleared = await service.call("autoApply.jobTags.save", { key: "boss:job-1", tags: [] });
  assert.equal(cleared.entry, null);
  assert.equal(cleared.items.length, 0);

  const state = await service.call("autoApply.state");
  assert.equal(state.profile.name, "张三");
  assert.equal(state.rules.dailyLimit, 5);
  assert.equal(state.applications.length, 1);
  assert.equal(state.applications[0].id, "app-test-1");
  assert.equal(state.applications[0].status, "submitted");
  assert.equal(state.lastRunAt, 123);

  await assert.rejects(service.call("autoApply.profile.sync", { input: { resumeId: "r-missing" } }), /简历已不存在/);
  await service.close();

  onDisk = JSON.parse(readFileSync(join(userDataDir, "auto-apply", "auto-apply.json"), "utf8"));
  assert.equal(onDisk.profile.name, "张三");
  assert.equal(onDisk.applications.length, 1);
});
