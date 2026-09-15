import type { Conversations } from "./conversations";
import { CHAT_ACTOR } from "../shared/conversation";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PlanSchema, ResultSchema, ReviewSchema, summarize, REVIEWER_ACTOR } from "../shared/schema";
import type { Store } from "./store";
import type { Engine } from "./engine";
import { workflowEvidence } from "./workflow-evidence";
import { ConversationBridgeServer } from "./bridge";

const chatSchemas = {
  get_conversation_status: z.object({}),
  start_task: z.object({ sourceMessageId: z.string(), goal: z.string().trim().min(1).max(32000) }),
  submit_operation: z.object({ operationId: z.string(), payload: z.union([PlanSchema, ReviewSchema]) }),
  control_task: z.object({ sourceMessageId: z.string(), action: z.enum(["pause", "resume", "cancel", "retry", "revise", "approve_plan", "accept_final", "reject_final", "request_changes"]), confirmationKey: z.string().optional(), goal: z.string().trim().min(1).max(32000).optional(), feedback: z.string().trim().min(1).max(16000).optional() }),
};

// Both transports use the same input validation, actor scope and state machine.
async function callChatTool(chats: Conversations, id: string, name: string, args: unknown) {
  switch (name) {
    case "get_conversation_status": chatSchemas.get_conversation_status.parse(args); return chats.status(id);
    case "start_task": return chats.start(id, chatSchemas.start_task.parse(args));
    case "submit_operation": { const input = chatSchemas.submit_operation.parse(args); return chats.submit(id, input.operationId, input.payload); }
    case "control_task": return chats.control(id, chatSchemas.control_task.parse(args));
    default: throw new Error("协作工具不存在");
  }
}

export class DirectorMcp {
  private server?: Server;
  private port = 0;
  private bridge?: ConversationBridgeServer;
  constructor(private store: Store, private engine: Engine, private conversations?: Conversations, private bridgeRoot?: string) {}
  url() { if (!this.port) throw new Error("AI 协作 MCP 尚未启动"); return `http://127.0.0.1:${this.port}/mcp`; }
  async start() {
    this.server = createServer(async (req, res) => {
      if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
      if (req.headers.origin) { res.writeHead(403).end(); return; }
      const authorization = req.headers.authorization;
      const scope = authorization?.startsWith("Bearer ") ? this.store.authenticate(authorization.slice(7)) : undefined;
      if (!scope) { res.writeHead(401).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const mcp = new McpServer({ name: "paseo-director", version: "0.1.0" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
      const submit = async (operationId: string, payload: unknown) => result(await this.engine.submit(scope.run_id, scope.actor, operationId, payload));
      if (scope.actor === CHAT_ACTOR && this.conversations) {
        const chats = this.conversations;
        const descriptions = {
          get_conversation_status: "读取当前任务、操作上下文、待确认版本和最新真实用户消息",
          start_task: "用户明确要求实施后启动任务；讨论和提问不启动",
          submit_operation: "提交当前设计或审核结果；后台校验后派发，聊天中正常回复",
          control_task: "按最新用户要求控制任务；批准需要真实明确用户消息及当前 confirmation.key",
        };
        for (const name of Object.keys(chatSchemas) as (keyof typeof chatSchemas)[]) {
          mcp.registerTool(name, { description: descriptions[name], inputSchema: chatSchemas[name].shape }, async (input: unknown) => result(await callChatTool(chats, scope.run_id, name, input)));
        }
      } else if (scope.actor === "director") {
        mcp.registerTool("submit_plan", { description: "提交总纲，结束本轮后自动按用户配置派发任务", inputSchema: { operationId: z.string(), payload: PlanSchema } }, async ({ operationId, payload }) => submit(operationId, payload));
        mcp.registerTool("dispatch_task", { description: "将已提交总纲中的任务加入优先派发队列；遵守用户 AI 配置和任务依赖", inputSchema: { taskId: z.string() } }, async ({ taskId }) => result(await this.engine.dispatch(scope.run_id, taskId)));
      } else if (scope.actor !== REVIEWER_ACTOR && scope.actor !== CHAT_ACTOR) {
        mcp.registerTool("submit_result", { description: "提交执行结果或阻塞原因，提交后结束当前轮次", inputSchema: { operationId: z.string(), payload: ResultSchema } }, async ({ operationId, payload }) => submit(operationId, payload));
      }
      if (scope.actor === REVIEWER_ACTOR || (scope.actor === "director" && !this.store.get(scope.run_id).settings.reviewerProfileId)) {
        mcp.registerTool("submit_review", { description: "提交当前成果版本的审核决定", inputSchema: { operationId: z.string(), payload: ReviewSchema } }, async ({ operationId, payload }) => submit(operationId, payload));
      }
      if (scope.actor !== CHAT_ACTOR) mcp.registerTool("get_run_status", { description: "查看本次任务的进度", inputSchema: {} }, async () => {
        const run = this.store.get(scope.run_id);
        return result({ ...summarize(run), workflowEvidence: workflowEvidence(run), operationId: run.activeOperationId, tasks: run.tasks.map(t => ({ id: t.spec.id, status: t.status, executorId: t.profileId })) });
      });
      try {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > 262144) { res.writeHead(413).end(); await mcp.close(); return; } chunks.push(chunk); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        await mcp.connect(transport);
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "请求失败" }));
        await transport.close(); await mcp.close();
      }
    });
    this.server.requestTimeout = 15000;
    const port = Number(process.env.PASEO_DIRECTOR_MCP_PORT ?? this.store.meta<number>("mcpPort") ?? 0);
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(port, "127.0.0.1", () => resolve()); });
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("无法获取 MCP 端口");
    this.port = address.port; this.store.setMeta("mcpPort", this.port);
    if (this.bridgeRoot && this.conversations) {
      this.bridge = new ConversationBridgeServer(this.bridgeRoot, async (token, name, args) => {
        const scope = this.store.authenticate(token);
        if (!scope || scope.actor !== CHAT_ACTOR) throw new Error("协作凭据无效或无权调用主对话工具");
        return callChatTool(this.conversations!, scope.run_id, name, args);
      });
      await this.bridge.start();
    }
  }
  async close() { await this.bridge?.close(); this.server?.closeAllConnections(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); }
}
