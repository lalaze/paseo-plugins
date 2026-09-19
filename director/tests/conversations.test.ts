import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { Conversations, validateChatApproval, type ConversationGateway } from "../server/conversations";
import { Store } from "../server/store";
import { Engine } from "../server/engine";
import type { Conversation } from "../shared/conversation";
import { FakeAgents, FakeRepository, settings, plan, result, review, harness } from "./helpers";

class ChatAgents extends FakeAgents implements ConversationGateway {
  histories = new Map<string, AgentTimelineItem[]>();
  mains = new Map<string, string>();
  links: { agent: string; conversation: string }[] = [];
  failCreate = false;
  override async workspaceDirectory() { return this.directory; }
  async workspaceForDirectory() { return "workspace"; }
  async takeoverProfile(agentId: string, workspaceId: string) {
    if (workspaceId !== "workspace" || !this.histories.has(agentId)) throw new Error("当前对话不属于此工作区");
    return { provider: "current/model", modeId: "auto-review", thinkingOptionId: "high" };
  }
  async adoptConversation(c: Conversation) { await this.takeoverProfile(c.agentId!, c.workspaceId); return "bridge instructions"; }
  async createConversation(c: Conversation) {
    if (this.failCreate) throw new Error("MCP 接入不可用");
    const id = `main-${c.id}-${c.generation ?? 0}`; this.mains.set(`${c.id}:${c.generation ?? 0}`, id); this.histories.set(id, []);
    this.states.set(id, { status: "idle", seen: false, output: "" }); return id;
  }
  async findConversation(id: string, generation = 0) { const key = `${id}:${generation}`; return this.mains.has(key) ? [this.mains.get(key)!] : []; }
  async conversationHistory(id: string) { return this.histories.get(id) ?? []; }
  async appendConversationLink(agent: string, conversation: string) { if (!this.links.some(l => l.agent === agent && l.conversation === conversation)) this.links.push({ agent, conversation }); }
  override async inspect(agentId: string, id?: string) {
    const state = await super.inspect(agentId);
    return this.histories.has(agentId) ? { ...state, seen: this.histories.get(agentId)!.some(i => i.type === "user_message" && i.clientMessageId === id) } : state;
  }
  override async send(agent: string, id: string, prompt: string) {
    await super.send(agent, id, prompt);
    if (this.histories.has(agent)) this.histories.get(agent)!.push({ type: "user_message", text: prompt, clientMessageId: id });
  }
  user(agent: string, id: string, text: string) { this.histories.get(agent)!.push({ type: "user_message", text, messageId: id }); }
  idle(agent: string) { this.states.set(agent, { status: "idle", seen: true, output: "普通自然语言回复" }); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "director-chat-"));
  const store = new Store(join(dir, "db")), gateway = new ChatAgents(), repo = new FakeRepository();
  gateway.directory = dir; store.saveSettings(settings());
  const engine = new Engine(store, gateway, repo), chats = new Conversations(store, engine, gateway);
  t.after(async () => { await chats.close(); await engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, gateway, repo, engine, chats };
}

test("blank native conversations don't prepare a branch; duplicate creation is idempotent", async t => {
  const h = await fixture(t);
  const first = await h.chats.open({ requestId: "new", workspaceId: "workspace", fresh: true });
  assert.ok(first.agentId); assert.equal(h.store.all().length, 0); assert.equal(h.gateway.sent.length, 0);
  const again = await h.chats.open({ requestId: "new", workspaceId: "workspace", fresh: true });
  assert.equal(again.agentId, first.agentId); assert.equal(h.gateway.mains.size, 1);
  assert.equal((await h.chats.open({ requestId: "open", workspaceId: "workspace" })).id, first.id);
});

test("only the latest real user message can start a task, with retries creating one run", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "new", workspaceId: "workspace", goal: "实现功能" });
  const status = await h.chats.status(c.id); assert.equal(status.latestUserMessage?.text, "实现功能");
  await assert.rejects(h.chats.start(c.id, { goal: "实现功能", sourceMessageId: "invented" }), /真实用户/);
  const a = await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: status.latestUserMessage!.id });
  const b = await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: status.latestUserMessage!.id });
  assert.deepEqual(a, b); assert.equal(h.store.all().length, 1);
  assert.equal(h.store.all()[0].chat?.mainAgentId, c.agentId);
});

