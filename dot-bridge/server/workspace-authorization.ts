import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspaceGrant } from '../shared/workspace-authorization';
import { workspaceGrantSchema } from '../shared/workspace-authorization';
import { dotBridgeError } from '../shared/errors';

export function workspaceRootIdentity(root: string): string {
  if (realpathSync(root) !== root || root === '/') throw new Error('Workspace root changed');
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Not an ordinary workspace directory');
  return `${stat.dev}:${stat.ino}`;
}

export function findWorkspaceGrant(grants: readonly WorkspaceGrant[], workspaceId: string, root: string | null): WorkspaceGrant | undefined {
  if (!root) return;
  const grant = grants.find(grant => grant.workspaceId === workspaceId && grant.workspaceRoot === root);
  if (!grant) return;
  try { if (workspaceRootIdentity(root) === grant.rootIdentity) return grant; } catch { /* Changed or absent roots fail closed. */ }
}

const policySchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(),
  grants: z.array(workspaceGrantSchema).max(100).refine(grants => new Set(grants.map(g => g.workspaceId)).size === grants.length),
}).strict();

/** Independent host policy, not a task permission or an MCP-editable settings file. */
export class WorkspaceAuthorizationStore {
  private state = policySchema.parse({ version: 1, revision: 0, grants: [] });
  private readonly file: string;
  constructor(private readonly dir: string) { this.file = join(dir, 'workspace-authorizations.json'); }
  init(): void {
    try { this.state = policySchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  grants(): readonly WorkspaceGrant[] { return this.state.grants; }
  status(workspaceId: string, root: string) {
    return { workspaceId, workspaceRoot: root, rootIdentity: workspaceRootIdentity(root), enabled: !!findWorkspaceGrant(this.state.grants, workspaceId, root), revision: String(this.state.revision) };
  }
  set(workspaceId: string, root: string, enabled: boolean, revision: string) {
    if (revision !== String(this.state.revision)) throw dotBridgeError('revision-conflict');
    const identity = workspaceRootIdentity(root);
    const grants = this.state.grants.filter(grant => grant.workspaceId !== workspaceId);
    if (enabled) grants.push({ id: randomUUID(), workspaceId, workspaceRoot: root, rootIdentity: identity, enabledAt: Date.now() });
    const next = policySchema.parse({ version: 1, revision: this.state.revision + 1, grants });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
    this.state = next;
    const directory = openSync(this.dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    return this.status(workspaceId, root);
  }
}
