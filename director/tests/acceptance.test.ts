import test from "node:test";
import assert from "node:assert/strict";
import { awaitingAcceptance, summarize, type Run } from "../shared/schema";
import { workflowEvidence } from "../server/workflow-evidence";
import { readDirectorPrompt } from "../client/prompt-model";
import { harness, plan, result, review } from "./helpers";

type Harness = Awaited<ReturnType<typeof harness>>;
const input = (run: Run) => ({ artifactId: run.finalEvidence!.id, expectedRevision: run.revision });
const context = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2, prompt.indexOf("\n\n本轮 operationId=")));
async function finishRound(h: Harness) {
  await h.until("plan"); await h.complete(plan);
  if (!h.run().planApproved) await h.engine.control(h.id, "approve_plan");
  await h.until("execute"); await h.complete(result);
  await h.until("final"); await h.complete(review(true));
}

test("AI final approval waits durably for the user, never resumes itself or consumes the waiting budget", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  const before = h.run(), sent = h.agents.sent.length;
  assert.equal(before.phase, "awaiting_acceptance"); assert.equal(before.control, "paused");
  assert.equal(before.userAcceptance, undefined); assert.equal(before.activeOperationId, undefined);
  assert.equal(before.operations.at(-1)!.state, "done");
  await h.restart(); h.elapse(before.settings.runTimeoutMs * 2);
  for (let i = 0; i < 3; i++) await h.engine.tick();
  assert.equal(h.run().revision, before.revision); assert.equal(h.agents.sent.length, sent);
  for (const action of ["resume", "retry", "approve_plan", "revise"] as const) await assert.rejects(h.engine.control(h.id, action, "变更目标"), /验收成果或提交修改意见/);
  await h.engine.control(h.id, "accept_final", undefined, input(h.run()));
  assert.equal(h.run().phase, "completed"); assert.equal(h.run().userAcceptance!.decision, "approved");
  assert.equal(h.run().userAcceptance!.artifactId, before.finalEvidence!.id);
  await h.restart(); await h.engine.tick(); assert.equal(h.agents.sent.length, sent);
});

test("user feedback preserves goal, evidence and team, gates the revised plan, and requires another final acceptance", async t => {
  const h = await harness({ requirePlanApproval: true, maxAttempts: 3 }); t.after(() => h.cleanup()); await finishRound(h);
  const original = h.run(), worker = original.tasks[0].agentId;
  h.elapse(original.settings.runTimeoutMs * 2);
  const request = { ...input(original), feedback: "空输入要说明原因，并提供重试入口" };
  await h.engine.control(h.id, "request_changes", undefined, request);
  assert.equal(h.run().goal, original.goal); assert.equal(h.run().cwd, original.cwd); assert.equal(h.run().branch, original.branch);
  assert.equal(h.run().roundOperationOffset, original.operations.length);
  assert.equal(h.run().finalReview, undefined); assert.equal(h.run().userAcceptance, undefined);
  assert.equal(h.run().changeRequests![0].artifactId, original.finalEvidence!.id);
  assert.deepEqual(h.run().changeRequests![0].previousReview, original.finalReview);
  await assert.rejects(h.engine.control(h.id, "request_changes", undefined, request), /没有可验收/);
  await h.restart();
  const planning = await h.until("plan"), draft = context(planning.prompt);
  assert.equal(planning.agentId, original.directorAgentId);
  assert.deepEqual(draft.previousPlan, original.plan); assert.equal(draft.previousTaskResults[0].agentId, worker);
  assert.equal(draft.userChangeRequests[0].feedback, request.feedback);
  assert.match(planning.prompt, /只设计和提交计划，具体修改交给执行 AI/);
  assert.equal(readDirectorPrompt(planning.prompt)!.stage, "plan");
  assert.deepEqual(readDirectorPrompt(planning.prompt)!.changes, [request.feedback]);
  await h.complete(plan); assert.equal(h.run().control, "paused"); assert.equal(h.run().planApprovedAt, undefined);
  assert.equal(workflowEvidence(h.run()).planApproval.userApprovedAt, null);
  await h.engine.tick(); assert.equal(h.agents.sent.length, original.operations.length + 1);
  await h.engine.control(h.id, "approve_plan");
  const execution = await h.until("execute"); assert.equal(execution.agentId, worker);
  assert.equal(context(execution.prompt).userChangeRequests[0].feedback, request.feedback);
  await h.complete(result); const final = await h.until("final"); assert.equal(final.agentId, original.directorAgentId);
  assert.match(final.prompt, /不替用户确认完成/);
  assert.equal(context(final.prompt).userChangeRequests[0].feedback, request.feedback);
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(h.agents.created.length, 2); assert.equal(h.run().operations.length, 6);
  // Same artifact in a newer round is still a different acceptance decision.
  await assert.rejects(h.engine.control(h.id, "accept_final", undefined, input(original)), /版本已变化/);
  await h.engine.control(h.id, "accept_final", undefined, input(h.run())); assert.equal(h.run().phase, "completed");
});