test("native chat plan, child execution, review and explicit acceptance form a complete workflow", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "flow", workspaceId: "workspace", goal: "实现功能" });
  const initial = await h.chats.status(c.id);
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: initial.latestUserMessage!.id });
  h.gateway.idle(c.agentId!);
  async function until(kind: "plan" | "execute" | "final") {
    for (let i = 0; i < 30; i++) {
      await h.engine.tick();
      const run = h.chats.summary(c.id).run!, op = run.operations.find(o => o.id === run.activeOperationId);
      if (op?.kind === kind && op.state === "sent") return op;
    }
    throw new Error(JSON.stringify(h.chats.summary(c.id)));
  }
  const design = await until("plan");
  // Ordinary conversation while waiting for a structured tool submission is fine.
  h.gateway.user(c.agentId!, "question", "进度怎么样？"); h.gateway.idle(c.agentId!);
  await h.engine.tick(); assert.equal(h.chats.summary(c.id).run?.control, "running");
  await h.chats.submit(c.id, design.id, plan); await h.engine.tick();
  const worker = await until("execute");
  h.gateway.user(c.agentId!, "question2", "先解释一下这个方案");
  await h.chats.status(c.id); await h.engine.tick();
  assert.equal(h.chats.summary(c.id).run?.activeOperationId, worker.id);
  await assert.rejects(h.chats.submit(c.id, worker.id, result), /无权/);
  h.gateway.states.set(worker.agentId!, { status: "idle", seen: true, output: JSON.stringify(result) });
  await h.engine.tick(); const audit = await until("final");
  await h.chats.submit(c.id, audit.id, review(true)); h.gateway.idle(c.agentId!); await h.engine.tick();
  assert.equal(h.chats.summary(c.id).run?.phase, "awaiting_acceptance");
  await h.chats.tick(); h.gateway.idle(c.agentId!);
  const pending = h.chats.summary(c.id).confirmation!; assert.ok(pending);
  h.gateway.user(c.agentId!, "ambiguous", "好");
  await assert.rejects(h.chats.control(c.id, { action: "accept_final", sourceMessageId: "ambiguous", confirmationKey: pending.key }), /单独回复/);
  h.gateway.user(c.agentId!, "approve", "验收通过");
  await h.chats.control(c.id, { action: "accept_final", sourceMessageId: "approve", confirmationKey: pending.key });
  await h.chats.control(c.id, { action: "accept_final", sourceMessageId: "approve", confirmationKey: pending.key });
  assert.equal(h.chats.summary(c.id).run?.phase, "completed");
  h.gateway.user(c.agentId!, "change", "请补充输入校验");
  await h.chats.control(c.id, { action: "request_changes", sourceMessageId: "change", feedback: "补充输入校验" });
  assert.equal(h.chats.summary(c.id).run?.phase, "planning");
});

test("approval rejects quotes, model text, stale anchors and approvals before the question", () => {
  const notice: AgentTimelineItem = { type: "user_message", clientMessageId: "notice", text: "请验收" };
  for (const text of ["好", "同意", "他说验收通过", "‘验收通过’", "> 验收通过", "```验收通过```", "验收通过，但是请先改完"]) {
    assert.throws(() => validateChatApproval([notice, { type: "user_message", messageId: "u", text }], { action: "accept_final", noticeId: "notice", messageId: "u" }));
  }
  assert.throws(() => validateChatApproval([notice, { type: "assistant_message", messageId: "a", text: "验收通过" }], { action: "accept_final", noticeId: "notice", messageId: "a" }));
  assert.throws(() => validateChatApproval([{ type: "user_message", messageId: "u", text: "验收通过" }, notice], { action: "accept_final", noticeId: "notice", messageId: "u" }));
  validateChatApproval([notice, { type: "user_message", messageId: "u", text: "验收通过。" }], { action: "accept_final", noticeId: "notice", messageId: "u" });
});

test("migration freezes dispatch, preserves in-flight operations and retries creation without duplicating work", async t => {
  const h = await fixture(t);
  const id = await h.engine.create({ requestId: "legacy", repository: h.dir, goal: "实现功能", settings: settings() });
  for (let i = 0; i < 4; i++) await h.engine.tick();
  const before = h.store.get(id), op = before.operations.find(o => o.id === before.activeOperationId)!;
  h.gateway.failCreate = true;
  await h.chats.migrate(); await h.chats.tick(); await h.engine.tick();
  assert.equal(h.store.get(id).activeOperationId, op.id); assert.ok(h.chats.summary(h.store.get(id).migrationConversationId!).error);
  h.gateway.failCreate = false; await h.chats.tick();
  const after = h.store.get(id); assert.equal(after.activeOperationId, op.id);
  assert.equal(after.operations[0].agentId, op.agentId); assert.notEqual(after.directorAgentId, op.agentId);
  const count = h.gateway.created.length;
  await h.chats.migrate(); await h.chats.tick(); assert.equal(h.gateway.mains.size, 1); assert.equal(h.gateway.created.length, count);
});

