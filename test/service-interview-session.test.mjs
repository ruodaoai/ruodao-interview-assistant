import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeInterviewSession } from "../lib/interview-session-store.mjs";
import { startService, tempUserData } from "./service-client.mjs";

const LEGACY_ID = "s-1700000000000";

function seedSession(userDataDir) {
  const root = join(userDataDir, "interview-sessions");
  mkdirSync(join(root, LEGACY_ID), { recursive: true });
  writeFileSync(join(root, `${LEGACY_ID}.json`), JSON.stringify({
    id: LEGACY_ID,
    startedAt: "2023-11-14T22:13:20.000Z",
    jobRole: "前端工程师",
    company: "某公司",
    mode: "live",
    turns: [
      { id: "t-q1", role: "interviewer", text: "介绍一下你自己", at: 1700000000001, points: ["经历主线"] },
      { id: "t-a1", role: "candidate", text: "我有五年经验", at: 1700000000002, questionId: "t-q1" },
      { id: "t-n1", role: "noise", text: "（咳嗽）", at: 1700000000003, ignored: true },
    ],
  }), "utf8");
  return root;
}

test("常驻服务管理面试场次：列表、详情、自评备注、复盘报告与删除", async (t) => {
  const userDataDir = tempUserData();
  const root = seedSession(userDataDir);
  const service = startService(userDataDir);
  t.after(() => service.close());
  const info = await service.ready;
  assert.ok(info.methods.includes("interview.session.list"));
  assert.ok(info.methods.includes("interview.session.update"));

  const started = await service.call("interview.session.start", { jobRole: "前端", company: "新公司" });
  assert.match(started.id, /^s-\d{13,}$/);
  assert.ok(existsSync(started.dir));
  assert.ok(existsSync(join(started.dir, "..", `${started.id}.json`)));

  const listed = await service.call("interview.session.list");
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, started.id);
  assert.equal(listed[1].id, LEGACY_ID);
  assert.equal(listed[1].questionCount, 1);
  assert.equal(listed[1].candidateCount, 1);

  const detail = await service.call("interview.session.detail", { id: LEGACY_ID });
  assert.equal(detail.turns.length, 3);
  assert.equal(detail.dir, join(root, LEGACY_ID));
  assert.equal(detail.transcriptPath, join(root, LEGACY_ID, "transcript.md"));

  const updated = await service.call("interview.session.update", {
    sessionId: LEGACY_ID,
    turnId: "t-q1",
    turn: { rating: 4, note: "主线讲清楚了" },
    notes: "整场节奏偏快",
    review: {
      summary: "整体不错",
      strengths: ["结构清晰"],
      weaknesses: ["数字不够"],
      nextQuestions: ["项目难点"],
      actionPlan: ["补充指标"],
    },
  });
  assert.equal(updated.turns.find((turn) => turn.id === "t-q1").rating, 4);
  assert.equal(updated.turns.find((turn) => turn.id === "t-q1").note, "主线讲清楚了");
  assert.equal(updated.notes, "整场节奏偏快");
  assert.equal(updated.review.summary, "整体不错");

  const transcript = readFileSync(updated.transcriptPath, "utf8");
  assert.match(transcript, /★★★★☆/);
  assert.match(transcript, /整场备注/);
  assert.match(transcript, /AI 复盘报告/);
  assert.match(transcript, /结构清晰/);

  const ended = await service.call("interview.session.end", { id: started.id });
  assert.equal(ended.id, started.id);
  assert.equal(ended.items, 0);
  assert.equal(ended.candidateCount, 0);
  assert.ok(existsSync(ended.transcriptPath));

  const afterRemove = await service.call("interview.session.remove", { id: LEGACY_ID });
  assert.equal(afterRemove.ok, true);
  assert.equal(existsSync(join(root, `${LEGACY_ID}.json`)), false);
  assert.equal(existsSync(join(root, LEGACY_ID)), false);
  assert.deepEqual((await service.call("interview.session.list")).map((item) => item.id), [started.id]);

  await assert.rejects(service.call("interview.session.detail", { id: "not-a-session" }), /面试场次不存在/);
  await assert.rejects(service.call("interview.session.update", { sessionId: "s-1700000009999", notes: "x" }), /不存在/);
});

test("旧版 items 场次读入时迁移成 turns", () => {
  const session = normalizeInterviewSession({
    id: LEGACY_ID,
    startedAt: "2023-11-14T22:13:20.000Z",
    items: [
      { question: "最大的项目", answer: "支付平台", points: ["规模"], candidateAnswer: "我负责结算", candidateAt: 1700000000009 },
      { question: "（环境噪音）", ignored: true, ignoreReason: "非面试内容" },
    ],
  });
  assert.equal(session.turns.length, 3);
  assert.equal(session.turns[0].role, "interviewer");
  assert.equal(session.turns[0].answer, "支付平台");
  assert.equal(session.turns[1].role, "candidate");
  assert.equal(session.turns[1].questionId, session.turns[0].id);
  assert.equal(session.turns[2].role, "noise");
  assert.equal(session.turns[2].ignored, true);
});
