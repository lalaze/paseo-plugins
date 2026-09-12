import test from "node:test";
import assert from "node:assert/strict";
import { harness, plan } from "./helpers";

test("workspace restore finds a pending approval beyond history pagination after restart", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  const original = { ...h.run(), workspaceId: "original-workspace" }; h.store.save(original);
  for (let i = 0; i < 30; i++) h.store.insert({ ...original, id: `other-${i}`, requestId: `other-${i}`, workspaceId: "other-workspace" });
  h.store.insert({ ...original, id: "newer-canceled", requestId: "newer-canceled", control: "canceled" });
  assert.equal(h.store.page(0, 20).runs.some(r => r.id === original.id), false);
  await h.restart();
  assert.equal(h.store.workspaceRunId("original-workspace"), original.id);
  assert.equal(h.store.workspaceRunId("other-workspace"), "other-29");
  assert.equal(h.store.workspaceRunId("unknown-workspace"), null);
  assert.equal(h.run().planApproved, false);
  assert.equal(h.run().control, "paused");
  assert.equal(h.agents.created.length, 1);
});

test("workspace restore opens the latest result when no unfinished run remains", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const original = { ...h.run(), workspaceId: "workspace", phase: "completed" as const }; h.store.save(original);
  h.store.insert({ ...original, id: "latest", requestId: "latest" });
  // Same directory does not mean the same Paseo workspace.
  h.store.insert({ ...original, id: "elsewhere", requestId: "elsewhere", workspaceId: "elsewhere", phase: "planning" });
  assert.equal(h.store.workspaceRunId("workspace"), "latest");
});
