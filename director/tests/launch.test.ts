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
    create: async (_input: Record<string, unknown>) => ({ id: "run-from-command" }),
  };
  const context = {
    args: " 实现登录功能 ", workspace: { id: "workspace-a", directory: "/projects/current" },
    openPanel: (id: string) => { state.opened.push(id); },
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      state.calls.push({ name: contract.name, input });
      if (contract.name === "director.settings.get") return { settings: state.saved, error: null };
      if (contract.name === "director.run.create") return state.create(input);
      throw new Error("Unexpected RPC");
    },
  } as unknown as Context;
  return { state, context };
}

test("bare slash opens the panel; a task uses the current directory and saved host roles", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  await command.submit({ ...context, args: " " });
  assert.deepEqual(state.opened, ["director"]); assert.equal(state.calls.length, 0);
  await command.submit(context);
  const call = state.calls.find(c => c.name === "director.run.create")!;
  assert.equal(call.input.repository, "/projects/current"); assert.equal(call.input.goal, "实现登录功能");
  assert.equal(call.input.workspaceId, "workspace-a");
  assert.equal("settings" in call.input, false);
  assert.equal(command.requests.get("workspace-a")?.runId, "run-from-command");
  assert.equal(command.requests.get("workspace-a")?.status, "created");
});

test("missing settings opens setup and keeps the goal without creating a task", async () => {
  const command = createDirectorCommand(), { state, context } = fixture(); state.saved = null;
  await command.submit(context);
  assert.equal(state.calls.length, 1);
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
    return { id: created.get(input.requestId)! };
  };
  const first = command.submit(context), duplicate = command.submit(context);
  const outcomes = Promise.allSettled([first, duplicate]);
  await assert.rejects(command.submit({ ...context, args: "另一个目标" }), /仍在提交/);
  finish(); await outcomes;
  assert.equal(state.calls.filter(c => c.name === "director.run.create").length, 1);
  const failed = command.requests.get("workspace-a")!;
  assert.equal(failed.status, "failed"); assert.match(failed.message!, /连接中断/);
  await command.submit(context);
  assert.equal(command.requests.get("workspace-a")?.requestId, failed.requestId);
  assert.equal(command.requests.get("workspace-a")?.runId, "one-run");
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
  await assert.rejects(a.submit(context), /重新加载/);
});

test("invalid goal or workspace does not issue any RPC", async () => {
  const command = createDirectorCommand(), { state, context } = fixture();
  await assert.rejects(command.submit({ ...context, args: "a".repeat(32001) }), /32000/);
  await assert.rejects(command.submit({ ...context, workspace: { ...context.workspace, directory: "" } }), /工作区/);
  assert.equal(state.calls.length, 0);
});
