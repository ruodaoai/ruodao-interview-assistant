import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startService, tempUserData } from "./service-client.mjs";

function seedStore(userDataDir) {
  const root = join(userDataDir, "auto-apply");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "auto-apply.json"), JSON.stringify({
    profile: {
      name: "张三",
      city: "杭州",
      years: "5 年",
      degree: "本科",
      skills: ["React", "TypeScript"],
      targetRoles: ["前端工程师"],
      answerBank: [{ question: "你的期望薪资是多少？", answer: "35K" }],
    },
    rules: {
      blockedCompanies: ["某某外包公司"],
      greetingTemplate: "您好，我是{name}，应聘{job}，我的技能是{skills}。",
      repeatMessages: ["您好，我是{name}，再次咨询{job}岗位的进展。"],
    },
    applications: [
      {
        id: "app-prep-1",
        job: { source: "boss", title: "前端工程师", company: "某公司", description: "负责 React 中后台开发", skills: ["React"] },
        status: "planned",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "app-block-1",
        job: { source: "boss", title: "外包前端", company: "某某外包公司", description: "驻场开发" },
        status: "planned",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "app-local-1",
        job: { source: "boss", title: "Node 工程师", company: "另一家公司", description: "Node 服务开发" },
        status: "planned",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "app-repeat-1",
        job: { source: "boss", title: "前端工程师", company: "某公司", sourceUrl: "https://www.zhipin.com/job_detail/1.html" },
        status: "submitted",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    lastRunAt: 0,
  }), "utf8");
}

const replies = {
  greeting: { greeting: "您好，我是张三，看到您在招前端工程师，我的 React 与 TypeScript 经历与岗位相关，期待沟通。", warnings: ["发送前核对招聘者称呼"] },
  polish: { text: "您好，我是{name}，想应聘{job}岗位，期待与您进一步沟通。", notes: ["更简洁"] },
  assistant: {
    reply: "已按你的要求锁定 AI Agent 方向，并补上深圳。",
    profilePatch: { targetRoles: ["AI Agent 开发工程师"], targetCities: ["深圳"] },
    rulesPatch: { dailyLimit: 40, filterOutsource: true },
    searchPlan: { sites: ["boss", "zhaopin"], keywords: ["AI Agent 开发工程师"], city: "深圳" },
    questions: [],
    warnings: ["简历里没有 AI Agent 项目，建议补充真实经历"],
  },
  materials: {
    headline: "前端工程师",
    summary: "五年 React 前端经验，长期负责中后台系统。",
    coverLetter: "您好，我是张三，应聘某公司的前端工程师岗位。我曾负责 React 中后台项目，与岗位职责匹配，期待进一步沟通。",
    highlights: ["五年 React 开发经验", "熟悉 TypeScript"],
    answers: [
      { question: "为什么想加入我们公司？", answer: "岗位方向与我的 React 经历匹配，希望在团队中持续投入。" },
      { question: "你的期望薪资是多少？", answer: "模型编造的薪资" },
    ],
    warnings: ["请核对项目指标是否可公开"],
  },
};

function mockHost(state) {
  return (message) => {
    if (message.method === "llm.available") {
      return state.modelEnabled
        ? { available: true, model: "mock-model", provider: "mock" }
        : { available: false, model: "", provider: "" };
    }
    if (message.method === "llm.chat") {
      const system = String(message.params?.system ?? "");
      const body = system.includes("求职材料定制助手")
        ? replies.materials
        : system.includes("开场招呼助手")
          ? replies.greeting
          : system.includes("润色助手")
            ? replies.polish
            : replies.assistant;
      return { content: JSON.stringify(body), finishReason: "stop", model: "mock-model", providerName: "mock" };
    }
    if (message.method === "jobSites.status") {
      return { items: [{ site: "boss", label: "Boss直聘", open: true, blocked: "" }] };
    }
    return { ok: true };
  };
}

