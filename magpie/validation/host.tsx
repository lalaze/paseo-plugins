import { useCallback } from "react";
import { demoCatalog, demoData } from "./fixtures";
import { actionSchema, type Page } from "../shared/rpc";
import { demoFeature } from "./features";
import type { Feature } from "../shared/features";

const data = demoData("agents");
export function useRpc(contract: { name: string }) {
  return useCallback(
    async (input: Record<string, unknown>) => {
      if (contract.name === "magpie.page.read") return { ...data, page: input.page as Page };
      if (contract.name === "magpie.feature.read")
        return { data: demoFeature(input.feature as Feature) };
      if (contract.name === "magpie.feature.mutate")
        return { data: { saved: true, preview: true } };
      if (contract.name === "magpie.plugins.catalog")
        return demoCatalog(input.source as "suggested" | "github" | "npm");
      if (contract.name === "magpie.gateway.key.reveal")
        return { secret: "sk-magpie-key-preview-only" };
      if (contract.name === "magpie.action.run") {
        const action = actionSchema.parse(input);
        if (action.type === "agent.set") {
          const field = data.agents
            .find((a) => a.id === action.id)
            ?.fields.find((f) => f.key === action.field);
          if (field) field.value = action.value;
        }
        if (action.type === "agent.connect" || action.type === "agent.disconnect") {
          const agent = data.agents.find((a) => a.id === action.id);
          if (agent) agent.wired = action.type === "agent.connect";
        }
        if (action.type === "provider.toggle") {
          const p = data.providers.find((p) => p.id === action.id);
          if (p) p.off = !action.on;
        }
        if (action.type === "provider.delete")
          data.providers = data.providers.filter((p) => p.id !== action.id);
        if (action.type === "group.save") {
          data.groups = data.groups.filter((g) => g.id !== action.draft.id);
          data.groups.push({
            ...action.draft,
            match: [],
            off: [],
            disabled: false,
            ready: true,
            auto: false,
          });
        }
        if (action.type === "group.delete")
          data.groups = data.groups.filter((g) => g.id !== action.id);
        if (action.type === "group.toggle") {
          const g = data.groups.find((g) => g.id === action.id);
          if (g) g.disabled = !action.on;
        }
        if (action.type === "settings.save" && data.settings)
          data.settings = { ...data.settings, ...action.settings };
        if (action.type === "settings.lan") {
          if (data.settings) data.settings.lan = action.on;
          if (data.gateway) data.gateway.lan = action.on;
        }
        if (action.type === "settings.textSize" && data.settings)
          data.settings.textSize = action.size;
        if (action.type === "gateway.key.add")
          data.gatewayKeys.push({
            id: `demo-${Date.now()}`,
            name: action.name,
            masked: "sk-magpie-key-…demo",
            off: false,
            models: [],
            accounts: [],
          });
        if (action.type === "gateway.key.change") {
          const key = data.gatewayKeys.find((k) => k.id === action.id);
          if (key && (action.operation === "on" || action.operation === "off"))
            key.off = action.operation === "off";
          if (action.operation === "remove")
            data.gatewayKeys = data.gatewayKeys.filter((k) => k.id !== action.id);
        }
        return { notice: "示例操作已完成，真实 Magpie 未被修改。", jobId: "" };
      }
      if (contract.name === "magpie.transcript.read")
        return {
          parts: [
            {
              role: "user",
              kind: "text",
              name: "",
              text: "实现一个任务队列，让前端能实时看到每项任务的状态。",
              model: "",
            },
            {
              role: "assistant",
              kind: "text",
              name: "",
              text: "已实现队列、并发控制和实时状态更新。任务支持等待、运行、完成和失败四个状态，并添加了取消操作。",
              model: "GPT-4.1",
            },
          ],
          cut: false,
        };
      if (contract.name === "magpie.signin")
        return {
          id: "demo",
          agent: input.agent || "codex",
          state: "waiting",
          url: "https://example.test/authorize",
          code: "DEMO-CODE",
          instructions: "这是示例授权界面。",
          pasteCallback: true,
          error: "",
        };
      throw new Error("This preview uses sample data only.");
    },
    [contract.name],
  );
}
