import test from "node:test";
import assert from "node:assert/strict";
import { resolveUiLocale } from "../client/i18n";

test("follows the explicit Paseo language or the desktop language", () => {
  assert.equal(resolveUiLocale({ localStorage: { getItem: () => JSON.stringify({ language: "zh-CN" }) }, navigator: { language: "en-US" } }), "zh-CN");
  assert.equal(resolveUiLocale({ localStorage: { getItem: () => JSON.stringify({ language: "system" }) }, navigator: { language: "zh-Hans" } }), "zh-CN");
  assert.equal(resolveUiLocale({ localStorage: { getItem: () => JSON.stringify({ language: "fr" }) }, navigator: { language: "zh-CN" } }), "en");
});
