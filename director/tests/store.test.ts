import test from "node:test";
import assert from "node:assert/strict";
import { harness, plan } from "./helpers";

test("pending plan approval survives restart without recreating the planning session", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  await h.until("plan"); await h.complete(plan);
  const original = { ...h.run(), workspaceId: "original-workspace" }; h.store.save(original);
  for (let i = 0; i < 30; i++) h.store.insert({ ...original, id: `other-${i}`, requestId: `other-${i}`, workspaceId: "other-workspace" });
  h.store.insert({ ...original, id: "newer-canceled", requestId: "newer-canceled", control: "canceled" });
  await h.restart();
  assert.equal(h.run().planApproved, false);
  assert.equal(h.run().control, "paused");
  assert.equal(h.agents.created.length, 1);
});

