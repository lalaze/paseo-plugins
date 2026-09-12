import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMessages, connectionConfig, PaseoGateway } from "../server/paseo";
import { parseOutput } from "../shared/schema";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
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
  assert.deepEqual(calls, [{ workspaceId: "origin-workspace", parent: undefined, title: "Director · 总 AI · 实现新功能" }, { workspaceId: "origin-workspace", parent: "original-director", title: "Director · 执行 AI · 实现" }]);
  assert.deepEqual(opened, []);
  await gateway.create({ ...run, workspaceId: undefined }, lead, run.settings.profiles[0], "unused");
  assert.deepEqual(opened, [h.directory]); assert.equal(calls[2].workspaceId, "isolated-workspace");
  assert.deepEqual(titles, ["Director · 实现新功能"]);
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

test("separate reviewer uses its configured provider, permissions and workspace without a design role label", async t => {
  const h = await harness(reviewerSettings()); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan); await h.until("execute"); await h.complete(result); const audit = await h.until("review");
  const gateway = new PaseoGateway({ url: "ws://127.0.0.1:1/ws" }, () => "http://127.0.0.1:1234/mcp"); t.after(() => gateway.close());
  t.mock.method(gateway, "connect", async () => {});
  t.mock.method(gateway.api.providers, "waitForReady", async () => ({ entries: [{ provider: "vendor-c", status: "ready", models: [{ id: "model-c" }] }] }));
  const calls: any[] = [];
  const handle = { id: "original-workspace", directory: h.directory, current: () => ({}), refresh: async () => ({ name: "项目" }), agents: { create: async (options: unknown) => { calls.push(options); return { id: "new-auditor" }; } } };
  t.mock.method(gateway.api.workspaces, "ref", () => handle);
  t.mock.method(gateway.api.workspaces, "open", async () => { throw new Error("不得新建工作区"); });
  const run = { ...h.run(), cwd: h.directory, workspaceId: "original-workspace" };
  await gateway.create(run, audit, run.settings.profiles[2], "test-review-token");
  assert.equal(calls[0].parent, run.directorAgentId); assert.match(calls[0].title, /^Director · 审核 AI ·/);
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
