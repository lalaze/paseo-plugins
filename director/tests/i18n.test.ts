import assert from "node:assert/strict";
import test from "node:test";
import { localizeDirectorMessage, resolveUiLocale } from "../client/i18n";

test("uses the explicit Paseo language before the system locale", () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: "zh-CN" }) },
    navigator: { languages: ["en-US"] },
  }), "zh-CN");
});

test("follows the system locale when Paseo is set to system", () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: "system" }) },
    navigator: { languages: ["zh-Hans-US", "en-US"] },
  }), "zh-CN");
});

test("uses English for unsupported explicit Paseo languages", () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: "ja" }) },
    navigator: { languages: ["zh-CN"] },
  }), "en");
});

test("turns server-side Chinese errors into English UI messages", () => {
  assert.equal(localizeDirectorMessage("仓库路径必须是绝对路径"), "The repository path must be absolute.");
  assert.match(localizeDirectorMessage("指定的 AI 不可用：vendor/model；请检查 Paseo 的供应商登录与模型配置"), /Selected AI unavailable: vendor\/model/);
  assert.doesNotMatch(localizeDirectorMessage("未识别的后台错误"), /[\u3400-\u9fff]/u);
});
