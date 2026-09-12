import test from "node:test";
import assert from "node:assert/strict";
import { createRunHint, runPresentation, runStatus } from "../client/run-model";
import type { Run } from "../shared/schema";
import { settings, plan } from "./helpers";

function run(patch: Partial<Run> = {}): Run {
  return { id: "demo", requestId: "demo", revision: 1, goal: "实现功能", repository: "/repo", cwd: "/repo", baseCommit: "base", branch: "director/demo", settings: settings(), createdAt: 1, updatedAt: 1, phase: "planning", control: "running", message: "", planApproved: false, tasks: [], operations: [], events: [], ...patch };
}

test("permission, stop and blocked states take priority over the workflow phase", () => {
  for (const phase of ["planning", "executing", "reviewing", "final_review", "awaiting_acceptance", "completed"] as const) {
    assert.equal(runStatus({ phase, control: "waiting_permission" }).label, "等待权限 / 回答");
    assert.equal(runStatus({ phase, control: "needs_attention" }).tone, "danger");
    assert.equal(runStatus({ phase, control: "canceled" }).label, "已结束");
    assert.equal(runStatus({ phase, control: "canceling" }).label, "正在停止");
  }
  assert.match(runPresentation(run({ control: "waiting_permission" })).next, /处理权限请求.*自动继续/);
  assert.match(runPresentation(run({ control: "paused" })).next, /当前 AI 仍可能完成本轮/);
});

test("plan confirmation is shown only when a saved plan actually needs approval", () => {
  assert.equal(runPresentation(run({ control: "paused" })).awaitingPlan, false);
  const approval = runPresentation(run({ control: "paused", plan }));
  assert.equal(approval.awaitingPlan, true);
  assert.equal(approval.status.label, "等待你确认总纲");
  assert.equal(runPresentation(run({ phase: "executing", control: "paused", plan })).stage, 0);
  assert.equal(runPresentation(run({ control: "paused", plan, planApproved: true })).awaitingPlan, false);
  assert.equal(runPresentation(run({ control: "canceled", plan })).awaitingPlan, false);
});

test("legacy AI completion still displays user acceptance instead of a finished workflow", () => {
  const final = run({ phase: "completed", planApproved: true, finalReview: { decision: "approved", artifactId: "a", summary: "通过", criteria: [], findings: [] }, finalEvidence: { id: "a", tree: "tree", diffPath: "/diff", changedFiles: [], diff: "", checks: [], passed: true, capturedAt: 1 } });
  const presentation = runPresentation(final);
  assert.equal(presentation.status.label, "等待你验收");
  assert.equal(presentation.awaitingFinal, true);
  assert.equal(presentation.ended, false);
  assert.equal(presentation.stage, 3);
  assert.match(presentation.next, /再验收或提交修改意见/);
  const accepted = runPresentation({ ...final, userAcceptance: { decision: "approved", artifactId: "a", decidedAt: 2 } });
  assert.equal(accepted.ended, true);
  assert.equal(accepted.status.label, "已完成");
  const rejected = runPresentation({ ...final, control: "canceled", userAcceptance: { decision: "rejected", artifactId: "a", decidedAt: 2 } });
  assert.equal(rejected.awaitingFinal, false);
  assert.equal(rejected.status.label, "已结束");
});

test("progress counts reviewed tasks, and keeps rework in the execution stage", () => {
  const executing = run({ phase: "reviewing", tasks: [
    { spec: plan.tasks[0], profileId: "worker", status: "approved", reworks: 0 },
    { spec: { ...plan.tasks[0], id: "task-2" }, profileId: "worker", status: "executing", reworks: 1 },
  ] });
  assert.equal(runPresentation(executing).stage, 1);
  assert.equal(runPresentation(executing).done, 1);
  assert.equal(runPresentation({ ...executing, phase: "final_review" }).stage, 2);
  assert.equal(runPresentation({ ...executing, phase: "planning", tasks: [] }).stage, 0);
});

test("creation explains missing inputs and validates the trimmed goal and absolute path", () => {
  const valid = { goal: "实现功能", directory: "/repo", needsWorkspace: false };
  assert.match(createRunHint({ ...valid, needsWorkspace: true })!, /先选择/);
  assert.match(createRunHint({ ...valid, directory: " " })!, /绝对路径/);
  assert.match(createRunHint({ ...valid, directory: "project" })!, /绝对路径/);
  assert.match(createRunHint({ ...valid, goal: " \n " })!, /目标与验收要求/);
  assert.match(createRunHint({ ...valid, goal: "字".repeat(32001) })!, /32000/);
  assert.equal(createRunHint({ ...valid, goal: ` ${"字".repeat(32000)} ` }), null);
  for (const directory of ["/repo with spaces", "C:\\Users\\project", "D:/project", "\\\\server\\share\\project"]) assert.equal(createRunHint({ ...valid, directory }), null);
});
