import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoWorkspaceListResult } from "@getpaseo/client";
import { listLaunchWorkspaces } from "../client/workspaces";

test("workspace choices preserve exact checkout identities across pages", async () => {
  const cursors: (string | undefined)[] = [];
  const workspace = (id: string, options = {}) => ({ id, name: `工作区 ${id}`, workspaceDirectory: "/repo", projectRootPath: "/repo", projectKind: "git", archivingAt: null, ...options });
  const choices = await listLaunchWorkspaces({ list: async options => {
    cursors.push(options?.page?.cursor);
    return {
      requestId: "test", pageInfo: { hasMore: !options?.page?.cursor, nextCursor: options?.page?.cursor ? null : "page-2" },
      entries: options?.page?.cursor ? [workspace("b", { workspaceDirectory: "/worktrees/feature" }), workspace("a")]
        : [workspace("a"), workspace("same-directory"), workspace("closing", { archivingAt: "now" }), workspace("not-git", { projectKind: "directory" }), workspace("missing-directory", { workspaceDirectory: undefined })],
    } as PaseoWorkspaceListResult;
  } });
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(choices, [
    { id: "a", name: "工作区 a", directory: "/repo" },
    { id: "same-directory", name: "工作区 same-directory", directory: "/repo" },
    { id: "b", name: "工作区 b", directory: "/worktrees/feature" },
  ]);
});

test("workspace listing fails clearly instead of silently returning an incomplete selection", async () => {
  for (const cursor of [null, "repeated-cursor"]) await assert.rejects(listLaunchWorkspaces({ list: async () => ({ requestId: "test", entries: [], pageInfo: { hasMore: true, nextCursor: cursor, prevCursor: null } }) }), /读取不完整/);
  await assert.rejects(listLaunchWorkspaces({ list: async () => { throw new Error("主机已断开"); } }), /主机已断开/);
});
