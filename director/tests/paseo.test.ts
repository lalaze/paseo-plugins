import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMessages, connectionConfig, PaseoGateway } from "../server/paseo";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { parseOutput } from "../shared/schema";
import { harness, plan, result, reviewerSettings } from "./helpers";

test("director and worker are created in the exact originating workspace; legacy runs keep their worktree", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  t.mock.method(gateway.api.providers, "waitForReady", async () => ({ entries: [{ provider: "vendor-a", status: "ready", models: [{ id: "model-a" }] }, { provider: "vendor-b", status: "ready", models: [{ id: "model-b" }] }] }));
  const calls: { workspaceId: string; parent?: string; title: string }[] = [], opened: string[] = [], titles: string[] = [];
  const handle = (id: string) => ({ id, directory: h.directory, refresh: async () => ({ name: "旧分支", projectDisplayName: "项目" }), current: () => ({}), setTitle: async (title: string) => { titles.push(title); return { title }; }, agents: { create: async (options: { parent?: string; title: string }) => { calls.push({ workspaceId: id, parent: options.parent, title: options.title }); return { id: `agent-${calls.length}` }; } } });
  t.mock.method(gateway.api.workspaces, "ref", handle);
  t.mock.method(gateway.api.workspaces, "open", async (cwd: string) => { opened.push(cwd); return handle("isolated-workspace"); });
  const lead = await h.until("plan"), run = { ...h.run(), cwd: h.directory, workspaceId: "origin-workspace" };
  await gateway.create(run, lead, run.settings.profiles[0], "unused");
  await h.complete(plan); const worker = await h.until("execute");
  await gateway.create({ ...run, tasks: h.run().tasks, directorAgentId: "original-director" }, worker, run.settings.profiles[1], "unused");
  assert.deepEqual(calls, [{ workspaceId: "origin-workspace", parent: undefined, title: "AI 协作 · 总 AI · 实现新功能" }, { workspaceId: "origin-workspace", parent: "original-director", title: "AI 协作 · 执行 AI · 实现" }]);
  assert.deepEqual(opened, []);
  await gateway.create({ ...run, workspaceId: undefined }, lead, run.settings.profiles[0], "unused");
  assert.deepEqual(opened, [h.directory]); assert.equal(calls[2].workspaceId, "isolated-workspace");
  assert.deepEqual(titles, ["AI 协作 · 实现新功能"]);
});

test("workspace names are pinned before branch changes and explicit titles are respected", async t => {
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  let branch = "feature/readme", title: string | null = null;
  const writes: string[] = [];
  const handle = { directory: "/repo", refresh: async () => ({ title, name: title ?? branch, projectDisplayName: "zeMc" }), setTitle: async (value: string) => { title = value; writes.push(value); return { title }; } };
  t.mock.method(gateway.api.workspaces, "ref", () => handle);
  await gateway.retainWorkspaceName("original");
  branch = "director/0123456789abcdef01234567";
  assert.equal((await handle.refresh()).name, "feature/readme");
  title = "我给工作区起的名字";
  await gateway.retainWorkspaceName("original");
  assert.equal(title, "我给工作区起的名字"); assert.equal(writes.length, 1);
  title = null;
  await gateway.retainWorkspaceName("original");
  assert.equal(title, "zeMc");
});

test("new sessions resolve live default permissions, honor explicit choices and reject unavailable modes", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const op = await h.until("plan"), run = { ...h.run(), cwd: h.directory, workspaceId: "workspace" };
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  let defaultModeId: string | null = "auto-review";
  let modes: { id: string; label: string }[] | undefined = ["auto", "auto-review", "full-access"].map(id => ({ id, label: id }));
  t.mock.method(gateway.api.providers, "waitForReady", async () => ({ entries: [{ provider: "vendor-a", status: "ready", models: [{ id: "model-a" }], modes, defaultModeId }] }));
  const configs: Record<string, unknown>[] = [];
  const handle = { id: "workspace", directory: h.directory, current: () => ({}), refresh: async () => ({ name: "项目" }), agents: { create: async ({ config }: { config: Record<string, unknown> }) => { configs.push(config); return { id: "created" }; } } };
  t.mock.method(gateway.api.workspaces, "ref", () => handle);
  for (const modeId of [undefined, "auto", "auto-review", "full-access"]) {
    await gateway.create(run, op, { ...run.settings.profiles[0], modeId }, "unused");
    assert.equal(configs.at(-1)?.modeId, modeId ?? "auto-review");
  }
  defaultModeId = "auto";
  await gateway.create(run, op, run.settings.profiles[0], "unused");
  assert.equal(configs.at(-1)?.modeId, "auto");
  const before = configs.length;
  await assert.rejects(gateway.create(run, op, { ...run.settings.profiles[0], modeId: "removed" }, "unused"), /执行权限不可用/);
  defaultModeId = "removed";
  await assert.rejects(gateway.create(run, op, run.settings.profiles[0], "unused"), /执行权限不可用/);
  assert.equal(configs.length, before);
  defaultModeId = null; modes = [];
  await gateway.create(run, op, run.settings.profiles[0], "unused");
  assert.equal(Object.hasOwn(configs.at(-1)!, "modeId"), false);
  modes = undefined;
  await gateway.create(run, op, { ...run.settings.profiles[0], modeId: "custom" }, "unused");
  assert.equal(configs.at(-1)?.modeId, "custom");
});

