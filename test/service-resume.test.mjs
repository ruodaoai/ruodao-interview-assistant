import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startService, tempUserData } from "./service-client.mjs";

test("常驻服务管理简历库：清洗、偏好、副本、删除与宿主同步", async () => {
  const userDataDir = tempUserData();
  const service = startService(userDataDir);
  const info = await service.ready;
  assert.equal(info.dataRoot, join(userDataDir, "resume-store"));
  assert.ok(info.methods.includes("resume.save"));

  const saved = await service.call("resume.save", {
    document: {
      title: "  张三的简历  ",
      templateId: "not-a-template",
      basics: { name: " 张三 ", email: " zhang@example.com " },
      intent: { role: "前端工程师" },
      education: [
        { school: "某大学", major: "", degree: "本科", detail: "" },
        { school: "", major: "", degree: "", detail: "" },
      ],
      experience: [{ company: "", role: "" }],
      revisions: [{ id: "v1", path: "summary", before: "旧", after: "新", source: "manual" }],
    },
  });
  assert.equal(saved.item.title, "张三的简历");
  assert.equal(saved.item.templateId, "geek");
  assert.equal(saved.item.templateName, "极客");
  assert.match(saved.item.id, /^r-/);

  const onDisk = JSON.parse(readFileSync(join(userDataDir, "resume-store", "resumes.json"), "utf8"));
  assert.equal(onDisk.resumes.length, 1);
  assert.equal(onDisk.resumes[0].basics.name, "张三");
  assert.equal(onDisk.resumes[0].education.length, 1);
  assert.equal(onDisk.resumes[0].experience.length, 0);
  assert.equal(onDisk.resumes[0].revisions.length, 1);

  const changed = service.hostRequests.find((entry) => entry.method === "resume.changed");
  assert.equal(changed?.params?.action, "save");
  assert.equal(changed?.params?.resumeId, saved.item.id);
  assert.ok(service.events.some((entry) => entry.event === "resume.changed"));

  const listed = await service.call("resume.list");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, saved.item.id);
  assert.equal(listed.prefs.defaultResumeId, "");

  const prefs = await service.call("resume.prefs.save", {
    prefs: { defaultResumeId: saved.item.id, defaultTemplateId: "dusk", favoriteTemplates: ["geek", "nope", "dusk", "geek"] },
  });
  assert.equal(prefs.defaultResumeId, saved.item.id);
  assert.equal(prefs.defaultTemplateId, "dusk");
  assert.deepEqual(prefs.favoriteTemplates, ["geek", "dusk"]);

  const detail = await service.call("resume.get", { id: saved.item.id });
  assert.equal(detail.basics.email, "zhang@example.com");
  assert.equal(detail.intent.role, "前端工程师");

  const copy = await service.call("resume.duplicate", { id: saved.item.id });
  assert.notEqual(copy.id, saved.item.id);
  assert.equal(copy.title, "张三的简历 副本");
  assert.equal(copy.revisions.length, 0);
  assert.equal(copy.diagnosis, undefined);

  const removed = await service.call("resume.remove", { id: saved.item.id });
  assert.equal(removed.prefs.defaultResumeId, "");
  const afterRemove = await service.call("resume.list");
  assert.deepEqual(afterRemove.items.map((entry) => entry.id), [copy.id]);

  await assert.rejects(service.call("resume.nope"), /不支持的插件服务方法/);
  await service.close();
});

test("损坏的简历文件先留档再返回空库", async () => {
  const userDataDir = tempUserData();
  const root = join(userDataDir, "resume-store");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "resumes.json"), "{ not json", "utf8");

  const service = startService(userDataDir);
  await service.ready;
  const listed = await service.call("resume.list");
  assert.equal(listed.items.length, 0);
  assert.ok(readdirSync(root).some((name) => name.includes(".corrupt-")), readdirSync(root).join(","));
  await service.close();
});
