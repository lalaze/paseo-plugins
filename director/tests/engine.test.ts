import test from "node:test";
import assert from "node:assert/strict";
import { harness, plan, result, review, settings } from "./helpers";
import { profileForTask, validatePlan, parseOutput, canResumeRun } from "../shared/schema";
import { inspectMessages } from "../server/paseo";

test("retry recovers an existing streamed plan without another AI call", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  for (let attempt = 0; attempt < 3; attempt++) {
    const op = await h.until("plan");
    h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: '{"\nsummary":"broken"}' });
    await h.engine.tick();
  }
  assert.equal(h.run().control, "needs_attention");
  const op = h.op()!, sent = h.agents.sent.length;
  const output = inspectMessages([{ type: "user_message", text: op.prompt }, ...Array.from(JSON.stringify(plan), text => ({ type: "assistant_message" as const, messageId: "final", text }))], op.id);
  h.agents.states.set(op.agentId!, { status: "idle", ...output });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().phase, "executing"); assert.deepEqual(h.run().plan, plan);
  assert.equal(h.agents.sent.length, sent); assert.equal(h.run().operations.length, 3);
  await h.until("execute"); await h.complete(result); await h.until("review"); await h.complete(review());
  await h.until("final"); await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
});

test("recovering a valid plan still honors the user's approval setting", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  const op = await h.until("plan"), run = h.run(); run.control = "needs_attention"; h.store.save(run);
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: JSON.stringify(plan) });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().control, "paused"); assert.equal(h.run().planApproved, false);
  assert.equal(h.agents.created.length, 1);
});

test("retry replaces invalid plans from structured output and MCP without bypassing approval", async t => {
  for (const transport of ["structured", "mcp"]) await t.test(transport, async t => {
    const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
    const original = await h.until("plan");
    const invalid = { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["missing"] }] };
    if (transport === "mcp") await h.engine.submit(h.id, "director", original.id, invalid);
    await h.complete(transport === "mcp" ? {} : invalid);
    assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /不存在的前置任务/);
    await h.restart();
    await h.engine.control(h.id, "retry");
    const replacement = await h.until("plan");
    assert.notEqual(replacement.id, original.id); assert.equal(replacement.agentId, original.agentId);
    assert.match(replacement.prompt, /不存在的前置任务：missing/);
    assert.equal(h.run().operations[0].state, "abandoned"); assert.equal(h.run().plan, undefined);
    await h.complete(plan);
    assert.deepEqual(h.run().plan, plan); assert.equal(h.run().control, "paused");
    await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
    await h.engine.control(h.id, "approve_plan"); await h.until("execute");
    assert.equal(h.run().operations.filter(op => op.kind === "plan").length, 2);
  });
});

test("invalid plan retries remain bounded by the original call budget", async t => {
  const h = await harness({ maxAttempts: 3 }); t.after(() => h.cleanup());
  const invalid = { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["task-1"] }] };
  for (let attempt = 0; attempt < 3; attempt++) {
    await h.until("plan"); await h.complete(invalid);
    assert.equal(h.run().control, "needs_attention");
    if (attempt < 2) await h.engine.control(h.id, "retry");
  }
  await assert.rejects(h.engine.control(h.id, "retry"), /调用次数上限/);
  assert.equal(h.run().operations.length, 3); assert.equal(h.run().control, "needs_attention");
  assert.equal(h.run().plan, undefined);
});

test("interrupted output cannot be recovered on retry", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const op = await h.until("plan"), run = h.run(); run.control = "needs_attention"; h.store.save(run);
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, interrupted: true, output: JSON.stringify(plan) });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().plan, undefined); assert.notEqual(h.op()!.id, op.id);
});

test("workspace launches preserve ownership and prevent overlapping runs on the same checkout", async t => {
  const h = await harness(); t.after(() => h.cleanup()); h.agents.directory = h.directory;
  const input = { requestId: "workspace-request", repository: h.directory, goal: "工作区内协作", workspaceId: "workspace-1", settings: settings() };
  const [first, duplicate] = await Promise.all([h.engine.create(input), h.engine.create(input)]);
  assert.equal(first, duplicate); assert.equal(h.store.get(first).cwd, h.directory);
  assert.equal(h.store.get(first).workspaceId, "workspace-1");
  await assert.rejects(h.engine.create({ ...input, requestId: "different", workspaceId: "same-directory-workspace-2" }), /未结束/);
  await h.engine.control(first, "pause");
  await assert.rejects(h.engine.create({ ...input, requestId: "while-paused" }), /未结束/);
  await h.engine.control(first, "cancel"); await h.engine.tick();
  const next = await h.engine.create({ ...input, requestId: "after-cancel" }); assert.notEqual(next, first);
  await assert.rejects(h.engine.create({ ...input, requestId: "mismatch", repository: "/tmp" }), /不一致/);
});

