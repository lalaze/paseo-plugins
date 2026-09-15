import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConversationBridge, bridgeInstructions, conversationQueueRoot } from "../server/bridge";
import { DirectorMcp } from "../server/mcp";
import { Conversations } from "../server/conversations";
import { Store } from "../server/store";
import { Engine } from "../server/engine";
import { CHAT_ACTOR } from "../shared/conversation";
import { FakeAgents, FakeRepository, settings } from "./helpers";

function invoke(path: string, tool: string, input?: unknown) {
  return new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path, tool], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { error += value; });
    child.on("error", reject); child.on("close", code => resolve({ code, output, error }));
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

test("terminal bridge calls scoped tools without network access, persists across restart and reports failures", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-bridge-' space-"));
  const store = new Store(join(root, "db")), agents = new FakeAgents();
  agents.directory = root;
  const engine = new Engine(store, agents, new FakeRepository());
  const chats = new Conversations(store, engine, {
    workspaceDirectory: async () => root, createConversation: async () => { throw new Error("must not create"); },
    findConversation: async () => [], conversationHistory: async () => [{ type: "user_message", messageId: "user", text: "实现功能" }],
    appendConversationLink: async () => {}, inspect: async () => ({ status: "idle", seen: false, output: "" }), send: async () => {},
  });
  store.saveConversation({ id: "current", requestId: "current", workspaceId: "workspace", cwd: root, agentId: "existing", settings: settings(), createdAt: 1, state: "ready", notices: [], receipts: {} });
  let mcp = new DirectorMcp(store, engine, chats, root);
  t.after(async () => { await mcp.close(); await chats.close(); await engine.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(conversationQueueRoot(root), { recursive: true, force: true }); });
  await mcp.start();
  const token = store.token("current", CHAT_ACTOR);
  const path = await writeConversationBridge(root, "current", token);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "bridges"))).mode & 0o777, 0o700);
  assert.ok(!bridgeInstructions(path).includes(token)); assert.ok(bridgeInstructions(path).includes("'\\''"));
  const status = await invoke(path, "get_conversation_status");
  assert.equal(status.code, 0, status.error); assert.equal(JSON.parse(status.output).agentId, "existing");
  assert.equal(JSON.parse(status.output).latestUserMessage.id, "user");
  const start = await invoke(path, "start_task", { sourceMessageId: "user", goal: "实现功能" });
  assert.equal(start.code, 0, start.output + start.error);
  assert.equal(store.all().length, 1); assert.equal(store.all()[0].chat!.mainAgentId, "existing");
  const duplicate = await invoke(path, "start_task", { sourceMessageId: "user", goal: "实现功能" });
  assert.equal(JSON.parse(duplicate.output).runId, JSON.parse(start.output).runId);
  const bad = await invoke(path, "control_task", { sourceMessageId: "invented", action: "cancel" });
  assert.equal(bad.code, 1); assert.match(bad.error, /真实用户/);
  const invalid = await invoke(path, "submit_result", {}); assert.equal(invalid.code, 1);
  await mcp.close(); mcp = new DirectorMcp(store, engine, chats, root); await mcp.start();
  assert.equal((await invoke(path, "get_conversation_status")).code, 0);
  const wrong = await writeConversationBridge(root, "wrong", "bad-token");
  const denied = await invoke(wrong, "get_conversation_status");
  assert.equal(denied.code, 1); assert.match(denied.error, /凭据无效/); assert.ok(!denied.error.includes("bad-token"));
});

test("bridge restart reuses a written receipt without executing its request again", async t => {
  const { ConversationBridgeServer } = await import("../server/bridge");
  const { writeFile, readFile, access } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "director-bridge-receipt-"));
  const queue = conversationQueueRoot(root);
  let calls = 0;
  let server = new ConversationBridgeServer(root, async () => { calls++; return { ok: true }; });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); await rm(queue, { recursive: true, force: true }); });
  await server.start();
  const base = join(queue, "00000000-0000-0000-0000-000000000001");
  const request = JSON.stringify({ token: "test", name: "get_conversation_status", arguments: {} });
  await writeFile(base + ".request.json", request, { mode: 0o600 });
  for (let i = 0; i < 50; i++) {
    if (await access(base + ".response.json").then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(await readFile(base + ".response.json", "utf8")), { value: { ok: true } });
  await server.close(); await writeFile(base + ".request.json", request, { mode: 0o600 });
  server = new ConversationBridgeServer(root, async () => { calls++; return {}; }); await server.start();
  for (let i = 0; i < 50; i++) {
    if (!await access(base + ".request.json").then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await assert.rejects(access(base + ".request.json")); assert.equal(calls, 1);
});
