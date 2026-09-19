import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { finalAcceptance, ReviewSchema, summarize, type Plan, type Operation } from "../shared/schema";
import { buildPrompt } from "../server/prompts";
import { readDirectorPrompt } from "../client/prompt-model";
import { harness, plan, result, review, reviewerSettings } from "./helpers";

const multiPlan: Plan = { ...plan, tasks: [
  { ...plan.tasks[0], id: "dependent", dependsOn: ["task-1"], acceptance: ["调用方兼容"] },
  plan.tasks[0],
  { ...plan.tasks[0], id: "independent", acceptance: ["独立功能可用"] },
] };
const approved = (artifactId = "artifact-v1") => ({ ...review(true), artifactId, criteria: finalAcceptance(multiPlan).map(criterion => ({ criterion, passed: true, evidence: "检查实际代码并完成集成测试" })) });

test("all tasks execute serially in dependency order before one verification and one review", async t => {
  const h = await harness({ ...reviewerSettings(), maxAttempts: 5 }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(multiPlan);
  await h.engine.dispatch(h.id, "dependent"); // Requested priority cannot bypass a dependency.
  for (const [index, taskId] of ["task-1", "dependent", "independent"].entries()) {
    const op = await h.until("execute"); assert.equal(op.taskId, taskId);
    const count = h.agents.sent.length;
    await Promise.all([h.engine.tick(), h.engine.tick()]);
    assert.equal(h.agents.sent.length, count, "no other task starts while this worker is running");
    await h.complete(result);
    assert.equal(h.run().tasks.find(task => task.spec.id === taskId)?.status, "executed");
    assert.equal(h.run().finalReview, undefined);
    assert.equal(summarize(h.run()).done, index + 1);
    assert.equal(h.repository.verifications, 0);
    assert.equal(h.run().operations.some(op => ["review", "final"].includes(op.kind)), false);
    if (index === 0) await h.restart();
  }
  const final = await h.until("final");
  assert.equal(final.profileId, "audit"); assert.equal(final.reviewScope, "all_tasks");
  assert.equal(h.repository.verifications, 1);
  assert.deepEqual(readDirectorPrompt(final.prompt)?.acceptance, finalAcceptance(multiPlan));
  assert.match(final.prompt, /不要求此前存在逐任务审核记录/);
  await h.restart(); await h.engine.tick(); assert.equal(h.repository.verifications, 1);
  await h.complete(approved());
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(h.run().userAcceptance, undefined);
  assert.deepEqual(h.run().tasks.map(task => task.status), ["approved", "approved", "approved"]);
  assert.deepEqual(h.run().operations.map(op => op.kind), ["plan", "execute", "execute", "execute", "final"]);
  const ready = h.run();
  await h.engine.control(h.id, "accept_final", undefined, { artifactId: ready.finalEvidence!.id, expectedRevision: ready.revision });
  assert.equal(h.run().phase, "completed");
});

test("unified rework reruns affected tasks and dependents, preserves independent work, then reviews a fresh artifact", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(multiPlan);
  for (let i = 0; i < 3; i++) { await h.until("execute"); await h.complete(result); }
  const original = h.run();
  await h.until("final"); await h.complete(review(true, "changes_requested"));
  assert.deepEqual(h.run().tasks.map(task => task.status), ["pending", "pending", "executed"]);
  assert.equal(h.run().finalEvidence, undefined);
  await h.restart();
  for (const id of ["task-1", "dependent"]) {
    const op = await h.until("execute"); assert.equal(op.taskId, id);
    assert.equal(op.agentId, original.tasks.find(task => task.spec.id === id)?.agentId);
    await h.complete(result);
  }
  assert.equal(h.run().operations.filter(op => op.kind === "execute" && op.taskId === "independent").length, 1);
  h.repository.version = "artifact-v2";
  await h.until("final"); await h.complete(approved("artifact-v2"));
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(h.repository.verifications, 2);
  assert.equal(h.run().operations.filter(op => op.kind === "final").length, 2);
  assert.equal(h.run().operations.some(op => op.kind === "review"), false);
});

