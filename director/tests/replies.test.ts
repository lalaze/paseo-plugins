import test from "node:test";
import assert from "node:assert/strict";
import { plan, result, review } from "./helpers";
import { readDirectorReply, isDirectorReply, ReplyCardSchema } from "../client/reply-model";

test("decodes JSON escapes once while retaining the exact original reply", () => {
  const payload = { ...plan, architecture: '共享接口：\n1. 保留 "引号"。\n2. Windows 路径 C:\\new\\test\n3. 字面量 \\n 保持不变。' };
  for (const raw of [JSON.stringify(payload), `\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`]) {
    const card = readDirectorReply(raw)!;
    assert.equal(card.kind, "plan"); assert.equal(card.raw, raw);
    assert.deepEqual(card.payload, payload);
    assert.deepEqual(ReplyCardSchema.parse(JSON.parse(JSON.stringify(card))), card);
  }
});

test("supports plans, worker results and every review decision", () => {
  for (const [kind, payload] of [["plan", plan], ["result", result], ["result", { ...result, status: "blocked", issues: ["缺少依赖"] }], ["review", review()], ["review", review(false, "changes_requested")], ["review", review(true, "blocked")]] as const) {
    const card = readDirectorReply(JSON.stringify(payload))!;
    assert.equal(card.kind, kind); assert.deepEqual(card.payload, payload);
  }
});

test("projected Paseo history dividers and optional code fences remain readable", () => {
  const json = JSON.stringify(plan, null, 2);
  for (const raw of [`\n\n---\n\n${json}`, `\r\n---\r\n\r\n\`\`\`json\r\n${json}\r\n\`\`\``, `\`\`\`\n${json}\n\`\`\``]) {
    const card = readDirectorReply(raw)!;
    assert.equal(card.kind, "plan"); assert.equal(card.raw, raw); assert.deepEqual(card.payload, plan);
  }
  assert.equal(readDirectorReply(`---\n解释和示例\n${json}`), undefined);
});

test("incomplete output, examples, extra fields and malformed JSON are not consumed", () => {
  const raw = JSON.stringify(plan);
  for (let i = 0; i < raw.length; i++) assert.equal(readDirectorReply(raw.slice(0, i)), undefined);
  for (const text of ["普通进度消息", `示例：\n${raw}`, `${raw}\n接下来需要你确认`, JSON.stringify({ ...plan, extra: "不要丢弃" }), JSON.stringify([plan]), raw + raw, '{"summary":"line\nbreak"}', JSON.stringify({ ...review(), criteria: [] })]) assert.equal(readDirectorReply(text), undefined);
  assert.equal(readDirectorReply(raw)?.kind, "plan");
});

test("only matching Director agent roles present a reply card", () => {
  for (const kind of ["plan", "result", "review"] as const) {
    assert.equal(isDirectorReply({}, kind), false);
    assert.equal(isDirectorReply({ "director-role": "director" }, kind), false);
  }
  const lead = { "director-run": "run-1", "director-role": "director" }, worker = { ...lead, "director-role": "worker" };
  assert.equal(isDirectorReply(lead, "plan"), true); assert.equal(isDirectorReply(lead, "review"), true);
  assert.equal(isDirectorReply(worker, "result"), true);
  assert.equal(isDirectorReply(worker, "plan"), false); assert.equal(isDirectorReply(lead, "result"), false);
  const reviewer = { ...lead, "director-role": "reviewer" };
  assert.equal(isDirectorReply(reviewer, "review"), true); assert.equal(isDirectorReply(reviewer, "draft"), true);
  assert.equal(isDirectorReply(reviewer, "plan"), false); assert.equal(isDirectorReply(reviewer, "result"), false);
});