test("workspace title is retained before switching branches, and a naming failure stops preparation", async t => {
  const h = await harness(); t.after(() => h.cleanup()); h.agents.directory = h.directory;
  const calls: string[] = [];
  t.mock.method(h.agents, "retainWorkspaceName", async () => { calls.push("retain-name"); });
  const prepare = h.repository.prepare.bind(h.repository);
  t.mock.method(h.repository, "prepare", async (...args: Parameters<typeof prepare>) => { calls.push("switch-branch"); return prepare(...args); });
  const input = { requestId: "name-test", repository: h.directory, goal: "测试名称", workspaceId: "original", settings: settings() };
  await h.engine.create(input);
  assert.deepEqual(calls, ["retain-name", "switch-branch"]);
  await h.engine.create(input); assert.equal(calls.length, 2);
  t.mock.method(h.agents, "retainWorkspaceName", async () => { throw new Error("无法保留名称"); });
  await h.engine.control(h.store.findRequest(input.requestId)!.id, "cancel"); await h.engine.tick();
  await assert.rejects(h.engine.create({ ...input, requestId: "naming-failure" }), /无法保留名称/);
  assert.equal(calls.length, 2);
});

test("full workflow uses selected AI, returns to original director and requires final integration review", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const director = await h.until("plan"); await h.complete(plan);
  const worker = await h.until("execute"); await h.complete(result);
  const reviewer = await h.until("review"); assert.equal(reviewer.agentId, director.agentId); await h.complete(review());
  assert.notEqual(h.run().phase, "completed");
  const final = await h.until("final"); assert.equal(final.agentId, director.agentId); await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance"); assert.equal(h.repository.verifications, 2);
  assert.notEqual(worker.agentId, director.agentId);
  assert.deepEqual(h.agents.created.map(a => a.profile.provider), ["vendor-a/model-a", "vendor-b/model-b"]);
});

test("same provider can fill both roles using separate sessions", async t => {
  const h = await harness({ workerProfileId: "lead" }); t.after(() => h.cleanup());
  const main = await h.until("plan"); await h.complete(plan); const worker = await h.until("execute");
  assert.notEqual(main.agentId, worker.agentId); assert.equal(h.agents.created[1].profile.id, "lead");
});

test("without extra commands the original director reviews, requests rework and gives final approval", async t => {
  const h = await harness({ verificationCommands: [] }); t.after(() => h.cleanup());
  const director = await h.until("plan"); await h.complete(plan);
  const worker = await h.until("execute"); await h.complete(result);
  assert.equal(h.run().phase, "reviewing");
  const firstReview = await h.until("review");
  assert.equal(firstReview.agentId, director.agentId);
  assert.match(firstReview.prompt, /用户未指定额外检查命令，验证方式由你决定/);
  assert.equal(h.run().tasks[0].evidence?.passed, false);
  assert.equal(h.run().tasks[0].evidence?.verificationStatus, "not_configured");
  await h.complete(review(false, "changes_requested"));
  assert.equal((await h.until("execute")).agentId, worker.agentId);
  await h.complete(result); await h.until("review"); await h.complete(review());
  assert.notEqual(h.run().phase, "completed");
  const final = await h.until("final"); assert.equal(final.agentId, director.agentId);
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
  assert.deepEqual(h.run().finalEvidence?.checks, []);
});

test("AI-only review still requires evidence for every original criterion", async t => {
  const h = await harness({ verificationCommands: [] }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result); await h.until("review");
  await h.complete({ ...review(), criteria: [{ criterion: "其他标准", passed: true, evidence: "查看了代码" }] });
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /审核未覆盖/);
});

test("duplicate events, restart, and duplicate create request never duplicate a sent task", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); const worker = await h.until("execute");
  const count = h.agents.sent.length;
  await Promise.all(Array.from({ length: 10 }, () => h.engine.tick()));
  await h.restart(); await h.engine.tick();
  assert.equal(h.agents.sent.length, count); assert.equal(h.op()?.id, worker.id);
  assert.equal(await h.engine.create({ requestId: "request-1", repository: "/repo", goal: "same", settings: settings() }), h.id);
  await h.complete(result); await h.until("review"); assert.equal(h.agents.created.length, 2);
});

test("rework returns precise instructions to original worker and respects limit", async t => {
  const h = await harness({ maxReworks: 1 }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); const worker = await h.until("execute"); await h.complete(result);
  await h.until("review"); await h.complete(review(false, "changes_requested"));
  const redo = await h.until("execute"); assert.equal(redo.agentId, worker.agentId); assert.match(redo.prompt, /增加空值处理/);
  await h.complete(result); await h.until("review"); await h.complete(review(false, "changes_requested"));
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /返工次数上限/);
});

