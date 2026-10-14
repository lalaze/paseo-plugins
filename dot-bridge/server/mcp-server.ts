import { AUTOMATIC_AUTHORIZATION_INSTRUCTIONS } from '../shared/workspace-authorization';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { dotBridgeError, parseDotBridgeError } from '../shared/errors';
import {
  CALLBACK_ENDPOINT_ERROR,
  EVENT_DEFINITIONS,
  MCP_EVENT_PROTOCOL_VERSION,
  PROVIDER_CONVERSATION_INSTRUCTIONS,
  PERMISSION_HANDOFF_INSTRUCTIONS,
  ATTACHMENT_DELIVERY_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  subscribeInputSchema,
  toolInputSchemas,
  TOOL_DEFINITIONS,
  unsubscribeInputSchema,
  type ToolName,
} from '../shared/mcp';
import { describeToolCall } from './activity';
import type { BridgeEngine } from './engine';
import { LOCAL_FILE_INSTRUCTIONS } from '../shared/local-files';
import { PROCESS_INSTRUCTIONS } from '../shared/processes';

export interface McpServerOptions {
  engine: BridgeEngine;
  host: string;
  port: number;
  path?: string;
  getToken: () => string;
  settleRemoteStop?: (taskId: string) => Promise<void>;
  remoteFiles?: (kind: 'list' | 'read' | 'changes' | 'apply', input: unknown) => Promise<unknown>;
}