test("a unified approval cannot omit an individual task's acceptance criteria", async t => {
  const h = await harness({ verificationCommands: [] }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(multiPlan);
  for (let i = 0; i < 3; i++) { await h.until("execute"); await h.complete(result); }
  await h.until("final");
  await h.complete({ ...approved(), criteria: approved().criteria.filter(item => item.criterion !== "调用方兼容") });
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /审核未覆盖/);
  assert.ok(h.run().tasks.every(task => task.status === "executed"));
  await h.engine.control(h.id, "retry"); await h.until("final"); await h.complete(approved());
  assert.equal(h.run().phase, "awaiting_acceptance");
});

test("a blocked worker pauses execution without dispatching a dependent or a review", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(multiPlan);
  const worker = await h.until("execute");
  await h.complete({ ...result, status: "blocked", summary: "缺少必要接口" });
  await h.restart(); await h.engine.tick();
  assert.equal(h.run().control, "needs_attention"); assert.equal(h.op()?.id, worker.id);
  assert.equal(h.run().operations.length, 2); assert.equal(h.repository.verifications, 0);
  assert.equal(summarize(h.run()).done, 0);
});

for (const state of [undefined, "pending", "ready", "creating", "sending", "sent"] as const) test(`legacy task review ${state ?? "not queued"} transitions to unified review without duplicate work`, async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete({ ...plan, tasks: [plan.tasks[0], { ...plan.tasks[0], id: "task-2", dependsOn: ["task-1"] }] });
  await h.until("execute"); await h.complete(result);
  const run = h.run(), task = run.tasks[0];
  run.phase = "reviewing"; task.status = "reviewing";
  task.evidence = { ...await h.repository.capture(), checks: [], passed: true };
  let legacy: Operation | undefined;
  if (state) {
    const id = randomUUID();
    legacy = { id, kind: "review", taskId: "task-1", state, profileId: "lead", agentId: state === "creating" ? undefined : run.directorAgentId, createdAt: Date.now(), sentAt: Date.now(), formatRetries: 0, prompt: buildPrompt(run, "review", id, "task-1") };
    run.operations.push(legacy); run.activeOperationId = id;
    if (state === "creating") h.agents.created.push({ id: run.directorAgentId!, runId: run.id, opId: id, profile: run.settings.profiles[0] });
    if (state === "sent" || state === "sending") h.agents.states.set(run.directorAgentId!, { status: "running", seen: true, output: "" });
  }
  h.store.save(run); await h.restart();
  const inFlight = state === "sent" || state === "sending";
  if (inFlight) {
    await h.engine.tick(); assert.equal(h.op()?.id, legacy!.id);
    assert.equal(h.run().phase, "reviewing"); assert.equal(h.agents.stopped.length, 0);
    await h.complete(review());
  }
  const next = await h.until("execute"); assert.equal(next.taskId, "task-2");
  if (legacy) assert.equal(h.run().operations.find(op => op.id === legacy!.id)?.state, inFlight ? "done" : "abandoned");
  await h.complete(result); await h.until("final"); await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(h.run().operations.filter(op => op.kind === "execute").length, 2);
  assert.equal(h.repository.verifications, 1);
});

test("an already sent legacy final review retains its original criteria contract", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result); await h.until("final");
  const run = h.run(); run.operations.at(-1)!.reviewScope = undefined; run.tasks[0].status = "approved";
  h.store.save(run); await h.restart();
  await h.complete({ ...review(true), criteria: review(true).criteria.slice(0, 1) });
  assert.equal(h.run().phase, "awaiting_acceptance");
});

test("review schema accommodates the complete supported plan and task acceptance list", () => {
  const large: Plan = { ...plan, acceptance: Array.from({ length: 30 }, (_, i) => `overall-${i}`), tasks: Array.from({ length: 30 }, (_, i) => ({ ...plan.tasks[0], id: `task-${i}`, acceptance: Array.from({ length: 30 }, (_, j) => `${i}-${j}`) })) };
  const criteria = finalAcceptance(large).map(criterion => ({ criterion, passed: true, evidence: "实际验证依据" }));
  assert.equal(criteria.length, 930);
  assert.equal(ReviewSchema.safeParse({ ...review(true), criteria }).success, true);
});