test("separate reviewer uses its configured provider, permissions and workspace without a design role label", async t => {
  const h = await harness(reviewerSettings()); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result); const audit = await h.until("final");
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1234/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  t.mock.method(gateway.api.providers, "waitForReady", async () => ({ entries: [{ provider: "vendor-c", status: "ready", models: [{ id: "model-c" }] }] }));
  const calls: any[] = [];
  const handle = { id: "original-workspace", directory: h.directory, current: () => ({}), refresh: async () => ({ name: "项目" }), agents: { create: async (options: unknown) => { calls.push(options); return { id: "new-auditor" }; } } };
  t.mock.method(gateway.api.workspaces, "ref", () => handle);
  t.mock.method(gateway.api.workspaces, "open", async () => { throw new Error("不得新建工作区"); });
  const run = { ...h.run(), cwd: h.directory, workspaceId: "original-workspace" };
  await gateway.create(run, audit, run.settings.profiles[2], "test-review-token");
  assert.equal(calls[0].parent, run.directorAgentId); assert.match(calls[0].title, /^AI 协作 · 审核 AI ·/);
  assert.equal(calls[0].labels["director-role"], "reviewer");
  assert.equal(calls[0].config.provider, "vendor-c/model-c"); assert.equal(calls[0].config.modeId, "auto-review"); assert.equal(calls[0].config.thinkingOptionId, "high");
  assert.equal(calls[0].config.mcpServers.director.headers.Authorization, "Bearer test-review-token");
  assert.match(calls[0].config.systemPrompt, /review operations must not modify source files/);
});

test("canonical deltas preserve keys, escapes and real newlines", () => {
  const value = { summary: '中文设计含 "引号"、\\路径和\n换行', tasks: [] };
  const json = JSON.stringify(value, null, 2);
  for (const messageId of ["message-1", undefined]) {
    const items: AgentTimelineItem[] = [{ type: "user_message", text: "[paseo-director:current]" }, ...Array.from(json, text => ({ type: "assistant_message" as const, messageId, text }))];
    assert.equal(inspectMessages(items, "current").output, json);
    assert.deepEqual(parseOutput(inspectMessages(items, "current").output), value);
  }
});

test("separates distinct messages and never consumes a later user turn", () => {
  const items: AgentTimelineItem[] = [
    { type: "user_message", text: "task", clientMessageId: "current" },
    { type: "assistant_message", messageId: "progress", text: "已完成检查。" },
    { type: "assistant_message", messageId: "final", text: '```json\n{"ok"' },
    { type: "assistant_message", messageId: "final", text: ':true}\n```' },
  ];
  assert.deepEqual(parseOutput(inspectMessages(items, "current").output), { ok: true });
  const interrupted = inspectMessages([...items, { type: "user_message", text: "新要求" }, { type: "assistant_message", text: "另一个结果" }], "current");
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.output, inspectMessages(items, "current").output);
});

test("only consumes assistant output for exact operation, detects subsequent user messages", () => {
  const items = [{ type: "assistant_message" as const, text: "old result" }, { type: "user_message" as const, text: "[paseo-director:current]\ndo work" }, { type: "reasoning" as const, text: "thinking" }, { type: "assistant_message" as const, text: "{\"ok\":true}" }];
  assert.deepEqual(inspectMessages(items, "current"), { seen: true, interrupted: false, output: '{"ok":true}' });
  assert.equal(inspectMessages(items, "other").seen, false);
  assert.equal(inspectMessages([...items, { type: "user_message", text: "changed requirements" }], "current").interrupted, true);
});
test("connection supports explicit host override and keeps credentials out of URL", () => {
  const config = connectionConfig({ PASEO_HOME: "/tmp/nonexistent-director-home", PASEO_DIRECTOR_URL: "ws://127.0.0.1:9999/ws", PASEO_DIRECTOR_PASSWORD: "secret" });
  assert.equal(config.url, "ws://127.0.0.1:9999/ws"); assert.equal(config.password, "secret");
});

