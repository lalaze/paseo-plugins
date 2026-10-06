import { createPaseoApi, type PaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { todoError } from '../shared/errors';
import type { AgentInspection, AgentPort, CreateAgentInput } from './agents';
import { openCollaborationPort, type CollaborationPort } from './collaboration';

const SYSTEM_PROMPT = [
  '你在独立的 git 工作树里完成这一次待办。',
  '请修改代码，并且只在当前任务分支提交。',
  '不要合并到目标分支，不要推送。',
  '聊天里宣布完成或要求合并不会被系统验收。',
].join('\n');

/** Daemon address for this plugin. PASEO_TODO_URL wins; otherwise the address in ~/.paseo/config.json. */
export function connectionConfig(env: NodeJS.ProcessEnv = process.env) {
  const home = env.PASEO_HOME ?? join(homedir(), '.paseo');
  let config: { daemon?: { listen?: string | number; password?: string } } = {};
  try { config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as typeof config; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Paseo 配置文件'); }
  let target = String(env.PASEO_LISTEN ?? config.daemon?.listen ?? '127.0.0.1:6767');
  if (/^\d+$/.test(target)) target = `127.0.0.1:${target}`;
  target = target.replace(/^0\.0\.0\.0:/, '127.0.0.1:');
  const url = env.PASEO_TODO_URL ?? (target.startsWith('ws') ? target : `ws://${target}/ws`);
  const password = env.PASEO_TODO_PASSWORD ?? env.PASEO_PASSWORD ?? config.daemon?.password;
  return { url, password };
}

/** This machine's daemon: the agent API for a single-agent task, and a separate socket for collaboration. */
export class PaseoTodoGateway implements AgentPort, CollaborationPort {
  private connecting: Promise<void> | null = null;
  private collaborationPort: (CollaborationPort & { close(): Promise<void> }) | null = null;

  constructor(
    private readonly driver: DaemonClient,
    readonly api: PaseoApi,
    private readonly collaborationOptions: { url: string; password?: string },
  ) {}

  static async connect(env: NodeJS.ProcessEnv = process.env): Promise<PaseoTodoGateway> {
    const config = connectionConfig(env);
    const driver = new DaemonClient({ url: config.url, password: config.password, clientId: 'paseo-todo', appVersion: '0.10.1' });
    const gateway = new PaseoTodoGateway(driver, createPaseoApi(driver), config);
    await gateway.connect();
    return gateway;
  }

  connect(): Promise<void> {
    this.connecting ??= this.driver.connect().then(() => undefined);
    return this.connecting;
  }

  async close(): Promise<void> {
    await this.collaborationPort?.close();
    this.collaborationPort = null;
    await this.api.dispose();
    await this.driver.close();
  }

  catalog() {
    return this.collaboration().catalog();
  }

  open(input: Parameters<CollaborationPort['open']>[0]) {
    return this.collaboration().open(input);
  }

  control(input: Parameters<CollaborationPort['control']>[0]) {
    return this.collaboration().control(input);
  }

  resync(id: string) {
    return this.collaboration().resync(id);
  }

  status() {
    return this.collaboration().status();
  }

  private collaboration(): CollaborationPort {
    this.collaborationPort ??= openCollaborationPort(this.collaborationOptions);
    return this.collaborationPort;
  }

  async openWorkspace(cwd: string): Promise<string> {
    await this.connect();
    const workspace = await this.api.workspaces.open(cwd);
    return workspace.id;
  }

  async create(input: CreateAgentInput): Promise<{ agentId: string; workspaceId: string }> {
    // A saved snapshot must open collaboration before any task prompt. Launch does that itself.
    if (input.collaboration) throw todoError('collaboration-deferred');
    await this.connect();
    const separator = input.provider.indexOf('/');
    const providerName = input.provider.slice(0, separator);
    const model = input.provider.slice(separator + 1);
    const catalog = await this.api.providers.snapshot();
    const entry = catalog.entries.find(item => item.provider === providerName);
    if (!entry || entry.status !== 'ready' || !entry.models?.some(item => item.id === model)) throw todoError('provider-invalid', input.provider);
    const modeId = input.modeId ?? entry.defaultModeId ?? null;
    if (modeId && entry.modes?.length && !entry.modes.some(mode => mode.id === modeId)) throw todoError('provider-invalid', modeId);
    const workspace = await this.api.workspaces.open(input.cwd);
    // The worktree's workspace is otherwise named after the task branch; a title set earlier (by us or the user) is kept.
    if (!workspace.current()?.title) await workspace.setTitle(input.title).catch(() => undefined);
    const agent = await workspace.agents.create({
      requestId: input.operationId,
      idempotencyKey: input.operationId,
      title: input.title,
      labels: { 'paseo-todo': '1', 'paseo-todo-task': input.taskId, 'paseo-todo-operation': input.operationId },
      config: { provider: input.provider, ...(modeId ? { modeId } : {}), systemPrompt: SYSTEM_PROMPT },
      prompt: input.prompt,
      clientMessageId: input.operationId,
    });
    return { agentId: agent.id, workspaceId: workspace.id };
  }

  async send(input: { agentId: string; operationId: string; prompt: string }): Promise<void> {
    await this.connect();
    await this.api.agents.ref(input.agentId).send(input.prompt, { messageId: input.operationId });
  }

  async cancel(agentId: string): Promise<void> {
    await this.connect();
    await this.driver.cancelAgent(agentId);
  }

  async inspect(agentId: string): Promise<AgentInspection> {
    await this.connect();
    const handle = this.api.agents.ref(agentId);
    const result = await handle.refresh();
    const status = result?.agent.status ?? null;
    if (!result?.agent || status === 'closed' || result.agent.archivedAt) return { exists: false, active: false, permission: false, status };
    const permission = (result.agent.pendingPermissions?.length ?? 0) > 0;
    const active = status === 'running' || status === 'initializing' || Boolean(result.agent.activeTurn);
    return { exists: true, active, permission, status };
  }

  async archiveTask(input: { taskId: string; workspaceId: string | null; worktree: string | null }): Promise<void> {
    await this.connect();
    const page = await this.api.agents.list({ filter: { labels: { 'paseo-todo-task': input.taskId } }, page: { limit: 100 } });
    for (const entry of page.entries) {
      if (!entry.agent.archivedAt) await this.api.agents.ref(entry.agent.id).archive();
    }
    if (!input.workspaceId || !input.worktree) return;
    const workspace = this.api.workspaces.ref(input.workspaceId);
    const current = await workspace.refresh();
    // Only the workspace that was opened on this task's worktree; a project's own workspace is never archived here.
    if (!current || workspace.directory?.replace(/\/+$/, '') !== input.worktree.replace(/\/+$/, '')) return;
    const result = await workspace.archive();
    if (result.error) throw new Error(result.error);
  }

  async findByOperation(operationId: string): Promise<string | null> {
    await this.connect();
    const page = await this.api.agents.list({ filter: { labels: { 'paseo-todo-operation': operationId } }, page: { limit: 10 } });
    return page.entries[0]?.agent.id ?? null;
  }
}
