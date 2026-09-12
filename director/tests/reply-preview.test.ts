import test from "node:test";
import assert from "node:assert/strict";
import { plan, result, review } from "./helpers";
import { readDirectorReply, isDirectorReply, ReplyCardSchema } from "../client/reply-model";
import { readDirectorReplyPreview } from "../client/reply-preview";

test("every partial reply stays a preview until the complete response validates", () => {
  for (const payload of [plan, result, review()]) {
    const json = JSON.stringify(payload, null, 2);
    for (const prefix of ["", "\n\n---\n\n", "\n\n---\n\n```json\n"]) {
      for (let end = 1; end < json.length; end++) {
        const raw = prefix + json.slice(0, end);
        assert.equal(readDirectorReply(raw), undefined);
        const preview = readDirectorReplyPreview(raw)!;
        assert.equal(preview.kind, "draft"); assert.equal(preview.raw, raw);
        assert.ok(payload.summary.startsWith(preview.summary));
        assert.deepEqual(ReplyCardSchema.parse(preview), preview);
      }
    }
    assert.notEqual(readDirectorReply(json)?.kind, undefined);
  }
});

test("streamed strings decode split escapes without leaking JSON or replacement characters", () => {
  const summary = '第一行\n引号 "完成"，路径 C:\\new\\test，字面量 \\n，中文 🧭。';
  const encoded = JSON.stringify(summary).replace("中", "\\u4e2d").replace("🧭", "\\ud83e\\udded");
  for (let end = 1; end <= encoded.length; end++) {
    const raw = '{"summary":' + encoded.slice(0, end);
    const preview = readDirectorReplyPreview(raw)!;
    assert.ok(summary.startsWith(preview.summary), JSON.stringify(preview.summary));
    assert.ok(!/[\uD800-\uDBFF]$/.test(preview.summary));
  }
  assert.equal(readDirectorReplyPreview('{"summary":' + encoded)?.summary, summary);
  const raw = '{"summary":"已阅读代码","architecture":"实现方案：\\n1. 保留接口。\\n2. 补充';
  assert.deepEqual(readDirectorReplyPreview(raw), { kind: "draft", stage: "plan", summary: "已阅读代码", architecture: "实现方案：\n1. 保留接口。\n2. 补充", raw });
});

test("only top-level preview fields are read, regardless of key order", () => {
  const raw = '{"tasks":[{"summary":"不要展示嵌套字段", "description":"带 } 和 \\" 的字符串"}],"architecture":"方案","summary":"真正的摘要';
  const preview = readDirectorReplyPreview(raw)!;
  assert.equal(preview.summary, "真正的摘要"); assert.equal(preview.architecture, "方案");
  assert.equal(preview.stage, "plan");
  assert.equal(readDirectorReplyPreview('{"decision":"approved","summary":"审核中')?.stage, "review");
  assert.equal(readDirectorReplyPreview('{"status":"ready_for_review","summary":"实现中')?.stage, "result");
});

test("ordinary prose and unrelated objects remain untouched; unfinished replies never become results", () => {
  for (const raw of ["", "阅读项目中", "示例：\n" + JSON.stringify(plan), '{"query":"abc"}', '[{"summary":"abc"}]', "```typescript\nconst plan = {};"]) assert.equal(readDirectorReplyPreview(raw), undefined);
  for (const raw of ['{"summary":"未结束\\u4', '{"decision":"approved","summary":"缺少验收项"}', '{"summary":"格式有误\\x20"}']) {
    assert.equal(readDirectorReply(raw), undefined);
    assert.equal(readDirectorReplyPreview(raw)?.kind, "draft");
  }
  assert.equal(isDirectorReply({}, "draft"), false);
  assert.equal(isDirectorReply({ "director-run": "run", "director-role": "other" }, "draft"), false);
  for (const role of ["director", "worker"]) assert.equal(isDirectorReply({ "director-run": "run", "director-role": role }, "draft"), true);
});
