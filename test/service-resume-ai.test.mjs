import assert from "node:assert/strict";
import test from "node:test";
import { startService, tempUserData } from "./service-client.mjs";

const RESUME = {
  id: "r-1",
  title: "张三的简历",
  basics: { name: "张三", email: "zhang@example.com" },
  intent: { role: "前端工程师" },
  summary: "负责前端开发，做过结算平台。",
  experience: [
    { id: "e-1", company: "某公司", role: "前端工程师", start: "2020.01", end: "2023.06", description: "负责结算平台前端开发" },
  ],
};

function mockChat(responses) {
  const calls = [];
  return {
    calls,
    async handler(message) {
      if (message.method !== "llm.chat") return { ok: true };
      calls.push(message.params);
      const next = typeof responses === "function" ? responses(calls.length - 1) : responses[calls.length - 1];
      if (!next) throw new Error(`unexpected llm.chat call ${calls.length}`);
      return {
        content: next.content,
        finishReason: next.finishReason ?? "stop",
        model: "mock-model",
        providerName: "Mock 供应商",
      };
    },
  };
}

test("简历 AI 在插件服务里组装提示词并经宿主 llm.chat 润色", async (t) => {
  const chat = mockChat([{
    content: JSON.stringify({
      polished: "第一行\\n第二行",
      notes: ["补充指标", "标题更聚焦", "去掉空话", "保留事实", "多余说明"],
      keywords: ["React", "TypeScript", "工程化", "性能优化", "跨端", "Node", "测试"],
    }),
  }]);
  const service = startService(tempUserData(), { onHostRequest: chat.handler });
  t.after(() => service.close());
  await service.ready;

  const result = await service.call("resume.ai", {
    input: {
      mode: "polish",
      resume: RESUME,
      section: { label: "个人简介", content: "负责前端开发" },
      target: { role: "高级前端工程师" },
      llm: { provider: "mock", model: "mock-model" },
    },
  });

  assert.equal(result.state, "succeeded");
  assert.equal(result.polished, "第一行\n第二行");
  assert.equal(result.notes.length, 4);
  assert.equal(result.keywords.length, 6);
  assert.equal(result.model, "mock-model");
  assert.equal(result.providerName, "Mock 供应商");

  assert.equal(chat.calls.length, 1);
  const request = chat.calls[0];
  assert.match(request.system, /资深简历顾问/);
  assert.match(request.user, /【待润色模块】个人简介/);
  assert.match(request.user, /负责前端开发/);
  assert.match(request.user, /目标岗位：高级前端工程师/);
  assert.equal(request.temperature, 0.5);
  assert.equal(request.maxTokens, 3000);
  assert.deepEqual(request.binding, { provider: "mock", model: "mock-model" });
});

test("简历诊断会过滤「未来日期」误报并校验字段路径", async (t) => {
  const chat = mockChat([{
    content: JSON.stringify({
      score: 82,
      summary: "可以投，优先补量化与关键词。",
      dimensions: [{ key: "content", label: "信息完整度", score: 80, comment: "基本完整" }],
      issues: [
        { severity: "high", section: "工作经历 · 第 1 段 · 工作内容", targets: ["experience[e-1].description"], title: "缺少量化", detail: "职责没有数字", suggestion: "补转化率与耗时" },
        { severity: "medium", section: "工作经历 · 第 1 段", targets: [], title: "结束时间是未来日期", detail: "2023.06 尚未结束", suggestion: "核实日期" },
      ],
      strengths: ["有完整项目经历"],
      matchedKeywords: ["React"],
      missingKeywords: ["TypeScript", "Node"],
    }),
  }]);
  const service = startService(tempUserData(), { onHostRequest: chat.handler });
  t.after(() => service.close());
  await service.ready;

  const result = await service.call("resume.ai", { input: { mode: "diagnose", resume: RESUME } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, "缺少量化");
  assert.deepEqual(result.issues[0].targets, ["experience[e-1].description"]);
  assert.match(chat.calls[0].system, /时间线事实/);
  assert.match(chat.calls[0].system, /未来日期：无/);
  assert.match(chat.calls[0].user, /字段路径清单/);
});

test("模型返回非法 JSON 时自动请求修复", async (t) => {
  const chat = mockChat([
    { content: "这不是 JSON" },
    { content: '{"polished":"修好了","notes":[],"keywords":[]}' },
  ]);
  const service = startService(tempUserData(), { onHostRequest: chat.handler });
  t.after(() => service.close());
  await service.ready;

  const result = await service.call("resume.ai", {
    input: { mode: "polish", resume: RESUME, section: { label: "简介", content: "负责前端" } },
  });
  assert.equal(result.polished, "修好了");
  assert.equal(chat.calls.length, 2);
  assert.match(chat.calls[1].system, /JSON 修复器/);
  assert.match(chat.calls[1].user, /这不是 JSON/);
});

test("简历 AI 参数错误不触发模型请求", async (t) => {
  const chat = mockChat([]);
  const service = startService(tempUserData(), { onHostRequest: chat.handler });
  t.after(() => service.close());
  await service.ready;

  await assert.rejects(service.call("resume.ai", { input: { mode: "nope" } }), /不支持的简历 AI 模式/);
  await assert.rejects(service.call("resume.ai", { input: { mode: "polish", resume: RESUME, section: { label: "简介", content: "  " } } }), /待润色的内容为空/);
  assert.equal(chat.calls.length, 0);
});