test("failed automatic verification cannot be overridden by director approval", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result);
  h.repository.passed = false; await h.until("review"); await h.complete(review());
  assert.equal(h.run().control, "needs_attention"); assert.notEqual(h.run().phase, "completed");
});

test("stale artifact and incomplete criteria are rejected", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result); await h.until("review");
  h.repository.version = "artifact-v2"; await h.complete(review());
  assert.equal(h.run().control, "needs_attention"); assert.match(h.run().message, /版本/);
});

test("pause gates new work, optional plan approval cannot be bypassed", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  assert.equal(h.run().control, "paused"); await h.engine.tick(); assert.equal(h.agents.created.length, 1);
  await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
  await h.engine.control(h.id, "approve_plan"); await h.until("execute");
  await h.engine.control(h.id, "pause"); await h.complete(result); assert.equal(h.run().phase, "executing");
  await h.engine.control(h.id, "resume"); await h.engine.tick(); assert.equal(h.run().phase, "reviewing");
});

test("planning paused before a plan exists can resume, then still waits for plan approval", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.engine.control(h.id, "pause"); assert.equal(canResumeRun(h.run()), true);
  await h.engine.control(h.id, "resume");
  const original = await h.until("plan");
  await h.engine.control(h.id, "pause"); await h.complete(plan); await h.restart();
  assert.equal(h.run().plan, undefined); assert.equal(canResumeRun(h.run()), true);
  await h.engine.control(h.id, "resume"); await h.engine.tick();
  assert.deepEqual(h.run().plan, plan); assert.equal(h.run().control, "paused");
  assert.equal(canResumeRun(h.run()), false);
  await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
  assert.deepEqual(h.agents.sent.map(op => op.opId), [original.id]);
  await h.engine.control(h.id, "approve_plan"); await h.until("execute");
});

test("permission wait is not success or an automatic retry", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  h.agents.states.set(op.agentId!, { status: "permission", seen: true, output: "" }); await h.engine.tick();
  assert.equal(h.run().control, "waiting_permission"); assert.equal(h.agents.created.length, 1);
  await h.complete(plan); assert.equal(h.run().control, "running"); assert.equal(h.run().phase, "executing");
});

test("review queue reports a busy director and permissions before delivery, then resumes once", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const director = await h.until("plan"); await h.complete(plan);
  await h.until("execute"); await h.complete(result);
  await h.engine.tick(); await h.engine.tick();
  assert.equal(h.op()?.state, "ready"); assert.match(h.run().message, /准备.*审核/);
  const sent = h.agents.sent.length;
  h.agents.states.set(director.agentId!, { status: "running", seen: false, output: "" });
  await h.engine.tick(); assert.match(h.run().message, /总 AI.*上一轮.*审核指令尚未发送/);
  const events = h.run().events.length;
  await h.engine.tick(); assert.equal(h.run().events.length, events);
  h.agents.states.set(director.agentId!, { status: "permission", seen: false, output: "" });
  await h.engine.tick(); assert.equal(h.run().control, "waiting_permission");
  assert.match(h.run().message, /总 AI.*权限.*审核指令尚未发送/);
  assert.equal(h.agents.sent.length, sent);
  h.agents.states.set(director.agentId!, { status: "idle", seen: false, output: "" });
  await h.engine.tick(); assert.equal(h.run().control, "running");
  assert.match(h.run().message, /已发送.*审核.*等待总 AI/);
  await h.engine.tick(); assert.match(h.run().message, /总 AI 正在审核/);
  await h.engine.tick(); assert.equal(h.agents.sent.length, sent + 1);
  await h.complete(review()); assert.equal(h.run().tasks[0].status, "approved");
});

test("permission resolution records resumed work even when the operation was already busy", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); const op = await h.until("execute");
  await h.engine.tick();
  h.agents.states.set(op.agentId!, { status: "permission", seen: true, output: "" }); await h.engine.tick();
  h.agents.states.set(op.agentId!, { status: "running", seen: true, output: "" }); await h.engine.tick();
  assert.equal(h.run().control, "running"); assert.match(h.run().message, /权限.*已处理.*执行 AI/);
  const events = h.run().events.length;
  await h.engine.tick(); assert.equal(h.run().events.length, events);
});

test("cancel stops the agent and rejects late MCP results", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  await h.engine.control(h.id, "cancel"); await h.engine.tick();
  assert.equal(h.run().control, "canceled"); assert.deepEqual(h.agents.stopped, [op.agentId]);
  await assert.rejects(h.engine.submit(h.id, "director", op.id, plan), /已经结束/);
});

test("crash after sending recovers from timeline marker, ambiguous delivery stops", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  let run = h.run(); run.operations[0].state = "sending"; h.store.save(run); await h.restart(); await h.engine.tick();
  assert.equal(h.op()?.state, "sent"); assert.equal(h.agents.sent.length, 1);
  run = h.run(); run.operations[0].state = "sending"; h.store.save(run);
  h.agents.states.set(op.agentId!, { status: "idle", seen: false, output: "" }); await h.engine.tick();
  assert.equal(h.run().control, "needs_attention"); assert.equal(h.agents.sent.length, 1);
});

