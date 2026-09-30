import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentInspection } from '../server/agents';
import { ReconnectingAgents, type ConnectedAgents } from '../server/reconnecting';

function fake(): ConnectedAgents & { closed: number } {
  const inspection: AgentInspection = { exists: true, active: true, permission: false, status: 'running' };
  return {
    closed: 0,
    api: {} as ConnectedAgents['api'],
    create: async () => ({ agentId: 'a', workspaceId: 'w' }),
    send: async () => undefined,
    cancel: async () => undefined,
    inspect: async () => inspection,
    findByOperation: async () => 'a',
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

  it('shares one connection attempt between concurrent callers', async () => {
    let attempts = 0;
    const agents = new ReconnectingAgents(async () => { attempts += 1; return fake(); });
    await Promise.all([agents.inspect('a'), agents.inspect('b'), agents.api()]);
    assert.equal(attempts, 1);
  });
});
