import test from "node:test";
import assert from "node:assert/strict";
import { createDirectorCommand } from "../client/launch";
import { settings } from "./helpers";

type Context = Parameters<ReturnType<typeof createDirectorCommand>["submit"]>[0];
function fixture() {
  const state = {
    saved: settings() as ReturnType<typeof settings> | null,
    opened: [] as string[],
    calls: [] as { name: string; input: Record<string, unknown> }[],
    create: async (_input: Record<string, unknown>) => ({ id: "conversation-from-command", agentId: "main-agent", runId: undefined }),
  };
  const context = {
    args: " 实现登录功能 ", workspace: { id: "workspace-a", directory: "/projects/current" },
    openSettings: (id: string) => { state.opened.push(id); },
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      state.calls.push({ name: contract.name, input });
      if (contract.name === "director.settings.get") return { settings: state.saved, error: null };
      if (contract.name === "director.conversation.open") return state.create(input);
      throw new Error("Unexpected RPC");
    },
  } as unknown as Context;
  return { state, context };
}

test("bare slash restores native chat; a goal creates a fresh conversation with saved host roles", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  await command.submit({ ...context, args: " " });
  assert.deepEqual(state.opened, []); assert.equal(state.calls.length, 2);
  await command.submit(context);
  const call = state.calls.filter(c => c.name === "director.conversation.open").at(-1)!;
  assert.equal(call.input.fresh, true); assert.equal(call.input.goal, "实现登录功能");
  assert.equal(call.input.workspaceId, "workspace-a");
  assert.equal("settings" in call.input, false);
  assert.equal(command.requests.get("workspace-a")?.conversationId, "conversation-from-command");
  assert.equal(command.requests.get("workspace-a")?.status, "created");
});

test("missing settings opens setup and keeps the goal without creating a task", async () => {
  const command = createDirectorCommand(), { state, context } = fixture(); state.saved = null;
  await command.submit(context);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.opened, ["director-settings"]);
  assert.equal(command.requests.get("workspace-a")?.status, "setup");
  assert.equal(command.requests.get("workspace-a")?.goal, "实现登录功能");
});

test("concurrent submissions coalesce and retry after a lost response reuses the same request", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const created = new Map<unknown, string>(); let loseResponse = true;
  state.create = async input => {
    created.set(input.requestId, "one-run"); await wait;
    if (loseResponse) { loseResponse = false; throw new Error("连接中断"); }
    return { id: created.get(input.requestId)!, agentId: "main-agent", runId: undefined };
  };
  const first = command.submit(context), duplicate = command.submit(context);
  const outcomes = Promise.allSettled([first, duplicate]);
  await assert.rejects(command.submit({ ...context, args: "另一个目标" }), /still being submitted/);
  finish(); await outcomes;
  assert.equal(state.calls.filter(c => c.name === "director.conversation.open").length, 1);
  const failed = command.requests.get("workspace-a")!;
  assert.equal(failed.status, "failed"); assert.match(failed.message!, /Connection interrupted/);
  await command.submit(context);
  assert.equal(command.requests.get("workspace-a")?.requestId, failed.requestId);
  assert.equal(command.requests.get("workspace-a")?.conversationId, "one-run");
  assert.equal(created.size, 1);
});

test("commands and navigation stay scoped to the workspace and plugin host", async () => {
  const a = createDirectorCommand(), b = createDirectorCommand(), { context } = fixture();
  let updates = 0;
  const unsubscribe = a.requests.subscribe(() => { updates++; });
  await a.submit(context);
  assert.equal(updates, 2);
  assert.equal(a.requests.get("different-workspace"), null);
  assert.equal(b.requests.get("workspace-a"), null);
  unsubscribe(); a.dispose(); assert.equal(a.requests.get("workspace-a"), null);
  await assert.rejects(a.submit(context), /was reloaded/);
});

test("invalid goal or workspace does not issue any RPC", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  await assert.rejects(command.submit({ ...context, args: "a".repeat(32001) }), /32000/);
  await assert.rejects(command.submit({ ...context, workspace: { ...context.workspace, directory: "" } }), /project workspace/);
  assert.equal(state.calls.length, 0);
});

test("new blank collaboration preserves the selected workspace and fresh intent through setup", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  state.saved = null;
  await command.submit({ ...context, args: "", fresh: true });
  assert.equal(command.requests.get("workspace-a")?.fresh, true);
  state.saved = settings();
  await command.resumeSetup();
  const call = state.calls.filter(c => c.name === "director.conversation.open").at(-1)!;
  assert.equal(call.input.workspaceId, "workspace-a");
  assert.equal(call.input.fresh, true);
  assert.equal(call.input.goal, undefined);
});

test("saving setup retries the original request without opening a workspace panel", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  state.saved = null;
  await command.submit(context);
  const requestId = command.requests.get("workspace-a")!.requestId;
  state.saved = settings();
  await command.resumeSetup();
  assert.equal(command.requests.get("workspace-a")!.requestId, requestId);
  assert.deepEqual(state.opened, ["director-settings"]);
  await command.resumeSetup();
  assert.equal(state.calls.filter(c => c.name === "director.conversation.open").length, 1);
});

test("takeover keeps the selected agent through setup and forwards it to the server", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  state.saved = null;
  await command.submit({ ...context, agent: { id: "original" } });
  state.saved = settings(); await command.resumeSetup();
  const call = state.calls.find(c => c.name === "director.conversation.open")!;
  assert.equal(call.input.agentId, "original"); assert.equal(call.input.fresh, false);
});

test("two tabs never coalesce takeover requests in the same workspace", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  let finish!: () => void;
  state.create = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { id: "c", agentId: "a", runId: undefined }; };
  const first = command.submit({ ...context, agent: { id: "a" } });
  await assert.rejects(command.submit({ ...context, agent: { id: "b" } }), /still being submitted/);
  await new Promise(resolve => setImmediate(resolve)); finish(); await first;
});
