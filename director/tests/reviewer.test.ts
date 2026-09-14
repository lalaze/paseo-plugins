import test from "node:test";
import assert from "node:assert/strict";
import { REVIEWER_ACTOR, SettingsSchema, type Run, type Operation, type Profile } from "../shared/schema";
import { readDirectorPrompt } from "../client/prompt-model";
import { harness, plan, result, review, reviewerSettings, settings } from "./helpers";

const context = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2, prompt.indexOf("\n\n本轮 operationId=")));

test("selected reviewer owns unified review and rework; user feedback returns to the original designer", async t => {
  const h = await harness({ ...reviewerSettings(), requirePlanApproval: true }); t.after(() => h.cleanup());
  const designer = await h.until("plan");
  const card = readDirectorPrompt(designer.prompt)!;
  assert.equal(card.actor, "设计 AI"); assert.equal(card.team.length, 3); assert.equal(card.team[2].name, "审核 AI · vendor-c/model-c");
  await h.complete(plan); await h.engine.control(h.id, "approve_plan");
  const worker = await h.until("execute"); await h.complete(result);
  const auditor = await h.until("final");
  assert.equal(auditor.profileId, "audit"); assert.notEqual(auditor.agentId, designer.agentId); assert.notEqual(auditor.agentId, worker.agentId);
  const evidence = context(auditor.prompt);
  assert.deepEqual(evidence.plan, plan); assert.deepEqual(evidence.taskResults[0].result, result); assert.equal(evidence.evidence.id, "artifact-v1");
  assert.ok(evidence.workflowEvidence.planApproval.userApprovedAt);
  assert.deepEqual(evidence.reviewer, { profileId: "audit", separateSession: true });
  assert.match(auditor.prompt, /只审核，不修改源代码/); assert.equal(readDirectorPrompt(auditor.prompt)!.actor, "审核 AI");
  assert.deepEqual(h.agents.created[2].profile, reviewerSettings().profiles[2]);
  await assert.rejects(h.engine.submit(h.id, "director", auditor.id, review(true)), /角色无权/);
  await assert.rejects(h.engine.submit(h.id, plan.tasks[0].id, auditor.id, review(true)), /角色无权/);
  await h.complete(review(true, "changes_requested")); await h.restart();
  const redo = await h.until("execute"); assert.equal(redo.agentId, worker.agentId); assert.match(redo.prompt, /增加空值处理/);
  await h.complete(result);
  const final = await h.until("final"); assert.equal(final.agentId, auditor.agentId);
  assert.equal(readDirectorPrompt(final.prompt)!.actor, "审核 AI");
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance"); assert.equal(h.run().userAcceptance, undefined);
  const completed = h.run();
  await h.engine.control(h.id, "request_changes", undefined, { feedback: "补充一个重试入口", artifactId: completed.finalEvidence!.id, expectedRevision: completed.revision });
  const revised = await h.until("plan"); assert.equal(revised.agentId, designer.agentId);
  assert.deepEqual(context(revised.prompt).previousFinalReview, completed.finalReview);
  await assert.rejects(h.engine.submit(h.id, REVIEWER_ACTOR, revised.id, plan), /角色无权/);
  await h.complete(plan); await h.engine.control(h.id, "approve_plan");
  assert.equal((await h.until("execute")).agentId, worker.agentId); await h.complete(result);
  assert.equal((await h.until("final")).agentId, auditor.agentId); await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance"); assert.equal(h.agents.created.length, 3);
});

test("explicitly choosing the same model still separates designer, worker and reviewer sessions", async t => {
  const h = await harness({ workerProfileId: "lead", reviewerProfileId: "lead" }); t.after(() => h.cleanup());
  const design = await h.until("plan"); await h.complete(plan);
  const worker = await h.until("execute"); await h.complete(result);
  const auditor = await h.until("final"); await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(new Set([design.agentId, worker.agentId, auditor.agentId]).size, 3);
  assert.deepEqual(h.agents.created.map(a => a.profile.id), ["lead", "lead", "lead"]);
});

test("old settings use the original director even if saved defaults change during the run", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  assert.equal(h.run().settings.reviewerProfileId, undefined);
  const design = await h.until("plan"); h.store.saveSettings(reviewerSettings()); await h.complete(plan);
  await h.until("execute"); await h.complete(result); await h.restart();
  assert.equal((await h.until("final")).agentId, design.agentId); await h.complete(review(true));
  assert.equal(h.run().reviewerAgentId, undefined); assert.equal(h.agents.created.length, 2);
});

test("reviewer permissions and missing-session recovery never fall back to the designer", async t => {
  const h = await harness(reviewerSettings()); t.after(() => h.cleanup());
  const designer = await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result);
  const auditor = await h.until("final"), sent = h.agents.sent.length;
  h.agents.states.set(auditor.agentId!, { status: "permission", seen: true, output: "" }); await h.engine.tick();
  assert.equal(h.run().control, "waiting_permission"); assert.match(h.run().message, /审核 AI等待权限/);
  await h.restart(); await h.engine.tick(); assert.equal(h.agents.sent.length, sent);
  h.agents.states.delete(auditor.agentId!); await h.engine.tick(); assert.equal(h.run().control, "needs_attention");
  await h.engine.control(h.id, "retry");
  const replacement = await h.until("final"); assert.equal(replacement.profileId, "audit");
  assert.notEqual(replacement.agentId, auditor.agentId); assert.notEqual(replacement.agentId, designer.agentId);
  assert.equal(h.run().directorAgentId, designer.agentId); assert.equal(h.run().reviewerAgentId, replacement.agentId);
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
});

test("a stale artifact cannot be approved by the separate reviewer", async t => {
  const h = await harness(reviewerSettings()); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result);
  await h.until("final"); h.repository.version = "artifact-v2"; await h.complete(review(true));
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /版本/);
  assert.equal(h.run().tasks[0].status, "executed");
});

test("unavailable reviewer pauses instead of assigning another model", async t => {
  const h = await harness(reviewerSettings()); t.after(() => h.cleanup());
  const designer = await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result);
  const create = h.agents.create.bind(h.agents);
  t.mock.method(h.agents, "create", async (run: Run, op: Operation, profile: Profile) => {
    if (profile.id === "audit") throw new Error("指定的审核 AI 不可用");
    return create(run, op, profile);
  });
  for (let i = 0; i < 5; i++) await h.engine.tick();
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /审核 AI 不可用/);
  assert.equal(h.run().directorAgentId, designer.agentId); assert.equal(h.run().reviewerAgentId, undefined);
  assert.equal(h.agents.created.length, 2); assert.equal(h.agents.sent.length, 2);
});

test("reviewer settings round-trip with advanced options and reject unknown profiles", () => {
  assert.deepEqual(SettingsSchema.parse(JSON.parse(JSON.stringify(reviewerSettings()))), reviewerSettings());
  assert.equal(SettingsSchema.parse(settings()).reviewerProfileId, undefined);
  assert.throws(() => SettingsSchema.parse({ ...settings(), reviewerProfileId: "missing" }), /不存在的 AI 配置/);
});
