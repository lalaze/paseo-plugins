// @vitest-environment jsdom
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { TextEncoder } from "node:util";
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoCatalog, demoColors, demoData } from "../validation/fixtures";
import { Modal } from "../validation/modal";
import { actionSchema, type Action, type Page } from "../shared/rpc";
import { demoFeature } from "../validation/features";
import { mutateFeature, type Feature } from "../shared/features";

const require = createRequire(import.meta.url);
// esbuild expects the encoder and typed array to come from the same realm.
Object.assign(globalThis, {
  Uint8Array: Object.getPrototypeOf(new TextEncoder().encode("")).constructor,
});
const { buildSync } = require("esbuild");
const ReactNative = require("react-native-web");
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
const source = buildSync({
  entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), "main.tsx")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  packages: "external",
  jsx: "automatic",
}).outputFiles[0].text;
const actions: Action[] = [];
const featureActions: { operation: string; body: object }[] = [];
const revealed: string[] = [];
const copied: string[] = [];
const readers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
const demo = demoData("agents");
const modules: Record<string, unknown> = {
  "react-native": ReactNative,
  "@getpaseo/plugin/client": {
    useRpc: (contract: { name: string }) => {
      if (!readers.has(contract.name))
        readers.set(contract.name, async (input) => {
          if (contract.name === "magpie.page.read") return { ...demo, page: input.page as Page };
          if (contract.name === "magpie.feature.read")
            return { data: demoFeature(input.feature as Feature) };
          if (contract.name === "magpie.feature.mutate") {
            const action = mutateFeature.input.parse(input);
            featureActions.push(action);
            return {
              data:
                action.operation === "library.mcp.signin"
                  ? { id: "mcp-demo", state: "waiting", url: "https://auth.example.test/authorize" }
                  : { saved: true },
            };
          }
          if (contract.name === "magpie.plugins.catalog")
            return demoCatalog(input.source as "suggested" | "github" | "npm");
          if (contract.name === "magpie.gateway.key.reveal") {
            revealed.push(String(input.id));
            return { secret: "sk-magpie-key-explicit-reveal" };
          }
          if (contract.name === "magpie.action.run") {
            const action = actionSchema.parse(input);
            actions.push(action);
            if (action.type === "agent.set") demo.agents[0].fields[0].value = action.value;
            return { notice: "已保存到 Magpie。" };
          }
          if (contract.name === "magpie.transcript.read")
            return {
              parts: [
                { role: "user", kind: "text", text: "实现一个任务队列" },
                {
                  role: "assistant",
                  kind: "text",
                  text: "已实现队列和状态更新。",
                },
              ],
              cut: false,
            };
          throw new Error(`Unexpected RPC ${contract.name}`);
        });
      return readers.get(contract.name);
    },
  },
  // Deliberately contains no WebFrame: this is the released client's available native UI.
  "@getpaseo/plugin/client/react-native": {
    Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
    Modal,
    ScrollView: ReactNative.ScrollView,
    TextInput: ReactNative.TextInput,
    copyText: async (value: string) => {
      copied.push(value);
    },
  },
  "@getpaseo/plugin/client/ui": { ExternalLink: "a" },
};
const module = { exports: {} };
runInNewContext(source, {
  module,
  exports: module.exports,
  require: (id: string) => modules[id] ?? require(id),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
const { MagpieScreen } = module.exports as {
  MagpieScreen: ComponentType<object>;
};
let root: Root;
let cache: InstanceType<typeof QueryClient>;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function click(label: string, role = "button") {
  const element = document.querySelector<HTMLElement>(`[role="${role}"][aria-label="${label}"]`);
  expect(element, `Missing ${role} ${label}`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  expect(input, `Missing input ${label}`).not.toBeNull();
  await act(async () => {
    const prototype =
      input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function render(compact = false) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(MagpieScreen, {
          host: { id: "test-host", label: "Mac mini" },
          theme: { colors: demoColors },
          layout: { compact },
        }),
      ),
    );
  });
  await settle();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.length = 0;
  featureActions.length = 0;
  revealed.length = 0;
  copied.length = 0;
  demo.agents[0].fields[0].value = "openai/gpt-4.1";
  demo.groups[0].routing = "order";
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
});

