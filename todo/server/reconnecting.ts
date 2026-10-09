import type { PaseoApi } from '@getpaseo/client';
import { todoError } from '../shared/errors';
import type { AgentInspection, AgentPort, CreateAgentInput } from './agents';
import type { CollaborationPort } from './collaboration';

export interface ConnectedAgents extends AgentPort, CollaborationPort {
  readonly api: PaseoApi;
  close(): Promise<void>;
}

/**
 * Connects on first use and again after a failed attempt. While the daemon is unreachable every call rejects with
 * `gateway-unavailable`: an agent that cannot be inspected is never reported as gone, so accept, cancel and recovery
 * keep their "cannot prove it stopped" paths.
 */
export class ReconnectingAgents implements AgentPort {
  private current: Promise<ConnectedAgents> | null = null;
  private closed = false;

  constructor(private readonly connect: () => Promise<ConnectedAgents>) {}

  private get(): Promise<ConnectedAgents> {
    if (this.closed) return Promise.reject(todoError('gateway-unavailable', 'paseo-todo is shutting down'));
    this.current ??= this.connect().catch(error => {
      this.current = null;
      throw todoError('gateway-unavailable', error instanceof Error ? error.message : String(error));
    });
    return this.current;
  }

  async api(): Promise<PaseoApi> {
    return (await this.get()).api;
  }

  async create(input: CreateAgentInput): Promise<{ agentId: string; workspaceId: string }> {
    return (await this.get()).create(input);
  }

  async openWorkspace(cwd: string, title?: string): Promise<string> {
    return (await this.get()).openWorkspace(cwd, title);
  }

  async send(input: { agentId: string; operationId: string; prompt: string }): Promise<void> {
    return (await this.get()).send(input);
  }

  async cancel(agentId: string): Promise<void> {
    return (await this.get()).cancel(agentId);
  }

  async inspect(agentId: string): Promise<AgentInspection> {
    return (await this.get()).inspect(agentId);
  }

  async findByOperation(operationId: string): Promise<string | null> {
    return (await this.get()).findByOperation(operationId);
  }

  async archiveTask(input: { taskId: string; workspaceId: string | null; worktree: string | null }): Promise<void> {
    return (await this.get()).archiveTask(input);
  }

  async catalog() {
    return (await this.get()).catalog();
  }

  async open(input: Parameters<CollaborationPort['open']>[0]) {
    return (await this.get()).open(input);
  }

  async control(input: Parameters<CollaborationPort['control']>[0]) {
    return (await this.get()).control(input);
  }

  async resync(id: string) {
    return (await this.get()).resync(id);
  }

  async status() {
    return (await this.get()).status();
  }

  async close(): Promise<void> {
    this.closed = true;
    const current = this.current;
    this.current = null;
    await current?.then(gateway => gateway.close(), () => undefined);
  }
}
