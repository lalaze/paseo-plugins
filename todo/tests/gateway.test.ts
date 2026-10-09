import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { unavailableCatalog } from '../shared/collaboration';
import type { AgentInspection } from '../server/agents';
import { PaseoTodoGateway } from '../server/paseo';
import { ReconnectingAgents, type ConnectedAgents } from '../server/reconnecting';

function fake(): ConnectedAgents & { closed: number } {
  const inspection: AgentInspection = { exists: true, active: true, permission: false, status: 'running' };
  return {
    closed: 0,
    api: {} as ConnectedAgents['api'],
    create: async () => ({ agentId: 'a', workspaceId: 'w' }),
    openWorkspace: async () => 'w',
    send: async () => undefined,
    cancel: async () => undefined,
    inspect: async () => inspection,
    findByOperation: async () => 'a',
    archiveTask: async () => undefined,
    catalog: async () => unavailableCatalog('stub'),
    open: async () => { throw new Error('not used'); },
    control: async () => { throw new Error('not used'); },
    resync: async () => { throw new Error('not used'); },
    status: async () => { throw new Error('not used'); },
    async close() { this.closed += 1; },
  };
}

describe('reconnecting gateway', () => {
  it('rejects while the daemon is unreachable instead of reporting agents as gone, then reconnects', async () => {
    let attempts = 0;
    const live = fake();
    const agents = new ReconnectingAgents(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('ECONNREFUSED');
      return live;
    });
    await assert.rejects(agents.inspect('a'), (error: Error) => /todo-error:gateway-unavailable/.test(error.message) && /ECONNREFUSED/.test(error.message));
    await assert.rejects(agents.cancel('a'), /gateway-unavailable/);
    assert.deepEqual(await agents.inspect('a'), { exists: true, active: true, permission: false, status: 'running' });
    assert.equal(await agents.findByOperation('op'), 'a');
    assert.equal(attempts, 3);
    await agents.close();
    assert.equal(live.closed, 1);
    await assert.rejects(agents.inspect('a'), /gateway-unavailable/);
    assert.equal(attempts, 3, 'no reconnect after close');
  });

  it('forwards a collaboration catalog on the same connection', async () => {
    let attempts = 0;
    const live = fake();
    let catalogs = 0;
    live.catalog = async () => {
      catalogs += 1;
      return unavailableCatalog('down');
    };
    const agents = new ReconnectingAgents(async () => {
      attempts += 1;
      return live;
    });
    const catalog = await agents.catalog();
    assert.equal(catalog.error, 'down');
    assert.equal(catalogs, 1);
    assert.equal(attempts, 1);
    await agents.inspect('a');
    assert.equal(attempts, 1);
    await agents.close();
  });

  it('shares one connection attempt between concurrent callers', async () => {
    let attempts = 0;
    const agents = new ReconnectingAgents(async () => { attempts += 1; return fake(); });
    await Promise.all([agents.inspect('a'), agents.inspect('b'), agents.api()]);
    assert.equal(attempts, 1);
  });

  it('opens a task workspace without sending a prompt, and refuses a normal create when a snapshot is present', async () => {
    const opened: string[] = [];
    const api = {
      workspaces: { open: async (cwd: string) => { opened.push(cwd); return { id: 'ws-9' }; } },
      dispose: async () => undefined,
    };
    const driver = { connect: async () => undefined, close: async () => undefined };
    const gateway = new PaseoTodoGateway(driver as unknown as DaemonClient, api as unknown as PaseoApi, { url: 'ws://127.0.0.1/ws' });
    assert.equal(await gateway.openWorkspace('/wt/task'), 'ws-9');
    await assert.rejects(() => gateway.create({
      operationId: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      cwd: '/wt/task', provider: 'stub/model', modeId: null, title: 'T', prompt: 'Do the work',
      collaboration: { mode: 'full', settings: { profiles: [] } } as never,
    }), /collaboration-deferred/);
    assert.deepEqual(opened, ['/wt/task']);
  });

  it('names a task workspace after the task, unless it already has a title', async () => {
    const titles: string[] = [];
    let existing: string | null = null;
    const api = {
      workspaces: { open: async () => ({
        id: 'ws-9',
        current: () => (existing ? { title: existing } : {}),
        setTitle: async (title: string) => { titles.push(title); },
      }) },
      dispose: async () => undefined,
    };
    const driver = { connect: async () => undefined, close: async () => undefined };
    const gateway = new PaseoTodoGateway(driver as unknown as DaemonClient, api as unknown as PaseoApi, { url: 'ws://127.0.0.1/ws' });
    assert.equal(await gateway.openWorkspace('/wt/task', 'Fix the thing'), 'ws-9');
    existing = 'Kept';
    assert.equal(await gateway.openWorkspace('/wt/task', 'Fix the thing'), 'ws-9');
    assert.equal(await gateway.openWorkspace('/wt/task'), 'ws-9');
    assert.deepEqual(titles, ['Fix the thing']);
  });

  it('forwards workspace open on the shared connection', async () => {
    let attempts = 0;
    const live = fake();
    let cwd = '';
    live.openWorkspace = async input => { cwd = input; return 'ws-9'; };
    const agents = new ReconnectingAgents(async () => {
      attempts += 1;
      return live;
    });
    assert.equal(await agents.openWorkspace('/wt/a'), 'ws-9');
    assert.equal(cwd, '/wt/a');
    await agents.inspect('a');
    assert.equal(attempts, 1);
    await agents.close();
  });
});