test("migration retains every persisted lifecycle state, completed outcomes and task evidence", async t => {
  const h = await fixture(t);
  for (const [index, state] of [
    { phase: "planning", control: "running" }, { phase: "executing", control: "running" },
    { phase: "executing", control: "paused" }, { phase: "final_review", control: "needs_attention" },
    { phase: "awaiting_acceptance", control: "paused" }, { phase: "completed", control: "running" }, { phase: "executing", control: "canceled" },
  ].entries()) {
    const id = await h.engine.create({ requestId: `legacy-${index}`, repository: h.dir, goal: "实现功能", settings: settings() });
    const run = h.store.get(id); Object.assign(run, state); run.plan = plan; run.planApproved = index !== 2;
    h.store.save(run);
  }
  const before = h.store.all(); await h.chats.migrate(); await h.chats.tick();
  for (const run of before) {
    const after = h.store.get(run.id); assert.equal(after.phase, run.phase); assert.equal(after.control, run.control);
    assert.deepEqual(after.plan, run.plan); assert.equal(after.planApproved, run.planApproved); assert.ok(after.chat);
  }
  assert.equal(h.gateway.sent.filter(s => s.prompt.startsWith("[paseo-director:")).length, 0);
});

test("busy main chats queue/coalesce notices, and a lost send acknowledgment is reconciled once", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "notifications", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id });
  await h.chats.tick(); assert.equal(h.gateway.sent.length, 1);
  h.gateway.idle(c.agentId!); const original = h.gateway.send.bind(h.gateway);
  h.gateway.send = async (...args) => { await original(...args); throw new Error("lost response"); };
  await h.chats.tick(); assert.equal(h.gateway.sent.length, 2);
  h.gateway.send = original; h.gateway.idle(c.agentId!); await h.chats.tick();
  assert.equal(h.gateway.sent.length, 2); assert.equal(h.store.conversation(c.id).notices.at(-1)?.state, "sent");
});

test("chat revision stops workers, rejects stale submissions, and doesn't cancel its own main turn", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "revision", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id });
  h.gateway.idle(c.agentId!); for (let i = 0; i < 3; i++) await h.engine.tick();
  const op = h.chats.summary(c.id).run!.operations.at(-1)!;
  h.gateway.user(c.agentId!, "revise", "增加登录功能");
  await h.chats.control(c.id, { action: "revise", sourceMessageId: "revise", goal: "实现功能并增加登录" });
  assert.equal(h.gateway.stopped.includes(c.agentId!), false);
  await assert.rejects(h.chats.submit(c.id, op.id, plan), /无权/);
  assert.equal(h.chats.summary(c.id).run?.goal, "实现功能并增加登录");
});

test("chat history with later user turns does not invalidate a main operation's submitted tool result", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const op = await h.until("plan");
  const run = h.run(); run.chat = { version: 1, conversationId: "chat", mainAgentId: op.agentId! }; h.store.save(run);
  await h.engine.submit(h.id, "director", op.id, plan);
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, interrupted: true, output: "你问的这个问题，可以这样理解…" });
  await h.engine.tick(); assert.equal(h.run().control, "running"); assert.deepEqual(h.run().plan, plan);
});

test("conversation creation recovers a committed run after its linking checkpoint was lost", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "crash", workspaceId: "workspace", goal: "实现功能" });
  const source = (await h.chats.status(c.id)).latestUserMessage!.id;
  const before = h.store.conversation(c.id);
  await h.chats.start(c.id, { sourceMessageId: source, goal: "实现功能" });
  before.receipts[`start:${source}`] = { action: "start", state: "pending" }; h.store.saveConversation(before);
  const restarted = new Conversations(h.store, h.engine, h.gateway);
  await restarted.tick(); assert.equal(restarted.summary(c.id).runId, h.store.all()[0].id);
  assert.equal(h.store.all().length, 1); await restarted.close();
});

