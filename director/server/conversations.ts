import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { CHAT_ACTOR, confirmationFor, type Conversation, type ConversationSummary } from "../shared/conversation";
import { SettingsSchema, type ControlAction, type Run, type Profile } from "../shared/schema";
import type { Store } from "./store";
import type { Engine, AgentSnapshot } from "./engine";

export interface ConversationGateway {
  workspaceDirectory(id: string): Promise<string>;
  takeoverProfile?(agentId: string, workspaceId: string): Promise<Pick<Profile, "provider" | "modeId" | "thinkingOptionId">>;
  adoptConversation?(conversation: Conversation, token: string): Promise<string>;
  createConversation(conversation: Conversation, token: string): Promise<string>;
  findConversation(id: string, generation?: number): Promise<string[]>;
  conversationHistory(agentId: string): Promise<AgentTimelineItem[]>;
  appendConversationLink(agentId: string, conversationId: string): Promise<void>;
  inspect(agentId: string, messageId: string): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string): Promise<void>;
  workspaceForDirectory?(cwd: string): Promise<string>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const messageId = (item: AgentTimelineItem) => item.type === "user_message" ? item.clientMessageId ?? item.messageId : undefined;
const normalize = (text: string) => text.trim().replace(/[。！!\s]+$/u, "");
const approvals = { approve_plan: ["批准方案", "确认方案", "方案通过"], accept_final: ["验收通过", "确认验收", "验收通过，完成任务"], reject_final: ["不采纳成果"] };

// Deliberately require a whole, explicit user message. Quotes, code blocks and
// mixed instructions never count as an approval, regardless of model claims.
export function validateChatApproval(items: AgentTimelineItem[], input: { messageId: string; noticeId: string; action: keyof typeof approvals }) {
  const anchor = items.findIndex(i => messageId(i) === input.noticeId);
  const index = items.findIndex(i => messageId(i) === input.messageId);
  const user = items[index];
  if (anchor < 0 || index <= anchor || user?.type !== "user_message" || !approvals[input.action].includes(normalize(user.text)))
    throw new Error(`请在当前确认请求之后，单独回复“${approvals[input.action][0]}”`);
}

