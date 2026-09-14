import test from "node:test";
import assert from "node:assert/strict";
import { harness, plan, result, review } from "./helpers";
import { workflowEvidence } from "../server/workflow-evidence";

test("approval, delivery and accepted review times survive restart and event truncation", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  assert.equal(workflowEvidence(h.run()).planApproval.userApprovedAt, null);
  h.elapse(1000); await h.engine.control(h.id, "approve_plan");
  h.elapse(1000); const worker = await h.until("execute");
  h.elapse(1000); await h.complete(result); await h.until("final");
  h.elapse(1000); await h.complete(review(true));
  const r = h.run(); r.events = []; h.store.save(r); await h.restart();
  const evidence = workflowEvidence(h.run());
  assert.equal(evidence.planApproval.timestampSource, "checkpoint");
  const execution = evidence.operations.find(op => op.operationId === worker.id)!;
  assert.ok(evidence.planApproval.userApprovedAt! < execution.sendRequestedAt!);
  assert.ok(execution.deliveryConfirmedAt! >= execution.sendRequestedAt!);
  assert.ok(execution.resultAcceptedAt! > execution.deliveryConfirmedAt!);
  const approved = evidence.operations.find(op => op.kind === "final")!;
  assert.equal(approved.reviewDecision, "approved");
  assert.equal(approved.artifactId, "artifact-v1");
  assert.ok(approved.resultAcceptedAt! > execution.resultAcceptedAt!);
});

test("legacy approval uses actual events and absent historical times stay unknown", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  h.elapse(1000); await h.engine.control(h.id, "approve_plan");
  h.elapse(1000); await h.until("execute");
  const r = h.run(), approval = r.events.find(e => e.message === "总纲已批准")!;
  r.planApprovedAt = undefined;
  for (const op of r.operations) { op.completedAt = undefined; op.deliveryConfirmedAt = undefined; }
  const evidence = workflowEvidence(r);
  assert.equal(evidence.planApproval.userApprovedAt, new Date(approval.time).toISOString());
  assert.equal(evidence.planApproval.timestampSource, "legacy_event");
  assert.equal(evidence.operations.find(op => op.kind === "execute")!.deliveryConfirmedAt, null);
  r.events = [];
  assert.equal(workflowEvidence(r).planApproval.userApprovedAt, null);
  assert.equal(workflowEvidence(r).planApproval.timestampSource, "unavailable");
});

test("revised plans cannot reuse the old plan's manual approval evidence", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.engine.control(h.id, "approve_plan");
  await h.engine.control(h.id, "pause"); h.elapse(1000);
  await h.engine.control(h.id, "revise", "修改目标");
  assert.equal(h.run().planApprovedAt, undefined);
  h.elapse(1000); await h.until("plan"); await h.complete(plan);
  const evidence = workflowEvidence(h.run());
  assert.equal(evidence.planApproval.approved, false);
  assert.equal(evidence.planApproval.userApprovedAt, null);
  assert.equal(evidence.events.some(e => e.message === "总纲已批准"), false);
});

test("blocked final review receives workflow evidence on retry without rerunning workers", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  const director = await h.until("plan"); await h.complete(plan);
  await h.engine.control(h.id, "approve_plan");
  await h.until("execute"); await h.complete(result);
  await h.until("final"); await h.complete({ ...review(true, "blocked"), summary: "缺少流程记录" });
  assert.equal(h.run().control, "needs_attention");
  const executions = h.agents.sent.filter(sent => sent.prompt.includes("你是执行 AI。"));
  await h.engine.control(h.id, "retry");
  const final = await h.until("final");
  assert.equal(final.agentId, director.agentId);
  const context = JSON.parse(final.prompt.slice(final.prompt.indexOf("\n\n{") + 2, final.prompt.indexOf("\n\n本轮 operationId=")));
  assert.equal(context.previousReview.summary, "缺少流程记录");
  assert.equal(context.workflowEvidence.planApproval.approved, true);
  assert.ok(context.workflowEvidence.planApproval.userApprovedAt);
  assert.equal(context.workflowEvidence.operations.some((op: { prompt?: string; response?: unknown }) => op.prompt || op.response), false);
  assert.deepEqual(h.agents.sent.filter(sent => sent.prompt.includes("你是执行 AI。")), executions);
  assert.equal(h.agents.created.length, 2);
  assert.equal(h.run().tasks[0].status, "executed");
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
});
