import test from "node:test";
import assert from "node:assert/strict";
import { permissionChoices } from "../client/permission-model";
import { SettingsDraftSchema, settingsForm } from "../shared/settings-draft";
import { harness } from "./helpers";

const modes = [
  { id: "auto", label: "Default permissions" },
  { id: "auto-review", label: "Auto-review" },
  { id: "full-access", label: "Full access" },
];

test("following the provider default is distinct from explicitly choosing Default permissions", () => {
  const entry = { status: "ready" as const, modes, defaultModeId: "auto-review" };
  const choices = permissionChoices(entry);
  assert.deepEqual(choices.options.map(option => option.id), ["", "auto", "auto-review", "full-access"]);
  assert.match(choices.options[0].label, /Follow provider default.*Auto review/);
  assert.match(choices.options[1].label, /Default permissions/);
  assert.equal(permissionChoices({ ...entry, defaultModeId: "auto" }).options[0].label, "Follow provider default: Default permissions (Default permissions)");
  assert.equal(permissionChoices({ status: "ready", modes: [{ id: "auto", label: "Auto mode" }], defaultModeId: "auto" }).options[1].label, "Auto mode");
});

test("permissions use the provider catalog and preserve saved selections during discovery and removal", () => {
  assert.deepEqual(permissionChoices().options, [{ id: "", label: "Follow provider default" }]);
  assert.equal(permissionChoices(undefined, "custom").unavailable, false);
  assert.equal(permissionChoices({ status: "loading", modes: [] }, "custom").unavailable, false);
  assert.equal(permissionChoices({ status: "ready" }, "custom").unavailable, false);
  const removed = permissionChoices({ status: "ready", modes }, "custom");
  assert.equal(removed.unavailable, true);
  assert.deepEqual(removed.options.at(-1), { id: "custom", label: "custom (saved, currently unavailable)" });
  const custom = permissionChoices({ status: "ready", modes: [{ id: "custom", label: "自定义权限", description: "供应商的说明" }] }, "custom");
  assert.equal(custom.unavailable, false); assert.equal(custom.description, "供应商的说明");
  assert.equal(custom.options.length, 2);
});

test("independent permission choices and clearing back to the default survive settings and draft storage", async t => {
  const h = await harness(); t.after(() => h.cleanup());
  const settings = h.run().settings;
  settings.profiles[0].modeId = "auto"; settings.profiles[1].modeId = "full-access";
  h.store.saveSettings(settings);
  assert.deepEqual(h.store.settings()?.profiles.map(profile => profile.modeId), ["auto", "full-access"]);
  const form = settingsForm(h.store.settings()!);
  form.profiles[0].modeId = undefined;
  const draft = SettingsDraftSchema.parse(JSON.parse(JSON.stringify({ version: 1, base: settings, form })));
  assert.deepEqual(draft.form.profiles.map(profile => profile.modeId), [undefined, "full-access"]);
  h.store.saveSettings({ ...settings, profiles: draft.form.profiles });
  assert.deepEqual(h.store.settings()?.profiles.map(profile => profile.modeId), [undefined, "full-access"]);
});