test("an unavailable MCP handshake is visible and no background task is fabricated", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "no-tools", workspaceId: "workspace", goal: "实现功能" });
  h.gateway.idle(c.agentId!); await h.chats.tick();
  assert.match(h.chats.summary(c.id).error!, /MCP/); assert.equal(h.store.all().length, 0);
  await h.chats.status(c.id); assert.equal(h.chats.summary(c.id).error, undefined);
});

test("a main Agent can submit context fetched from tools before a queued prompt is sent", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "tool-context", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id });
  await h.engine.tick(); await h.engine.tick();
  const op = (await h.chats.status(c.id)).operation!; assert.equal(op.state, "ready");
  await h.chats.submit(c.id, op.id, plan);
  // The same interactive chat turn is still running and no operation prompt
  // exists in its history. A valid MCP submission is sufficient for acceptance.
  await h.engine.tick(); assert.deepEqual(h.chats.summary(c.id).run?.plan, plan);
  assert.equal(h.chats.summary(c.id).run?.control, "running");
});

test("resync replaces a missing main conversation without replacing child work or restarting the run", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "missing-main", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id });
  const runId = h.chats.summary(c.id).runId;
  h.gateway.states.delete(c.agentId!);
  await h.chats.resync(c.id);
  const restored = h.chats.summary(c.id); assert.notEqual(restored.agentId, c.agentId); assert.equal(restored.runId, runId);
  assert.equal(restored.run?.chat?.mainAgentId, restored.agentId); assert.equal(h.store.all().length, 1);
  await h.chats.resync(c.id); assert.equal(h.gateway.mains.size, 2);
});

test("revision keeps retrying an asynchronous worker stop and discards its late result", async t => {
  const h = await fixture(t), c = await h.chats.open({ requestId: "async-stop", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id });
  await h.engine.tick(); await h.engine.tick();
  await h.chats.submit(c.id, (await h.chats.status(c.id)).operation!.id, plan); await h.engine.tick();
  for (let i=0;i<4;i++) await h.engine.tick();
  const before=h.chats.summary(c.id).run!, op=before.operations.find(o=>o.id===before.activeOperationId)!;
  assert.equal(op.kind,"execute");
  const stop=h.gateway.stop.bind(h.gateway); let stopping=true;
  h.gateway.stop=async id=>{if(!stopping)await stop(id);};
  h.gateway.user(c.agentId!,"new-goal","增加登录功能");
  await assert.rejects(h.chats.control(c.id,{action:"revise",sourceMessageId:"new-goal",goal:"实现功能并增加登录"}),/正在停止/);
  stopping=false; await h.chats.tick();
  const after=h.chats.summary(c.id).run!; assert.equal(after.goal,"实现功能并增加登录");
  assert.equal(after.phase,"planning");
  await assert.rejects(h.engine.submit(after.id,op.taskId!,op.id,result),/已经结束/);
});

test("takeover preserves history and agent identity, leaves worker bindings intact and ignores old instructions", async t => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", [{ type: "user_message", messageId: "old", text: "实现旧任务" }]); h.gateway.idle("existing");
  const original = h.store.settings()!; original.workerProfileId = original.directorProfileId; h.store.saveSettings(original);
  const c = await h.chats.open({ requestId: "take", workspaceId: "workspace", agentId: "existing" });
  assert.equal(c.agentId, "existing"); assert.equal(h.gateway.mains.size, 0); assert.equal(h.store.all().length, 0);
  assert.equal(h.gateway.histories.get("existing")![0].type, "user_message");
  const snapshot = h.store.conversation(c.id).settings;
  assert.equal(snapshot.profiles.find(p => p.id === snapshot.directorProfileId)!.provider, "current/model");
  assert.equal(snapshot.workerProfileId, original.workerProfileId);
  assert.equal(snapshot.profiles.find(p => p.id === snapshot.workerProfileId)!.provider, "vendor-a/model-a");
  assert.deepEqual(h.store.settings(), original);
  assert.equal((await h.chats.status(c.id)).latestUserMessage, undefined);
  await assert.rejects(h.chats.start(c.id, { sourceMessageId: "old", goal: "实现旧任务" }), /真实用户/);
  await h.chats.open({ requestId: "again", workspaceId: "workspace", agentId: "existing" });
  assert.equal(h.gateway.sent.length, 1); assert.equal(h.store.conversations().length, 1);
  h.gateway.idle("existing"); h.gateway.user("existing", "new", "实现新任务");
  await h.chats.start(c.id, { sourceMessageId: "new", goal: "实现新任务" });
  assert.equal(h.store.all()[0].chat!.mainAgentId, "existing");
});

