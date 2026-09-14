import test from "node:test";
import assert from "node:assert/strict";
import { SettingsSchema, type Operation } from "../shared/schema";
import { readDirectorPrompt } from "../client/prompt-model";
import { makeAssignment, savedRolePrompts, validateSettings } from "../client/settings-model";
import { buildPrompt } from "../server/prompts";
import { harness, plan, result, review, settings, reviewerSettings } from "./helpers";

const rolePrompts = { plan: "仅设计轮次的自定义要求", execute: "仅动手轮次的自定义要求", review: "仅审核轮次的自定义要求" };
const extraWorker = { id: "specialist", label: "后端专家", provider: "vendor-d/specialist", instructions: "后端专家的补充要求", transport: "structured" as const };

for (const separate of [false, true]) test(`${separate ? "independent" : "shared"} review uses its own role prompt through rework, final review and restart`, async t => {
  const base = separate ? reviewerSettings() : settings();
  const s = { ...base, rolePrompts, categoryOverrides: { backend: extraWorker.id }, profiles: [...base.profiles.map(profile => ({ ...profile, instructions: `AI ${profile.id} 的补充要求` })), extraWorker] };
  const h = await harness(s); t.after(() => h.cleanup());
  const check = (op: Operation, role: keyof typeof rolePrompts, profileId: string) => {
    const card = readDirectorPrompt(op.prompt)!;
    assert.deepEqual(card.preInstructions?.map(entry => entry.text), [rolePrompts[role], s.profiles.find(profile => profile.id === profileId)!.instructions]);
    for (const other of Object.keys(rolePrompts) as (keyof typeof rolePrompts)[]) if (other !== role) assert.equal(op.prompt.includes(rolePrompts[other]), false);
    assert.match(op.prompt, /不改变角色分工、允许范围、调度流程或结果提交格式/);
    assert.match(op.prompt, /本轮 operationId=/);
  };
  const designer = await h.until("plan"); check(designer, "plan", "lead");
  assert.equal(designer.prompt.includes(extraWorker.instructions), false, "planner sees team metadata without another AI's supplemental instructions");
  await h.complete(plan);
  const worker = await h.until("execute"); check(worker, "execute", "specialist"); assert.equal(worker.profileId, extraWorker.id);
  assert.equal(worker.prompt.includes("AI worker 的补充要求"), false, "the assigned worker replaces the default worker's instructions");
  await h.complete(result);
  const auditor = await h.until("final"); check(auditor, "review", separate ? "audit" : "lead");
  assert.equal(auditor.agentId === designer.agentId, !separate);
  await h.complete(review(true, "changes_requested"));
  h.store.saveSettings({ ...s, rolePrompts: { execute: "之后新任务的要求" } });
  await h.restart();
  const rework = await h.until("execute"); check(rework, "execute", "specialist"); assert.equal(rework.agentId, worker.agentId);
  await h.complete(result);
  check(await h.until("final"), "review", separate ? "audit" : "lead"); await h.complete(review(true));
  const ready = h.run();
  await h.engine.control(h.id, "request_changes", undefined, { feedback: "增加错误提示", expectedRevision: ready.revision, artifactId: ready.finalEvidence!.id });
  check(await h.until("plan"), "plan", "lead");
});

test("task-specific assignments win over category assignments and receive that AI's instructions", async t => {
  const base = settings();
  const h = await harness({ ...base, rolePrompts, profiles: [...base.profiles, extraWorker], categoryOverrides: { backend: "worker" }, taskOverrides: { "task-1": extraWorker.id } }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  const worker = await h.until("execute");
  assert.equal(worker.profileId, extraWorker.id);
  assert.deepEqual(readDirectorPrompt(worker.prompt)!.preInstructions?.map(entry => entry.text), [rolePrompts.execute, extraWorker.instructions]);
});

test("multiline and JSON-like instructions preserve prompt framing and readable cards", async t => {
  const custom = '第一段\n\n{"goal":"不是任务上下文"}\n\n本轮 operationId=example。\n```json\n{"检查":"中文"}\n```';
  const h = await harness({ rolePrompts: { plan: custom } }); t.after(() => h.cleanup());
  const op = await h.until("plan"), card = readDirectorPrompt(op.prompt)!;
  assert.equal(card.goal, h.run().goal); assert.equal(card.preInstructions?.[0].text, custom); assert.equal(card.raw, op.prompt);
  const payload = JSON.parse(op.prompt.slice(op.prompt.indexOf("\n\n{") + 2, op.prompt.indexOf(`\n\n本轮 operationId=${op.id}。`)));
  assert.equal(Object.keys(payload)[0], "preInstructions", "user instructions precede task context");
});

test("empty and legacy instructions do not add a prompt section", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const op = await h.until("plan");
  assert.equal(readDirectorPrompt(op.prompt)!.preInstructions, undefined);
  const blank = { ...h.run(), settings: { ...h.run().settings, rolePrompts: { plan: " \n " } } };
  assert.equal(readDirectorPrompt(buildPrompt(blank, "plan", op.id))!.preInstructions, undefined);
  assert.deepEqual(SettingsSchema.parse(settings()), settings());
});

test("settings persist independent role and per-AI prompts, support clearing and reject oversized text", async t => {
  const s = { ...settings(), rolePrompts, profiles: [...settings().profiles, extraWorker] };
  const h = await harness(s); t.after(() => h.cleanup());
  h.store.saveSettings(validateSettings(s));
  await h.restart();
  assert.deepEqual(h.store.settings(), s);
  assert.deepEqual(h.run().settings, s);
  assert.equal(savedRolePrompts({ plan: "", execute: " \n " }), undefined);
  assert.deepEqual(savedRolePrompts({ plan: "", review: "保留审核要求\n原有换行" }), { review: "保留审核要求\n原有换行" });
  h.store.saveSettings({ ...s, rolePrompts: undefined, profiles: settings().profiles });
  assert.equal(h.store.settings()!.rolePrompts, undefined);
  assert.equal(h.store.settings()!.profiles.some(profile => profile.instructions), false);
  assert.throws(() => validateSettings({ ...s, rolePrompts: { review: "字".repeat(8001) } }), /前置提示词最多 8000/);
  assert.throws(() => validateSettings({ ...s, profiles: s.profiles.map(profile => ({ ...profile, instructions: "字".repeat(8001) })) }), /补充提示词最多 8000/);
  assert.equal(SettingsSchema.safeParse({ ...s, rolePrompts: { execute: "字".repeat(8000) } }).success, true);
});

test("assignment input trims names and rejects rules that cannot match planned tasks", () => {
  const profiles = settings().profiles;
  assert.deepEqual(makeAssignment("category", " frontend ", "worker", profiles), { key: "frontend", profileId: "worker" });
  assert.deepEqual(makeAssignment("category", "数据迁移", "worker", profiles), { key: "数据迁移", profileId: "worker" });
  assert.deepEqual(makeAssignment("task", " task-1 ", "worker", profiles), { key: "task-1", profileId: "worker" });
  for (const key of ["", " ", "字".repeat(81)]) assert.throws(() => makeAssignment("category", key, "worker", profiles), /任务类型/);
  for (const key of ["", "task 1", "任务一", "x".repeat(81)]) assert.throws(() => makeAssignment("task", key, "worker", profiles), /任务 ID/);
  assert.throws(() => makeAssignment("category", "frontend", "missing", profiles), /配置完整/);
});