test("常驻服务生成招呼语、润色话术、求职建议与投递材料", async (t) => {
  const userDataDir = tempUserData();
  seedStore(userDataDir);
  const state = { modelEnabled: false };
  const service = startService(userDataDir, { onHostRequest: mockHost(state) });
  t.after(() => service.close());
  const info = await service.ready;
  for (const method of ["autoApply.greeting", "autoApply.greeting.polish", "autoApply.assistant", "autoApply.materials"]) {
    assert.ok(info.methods.includes(method), method);
  }

  const resume = await service.call("resume.save", {
    document: {
      title: "张三的简历",
      basics: { name: "张三", city: "杭州" },
      summary: "五年 React 前端经验。",
      skills: "React / TypeScript",
    },
  });
  await service.call("autoApply.profile.sync", { input: { resumeId: resume.item.id, overwrite: false } });
  const job = { source: "boss", title: "交互设计师", company: "目标公司", sourceUrl: "https://www.zhipin.com/job_detail/9.html" };

  // 没配置模型但填了固定模板：与宿主一致，直接渲染模板，不发起 llm.chat。
  const chatCalls = () => service.hostRequests.filter((entry) => entry.method === "llm.chat").length;
  const renderedGreeting = await service.call("autoApply.greeting", { job });
  assert.equal(renderedGreeting.mode, "template");
  assert.equal(renderedGreeting.model, "template");
  assert.equal(renderedGreeting.text, "您好，我是张三，应聘交互设计师，我的技能是React、TypeScript。");
  assert.equal(chatCalls(), 0);

  // 模板清空后没模型才用档案拼本地兜底。
  await service.call("autoApply.rules.save", { rules: { greetingTemplate: "" } });
  const localGreeting = await service.call("autoApply.greeting", { job });
  assert.equal(localGreeting.mode, "local");
  assert.equal(localGreeting.model, "local-fallback");
  assert.match(localGreeting.text, /交互设计师/);
  assert.match(localGreeting.warnings[0], /未连接文本模型/);
  assert.equal(chatCalls(), 0);

  // 恢复固定模板后，显式模板模式优先渲染占位符。
  await service.call("autoApply.rules.save", { rules: { greetingTemplate: "您好，我是{name}，应聘{job}，我的技能是{skills}。" } });
  const templateGreeting = await service.call("autoApply.greeting", { job, mode: "template" });
  assert.equal(templateGreeting.mode, "template");
  assert.equal(templateGreeting.model, "template");
  assert.equal(templateGreeting.text, "您好，我是张三，应聘交互设计师，我的技能是React、TypeScript。");
  assert.equal(chatCalls(), 0);

  // 同一岗位已投递过时用重复沟通话术。
  const repeatJob = { source: "boss", title: "前端工程师", company: "某公司", sourceUrl: "https://www.zhipin.com/job_detail/1.html" };
  const repeatGreeting = await service.call("autoApply.greeting", { job: repeatJob });
  assert.equal(repeatGreeting.repeat, true);
  assert.equal(repeatGreeting.mode, "repeat");
  assert.match(repeatGreeting.text, /再次咨询前端工程师岗位/);

  // 没有模型时求职小助手只做本地档案检查，不发请求。
  const localAssistant = await service.call("autoApply.assistant", { message: "帮我看看还差什么" });
  assert.equal(localAssistant.mode, "local");
  assert.match(localAssistant.reply, /前端工程师/);
  assert.equal(chatCalls(), 0);

  // 有模型时 AI 招呼语直接返回模型结果。
  state.modelEnabled = true;
  const aiGreeting = await service.call("autoApply.greeting", { job });
  assert.equal(aiGreeting.mode, "ai");
  assert.equal(aiGreeting.model, "mock-model");
  assert.match(aiGreeting.text, /React 与 TypeScript/);
  assert.deepEqual(aiGreeting.warnings, ["发送前核对招聘者称呼"]);

  // 润色固定模板必须保留占位符。
  const polished = await service.call("autoApply.greeting.polish", {
    text: "您好，我是{name}，应聘{job}。",
    kind: "template",
    instruction: "更自然一点",
    job,
  });
  assert.equal(polished.text, "您好，我是{name}，想应聘{job}岗位，期待与您进一步沟通。");
  assert.deepEqual(polished.notes, ["更简洁"]);
  assert.equal(polished.model, "mock-model");

  // 求职小助手：模型结果原样落回结构化补丁。
  const assistant = await service.call("autoApply.assistant", { message: "我想投 AI Agent，地点深圳" });
  assert.equal(assistant.reply, replies.assistant.reply);
  assert.deepEqual(assistant.profilePatch.targetRoles, ["AI Agent 开发工程师"]);
  assert.deepEqual(assistant.rulesPatch, { dailyLimit: 40, filterOutsource: true });
  assert.deepEqual(assistant.searchPlan, replies.assistant.searchPlan);
  assert.equal(assistant.mode, "ai");
  assert.equal(assistant.model, "mock-model");

  // 投递材料：模型答案被档案里的固定答案覆盖，状态推进到 prepared。
  const prepared = await service.call("autoApply.materials", { id: "app-prep-1" });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.materials.headline, "前端工程师");
  assert.equal(prepared.materials.model, "mock-model");
  const salary = prepared.materials.answers.find((entry) => entry.question === "你的期望薪资是多少？");
  assert.equal(salary.answer, "35K");
  assert.ok(prepared.materials.answers.some((entry) => entry.question === "为什么想加入我们公司？"));
  assert.equal(prepared.note, "请核对项目指标是否可公开");
  assert.ok(prepared.evidence.log.some((entry) => entry.message.includes("已生成投递材料（mock-model）")));
  assert.ok(service.hostRequests.some((entry) => entry.method === "autoApply.changed" && entry.params?.scope === "applications"));

  const onDisk = JSON.parse(readFileSync(join(userDataDir, "auto-apply", "auto-apply.json"), "utf8"));
  const stored = onDisk.applications.find((entry) => entry.id === "app-prep-1");
  assert.equal(stored.status, "prepared");
  assert.equal(stored.materials.coverLetter, replies.materials.coverLetter);

  // 命中安全规则：材料不生成，记录改为 blocked。
  await assert.rejects(service.call("autoApply.materials", { id: "app-block-1" }), /已按安全规则拦截/);
  const blockedDisk = JSON.parse(readFileSync(join(userDataDir, "auto-apply", "auto-apply.json"), "utf8"));
  assert.equal(blockedDisk.applications.find((entry) => entry.id === "app-block-1").status, "blocked");

  // 没模型时材料仍要用档案与简历原文拼出可用版本。
  state.modelEnabled = false;
  const localMaterials = await service.call("autoApply.materials", { id: "app-local-1" });
  assert.equal(localMaterials.status, "prepared");
  assert.equal(localMaterials.materials.model, "local-fallback");
  assert.match(localMaterials.materials.warnings.join("；"), /未连接可用文本模型/);
});
