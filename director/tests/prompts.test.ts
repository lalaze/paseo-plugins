import test from "node:test";
import assert from "node:assert/strict";
import { harness, plan, result, review } from "./helpers";
import { buildPrompt } from "../server/prompts";
import { PromptCardSchema, readDirectorPrompt } from "../client/prompt-model";

test("all workflow prompts become readable cards while preserving the complete original", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  for (const [kind, payload] of [["plan", plan], ["execute", result], ["final", review(true)]] as const) {
    const op = await h.until(kind);
    const card = readDirectorPrompt(op.prompt)!;
    assert.equal(PromptCardSchema.safeParse(card).success, true);
    assert.equal(card.stage, kind); assert.equal(card.goal, h.run().goal);
    assert.equal(card.raw, op.prompt);
    assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
    if (kind === "plan") assert.deepEqual(card.team.map(p => p.name), ["总 AI · vendor-a/model-a", "执行 AI · vendor-b/model-b"]);
    if (kind === "execute") assert.deepEqual(card.files, plan.tasks[0].files);
    if (kind === "final") assert.deepEqual(card.acceptance, [...plan.acceptance, ...plan.tasks[0].acceptance]);
    await h.complete(payload);
  }
});

test("legacy prompts, approval mode, JSON-like goals and retry suffixes remain readable", async t => {
  const h = await harness({ requirePlanApproval: true }); t.after(() => h.cleanup());
  const run = h.run(); run.goal = '支持 {"name":"中文"} 和\n多行目标';
  const prompt = buildPrompt(run, "plan", "22df95f7-5163-4c55-9137-c8df04ed73f7");
  assert.match(readDirectorPrompt(prompt)!.next, /等你确认/);
  const legacy = prompt.replace(/^  "branch":.*\n/m, "").replace(/^  "requirePlanApproval":.*\n/m, "");
  const card = readDirectorPrompt(legacy + "\n上一轮结果格式错误，请补交正确格式。")!;
  assert.equal(card.goal, run.goal); assert.equal(card.branch, undefined);
  assert.match(card.next, /已保存的协作设置/);
});

test("ordinary, unrelated, malformed and incomplete messages are not replaced", async t => {
  const h = await harness(); t.after(() => h.cleanup()); const op = await h.until("plan");
  for (const raw of ["你好", "解释一下 " + op.prompt, op.prompt.slice(0, 200), op.prompt.replace('"goal":', '"goal": BROKEN'), op.prompt.replace("你是总 AI。", "普通聊天。"), op.prompt.replace("。如果有 submit_plan 工具，", "。如果有 other_tool 工具，")]) assert.equal(readDirectorPrompt(raw), undefined);
});
