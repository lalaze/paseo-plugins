import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { openConversationRpc, getSettingsRpc } from "../shared/rpc";

export type LaunchRequest = {
  status: "submitting" | "created" | "failed" | "setup";
  goal: string;
  requestId: string;
  runId?: string;
  conversationId?: string;
  agentId?: string;
  message?: string;
};

// A separate store per plugin contribution keeps different Paseo hosts apart.
// The SDK cannot pass arbitrary data through openPanel in Paseo 0.8.
export class LaunchRequests {
  private states = new Map<string, LaunchRequest>();
  private listeners = new Set<() => void>();
  get = (workspaceId: string) => this.states.get(workspaceId) ?? null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(workspaceId: string, value: LaunchRequest) {
    this.states.set(workspaceId, value);
    this.listeners.forEach(listener => listener());
  }
  clear() { this.states.clear(); this.listeners.clear(); }
}

type SubmitContext = Pick<PluginWorkspaceCommandContext, "workspace" | "rpc" | "openPanel"> & { args: string; fresh?: boolean };
type Attempt = { directory: string; goal: string; requestId: string; pending?: Promise<void> };

export function createDirectorCommand() {
  const requests = new LaunchRequests();
  const attempts = new Map<string, Attempt>();
  let disposed = false;
  async function submit(context: SubmitContext): Promise<void> {
    const goal = context.args.trim();

    if (goal.length > 32000) throw new Error("任务描述最多 32000 个字符，请缩短后提交。");
    const { id: workspaceId, directory } = context.workspace;
    if (!directory.trim()) throw new Error("请先打开一个项目工作区，再使用 /director 下发任务。");
    if (disposed) throw new Error("AI 协作已重新加载，请重新提交命令。");
    const previous = attempts.get(workspaceId);
    // Each workspace has one creation in flight. Keep the request ID on failure
    // so a retry reconciles a committed run if its RPC response was lost.
    if (previous?.pending) {
      if (previous.goal === goal && previous.directory === directory) return previous.pending;
      throw new Error("上一条协作任务仍在提交，请稍后再下发新任务。");
    }
    const attempt = previous?.goal === goal && previous.directory === directory ? previous
      : { directory, goal, requestId: `composer-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    attempts.set(workspaceId, attempt);
    const publish = (value: Omit<LaunchRequest, "goal" | "requestId">) => {
      if (!disposed) requests.set(workspaceId, { ...value, goal, requestId: attempt.requestId });
    };
    const pending = Promise.resolve().then(async () => {
      publish({ status: "submitting" });
      try {
        if (disposed) throw new Error("AI 协作已重新加载，请重新提交命令。");
        context.openPanel("director");
        const saved = await context.rpc(getSettingsRpc, {});
        if (saved.error) throw new Error(saved.error);
        if (!saved.settings) {
          publish({ status: "setup", message: "请先保存设计、执行和审核 AI 的安排。任务描述已保留，保存后进入主对话。" });
          attempts.delete(workspaceId);
          return;
        }
        if (disposed) throw new Error("AI 协作已重新加载，请重新提交命令。");
        // The server loads the saved host configuration, just like a new task.
        const result = await context.rpc(openConversationRpc, { requestId: attempt.requestId, goal: goal || undefined, workspaceId, fresh: context.fresh || !!goal });
        publish({ status: "created", conversationId: result.id, agentId: result.agentId, runId: result.runId });
        attempts.delete(workspaceId);
      } catch (error) {
        publish({ status: "failed", message: `${error instanceof Error ? error.message : String(error)}\n可以重试提交；本次请求标识会保留，避免重复创建。` });
        throw error;
      }
    });
    attempt.pending = pending;
    try { await pending; } finally { attempt.pending = undefined; }
  }
  return { requests, submit, dispose() { disposed = true; attempts.clear(); requests.clear(); } };
}
