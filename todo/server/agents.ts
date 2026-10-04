import type { TaskCollaboration } from '../shared/collaboration';

export interface AgentInspection {
  exists: boolean;
  active: boolean;
  permission: boolean;
  status: string | null;
}

export interface CreateAgentInput {
  operationId: string;
  taskId: string;
  cwd: string;
  provider: string;
  modeId: string | null;
  title: string;
  prompt: string;
  /** Task snapshot. Null keeps the normal single-agent launch. */
  collaboration: TaskCollaboration | null;
}

export interface AgentPort {
  create(input: CreateAgentInput): Promise<{ agentId: string; workspaceId: string }>;
  /** Opens the task worktree's workspace and does not create an agent or send a prompt. */
  openWorkspace(cwd: string): Promise<string>;
  send(input: { agentId: string; operationId: string; prompt: string }): Promise<void>;
  cancel(agentId: string): Promise<void>;
  inspect(agentId: string): Promise<AgentInspection>;
  findByOperation(operationId: string): Promise<string | null>;
  /** Archives every session made for the task, and the workspace opened on its worktree (never any other workspace). */
  archiveTask(input: { taskId: string; workspaceId: string | null; worktree: string | null }): Promise<void>;
}
