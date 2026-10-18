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
const readers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
const demo = demoData("agents");
const modules: Record<string, unknown> = {
  "react-native": ReactNative,
  "@getpaseo/plugin/client": {
    useRpc: (contract: { name: string }) => {
      if (!readers.has(contract.name))
        readers.set(contract.name, async (input) => {
          if (contract.name === "magpie.page.read") return { ...demo, page: input.page as Page };
          if (contract.name === "magpie.plugins.catalog")
            return demoCatalog(input.source as "suggested" | "github" | "npm");
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
                { role: "assistant", kind: "text", text: "已实现队列和状态更新。" },
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
    copyText: async () => {},
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
const { MagpieScreen } = module.exports as { MagpieScreen: ComponentType<object> };
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
  demo.agents[0].fields[0].value = "openai/gpt-4.1";
  demo.groups[0].routing = "order";
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
});

describe("native Magpie UI on the released Paseo runtime", () => {
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
