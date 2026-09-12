import assert from "node:assert/strict";
import test from "node:test";
import { DraftWriter } from "../client/draft-writer";
import { documentKey, formChanged, settingsForm, type SettingsDraft } from "../shared/settings-draft";
import { harness, settings } from "./helpers";

const draft = (text = "待保存的执行要求"): SettingsDraft => ({ version: 1, base: settings(), form: { ...settingsForm(settings()), rolePrompts: { execute: text } } });

test("incomplete settings drafts survive a restart without becoming active settings", async t => {
  const h = await harness(); t.after(() => h.cleanup()); h.store.saveSettings(settings());
  const value = draft(); value.form.maxReworks = ""; value.form.extraProfile = { id: "extra", label: "", provider: "vendor/", transport: "structured", instructions: "字".repeat(8001) };
  value.form.checkLine = "npm test --"; value.form.showCommand = true; value.form.step = 1;
  const saved = h.store.writeSettingsDraft({ revision: 0, draft: value });
  await h.restart();
  assert.deepEqual(h.store.settingsDraft(), saved);
  assert.deepEqual(h.store.settings(), settings());
  assert.deepEqual(h.run().settings, settings());
});

test("saving settings clears only the matching draft in the same transaction", async t => {
  const h = await harness(); t.after(() => h.cleanup()); h.store.saveSettings(settings());
  const value = draft(), state = h.store.writeSettingsDraft({ revision: 0, draft: value });
  const changed = { ...settings(), rolePrompts: value.form.rolePrompts };
  h.store.commitSettings(changed, settings(), state.revision);
  assert.deepEqual(h.store.settings(), changed);
  assert.deepEqual(h.store.settingsDraft(), { revision: state.revision + 1, draft: null });
  // An older window cannot reintroduce the draft after the successful save.
  assert.throws(() => h.store.writeSettingsDraft({ revision: state.revision, draft: value }), /另一窗口/);
  assert.deepEqual(h.run().settings, settings());
});

test("conflicting drafts and changed active settings do not overwrite either document", async t => {
  const h = await harness(); t.after(() => h.cleanup()); h.store.saveSettings(settings());
  const state = h.store.writeSettingsDraft({ revision: 0, draft: draft("来自窗口 A") });
  assert.throws(() => h.store.writeSettingsDraft({ revision: 0, draft: draft("来自窗口 B") }), /另一窗口/);
  assert.throws(() => h.store.commitSettings(settings(), settings(), 0), /另一窗口/);
  const changed = { ...settings(), maxReworks: 4 }; h.store.saveSettings(changed);
  assert.throws(() => h.store.commitSettings(settings(), settings(), state.revision), /已生效的设置/);
  assert.deepEqual(h.store.settingsDraft(), state);
  assert.deepEqual(h.store.settings(), changed);
  // Validation failure also rolls back the draft clear.
  assert.throws(() => h.store.commitSettings({ ...changed, maxAttempts: 0 }, changed, state.revision));
  assert.deepEqual(h.store.settingsDraft(), state);
});

test("drafts for first-time setup can be discarded without creating settings", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const value: SettingsDraft = { version: 1, base: null, form: { ...settingsForm(null), rolePrompts: { plan: "先阅读项目" } } };
  const state = h.store.writeSettingsDraft({ revision: 0, draft: value });
  h.store.writeSettingsDraft({ revision: state.revision, draft: null });
  assert.equal(h.store.settingsDraft().draft, null);
  assert.equal(h.store.settings(), undefined);
});

test("draft writer serializes and coalesces edits before a settings commit", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: { revision: number; draft: SettingsDraft | null }[] = [];
  const writer = new DraftWriter(3, async input => { calls.push(input); if (calls.length === 1) await gate; return { ...input, revision: input.revision + 1 }; });
  writer.enqueue(draft("first")); await Promise.resolve();
  writer.enqueue(draft("middle")); writer.enqueue(draft("latest"));
  const flushed = writer.flush(); release(); await flushed;
  assert.deepEqual(calls.map(call => call.revision), [3, 4]);
  assert.deepEqual(calls.map(call => call.draft?.form.rolePrompts.execute), ["first", "latest"]);
  assert.equal(writer.revision, 5); assert.equal(writer.busy, false);
});

test("failed draft writes retain the most recent edit for an explicit retry", async () => {
  let attempts = 0;
  const writer = new DraftWriter(0, async input => { if (++attempts === 1) throw new Error("offline"); return { ...input, revision: input.revision + 1 }; });
  writer.enqueue(draft("first")); await assert.rejects(writer.flush(), /offline/);
  writer.enqueue(draft("latest")); assert.equal(attempts, 1);
  await writer.flush(); assert.equal(writer.revision, 1); assert.equal(writer.error, null); assert.equal(writer.busy, false);
});

test("step navigation is not an unsaved edit and document comparison ignores key order", () => {
  assert.equal(formChanged({ ...settingsForm(settings()), step: 2 }, settings()), false);
  assert.equal(formChanged(draft().form, settings()), true);
  assert.equal(documentKey({ a: 1, b: { x: 2, y: 3 } }), documentKey({ b: { y: 3, x: 2 }, a: 1 }));
});
