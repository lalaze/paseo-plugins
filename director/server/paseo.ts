import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
// 0.8.0 has no public handle.cancel(). Keep this single low-level dependency here.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentGateway, AgentSnapshot } from "./engine";
import type { Conversation } from "../shared/conversation";
import type { Run, Operation, Profile } from "../shared/schema";
import { CHAT_PROMPT, ROLE_PROMPT } from "./prompts";
import { operationRole, operationLabel } from "../shared/schema";
import { realpath } from "node:fs/promises";

export function connectionConfig(env: NodeJS.ProcessEnv = process.env) {
  const home = env.PASEO_HOME ?? join(homedir(), ".paseo");
  let config: { daemon?: { listen?: string | number; password?: string } } = {};
  try { config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取 Paseo 配置文件"); }
  let target = String(env.PASEO_LISTEN ?? config.daemon?.listen ?? "127.0.0.1:6767");
  if (/^\d+$/.test(target)) target = `127.0.0.1:${target}`;
  target = target.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
  const invalidAddress = "此监听方式需要设置 PASEO_DIRECTOR_URL 为 daemon 的 WebSocket 地址";
  if (env.PASEO_DIRECTOR_URL === undefined && target.startsWith("/")) throw new Error(invalidAddress);
  const url = env.PASEO_DIRECTOR_URL ?? (/^wss?:\/\//.test(target) ? target : `ws://${target}/ws`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(invalidAddress); }
  if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error(invalidAddress);
  return { home, url, password: env.PASEO_DIRECTOR_PASSWORD ?? env.PASEO_PASSWORD ?? config.daemon?.password };
}

export function inspectMessages(items: AgentTimelineItem[], operationId: string) {
  const marker = `[paseo-director:${operationId}]`;
  const start = items.findIndex(item => item.type === "user_message" && (item.clientMessageId === operationId || item.messageId === operationId || item.text.startsWith(marker)));
  if (start < 0) return { seen: false, output: "", interrupted: false };
  const later = items.slice(start + 1);
  const nextUser = later.findIndex(i => i.type === "user_message");
  let output = "", previousId: string | undefined, separated = false;
  // Canonical history stores deltas, even inside JSON keys and escapes.
  for (const item of nextUser < 0 ? later : later.slice(0, nextUser)) {
    if (item.type !== "assistant_message") { separated = true; continue; }
    const sameMessage = item.messageId && item.messageId === previousId;
    if (output && !sameMessage && (separated || (item.messageId && previousId && item.messageId !== previousId))) output += "\n";
    output += item.text; previousId = item.messageId; separated = false;
  }
  return { seen: true, interrupted: nextUser >= 0, output };
}
export class PaseoGateway implements AgentGateway {
  readonly api: PaseoApi;
  private pluginApi?: PaseoApi;
  setPluginApi(api: PaseoApi) { this.pluginApi = api; }
  private driver: DaemonClient;
  private connectPromise?: Promise<void>;
  private isClosed = false;
  constructor(config: { url: string; password?: string }, private mcpUrl: () => string) {
    this.driver = new DaemonClient({ ...config, clientId: `director-${randomUUID()}`, clientType: "cli", appVersion: "0.8.0", connectTimeoutMs: 8000, reconnect: { enabled: true }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    this.api = createPaseoApi(this.driver);
  }
  async connect() {
    if (this.isClosed) throw new Error("AI 协作后台已关闭");
    if (this.driver.getConnectionState().status === "connected") return;
    if (!this.connectPromise) this.connectPromise = this.driver.connect().finally(() => { this.connectPromise = undefined; });
    await this.connectPromise;
  }
  async close() { this.isClosed = true; await this.driver.close(); }
  async workspaceForDirectory(cwd: string) { await this.connect(); return (await this.api.workspaces.open(cwd)).id; }
  async workspaceDirectory(workspaceId: string) {
    await this.connect();
    const workspace = this.api.workspaces.ref(workspaceId);
    if (!await workspace.refresh() || !workspace.directory || workspace.current()?.archivingAt) throw new Error("原工作区已不可用，请打开项目工作区后重新发起任务");
    return workspace.directory;
  }
  async retainWorkspaceName(workspaceId: string, isolatedTitle?: string) {
    await this.connect();
    const workspace = this.api.workspaces.ref(workspaceId), snapshot = await workspace.refresh();
    if (!snapshot || !workspace.directory || snapshot.archivingAt) throw new Error("工作区已不可用，无法保留名称");
    if (snapshot.title?.trim()) return; // Preserve an explicit user title.
    const name = snapshot.name.trim();
    const fallback = snapshot.projectCustomName?.trim() || snapshot.projectDisplayName?.trim() || basename(workspace.directory);
    // Also recover an automatic Director branch label left by an older run.
    await workspace.setTitle(isolatedTitle || (!name || /^director\/[a-f\d]{24}$/i.test(name) ? fallback : name));
  }
  async create(run: Run, op: Operation, profile: Profile, token: string) {
    await this.connect();
    const slash = profile.provider.indexOf("/"), provider = profile.provider.slice(0, slash), model = profile.provider.slice(slash + 1);
    const catalog = await this.api.providers.waitForReady({ cwd: run.cwd, timeoutMs: 12000 });
    const entry = catalog.entries.find(e => e.provider === provider);
    if (!entry || entry.status !== "ready" || !entry.models?.some(m => m.id === model)) throw new Error(`指定的 AI 不可用：${profile.provider}；请检查 Paseo 的供应商登录与模型配置`);
    // Resolve the live catalog default explicitly so the selector and new
    // session agree. Never substitute a different mode for a saved choice.
    const modeId = profile.modeId || entry.defaultModeId || undefined;
    if (modeId && entry.modes !== undefined && !entry.modes.some(mode => mode.id === modeId)) throw new Error(`指定的执行权限不可用：${modeId}（${profile.provider}）；请检查供应商配置或重新选择权限后新建任务`);
    const workspace = run.workspaceId ? this.api.workspaces.ref(run.workspaceId) : await this.api.workspaces.open(run.cwd);
    if (run.workspaceId && await realpath(await this.workspaceDirectory(run.workspaceId)) !== await realpath(run.cwd)) throw new Error("工作区目录已变化，请检查后重新发起任务");
    const goalTitle = Array.from(run.goal.trim().replace(/\s+/g, " ")).slice(0, 60).join("");
    if (!run.workspaceId) await this.retainWorkspaceName(workspace.id, `AI 协作 · ${goalTitle}`);
    const taskTitle = run.tasks.find(task => task.spec.id === op.taskId)?.spec.title ?? goalTitle;
    const role = operationRole(run.settings, op.kind);
    const agent = await workspace.agents.create({
      config: { provider: profile.provider, ...(modeId ? { modeId } : {}), ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), systemPrompt: ROLE_PROMPT,
        ...(profile.transport === "mcp" ? { mcpServers: { director: { type: "http", url: this.mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } } : {}) },
      parent: role !== "director" ? run.chat?.mainAgentId ?? run.directorAgentId : undefined,
      title: `AI 协作 · ${operationLabel(run.settings, op.kind)} · ${op.kind === "execute" ? Array.from(taskTitle.trim().replace(/\s+/g, " ")).slice(0, 60).join("") : goalTitle}`,
      requestId: op.id, labels: { "director-run": run.id, "director-operation": op.id, "director-role": role },
    });
    return agent.id;
  }
  async find(runId: string, operationId: string) {
    await this.connect(); const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await this.api.agents.list({ filter: { labels: { "director-run": runId, "director-operation": operationId } }, page: { limit: 100, cursor } });
      ids.push(...page.entries.map(e => e.agent.id)); cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }
  async inspect(agentId: string, operationId: string): Promise<AgentSnapshot> {
    await this.connect(); const agent = this.api.agents.ref(agentId);
    if (!(await agent.refresh()) || agent.archivedAt || agent.status === "closed") return { status: "missing", seen: false, output: "" };
    const status: AgentSnapshot["status"] = agent.pendingPermissions?.length ? "permission" : agent.status === "error" ? "error" : agent.activeTurn || agent.status === "running" || agent.status === "initializing" ? "running" : "idle";
    let page = await agent.timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" });
    const items = page.entries.map(e => e.item);
    let count = 0;
    while (!inspectMessages(items, operationId).seen && page.hasOlder && page.startCursor) {
      if (++count > 100) throw new Error("本轮会话记录过长，需要人工核对后继续");
      page = await agent.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 100, projection: "canonical" });
      if (page.staleCursor || page.gap) throw new Error("会话记录在读取期间发生变化，请稍后重试");
      items.unshift(...page.entries.map(e => e.item));
    }
    return { status, ...inspectMessages(items, operationId), error: agent.lastError ?? undefined };
  }
  async send(agentId: string, operationId: string, prompt: string) {
    await this.connect();
    const agent = this.api.agents.ref(agentId);
    const snapshot = await agent.refresh();
    if (snapshot?.agent.labels?.["director-conversation"] && prompt.startsWith("[paseo-director:")) {
      prompt += "\n这是主对话中的后台操作。通过 submit_operation 提交（operationId 和 payload），不要在聊天中输出 JSON。可先调用 get_conversation_status 核对最新状态。";
    }
    await agent.send(prompt, { messageId: operationId });
  }
  async createConversation(conversation: Conversation, token: string) {
    await this.connect();
    const profile = conversation.settings.profiles.find(p => p.id === conversation.settings.directorProfileId)!;
    const slash = profile.provider.indexOf("/"), provider = profile.provider.slice(0, slash), model = profile.provider.slice(slash + 1);
    const catalog = await this.api.providers.waitForReady({ cwd: conversation.cwd, timeoutMs: 12000 });
    const entry = catalog.entries.find(e => e.provider === provider);
    if (!entry || entry.status !== "ready" || !entry.models?.some(m => m.id === model)) throw new Error(`主 Agent 不可用：${profile.provider}；请检查模型及 MCP 接入`);
    const modeId = profile.modeId || entry.defaultModeId || undefined;
    if (modeId && entry.modes && !entry.modes.some(m => m.id === modeId)) throw new Error("主 Agent 保存的权限模式不可用，请在设置中重新选择");
    const workspace = this.api.workspaces.ref(conversation.workspaceId);
    if (await realpath(await this.workspaceDirectory(workspace.id)) !== await realpath(conversation.cwd)) throw new Error("会话工作区目录已变化");
    const agent = await workspace.agents.create({
      requestId: `${conversation.id}:${conversation.generation ?? 0}`, title: `主 Agent · ${(conversation.initialGoal || "AI 协作").slice(0, 50)}`,
      labels: { "director-conversation": conversation.id, "director-generation": String(conversation.generation ?? 0), "director-role": "chat" },
      config: { provider: profile.provider, ...(modeId ? { modeId } : {}),
        ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        systemPrompt: CHAT_PROMPT + (profile.instructions ? `\n用户的主 Agent 补充要求：\n${profile.instructions}` : ""),
        mcpServers: { director: { type: "http", url: this.mcpUrl(), headers: { Authorization: `Bearer ${token}` } } },
      },
    });
    return agent.id;
  }
  async findConversation(id: string, generation = 0) {
    await this.connect();
    const page = await this.api.agents.list({ filter: { labels: { "director-conversation": id, "director-generation": String(generation) } }, page: { limit: 100 } });
    return page.entries.map(e => e.agent.id);
  }
  async conversationHistory(agentId: string) {
    await this.connect();
    const agent = this.api.agents.ref(agentId);
    let page = await agent.timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" });
    const items = page.entries.map(e => e.item);
    for (let count = 0; page.hasOlder && page.startCursor; count++) {
      if (count >= 100) throw new Error("聊天记录过长，无法可靠核验用户确认");
      page = await agent.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 100, projection: "canonical" });
      if (page.staleCursor || page.gap) throw new Error("聊天记录发生变化，请重试");
      items.unshift(...page.entries.map(e => e.item));
    }
    return items;
  }
  async appendConversationLink(agentId: string, conversationId: string) {
    await this.connect();
    const items = await this.conversationHistory(agentId);
    if (items.some(i => i.type === "plugin" && i.kind === "director-conversation" && (i.data as { conversationId?: string }).conversationId === conversationId)) return;
    if (!this.pluginApi) throw new Error("等待宿主插件连接，以恢复聊天入口");
    await this.pluginApi.agents.ref(agentId).timeline.append({ type: "plugin", id: `conversation-${conversationId}`, kind: "director-conversation", version: 1, data: { conversationId } });
  }
  async stop(agentId: string) { await this.connect(); await this.driver.cancelAgent(agentId); }
}
