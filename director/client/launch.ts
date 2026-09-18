import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { openConversationRpc, getSettingsRpc } from "../shared/rpc";
import { localizeDirectorMessage, ui } from "./i18n";

export type LaunchRequest = {
  status: "submitting" | "created" | "failed" | "setup";
  goal: string;
  requestId: string;
  fresh?: boolean;
  runId?: string;
  conversationId?: string;
  agentId?: string;
  message?: string;
};

// A separate store per plugin contribution keeps different Paseo hosts apart.
// Keep pending setup and retry state isolated to this host.
// Use a closure: bundled anonymous classes fail when instantiated by Hermes eval.
export function createLaunchRequests() {
  const states = new Map<string, LaunchRequest>();
  const listeners = new Set<() => void>();
  const get = (workspaceId: string) => states.get(workspaceId) ?? null;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function set(workspaceId: string, value: LaunchRequest) {
    states.set(workspaceId, value);
    listeners.forEach(listener => listener());
  }
  function clear() { states.clear(); listeners.clear(); }
  return { get, subscribe, set, clear };
}

type SubmitContext = Pick<PluginWorkspaceCommandContext, "workspace" | "rpc" | "openSettings"> & { args: string; fresh?: boolean; agent?: { id: string } };
type Attempt = { agentId?: string; fresh?: boolean; directory: string; goal: string; requestId: string; pending?: Promise<void> };

export function createDirectorCommand() {
  const requests = createLaunchRequests();
  const attempts = new Map<string, Attempt>();
  const setup = new Map<string, SubmitContext>();
  let disposed = false;
  async function submit(context: SubmitContext): Promise<void> {
    const goal = context.args.trim();

    if (goal.length > 32000) throw new Error(ui("The task description is limited to 32000 characters. Shorten it before submitting.", "任务描述最多 32000 个字符，请缩短后提交。"));
    const { id: workspaceId, directory } = context.workspace;
    if (!directory.trim()) throw new Error(ui("Open a project workspace before using /director.", "请先打开一个项目工作区，再使用 /director 下发任务。"));
    if (disposed) throw new Error(ui("AI collaboration was reloaded. Submit the command again.", "AI 协作已重新加载，请重新提交命令。"));
    const previous = attempts.get(workspaceId);
    const agentId = context.agent?.id;
    const same = previous?.goal === goal && previous.directory === directory && previous.agentId === agentId && previous.fresh === context.fresh;
    // Each workspace has one creation in flight. Keep the request ID on failure
    // so a retry reconciles a committed run if its RPC response was lost.
    if (previous?.pending) {
      if (same) return previous.pending;
      throw new Error(ui("The previous collaboration task is still being submitted. Wait before sending another.", "上一条协作任务仍在提交，请稍后再下发新任务。"));
    }
    const attempt = same ? previous!
      : { directory, goal, agentId, fresh: context.fresh, requestId: `composer-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    attempts.set(workspaceId, attempt);
    const publish = (value: Omit<LaunchRequest, "goal" | "requestId">) => {
      if (!disposed) requests.set(workspaceId, { ...value, goal, fresh: agentId ? false : context.fresh || !!goal, requestId: attempt.requestId });
    };
    const pending = Promise.resolve().then(async () => {
      publish({ status: "submitting" });
      try {
        if (disposed) throw new Error(ui("AI collaboration was reloaded. Submit the command again.", "AI 协作已重新加载，请重新提交命令。"));
        const saved = await context.rpc(getSettingsRpc, {});
        if (saved.error) throw new Error(saved.error);
        if (!saved.settings) {
          publish({ status: "setup", message: ui("Save the planning, implementation, and review AI assignments first. The task description is preserved and collaboration will continue after saving.", "请先保存设计、执行和审核 AI 的安排。任务描述已保留，保存后继续启用协作。") });
          setup.set(workspaceId, context);
          context.openSettings("director-settings");
          return;
        }
        if (disposed) throw new Error(ui("AI collaboration was reloaded. Submit the command again.", "AI 协作已重新加载，请重新提交命令。"));
        // The server loads the saved host configuration, just like a new task.
        const result = await context.rpc(openConversationRpc, { requestId: attempt.requestId, goal: goal || undefined, workspaceId, agentId, fresh: agentId ? false : context.fresh || !!goal });
        publish({ status: "created", conversationId: result.id, agentId: result.agentId, runId: result.runId });
        attempts.delete(workspaceId);
        setup.delete(workspaceId);
      } catch (error) {
        publish({ status: "failed", message: `${localizeDirectorMessage(error instanceof Error ? error.message : String(error))}\n${ui("You can retry; this request ID is preserved to prevent duplicates.", "可以重试提交；本次请求标识会保留，避免重复创建。")}` });
        throw error;
      }
    });
    attempt.pending = pending;
    try { await pending; } finally { attempt.pending = undefined; }
  }
  async function resumeSetup() {
    for (const context of [...setup.values()]) await submit(context);
  }
  return { requests, submit, resumeSetup, dispose() { disposed = true; setup.clear(); attempts.clear(); requests.clear(); } };
}