test("takeover waits for the current turn, survives reload and delivers each command once", async t => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []);
  h.gateway.states.set("existing", { status: "running", seen: false, output: "" });
  const input = { requestId: "take", workspaceId: "workspace", agentId: "existing", goal: "实现功能" };
  const c = await h.chats.open(input);
  assert.equal(h.gateway.sent.length, 0); assert.equal(h.gateway.stopped.length, 0);
  await h.chats.close();
  const restarted = new Conversations(h.store, h.engine, h.gateway); t.after(() => restarted.close());
  h.gateway.idle("existing"); await restarted.tick();
  assert.equal(h.gateway.sent.length, 1); assert.match(h.gateway.sent[0].prompt, /^实现功能/);
  await restarted.open(input); assert.equal(h.gateway.sent.length, 1);
  assert.equal((await restarted.status(c.id)).latestUserMessage!.id, h.gateway.sent[0].opId);
  h.gateway.idle("existing");
  await restarted.open({ ...input, requestId: "second", goal: "增加搜索" });
  assert.equal(h.gateway.sent.length, 2); assert.equal(h.store.conversations().length, 1);
  h.gateway.histories.delete("existing"); h.gateway.states.delete("existing");
  await assert.rejects(restarted.resync(c.id), /原对话已不可用/);
  assert.equal(h.gateway.mains.size, 0);
});

test("takeover validates ownership before persisting anything", async t => {
  const h = await fixture(t);
  await assert.rejects(h.chats.open({ requestId: "invalid", workspaceId: "other", agentId: "unknown" }), /工作区/);
  assert.equal(h.store.conversations().length, 0);
});

test("ambiguous takeover delivery requires resync and never creates a replacement agent", async t => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []); h.gateway.idle("existing");
  const send = h.gateway.send.bind(h.gateway); let fail = true;
  t.mock.method(h.gateway, "send", async (...args: Parameters<typeof send>) => { if (fail) throw new Error("lost connection"); await send(...args); });
  await assert.rejects(h.chats.open({ requestId: "take", workspaceId: "workspace", agentId: "existing" }), /lost connection/);
  const c = h.store.conversations()[0];
  await h.chats.tick(); assert.match(h.chats.summary(c.id).error!, /无法确认/);
  assert.equal(h.gateway.sent.length, 0); assert.equal(h.gateway.mains.size, 0);
  fail = false; await h.chats.resync(c.id);
  assert.equal(h.gateway.sent.length, 1); assert.equal(h.gateway.sent[0].opId, c.takeover!.messages[0].id);
  h.gateway.idle("existing"); await h.chats.tick();
  assert.match(h.chats.summary(c.id).error!, /协作工具/);
  await h.chats.status(c.id); assert.equal(h.chats.summary(c.id).error, undefined);
});

test("workers receive the persisted approval made in an adopted main conversation", async t => {
  const { buildPrompt } = await import("../server/prompts");
  const h = await fixture(t), saved = settings(); saved.requirePlanApproval = true; h.store.saveSettings(saved);
  h.gateway.histories.set("existing", []); h.gateway.idle("existing");
  const c = await h.chats.open({ requestId: "take", workspaceId: "workspace", agentId: "existing", goal: "实现功能" });
  const status = await h.chats.status(c.id);
  await h.chats.start(c.id, { sourceMessageId: status.latestUserMessage!.id, goal: "实现功能" });
  const runId = h.chats.summary(c.id).runId!;
  await h.engine.tick();
  const op = h.store.get(runId).operations.find(o => o.kind === "plan")!;
  await h.chats.submit(c.id, op.id, plan); h.gateway.idle("existing"); await h.engine.tick(); await h.chats.tick();
  const approval = h.chats.summary(c.id).confirmation!;
  h.gateway.user("existing", "approval", "批准方案");
  await h.chats.control(c.id, { action: "approve_plan", sourceMessageId: "approval", confirmationKey: approval.key });
  const run = h.store.get(runId);
  const prompt = buildPrompt(run, "execute", "test-operation", run.tasks[0].spec.id);
  const start = prompt.indexOf("\n\n") + 2, end = prompt.indexOf("\n\n本轮 operationId=");
  const evidence = JSON.parse(prompt.slice(start, end)).workflowEvidence;
  assert.equal(evidence.planApproval.approved, true); assert.equal(evidence.planApproval.required, true);
  assert.equal(evidence.planApproval.userApprovedAt, new Date(run.planApprovedAt!).toISOString());
});