export interface McpServerHandle {
  start(): Promise<{ host: string; port: number; endpoint: string }>;
  stop(): Promise<void>;
  address(): { listening: boolean; host: string; port: number; endpoint: string; error: string | null };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// RPC attachments are bounded separately from the 256 KiB webhook event envelope.
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const SERVER_INFO = { name: 'paseo-dot-bridge', version: '0.1.0' };
const EVENT_CAPABILITY = { delivery: ['webhook'] };
const requestParamsSchema = z.object({ _meta: z.record(z.string(), z.unknown()).optional() }).passthrough();

/** MCP reserves params._meta for protocol metadata; it is never a business argument. */
function withoutRequestMetadata(params: unknown): unknown {
  if (params === undefined) return params;
  const parsed = requestParamsSchema.parse(params);
  delete parsed._meta;
  return parsed;
}

/** Builds the tool input JSON schema from the same Zod schema the handler parses with. */
function toolSchema(name: ToolName): Record<string, unknown> {
  return z.toJSONSchema(toolInputSchemas[name], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const path = options.path ?? '/mcp/dot';
  let server: Server | null = null;
  let listening = false;
  let stopping = false;
  let lastError: string | null = null;
  let boundPort = options.port;

  const endpoint = () => `http://${options.host}:${boundPort}${path}`;

  /** Negotiates a protocol version the server supports, per MCP's initialize contract. */
  function negotiate(params: unknown): string {
    const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
    return MCP_EVENT_PROTOCOL_VERSION;
  }

  async function handleRpc(request: JsonRpcRequest, token: string | null): Promise<{ status: number; body: unknown }> {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { status: 400, body: rpcError(request.id ?? null, -32600, 'invalid request') };
    }
    // Notifications carry no id and must not receive a response body.
    if (request.method.startsWith('notifications/')) return { status: 204, body: null };
    if (!token || token !== options.getToken()) {
      return { status: 401, body: rpcError(request.id ?? null, -32001, 'unauthorized') };
    }
    try {
      const result = await dispatch(request.method, withoutRequestMetadata(request.params));
      return { status: 200, body: { jsonrpc: '2.0', id: request.id ?? null, result } };
    } catch (error) {
      const rpcCode = (error as { rpcCode?: number }).rpcCode;
      if (rpcCode === CALLBACK_ENDPOINT_ERROR) {
        const reason = (error as { reason?: string }).reason ?? 'challenge_failed';
        return { status: 200, body: rpcErrorWithData(request.id ?? null, rpcCode, parseDotBridgeError(error), { reason }) };
      }
      const code = (error as { code?: string }).code === 'duplicate-mismatch' ? -32002 : -32000;
      return { status: 200, body: rpcError(request.id ?? null, code, parseDotBridgeError(error)) };
    }
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: negotiate(params),
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: { tools: {}, events: EVENT_CAPABILITY },
          serverInfo: SERVER_INFO,
        };
      case 'ping':
        return {};
      case 'server/discover':
        return {
          resultType: 'complete',
          protocolVersion: MCP_EVENT_PROTOCOL_VERSION,
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {}, events: EVENT_CAPABILITY },
        };
      case 'tools/list':
        return {
          tools: TOOL_DEFINITIONS.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: toolSchema(tool.name),
            annotations: { readOnlyHint: tool.readOnlyHint },
          })),
        };
      case 'tools/call':
        return callTool(params);
      case 'events/list':
        return {
          events: EVENT_DEFINITIONS.map(definition => ({
            name: definition.name,
            description: definition.description,
            delivery: definition.delivery,
            inputSchema: definition.inputSchema,
            payloadSchema: definition.payloadSchema,
          })),
          nextCursor: null,
        };
      case 'events/subscribe':
        return subscribe(params);
      case 'events/unsubscribe':
        return unsubscribe(params);
      default:
        throw rpcMethodNotFound(method);
    }
  }

  async function callTool(params: unknown): Promise<unknown> {
    const parsed = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).strict().parse(params);
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === parsed.name);
    if (!definition) throw dotBridgeError('readonly-rejected', `unknown tool ${parsed.name}`);
    const name = definition.name;
    const input = toolInputSchemas[name].parse(parsed.arguments);
    let result: unknown;
    try {
      result = await invoke(name, input);
    } catch (error) {
      observe(name, input, { error });
      throw error;
    }
    observe(name, input, { result });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  /** Mirrors Dot's call into the live native conversation. It never changes the tool's outcome. */
  function observe(name: ToolName, input: unknown, outcome: { result?: unknown; error?: unknown }): void {
    try {
      const args = input as Record<string, unknown>;
      const task = options.engine.tasks().find(item => item.id === args.taskId && item.connectionId === args.connectionId);
      const entry = task ? describeToolCall(name, args, outcome, task, Date.now()) : null;
      if (entry) options.engine.activity.record(entry);
    } catch (error) {
      console.error('[paseo-dot-bridge] activity', error);
    }
  }

  async function invoke(name: ToolName, input: unknown): Promise<unknown> {
    const args = input as Record<string, unknown>;
    const remoteTask = typeof args.taskId === 'string' ? options.engine.tasks().find(task => task.id === args.taskId && task.connectionId === args.connectionId && task.remoteOrigin) : undefined;
    if (remoteTask && ['list_dot_files', 'read_dot_file', 'read_dot_workspace_changes', 'apply_dot_changes'].includes(name)) {
      if (!options.remoteFiles) throw dotBridgeError('task-rejected', 'Remote file routing is unavailable');
      return options.remoteFiles(name === 'list_dot_files' ? 'list' : name === 'read_dot_file' ? 'read' : name === 'read_dot_workspace_changes' ? 'changes' : 'apply', input);
    }
    switch (name) {
      case 'list_dot_tasks': {
        const args = input as z.infer<typeof toolInputSchemas.list_dot_tasks>;
        return options.engine.listForConnection(args.connectionId, args.cursor);
      }
      case 'get_dot_task': {
        const args = input as z.infer<typeof toolInputSchemas.get_dot_task>;
        const task = options.engine.getForConnection(args.connectionId, args.taskId);
        return { task, ...(task.mode === 'text' ? { ...(task.provider ? { conversationInstructions: PROVIDER_CONVERSATION_INSTRUCTIONS } : {}), workspaceAutomaticAuthorization: options.engine.automaticAuthorization(task), permissionInstructions: AUTOMATIC_AUTHORIZATION_INSTRUCTIONS + ' ' + PERMISSION_HANDOFF_INSTRUCTIONS, processInstructions: AUTOMATIC_AUTHORIZATION_INSTRUCTIONS + ' ' + PROCESS_INSTRUCTIONS, commandsAvailable: !task.remoteOrigin && !!task.workspaceRoot, attachmentInstructions: ATTACHMENT_DELIVERY_INSTRUCTIONS + (task.remoteOrigin ? ' This task originated on a remote device. Upload success means the center received the file; confirm remote delivery from a later task attachment localPath before claiming it was saved on the originating device.' : ''), localFileInstructions: LOCAL_FILE_INSTRUCTIONS, localFilesAvailable: task.workspaceRoot !== null || task.remoteOrigin !== null } : { legacyReadOnly: true }) };
      }
      case 'claim_dot_task': {
        const args = input as z.infer<typeof toolInputSchemas.claim_dot_task>;
        const claim = await options.engine.claimTask(args);
        return { claim };
      }
      case 'request_dot_permission': return { permission: await options.engine.requestPermission(input as z.infer<typeof toolInputSchemas.request_dot_permission>) };
      case 'report_dot_permission_blocked': return { permission: await options.engine.reportPermissionBlocked(input as z.infer<typeof toolInputSchemas.report_dot_permission_blocked>) };
      case 'report_dot_progress': {
        const args = input as z.infer<typeof toolInputSchemas.report_dot_progress>;
        if (remoteTask && args.kind === 'stopped') { if (!options.settleRemoteStop) throw new Error('Remote stop confirmation unavailable'); await options.settleRemoteStop(args.taskId); }
        return options.engine.reportProgress(args);
      }
      case 'list_dot_files': return options.engine.listLocalFiles(input as z.infer<typeof toolInputSchemas.list_dot_files>);
      case 'read_dot_file': return options.engine.readLocalFile(input as z.infer<typeof toolInputSchemas.read_dot_file>);
      case 'read_dot_workspace_changes': return options.engine.readLocalWorkspaceChanges(input as z.infer<typeof toolInputSchemas.read_dot_workspace_changes>);
      case 'apply_dot_changes': return options.engine.applyLocalFiles(input as z.infer<typeof toolInputSchemas.apply_dot_changes>);
      case 'run_dot_command': return options.engine.runCommand(input as z.infer<typeof toolInputSchemas.run_dot_command>);
      case 'read_dot_process': return options.engine.readProcess(input as z.infer<typeof toolInputSchemas.read_dot_process>);
      case 'stop_dot_process': return options.engine.stopProcess(input as z.infer<typeof toolInputSchemas.stop_dot_process>);
      case 'list_dot_processes': return options.engine.listProcesses(input as z.infer<typeof toolInputSchemas.list_dot_processes>);
      case 'upload_dot_attachment': {
        const { taskId, ...args } = input as z.infer<typeof toolInputSchemas.upload_dot_attachment>;
        const result = await options.engine.uploadAttachment({ ...args, id: taskId, actor: 'dot' });
        if (remoteTask) delete result.attachment.localPath;
        return result;
      }
      case 'upload_dot_attachment_chunk': {
        const result = await options.engine.uploadAttachmentChunk(input as z.infer<typeof toolInputSchemas.upload_dot_attachment_chunk>);
        if (remoteTask && result.attachment) delete result.attachment.localPath;
        return result;
      }
      case 'read_dot_attachment_chunk': {
        const args = input as z.infer<typeof toolInputSchemas.read_dot_attachment_chunk>;
        return options.engine.readAttachmentChunk(args.taskId, args.attachmentId, args.index, args.connectionId);
      }
      case 'read_dot_attachment': {
        const args = input as z.infer<typeof toolInputSchemas.read_dot_attachment>;
        return options.engine.readAttachment(args.taskId, args.attachmentId, args.connectionId);
      }
      case 'submit_dot_text_result': {
        const { text, ...args } = input as z.infer<typeof toolInputSchemas.submit_dot_text_result>;
        return options.engine.processResult({ ...args, kind: 'text', summary: text, baseSha: null, headSha: null, branch: null, checks: [], prUrl: null });
      }
      case 'confirm_dot_connection': {
        const args = input as z.infer<typeof toolInputSchemas.confirm_dot_connection>;
        return options.engine.confirmConnection(args.connectionId, args.challenge);
      }
      default:
        throw dotBridgeError('readonly-rejected', String(name));
    }
  }

  async function subscribe(params: unknown): Promise<unknown> {
    const args = subscribeInputSchema.parse(params);
    return options.engine.setSubscription(args);
  }

  async function unsubscribe(params: unknown): Promise<unknown> {
    const args = unsubscribeInputSchema.parse(params);
    await options.engine.unsubscribe(args);
    return {};
  }

  async function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RPC_BYTES) {
          reject(dotBridgeError('payload-too-large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  async function onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Once stop() began, refuse new work instead of starting a tool call the server cannot finish.
    if (stopping) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'server stopping' }, id: null }));
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (request.method === 'GET') {
      // A discovery probe; no task data is returned without a token.
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'POST JSON-RPC only' }, id: null }));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      response.writeHead(413, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: parseDotBridgeError(error) }, id: null }));
      return;
    }
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body) as JsonRpcRequest;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
      return;
    }
    const outcome = await handleRpc(parsed, token);
    if (outcome.status === 204 || outcome.body === null) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(outcome.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(outcome.body));
  }

  return {
    async start() {
      if (server) return { host: options.host, port: boundPort, endpoint: endpoint() };
      stopping = false;
      server = createServer((request, response) => {
        onRequest(request, response).catch(error => {
          lastError = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: lastError }, id: null }));
        });
      });
      const starting = server;
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { starting.removeListener('listening', bound); reject(error); };
          const bound = () => { starting.removeListener('error', failed); resolve(); };
          starting.once('error', failed);
          starting.once('listening', bound);
          starting.listen(options.port, options.host);
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        listening = false;
        if (server === starting) server = null;
        starting.close();
        throw error;
      }
      if (stopping || server !== starting) { starting.close(); throw new Error('MCP bridge stopped during startup'); }
      starting.on('error', error => {
        lastError = error.message;
        if (server === starting) { listening = false; server = null; }
        starting.close();
        starting.closeAllConnections();
      });
      const address = server.address();
      if (address && typeof address === 'object') boundPort = address.port;
      listening = true;
      lastError = null;
      return { host: options.host, port: boundPort, endpoint: endpoint() };
    },
    async stop() {
      const current = server;
      server = null;
      listening = false;
      stopping = true;
      if (!current) return;
      // `close` stops accepting and waits for idle connections; force the active ones closed too, so a
      // held tool request cannot keep stop from completing. The engine's lifecycle signal cancels the
      // underlying Git/HTTP work separately.
      await new Promise<void>(resolve => {
        current.close(() => resolve());
        (current as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
    address() {
      return { listening, host: options.host, port: boundPort, endpoint: endpoint(), error: lastError };
    },
  };
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcErrorWithData(id: string | number | null, code: number, message: string, data: unknown): unknown {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function rpcMethodNotFound(method: string): Error {
  const error = new Error(`method not found: ${method}`) as Error & { code?: number };
  error.code = -32601;
  return error;
}