test("MCP submissions validate actor and operation and cannot finish a still running turn", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  await assert.rejects(h.engine.submit(h.id, "task-1", op.id, plan), /无权/);
  await assert.rejects(h.engine.submit(h.id, "director", "old-operation", plan), /已经结束/);
  await h.engine.submit(h.id, "director", op.id, plan); await h.engine.submit(h.id, "director", op.id, plan);
  await h.engine.tick(); assert.equal(h.run().phase, "planning");
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: "" }); await h.engine.tick();
  assert.equal(h.run().phase, "executing");
});

test("timeout first stops the AI before offering retry", async t => {
  const h = await harness({ turnTimeoutMs: 1000 }); t.after(() => h.cleanup()); const op = await h.until("plan");
  h.elapse(1001); await h.engine.tick(); assert.equal(h.run().control, "canceling");
  await h.engine.tick(); assert.equal(h.run().control, "needs_attention"); assert.deepEqual(h.agents.stopped, [op.agentId]);
});

test("manual steering invalidates automatic consumption of the old turn", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: JSON.stringify(plan), interrupted: true });
  await h.engine.tick(); assert.equal(h.run().control, "needs_attention");
});

test("routing uses user task override, category override, then allowed selection", () => {
  const s = settings(), task = { ...plan.tasks[0], executorId: "lead" };
  assert.equal(profileForTask(s, task), "worker");
  s.allowDirectorSelection = true; assert.equal(profileForTask(s, task), "lead");
  s.categoryOverrides.backend = "worker"; assert.equal(profileForTask(s, task), "worker");
  s.taskOverrides[task.id] = "lead"; assert.equal(profileForTask(s, task), "lead");
});

test("invalid graphs and fabricated provider IDs cannot dispatch", () => {
  const s = settings();
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["task-1"] }] }, s), /循环/);
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["missing"] }] }, s), /不存在/);
  s.allowDirectorSelection = true;
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], executorId: "unknown" }] }, s), /未知 AI/);
  assert.deepEqual(parseOutput("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.deepEqual(parseOutput("正在核对代码。\n{\"summary\":\"包含 } 和 \\\" 字符\",\"nested\":{\"ok\":true}}"), { summary: '包含 } 和 " 字符', nested: { ok: true } });
  assert.throws(() => parseOutput("all done"));
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], id: "director" }] }, s), /保留/);
});

test("paused in-flight MCP submission is saved without advancing", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  await h.engine.control(h.id, "pause"); await h.engine.submit(h.id, "director", op.id, plan);
  await h.engine.tick(); assert.equal(h.run().phase, "planning");
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: "" });
  await h.engine.control(h.id, "resume"); await h.engine.tick(); assert.equal(h.run().phase, "executing");
});

test("new requirements stop the old turn and invalidate its late results", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await h.until("plan"); await h.complete(plan);
  const worker = await h.until("execute"); await h.engine.control(h.id, "pause");
  await h.engine.control(h.id, "revise", "增加新功能和错误处理");
  assert.equal(h.run().phase, "planning"); assert.equal(h.run().planVersion, 2); assert.equal(h.run().tasks.length, 0);
  assert.ok(h.agents.stopped.includes(worker.agentId!));
  await assert.rejects(h.engine.submit(h.id, "task-1", worker.id, result), /已经结束/);
  const updated = await h.until("plan"); assert.match(updated.prompt, /增加新功能/);
});

test("cancel reconciles a child created just before a checkpoint crash", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await h.until("plan");
  const run = h.run(); const op = run.operations[0]; op.state = "creating"; op.agentId = undefined; h.store.save(run);
  await h.engine.control(h.id, "cancel"); await h.engine.tick();
  assert.equal(h.run().control, "canceled"); assert.deepEqual(h.agents.stopped, [h.agents.created[0].id]);
});

test("final review rework invalidates accepted dependent tasks", async t => {
  const h = await harness(); t.after(() => h.cleanup()); await h.until("plan");
  const second = { ...plan.tasks[0], id: "task-2", title: "依赖任务", dependsOn: ["task-1"] };
  await h.complete({ ...plan, tasks: [...plan.tasks, second] });
  for (let i = 0; i < 2; i++) { await h.until("execute"); await h.complete(result); await h.until("review"); await h.complete(review()); }
  await h.until("final"); await h.complete(review(true, "changes_requested"));
  assert.deepEqual(h.run().tasks.map(task => task.status), ["pending", "pending"]);
  assert.equal(h.run().tasks[0].reworks, 1); assert.equal(h.run().tasks[1].review, undefined);
});