export class Conversations {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private store: Store, private engine: Engine, private gateway: ConversationGateway) {}
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(fn); this.tail = next; return next;
  }
  async close() { this.closed = true; await this.tail.catch(() => undefined); }
  summary(id: string): ConversationSummary {
    const c = this.store.conversation(id), run = c.runId ? this.store.get(c.runId) : undefined;
    return { id: c.id, agentId: c.agentId, workspaceId: c.workspaceId, runId: c.runId, state: c.state, error: c.error, title: run?.goal ?? c.initialGoal ?? "新的协作对话", run, confirmation: c.confirmation };
  }
  async open(input: { requestId: string; workspaceId: string; goal?: string; fresh?: boolean; conversationId?: string; agentId?: string }) {
    return this.locked(async () => {
      if (input.agentId) return this.takeover(input as typeof input & { agentId: string });
      if (input.conversationId) {
        const c = this.store.conversation(input.conversationId);
        if (c.workspaceId !== input.workspaceId) throw new Error("会话不属于当前工作区");
        await this.ensure(c); return this.summary(c.id);
      }
      let c = this.store.conversations().find(c => c.requestId === input.requestId);
      if (!c && !input.fresh && !input.goal) {
        const matches = this.store.conversations().filter(c => c.workspaceId === input.workspaceId);
        c = matches.find(c => { const run = c.runId ? this.store.get(c.runId) : undefined; return run && run.phase !== "completed" && run.control !== "canceled"; }) ?? matches[0];
      }
      if (!c) {
        const settings = SettingsSchema.parse(this.store.settings());
        c = { id: `chat-${digest(input.requestId)}`, requestId: input.requestId, workspaceId: input.workspaceId,
          cwd: await this.gateway.workspaceDirectory(input.workspaceId), settings, createdAt: Date.now(), state: "creating",
          initialGoal: input.goal?.trim() || undefined, notices: [], receipts: {} };
        this.store.saveConversation(c);
      }
      await this.ensure(c); return this.summary(c.id);
    });
  }
  private async takeover(input: { requestId: string; workspaceId: string; agentId: string; goal?: string }) {
    if (!this.gateway.takeoverProfile || !this.gateway.adoptConversation) throw new Error("当前接入不支持原地接管");
    const profile = await this.gateway.takeoverProfile(input.agentId, input.workspaceId);
    let c = this.store.conversations().find(c => c.agentId === input.agentId);
    const request = this.store.conversations().find(c => c.requestId === input.requestId);
    if (request && request.agentId !== input.agentId) throw new Error("请求已绑定其他对话");
    if (c && c.workspaceId !== input.workspaceId) throw new Error("会话不属于当前工作区");
    if (!c) {
      const settings = SettingsSchema.parse(this.store.settings());
      const lead = settings.profiles.find(p => p.id === settings.directorProfileId)!;
      let id = "current-chat";
      while (settings.profiles.some(p => p.id === id)) id += "-";
      // Keep worker/reviewer bindings intact even when they share the old lead profile.
      if (settings.profiles.length >= 30) throw new Error("协作配置已满，请先移除一个未使用的 AI 配置再接管当前对话");
      settings.profiles.push({ ...lead, ...profile, id, label: "当前对话", transport: "structured" });
      settings.directorProfileId = id;
      c = { id: `chat-${digest(input.requestId)}`, requestId: input.requestId, workspaceId: input.workspaceId,
        agentId: input.agentId, cwd: await this.gateway.workspaceDirectory(input.workspaceId), settings,
        createdAt: Date.now(), state: "creating", takeover: { messages: [] }, notices: [], receipts: {} };
      this.store.saveConversation(c);
    }
    // Existing main sessions can be adopted too, without changing their identity.
    if (!c.takeover) { c.takeover = { messages: [] }; c.linksReady = false; }
    const id = `chat-command:${digest(input.requestId)}`;
    if (!c.takeover.messages.some(m => m.id === id) && (input.goal?.trim() || !c.takeover.messages.length)) {
      c.takeover.messages.push({ id, text: input.goal?.trim() || "用户已在当前对话启用协作。请确认工具连接并简短告知已就绪。此消息只启用协作，不授权启动任务，不根据历史消息自动实施。", automatic: !input.goal?.trim(), state: "pending" });
      this.store.saveConversation(c);
    }
    await this.ensure(c);
    return this.summary(c.id);
  }
  private async ensure(c: Conversation) {
    try {
      if (!c.workspaceId) {
        c.workspaceId = await this.gateway.workspaceForDirectory?.(c.cwd) ?? "";
        if (!c.workspaceId) throw new Error("原工作区不可用，请恢复原代码目录后重试迁移");
        this.store.saveConversation(c);
      }
      if (!c.runId) {
        const recovered = this.store.all().find(run => run.chat?.conversationId === c.id);
        if (recovered) {
          c.runId = recovered.id;
          for (const entry of Object.values(c.receipts)) if (entry.action === "start" && entry.state === "pending") { entry.state = "done"; entry.value = { runId: recovered.id }; }
          this.store.saveConversation(c);
        }
      }
      if (c.takeover && !c.linksReady) {
        if (!c.agentId || !this.gateway.adoptConversation) throw new Error("当前对话无法接管");
        c.takeover.instruction = await this.gateway.adoptConversation(c, this.store.token(c.id, CHAT_ACTOR));
        this.store.saveConversation(c);
      }
      if (!c.agentId) {
        const found = await this.gateway.findConversation(c.id, c.generation);
        if (found.length > 1) throw new Error("发现多个主会话，请先核对，未重复创建");
        c.agentId = found[0] ?? await this.gateway.createConversation(c, this.store.token(c.id, CHAT_ACTOR));
        this.store.saveConversation(c);
      }
      if (c.runId) {
        const run = this.store.get(c.runId);
        if (!run.chat) await this.engine.attachConversation(c.runId, c.id, c.agentId);
        else if (run.chat.recovering || run.chat.mainAgentId !== c.agentId) await this.engine.recoverMain(c.runId, c.agentId);
      }
      c.state = "ready"; c.error = undefined; this.store.saveConversation(c);
      await this.gateway.appendConversationLink(c.agentId, c.id);
      if (c.legacyAgentId) await this.gateway.appendConversationLink(c.legacyAgentId, c.id);
      c.linksReady = true; this.store.saveConversation(c);
      if (c.takeover) {
        for (const message of c.takeover.messages.filter(m => m.state !== "sent")) {
          const state = await this.gateway.inspect(c.agentId, message.id);
          if (state.seen) { message.state = "sent"; this.store.saveConversation(c); continue; }
          if (message.state === "sending") throw new Error("无法确认接管消息是否送达，请重新同步到主对话后重试");
          if (state.status === "missing") throw new Error("原对话已不可用，无法原地接管");
          if (state.status !== "idle") return;
          message.state = "sending"; this.store.saveConversation(c);
          await this.gateway.send(c.agentId, message.id, `${message.text}\n\n[paseo-director-takeover]\n${c.takeover.instruction ?? ""}`);
          message.state = "sent"; this.store.saveConversation(c);
          break;
        }
      }
      if (!c.initialDelivered && c.initialGoal && !c.runId) {
        const id = `chat-user:${c.id}`;
        const state = await this.gateway.inspect(c.agentId, id);
        if (!state.seen && state.status === "idle") await this.gateway.send(c.agentId, id, c.initialGoal);
        else if (!state.seen) return;
        c.initialDelivered = true; this.store.saveConversation(c);
      }
    } catch (error) {
      c.error = error instanceof Error ? error.message : String(error); this.store.saveConversation(c); throw error;
    }
  }
  private async user(c: Conversation, id?: string) {
    if (!c.agentId) throw new Error("主会话尚未建立");
    const items = await this.gateway.conversationHistory(c.agentId);
    const automatic = new Set([...(c.takeover?.messages.filter(m => m.automatic).map(m => m.id) ?? []), ...c.notices.map(n => n.id), ...(c.runId ? this.store.get(c.runId).operations.map(o => o.id) : [])]);
    const firstCommand = c.takeover?.messages[0]?.id;
    const boundary = firstCommand ? items.findIndex(i => messageId(i) === firstCommand) : 0;
    const eligible = boundary < 0 ? [] : items.slice(boundary);
    const latest = eligible.filter(i => i.type === "user_message" && messageId(i) && !automatic.has(messageId(i)!)).at(-1);
    if (id && (!latest || messageId(latest) !== id)) throw new Error("请基于主对话最新的真实用户消息操作");
    return { items, latest: latest?.type === "user_message" ? { id: messageId(latest)!, text: latest.text } : undefined };
  }
  async status(id: string) {
    return this.locked(async () => {
      const c = this.store.conversation(id);
      c.toolsConnectedAt ??= Date.now();
      if (c.error?.includes("协作工具") || c.error?.includes("MCP")) c.error = undefined;
      this.store.saveConversation(c);
      const { latest } = await this.user(c);
      const summary = this.summary(id), run = summary.run;
      const operation = run?.operations.find(o => o.id === run.activeOperationId);
      return { ...summary, latestUserMessage: latest, operation: operation && operation.agentId === c.agentId ? operation : undefined,
        toolsAvailable: true, confirmationInstructions: "方案确认请单独回复：批准方案；最终确认请单独回复：验收通过；拒绝成果请单独回复：不采纳成果。" };
    });
  }
  async start(id: string, input: { sourceMessageId: string; goal: string }) {
    return this.locked(async () => {
      const c = this.store.conversation(id);
      await this.user(c, input.sourceMessageId);
      const key = `start:${input.sourceMessageId}`;
      if (c.receipts[key]?.state === "done") return c.receipts[key].value;
      if (c.runId) throw new Error("当前会话已有任务；请修改当前需求，或新建协作对话");
      c.receipts[key] = { action: "start", state: "pending" }; this.store.saveConversation(c);
      const runId = await this.engine.create({ requestId: `${c.id}:${digest(key)}`, workspaceId: c.workspaceId, repository: c.cwd,
        goal: input.goal, settings: c.settings, chat: { version: 1, conversationId: c.id, mainAgentId: c.agentId! } });
      c.runId = runId; c.receipts[key] = { action: "start", state: "done", value: { runId } }; this.store.saveConversation(c);
      return { runId };
    });
  }
  async submit(id: string, operationId: string, payload: unknown) {
    return this.locked(async () => {
      const c = this.store.conversation(id), run = c.runId ? this.store.get(c.runId) : undefined;
      const op = run?.operations.find(o => o.id === run.activeOperationId);
      if (!run || !op || op.agentId !== c.agentId || op.id !== operationId || !["plan", "final", "review"].includes(op.kind)) throw new Error("主 Agent 无权提交此步骤");
      return this.engine.submit(run.id, "director", operationId, payload);
    });
  }
  async control(id: string, input: { action: ControlAction; sourceMessageId: string; confirmationKey?: string; goal?: string; feedback?: string }) {
    return this.locked(async () => {
      const c = this.store.conversation(id);
      if (!c.runId) throw new Error("尚未启动任务");
      const receipt = `${input.sourceMessageId}:${input.action}`;
      if (c.receipts[receipt]?.state === "done") return { ok: true };
      const { items } = await this.user(c, input.sourceMessageId);
      let run = this.store.get(c.runId);
      if (run.chatReceipts?.[`${c.id}:${receipt}`] === input.action) return { ok: true };
      if (["approve_plan", "accept_final", "reject_final"].includes(input.action)) {
        const current = confirmationFor(run);
        if (!current || !c.confirmation || current.key !== c.confirmation.key || input.confirmationKey !== current.key || (input.action === "approve_plan") !== (current.kind === "plan")) throw new Error("确认请求已过期，请先读取当前方案或成果");
        validateChatApproval(items, { messageId: input.sourceMessageId, noticeId: c.confirmation.noticeId, action: input.action as keyof typeof approvals });
      }
      if (["revise", "cancel"].includes(input.action)) for (const entry of Object.values(c.receipts)) if (entry.action === "revise" && entry.state === "pending") entry.state = "done";
      c.receipts[receipt] = { action: input.action, state: "pending", goal: input.goal }; this.store.saveConversation(c);
      if (input.action === "revise" && ["running", "waiting_permission"].includes(run.control)) {
        await this.engine.control(run.id, "pause"); run = this.store.get(run.id);
      }
      // Retrying a revise continues the same stop-and-reconcile transaction.
      await this.engine.control(run.id, input.action, input.goal, { feedback: input.feedback, expectedRevision: run.revision, artifactId: run.finalEvidence?.id }, `${c.id}:${receipt}`);
      c.receipts[receipt] = { action: input.action, state: "done" }; this.store.saveConversation(c);
      return { ok: true };
    });
  }
  async migrate() {
    return this.locked(async () => {
      for (const run of this.store.all()) {
        if (run.chat) continue;
        const id = run.migrationConversationId ?? `legacy-${run.id}`;
        let c = this.store.conversations().find(c => c.id === id);
        if (!c) {
          const workspaceId = run.workspaceId ?? "";
          const saved = this.store.settings(), lead = saved?.profiles.find(p => p.id === saved.directorProfileId);
          const settings = SettingsSchema.parse({ ...run.settings, profiles: run.settings.profiles.map(p => p.id === run.settings.directorProfileId && lead ? { ...lead, id: p.id } : p) });
          c = { id, requestId: id, workspaceId, cwd: run.cwd, settings, runId: run.id, createdAt: Date.now(), state: "migration_pending",
            legacyAgentId: run.directorAgentId, notices: [], receipts: {} };
          this.store.saveConversation(c);
        }
        await this.engine.markMigration(run.id, id);
      }
    });
  }
  async resync(id: string) {
    return this.locked(async () => {
      const c = this.store.conversation(id);
      // Explicit user retry creates a new delivery attempt. An ambiguous old
      // message remains recorded, but can no longer authorize a confirmation.
      for (const notice of c.notices) if (notice.state !== "sent") notice.state = "sent";
      c.noticeKey = undefined; c.confirmation = undefined; c.error = undefined;
      if (c.takeover) {
        if (!c.agentId || (await this.gateway.inspect(c.agentId, "recover-main")).status === "missing") throw new Error("原对话已不可用，无法原地接管；请从历史恢复此对话");
        c.linksReady = false;
        for (const message of c.takeover.messages) if (message.state === "sending") {
          const state = await this.gateway.inspect(c.agentId, message.id);
          // Explicit resync authorizes a retry, with the same message ID.
          message.state = state.seen ? "sent" : "pending";
        }
      }
      if (c.takeover && !c.takeover.messages.some(m => m.state !== "sent")) {
        c.takeover.messages.push({ id: `chat-command:resync:${c.id}:${c.takeover.messages.length}`, text: "用户已在当前对话启用协作。请重新查询状态，确认工具可用；这不是新的实施任务。", automatic: true, state: "pending" });
      }
      if (!c.takeover && c.agentId && (await this.gateway.inspect(c.agentId, "recover-main")).status === "missing") {
        if (c.runId) await this.engine.recoverMain(c.runId);
        c.previousAgentIds = [...(c.previousAgentIds ?? []), c.agentId];
        c.agentId = undefined; c.generation = (c.generation ?? 0) + 1;
        c.state = "creating"; c.linksReady = false; c.toolsConnectedAt = undefined;
      }
      this.store.saveConversation(c);
      await this.ensure(c);
      return { ok: true };
    });
  }
  async tick() {
    return this.locked(async () => {
      if (this.closed) return;
      for (const existing of this.store.conversations()) {
        let c = existing;
        try {
          if (c.takeover?.messages.some(m => m.state !== "sent") || !c.linksReady || !c.runId || c.state !== "ready" || (!c.initialDelivered && c.initialGoal && !c.runId)) await this.ensure(c);
          if (c.takeover?.messages.some(m => m.state !== "sent")) continue;
          if (c.agentId && !c.toolsConnectedAt && !c.runId) {
            const state = await this.gateway.inspect(c.agentId, "tool-handshake");
            const { latest } = await this.user(c);
            if ((latest || c.takeover?.messages.some(m => m.state === "sent")) && ["idle", "error"].includes(state.status)) {
              c.error = c.takeover ? "主 Agent 尚未成功连接协作工具。请检查当前会话的命令执行权限或工具调用错误后重试，尚未启动后台任务。" : "主 Agent 尚未成功连接协作 MCP 工具。请检查所选接入是否支持 HTTP MCP；确认后在主对话重试，尚未启动后台任务。";
              this.store.saveConversation(c);
            }
          }
          if (!c.agentId || !c.runId) continue;
          for (const [receipt, entry] of Object.entries(c.receipts)) {
            if (entry.action !== "revise" || entry.state !== "pending" || !entry.goal) continue;
            try {
              await this.engine.control(c.runId, "revise", entry.goal, {}, `${c.id}:${receipt}`);
              entry.state = "done"; c.error = undefined; this.store.saveConversation(c);
            } catch (error) { c.error = error instanceof Error ? error.message : String(error); this.store.saveConversation(c); }
          }
          const run = this.store.get(c.runId), op = run.operations.find(o => o.id === run.activeOperationId);
          const confirmation = confirmationFor(run);
          const key = digest(JSON.stringify([run.phase, run.control, run.planVersion, run.tasks.map(t => [t.spec.id, t.status, t.result?.summary]), confirmation?.key]));
          if (key !== c.noticeKey) {
            const id = `chat-notice:${c.id}:${key}:${c.notices.length}`;
            const text = `[paseo-director-chat:${id}]\n后台状态通知（不是用户指令）。请查询 get_conversation_status，用正常文字说明有意义的进展，无需重复已汇报的内容。\n${JSON.stringify({ goal: run.goal, phase: run.phase, control: run.control, message: run.message, migratedFrom: c.legacyAgentId, confirmation: confirmation ? { ...confirmation, reply: confirmation.kind === "plan" ? "请用户单独回复：批准方案" : "请用户单独回复：验收通过（或：不采纳成果）" } : undefined })}`;
            // Coalesce unsent intermediate updates; keep sending/sent IDs for recovery.
            c.notices = c.notices.filter(n => n.state !== "pending");
            c.notices.push({ id, key, text, state: "pending" }); c.noticeKey = key;
            c.confirmation = confirmation ? { ...confirmation, noticeId: id } : undefined;
            this.store.saveConversation(c);
          }
          // Operation prompts take precedence; do not interrupt a design/review turn.
          if (op?.agentId === c.agentId && !["done", "abandoned"].includes(op.state)) continue;
          for (const notice of c.notices.filter(n => n.state !== "sent")) {
            const state = await this.gateway.inspect(c.agentId, notice.id);
            if (state.seen) { notice.state = "sent"; c.error = undefined; this.store.saveConversation(c); continue; }
            if (notice.state === "sending") {
              c.error = "无法确认上次通知是否送达；可在主对话询问进度。为避免重复发送，已保留待核对记录。"; this.store.saveConversation(c); break;
            }
            if (["missing", "error"].includes(state.status)) {
              c.error = state.status === "missing" ? "主会话已不可用，请重新同步以创建承接会话，任务进度会保留。" : "主 Agent 会话出错，请检查原生会话错误并重试。";
              this.store.saveConversation(c); break;
            }
            if (state.status !== "idle") break;
            notice.state = "sending"; this.store.saveConversation(c);
            await this.gateway.send(c.agentId, notice.id, notice.text);
            notice.state = "sent"; c.error = undefined; this.store.saveConversation(c); break;
          }
        } catch (error) {
          c = this.store.conversation(c.id); c.error = error instanceof Error ? error.message : String(error); this.store.saveConversation(c);
        }
      }
    });
  }
}
