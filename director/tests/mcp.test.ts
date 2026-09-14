import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DirectorMcp } from "../server/mcp";
import { harness, plan, result, review, reviewerSettings } from "./helpers";
import { REVIEWER_ACTOR } from "../shared/schema";

test("real MCP transport authenticates and scopes tools, accepts durable structured submissions", async t => {
  const h = await harness(); const mcp = new DirectorMcp(h.store, h.engine);
  t.after(async () => { await mcp.close(); await h.cleanup(); });
  await mcp.start();
  const op = await h.until("plan");
  const noAuth = await fetch(mcp.url(), { method: "POST", body: "{}" }); assert.equal(noAuth.status, 401);
  const token = h.store.token(h.id, "director");
  const origin = await fetch(mcp.url(), { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://untrusted.invalid" }, body: "{}" }); assert.equal(origin.status, 403);
  const client = new Client({ name: "director-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === "submit_plan"));
  assert.ok(!tools.tools.some(tool => tool.name === "submit_result"));
  const result = await client.callTool({ name: "submit_plan", arguments: { operationId: op.id, payload: plan } });
  assert.notEqual(result.isError, true); assert.deepEqual(h.op()?.response, plan);
  const dispatch = await client.callTool({ name: "dispatch_task", arguments: { taskId: "task-1" } });
  assert.notEqual(dispatch.isError, true); assert.deepEqual(h.run().dispatchOrder, ["task-1"]);
  await h.engine.control(h.id, "cancel");
  const late = await client.callTool({ name: "submit_plan", arguments: { operationId: op.id, payload: plan } }); assert.equal(late.isError, true);
});

test("MCP endpoint port persists across plugin restarts", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const first = new DirectorMcp(h.store, h.engine); await first.start(); const url = first.url(); await first.close();
  const second = new DirectorMcp(h.store, h.engine); t.after(() => second.close()); await second.start(); assert.equal(second.url(), url);
});

test("MCP isolates reviewer tools and credentials from designer and legacy task IDs", async t => {
  const h = await harness(reviewerSettings()), mcp = new DirectorMcp(h.store, h.engine), clients: Client[] = [];
  t.after(async () => { await Promise.allSettled(clients.map(c => c.close())); await mcp.close(); await h.cleanup(); });
  await mcp.start();
  async function connect(actor: string) {
    const client = new Client({ name: "role-test", version: "1.0.0" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url()), { requestInit: { headers: { Authorization: `Bearer ${h.store.token(h.id, actor)}` } } }));
    return client;
  }
  const designer = await connect("director"), reviewer = await connect(REVIEWER_ACTOR), worker = await connect("reviewer");
  assert.deepEqual((await designer.listTools()).tools.map(t => t.name).sort(), ["dispatch_task", "get_run_status", "submit_plan"]);
  assert.deepEqual((await reviewer.listTools()).tools.map(t => t.name).sort(), ["get_run_status", "submit_review"]);
  assert.deepEqual((await worker.listTools()).tools.map(t => t.name).sort(), ["get_run_status", "submit_result"]);
  const design = await h.until("plan");
  await assert.rejects(h.engine.submit(h.id, REVIEWER_ACTOR, design.id, plan), /角色无权/);
  await h.complete({ ...plan, tasks: [{ ...plan.tasks[0], id: "reviewer" }] });
  const execution = await h.until("execute");
  const submitted = await worker.callTool({ name: "submit_result", arguments: { operationId: execution.id, payload: result } });
  assert.notEqual(submitted.isError, true); await h.complete(result);
  const audit = await h.until("final");
  await assert.rejects(h.engine.submit(h.id, "reviewer", audit.id, review(true)), /角色无权/);
  await assert.rejects(h.engine.submit(h.id, "director", audit.id, review(true)), /角色无权/);
  const accepted = await reviewer.callTool({ name: "submit_review", arguments: { operationId: audit.id, payload: review(true) } });
  assert.notEqual(accepted.isError, true);
  await h.complete(review(true)); assert.equal(h.run().phase, "awaiting_acceptance");
  const stale = await reviewer.callTool({ name: "submit_review", arguments: { operationId: audit.id, payload: review(true) } });
  assert.equal(stale.isError, true);
});

test("conversation tokens expose chat tools without granting worker or reviewer user-control tools", async t => {
  const { Conversations } = await import("../server/conversations");
  const { CHAT_ACTOR } = await import("../shared/conversation");
  const h = await harness();
  const chats = new Conversations(h.store, h.engine, {
    workspaceDirectory: async () => "/repo", createConversation: async () => "main", findConversation: async () => [],
    conversationHistory: async () => [{ type: "user_message", messageId: "user", text: "请说明进度" }],
    appendConversationLink: async () => {}, inspect: async () => ({ status: "idle", seen: true, output: "" }), send: async () => {},
  });
  h.store.saveConversation({ id: "chat", requestId: "chat", workspaceId: "workspace", cwd: "/repo", agentId: "main", settings: h.run().settings, createdAt: 1, state: "ready", notices: [], receipts: {} });
  const mcp = new DirectorMcp(h.store, h.engine, chats), clients: Client[] = [];
  t.after(async () => { await Promise.allSettled(clients.map(c => c.close())); await mcp.close(); await chats.close(); await h.cleanup(); });
  await mcp.start();
  async function connect(id: string, actor: string) {
    const client = new Client({ name: "chat-tools", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url()), { requestInit: { headers: { Authorization: `Bearer ${h.store.token(id, actor)}` } } })); return client;
  }
  const main = await connect("chat", CHAT_ACTOR);
  assert.deepEqual((await main.listTools()).tools.map(t => t.name).sort(), ["control_task", "get_conversation_status", "start_task", "submit_operation"]);
  const state = await main.callTool({ name: "get_conversation_status", arguments: {} }); assert.notEqual(state.isError, true);
  const worker = await connect(h.id, "task-1"), reviewer = await connect(h.id, REVIEWER_ACTOR);
  for (const client of [worker, reviewer]) {
    assert.equal((await client.listTools()).tools.some(t => t.name === "control_task" || t.name === "start_task"), false);
    assert.equal((await client.callTool({ name: "control_task", arguments: { sourceMessageId: "user", action: "accept_final" } })).isError, true);
  }
});