test("explicit WebSocket addresses override Unix socket listeners from environment or daemon config", t => {
  const home = mkdtempSync(join(tmpdir(), "director-socket-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { listen: "/tmp/paseo.sock" } }));
  for (const listener of [{ PASEO_HOME: home }, { PASEO_HOME: home, PASEO_LISTEN: "/tmp/another-paseo.sock" }]) {
    for (const url of ["ws://127.0.0.1:9999/ws", "wss://daemon.example.invalid/ws"]) {
      assert.equal(connectionConfig({ ...listener, PASEO_DIRECTOR_URL: url }).url, url);
    }
    assert.throws(() => connectionConfig(listener), /PASEO_DIRECTOR_URL/);
    for (const invalid of ["", "not a URL", "http://127.0.0.1:9999/ws", "file:///tmp/paseo.sock"]) {
      assert.throws(() => connectionConfig({ ...listener, PASEO_DIRECTOR_URL: invalid }), /PASEO_DIRECTOR_URL/);
    }
  }
});

test("adoption only adds labels and a private bridge, keeping model, permissions, history and title", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1/mcp", h.directory);
  t.after(() => gateway.close()); t.mock.method(gateway, "connect", async () => {});
  const original = { id: "original", workspaceId: "workspace", cwd: h.directory, model: "chosen", provider: "vendor", currentModeId: "auto-review", thinkingOptionId: "high", status: "idle", title: "我的对话", labels: { custom: "keep" } };
  t.mock.method(gateway.api.agents, "ref", () => ({ refresh: async () => ({ agent: original }) }));
  t.mock.method(gateway, "workspaceDirectory", async () => h.directory);
  const updates: unknown[] = [];
  t.mock.method((gateway as any).driver, "updateAgent", async (id: string, changes: unknown) => { assert.equal(id, "original"); updates.push(changes); });
  const profile = await gateway.takeoverProfile("original", "workspace");
  assert.deepEqual(profile, { provider: "vendor/chosen", modeId: "auto-review", thinkingOptionId: "high" });
  const instruction = await gateway.adoptConversation({ id: "chat", agentId: "original", workspaceId: "workspace" } as any, "private-test-token");
  assert.ok(instruction.includes("get_conversation_status")); assert.ok(!instruction.includes("private-test-token"));
  assert.deepEqual(updates, [{ labels: { custom: "keep", "director-conversation": "chat", "director-role": "chat", "director-transport": "bridge" } }]);
  await assert.rejects(gateway.takeoverProfile("original", "other"), /工作区/);
  (original.labels as Record<string, string>)["director-role"] = "worker";
  await assert.rejects(gateway.takeoverProfile("original", "workspace"), /子会话/);
});

function pagedTimeline(pages: { items: AgentTimelineItem[]; timestamp: string }[][]) {
  // pages[0] is the tail; each earlier page is one "before" fetch.
  const fetches: string[] = [];
  const build = (index: number) => ({
    entries: pages[index].map(({ items, timestamp }) => ({ item: items[0], timestamp })),
    hasOlder: index + 1 < pages.length, startCursor: index + 1 < pages.length ? { epoch: "e", seq: index + 1 } : null, staleCursor: false, gap: false,
  });
  const agent = {
    refresh: async () => ({ agent: {} }), archivedAt: undefined, status: "idle", pendingPermissions: [], activeTurn: undefined, lastError: undefined,
    timeline: { refetch: async (options: { direction: string; cursor?: { seq: number } }) => { fetches.push(options.direction); return build(options.direction === "tail" ? 0 : options.cursor!.seq); } },
  };
  return { agent, fetches };
}

test("history reads stop paging once a page predates the message being searched for", async t => {
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const user = (text: string): AgentTimelineItem => ({ type: "user_message", text, messageId: text });
  const { agent, fetches } = pagedTimeline([
    [{ items: [user("recent")], timestamp: at(0) }],
    [{ items: [user("older")], timestamp: at(10) }],
    [{ items: [user("ancient")], timestamp: at(600) }],
    [{ items: [user("oldest")], timestamp: at(6000) }],
  ]);
  t.mock.method(gateway.api.agents, "ref", () => agent);
  // Unbounded: an absent marker walks the whole history.
  assert.equal((await gateway.inspect("agent", "missing")).seen, false);
  assert.equal(fetches.length, 4); fetches.length = 0;
  // Bounded by the operation's creation time: the first page that is entirely older ends the search.
  assert.equal((await gateway.inspect("agent", "missing", Date.now() - 5 * 60000)).seen, false);
  assert.equal(fetches.length, 2); fetches.length = 0;
  // A marker older than the bound is out of scope; without a bound it is still found.
  assert.equal((await gateway.inspect("agent", "ancient", Date.now())).seen, false);
  assert.equal(fetches.length, 2); fetches.length = 0;
  assert.equal((await gateway.inspect("agent", "ancient")).seen, true);
  assert.equal(fetches.length, 3); fetches.length = 0;
  // Callers of conversationHistory stop as soon as they have what they need.
  const items = await gateway.conversationHistory("agent", items => items.some(i => i.type === "user_message" && i.text === "older"));
  assert.deepEqual(items.map(i => (i as { text: string }).text), ["older", "recent"]);
  assert.equal(fetches.length, 2);
});