describe("native Magpie UI on the released Paseo runtime", () => {
  it("saves ordinary settings at 100% and uses the dedicated zoom route", async () => {
    await render();
    await click("设置", "tab");
    await click("保存设置");
    expect(actions[0]).toMatchObject({ type: "settings.save" });
    expect(actions[0]).not.toHaveProperty("settings.textSize");
    await click("Magpie 窗口缩放：100%");
    await click("125%");
    expect(actions[1]).toEqual({ type: "settings.textSize", size: 125 });
  });
  it("renders all eight settings sections and sends changed privacy fields only", async () => {
    await render();
    await click("设置", "tab");
    for (const label of [
      "通用",
      "额度",
      "网络与共享",
      "模型",
      "隐私",
      "可观测性",
      "同步与备份",
      "关于",
    ]) {
      await click(label);
    }
    await click("隐私");
    await click("不读取 Agent 的订阅登录", "switch");
    await click("保存隐私");
    expect(featureActions).toEqual([
      { operation: "preferences.patch", body: { noAccountDiscovery: true } },
    ]);
  });
  it("edits shared instructions and creates a Hook with its default event and agents", async () => {
    await render();
    await click("资源库", "tab");
    await fill("共享指令 Markdown", "Use meaningful names.");
    await click("保存共享指令");
    expect(featureActions[0]).toEqual({
      operation: "library.instructions",
      body: { set: "shared", text: "Use meaningful names." },
    });
    await click("Hooks");
    const names = document.querySelectorAll('[aria-label="Hook 名称"]');
    expect(names.length).toBeGreaterThan(0);
    await fill("Hook 名称", "test-hook");
    await fill("执行命令", "echo complete");
    await click("保存新建 Hook");
    expect(featureActions[1]).toMatchObject({
      operation: "library.hooks.save",
      body: {
        old: "",
        name: "test-hook",
        command: "echo complete",
        event: "turn-end",
        agents: ["codex", "claude"],
      },
    });
  });
  it("searches settings across sections and preserves the account auto-reset condition", async () => {
    await render();
    await click("设置", "tab");
    await fill("搜索全部设置", "noUsageStats");
    expect(document.body.textContent).toContain("关闭 Agent、供应商和模型统计");
    expect(document.body.textContent).not.toContain("同时保持屏幕开启");
    await fill("搜索全部设置", "");
    await click("额度");
    await click("自动使用重置", "switch");
    await click("保存自动使用重置");
    expect(featureActions[0]).toEqual({
      operation: "settings.codex-auto-reset",
      body: { user: "demo@example.test", on: false, when: "expiring" },
    });
  });
  it("loads each budget window and saves only the selected window", async () => {
    await render();
    await click("网关", "tab");
    await click("预算窗口：窗口 1 · day");
    await click("窗口 2 · week");
    const input = document.querySelector<HTMLInputElement>('[aria-label="Token 上限（0 不限制）"]');
    expect(input?.value).toBe("700000");
    await fill("Token 上限（0 不限制）", "800000");
    await click("保存密钥预算");
    expect(featureActions[0]).toMatchObject({
      operation: "gateway.key.limit",
      body: { key: "laptop-key", index: 1, period: "week", tokens: 800000, cost: 20 },
    });
    await click("移除此预算窗口");
    expect(featureActions).toHaveLength(1);
    await click("确认移除此预算窗口");
    expect(featureActions[1]).toEqual({
      operation: "gateway.key.limit",
      body: { key: "laptop-key", index: 1, limit: null },
    });
  });
  it("follows MCP authorization and provides a cancel action", async () => {
    await render();
    await click("资源库", "tab");
    await click("MCP 配置");
    await click("MCP 账号授权");
    expect(document.querySelector('a[href="https://auth.example.test/authorize"]')).not.toBeNull();
    expect(document.body.textContent).toContain("授权状态会自动更新");
    await click("取消 MCP 授权");
    expect(featureActions).toEqual([
      { operation: "library.mcp.signin", body: { name: "文档检索" } },
      { operation: "library.mcp.cancel", body: { id: "mcp-demo" } },
    ]);
    expect(document.body.textContent).toContain("授权已取消");
  });
  it("exports the whole request filter and uses the API's failed flag", async () => {
    await render();
    await click("用量", "tab");
    await click("请求结果：全部");
    await click("失败");
    await fill("搜索模型、会话、供应商", "gpt");
    await click("导出筛选结果全部 CSV 到主机");
    expect(featureActions[0]).toEqual({
      operation: "usage.export",
      body: { period: "7d", q: "gpt", failed: "1" },
    });
  });
  it("loads current extension options before editing", async () => {
    await render();
    await click("插件", "tab");
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="页面参数 JSON"]')?.value,
    ).toContain('"theme": "dark"');
  });
  it("edits a routing rule through native controls and preserves its conditions", async () => {
    await render();
    await click("路由", "tab");
    await click("规则与高级配置");
    await click("编辑 日常编程 的高级配置");
    await click("添加路由规则");
    await fill("规则 1 意图描述", "writing tests");
    await fill("规则 1 Agent ID（一行一个）", "codex\nclaude");
    await fill("规则 1 最低 Token 数", "50000");
    await click("规则 1 限定生效时间", "switch");
    await fill("规则 1 开始时间（HH:MM）", "09:00");
    await fill("规则 1 结束时间（HH:MM）", "18:00");
    await click("规则 1 周一", "switch");
    await click("保存路由规则");
    expect(featureActions[0]).toMatchObject({
      operation: "groups.save",
      body: {
        id: "daily",
        rules: [
          {
            use: "openai/gpt-4.1",
            intent: "writing tests",
            tokens: 50000,
            agents: ["codex", "claude"],
            time: { from: "09:00", to: "18:00", days: ["mon"] },
          },
        ],
      },
    });
  });
  it("requires confirmation before importing a backup and sends the chosen restore parts", async () => {
    await render();
    await click("设置", "tab");
    await click("同步与备份");
    await fill("备份文件在主机上的路径", "/tmp/example.magpie");
    await click("保存导入加密备份");
    expect(featureActions).toEqual([]);
    await click("确认保存导入加密备份");
    expect(featureActions[0]).toEqual({
      operation: "backup.import",
      body: { path: "/tmp/example.magpie", agents: false, library: true },
    });
  });
  it("preserves all Agent arrangement lists when editing only one", async () => {
    await render();
    await fill("隐藏的 Agent（一行一个 ID）", "claude");
    await click("保存Agent 排序和显示");
    expect(featureActions[0]).toEqual({
      operation: "agents.arrange",
      body: { order: ["codex", "claude"], hidden: ["claude"], shown: [] },
    });
  });
  it("can open a ranked session's analysis details", async () => {
    await render();
    await click("用量", "tab");
    await click("会话分析");
    expect(document.body.textContent).toContain("会话 Token 中位数");
    await click("查看会话分析 codex:demo-session");
    expect(document.body.textContent).toContain("关闭会话分析详情");
    expect(document.body.textContent).toContain("20000");
  });
  it("edits a model's context window without replacing other model settings", async () => {
    await render();
    await click("供应商", "tab");
    await click("模型与账户");
    await click("要调整的模型：选择一个模型");
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"][aria-label="GPT-4.1"]'),
    );
    expect(options).toHaveLength(1);
    await act(async () => {
      options[0].click();
    });
    await settle();
    await fill("模型上下文窗口（Token，0 默认）", "128000");
    await click("保存模型参数");
    expect(featureActions[0]).toEqual({
      operation: "provider.modelprefs",
      body: { id: "openai", model: "gpt-4.1", context: 128000 },
    });
  });
  it("requires confirmation before permanently purging trash", async () => {
    await render();
    await click("会话", "tab");
    await click("回收站");
    await click("永久删除会话");
    expect(featureActions).toEqual([]);
    await click("确认永久删除会话");
    expect(featureActions).toEqual([
      { operation: "sessions.purge", body: { keys: ["trash-demo"] } },
    ]);
  });
  it("changes sharing through its own action and reveals credentials only on demand", async () => {
    await render();
    await click("设置", "tab");
    expect(document.body.textContent).toContain("局域网共享");
    expect(document.body.textContent).toContain("http://100.96.195.115:3425");
    await click("共享 Magpie 网关", "switch");
    expect(actions).toEqual([{ type: "settings.lan", on: false }]);
    await click("网关", "tab");
    expect(revealed).toEqual([]);
    expect(document.body.textContent).not.toContain("sk-magpie-key-explicit-reveal");
    await click("查看并复制密钥");
    expect(revealed).toEqual(["laptop-key"]);
    await click("复制网关密钥");
    expect(copied).toEqual(["sk-magpie-key-explicit-reveal"]);
    await click("完成");
    expect(document.body.textContent).not.toContain("sk-magpie-key-explicit-reveal");
    await click("删除网关密钥");
    expect(actions).toHaveLength(1);
    await click("确认删除网关密钥");
    expect(actions[1]).toEqual({
      type: "gateway.key.change",
      id: "laptop-key",
      operation: "remove",
    });
  });
  it("accepts a Remote magpie address in the provider form", async () => {
    await render();
    await click("供应商", "tab");
    await click("添加供应商");
    await click("供应商预设：自定义供应商");
    await click("Remote magpie");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="远程 Magpie 地址"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "http://100.96.195.115:3425",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("保存供应商");
    expect(actions[0]).toMatchObject({
      type: "provider.save",
      fresh: true,
      draft: {
        preset: "remote-magpie",
        chat: "http://100.96.195.115:3425",
      },
    });
  });
  it("renders the native navigation and Agent controls without WebFrame", async () => {
    await render();
    expect(document.body.textContent).toContain("Codex");
    expect(document.body.textContent).not.toContain("不支持内嵌");
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(9);
  });
  it("sends the selected Agent model to the real typed action contract", async () => {
    await render();
    await click("模型：GPT-4.1 · OpenAI");
    await click("DeepSeek V3");
    expect(actions).toEqual([
      { type: "agent.set", id: "codex", field: "model", value: "deepseek/v3" },
    ]);
    expect(document.body.textContent).toContain("已保存到 Magpie");
  });
  it("renders every navigation page with its native content", async () => {
    await render();
    for (const [tab, text] of [
      ["会话", "实现新的任务队列"],
      ["资源库", "文档检索"],
      ["供应商", "OpenAI"],
      ["路由", "日常编程"],
      ["网关", "本机 API 入口"],
      ["用量", "估算费用"],
      ["插件", "插件扩展 magpie"],
      ["设置", "关于此 Magpie 实例"],
    ]) {
      await click(tab, "tab");
      expect(document.body.textContent).toContain(text);
    }
    expect(actions).toEqual([]);
  });
  it("reads a conversation only when the user opens it", async () => {
    await render();
    await click("会话", "tab");
    await click("查看会话");
    expect(document.body.textContent).toContain("已实现队列和状态更新");
    await click("返回会话列表");
    expect(document.body.textContent).toContain("实现新的任务队列");
  });
  it("requires an explicit confirmation before deleting a provider", async () => {
    await render();
    await click("供应商", "tab");
    await click("模型与账户");
    await click("删除供应商");
    expect(actions).toHaveLength(0);
    await click("确认删除供应商");
    expect(actions[0]).toEqual({ type: "provider.delete", id: "openai" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("opens provider management in a dismissible dialog on desktop and mobile", async () => {
    for (const compact of [false, true]) {
      await render(compact);
      await click("供应商", "tab");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await click("模型与账户");
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-label")).toBe("OpenAI · 模型与账户");
      expect(dialog?.textContent).toContain("工作密钥");
      await click("编辑");
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.querySelector('[role="dialog"] input[aria-label="显示名称"]')).not.toBeNull();
      await click("取消");
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("工作密钥");
      await click("关闭弹窗");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    expect(actions).toEqual([]);
  });
  it("provides the same pages on a compact mobile layout", async () => {
    await render(true);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(9);
    await click("路由", "tab");
    await click("新建路由组");
    expect(document.body.textContent).toContain("添加模型成员");
    expect(actions).toHaveLength(0);
  });
  it("confirms before disconnecting an Agent from the row switch", async () => {
    await render();
    await click("将 Codex 接入 magpie", "switch");
    expect(actions).toHaveLength(0);
    await click("取消");
    expect(actions).toHaveLength(0);
    await click("将 Codex 接入 magpie", "switch");
    await click("确认断开接入");
    expect(actions).toEqual([{ type: "agent.disconnect", id: "codex" }]);
  });
  it("restores navigation after collapsing the sidebar", async () => {
    await render();
    await click("隐藏侧边栏");
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    await click("显示侧边栏");
    await click("供应商", "tab");
    expect(document.body.textContent).toContain("OpenAI");
    expect(actions).toHaveLength(0);
  });
  it("saves a provider form without inventing a replacement API key", async () => {
    await render();
    await click("供应商", "tab");
    await click("模型与账户");
    await click("编辑");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="显示名称"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "OpenAI 工作",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("保存供应商");
    expect(actions[0]).toMatchObject({
      type: "provider.save",
      fresh: false,
      draft: { id: "openai", name: "OpenAI 工作", key: "" },
    });
  });
  it("retains a custom plugin routing strategy when editing a group", async () => {
    demo.groups[0].routing = "example/custom";
    await render();
    await click("路由", "tab");
    await click("编辑路由组");
    await click("保存路由组");
    expect(actions[0]).toMatchObject({
      type: "group.save",
      draft: { id: "daily", routing: "example/custom" },
    });
  });
  it("finds WorkBuddy in discovery and installs its actual package", async () => {
    await render();
    await click("插件", "tab");
    await click("发现");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索插件"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "workbuddy",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await click("安装 WorkBuddy");
    expect(actions).toEqual([
      { type: "plugin.add", spec: "@magpie-community/opencode-workbuddy-auth" },
    ]);
  });
});