test("legacy AI-completed tasks allow acceptance or changes without recreating the workspace", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  const old = h.run(); old.phase = "completed"; old.control = "running"; h.store.save(old); await h.restart();
  assert.equal(awaitingAcceptance(h.run()), true); assert.equal(summarize(h.run()).phase, "awaiting_acceptance");
  const original = h.run();
  await h.engine.control(h.id, "accept_final", undefined, input(original));
  assert.equal(awaitingAcceptance(h.run()), false);
  await h.engine.control(h.id, "request_changes", undefined, { ...input(h.run()), feedback: "再增加一个示例" });
  assert.equal(h.run().changeRequests![0].previousAcceptance!.decision, "approved");
  assert.equal((await h.until("plan")).agentId, original.directorAgentId);
});

test("user can reject a final result without restarting agents or removing files", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  const old = h.run(), sent = h.agents.sent.length;
  t.mock.method(h.repository, "capture", async () => { throw new Error("不应读取或修改仓库"); });
  await h.engine.control(h.id, "reject_final", undefined, input(old)); await h.restart(); await h.engine.tick();
  assert.equal(h.run().control, "canceled"); assert.equal(h.run().userAcceptance!.decision, "rejected");
  assert.deepEqual(h.run().finalEvidence, old.finalEvidence); assert.equal(h.run().cwd, old.cwd);
  assert.equal(h.agents.sent.length, sent); assert.equal(h.agents.stopped.length, 0);
  await assert.rejects(h.engine.control(h.id, "accept_final", undefined, input(h.run())), /没有可验收/);
});

test("final controls reject absent/stale evidence, empty feedback and acceptance of changed code", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await assert.rejects(h.engine.control(h.id, "accept_final"), /没有可验收/);
  await finishRound(h); const before = h.run();
  await assert.rejects(h.engine.control(h.id, "accept_final"), /版本已变化/);
  await assert.rejects(h.engine.control(h.id, "accept_final", undefined, { ...input(before), artifactId: "old" }), /版本已变化/);
  await assert.rejects(h.engine.control(h.id, "request_changes", undefined, { ...input(before), feedback: "   " }), /填写修改意见/);
  h.repository.version = "artifact-v2";
  await assert.rejects(h.engine.control(h.id, "accept_final", undefined, input(before)), /代码已在最终审核后发生变化/);
  assert.equal(h.run().revision, before.revision); assert.equal(h.run().userAcceptance, undefined);
  t.mock.method(h.repository, "assertBranch", async () => { throw new Error("请切回成果分支"); });
  await assert.rejects(h.engine.control(h.id, "request_changes", undefined, { ...input(before), feedback: "修改说明" }), /切回成果分支/);
  assert.equal(h.run().revision, before.revision);
});

test("blocked final reviews cannot be approved by the user as a shortcut", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result);
  await h.until("final"); await h.complete(review(true, "blocked"));
  assert.equal(h.run().control, "needs_attention");
  await assert.rejects(h.engine.control(h.id, "accept_final", undefined, input(h.run())), /没有可验收/);
});

test("duplicate user acceptance is applied once", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  const decision = input(h.run());
  const results = await Promise.allSettled([1, 2].map(() => h.engine.control(h.id, "accept_final", undefined, decision)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.run().events.filter(e => e.message.startsWith("你已验收通过")).length, 1);
});

test("reopening a finished result cannot overlap another task in its directory", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  const old = h.run(); old.phase = "completed"; old.control = "running"; h.store.save(old);
  h.store.insert({ ...old, id: "other", requestId: "other", phase: "executing", activeOperationId: undefined });
  await assert.rejects(h.engine.control(h.id, "request_changes", undefined, { ...input(h.run()), feedback: "修改说明" }), /其他未结束/);
  assert.equal(h.run().phase, "completed"); assert.equal(h.run().changeRequests, undefined);
});

test("pending final acceptance restores in its workspace and holds the checkout until the user decides", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await finishRound(h);
  h.agents.directory = h.directory;
  const run = { ...h.run(), workspaceId: "workspace", cwd: h.directory }; h.store.save(run);
  await h.restart();
  assert.equal(h.store.pending().length, 0);
  const next = { requestId: "next", workspaceId: "workspace", repository: h.directory, goal: "另一个目标", settings: run.settings };
  await assert.rejects(h.engine.create(next), /已有未结束/);
  await h.engine.control(h.id, "reject_final", undefined, input(h.run()));
  const nextId = await h.engine.create(next);
  assert.notEqual(nextId, h.id);
});
