import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaseoAgentUpdate } from '@getpaseo/client';
import { installComposerPills } from '../client/pills';

type Agent = { id: string; workspaceId?: string; archivedAt?: string | null };

function fakeClient(pages: Agent[][]) {
  const handlers = new Set<(update: PaseoAgentUpdate) => void>();
  const calls: string[] = [];
  const pills = new Map<string, { workspaceId: string; removed: boolean }>();
  let page = 0;
  const client = {
    paseo: { agents: {
      list: async () => {
        const entries = (pages[page] ?? []).map(agent => ({ agent }));
        const hasMore = page < pages.length - 1;
        page++;
        return { entries, pageInfo: { hasMore, nextCursor: hasMore ? `cursor-${page}` : null, prevCursor: null } };
      },
      subscribe: (handler: (update: PaseoAgentUpdate) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
    } },
    addComposerPill: (contribution: { id: string; workspaceId: string; agentId: string }) => {
      calls.push(`add ${contribution.agentId}@${contribution.workspaceId}`);
      const pill = { workspaceId: contribution.workspaceId, removed: false };
      pills.set(contribution.agentId, pill);
      return { update() {}, remove() { pill.removed = true; calls.push(`remove ${contribution.agentId}`); } };
    },
  };
  const emit = (update: unknown) => { for (const handler of handlers) handler(update as PaseoAgentUpdate); };
  return { client: client as unknown as Parameters<typeof installComposerPills>[0], calls, pills, emit, handlers };
}

const Content = () => null;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('registers one pill per active agent across pages and follows live updates', async () => {
  const fake = fakeClient([[{ id: 'a1', workspaceId: 'w1' }, { id: 'a2', workspaceId: 'w1', archivedAt: '2026-01-01' }], [{ id: 'a3', workspaceId: 'w2' }, { id: 'a4' }]]);
  const dispose = installComposerPills(fake.client, Content, 60 * 60 * 1000);
  await settle();
  assert.deepEqual(fake.calls, ['add a1@w1', 'add a3@w2']);

  fake.emit({ kind: 'upsert', agent: { id: 'a5', workspaceId: 'w2' } });
  fake.emit({ kind: 'upsert', agent: { id: 'a1', workspaceId: 'w1' } });
  assert.deepEqual(fake.calls.slice(2), ['add a5@w2']);

  fake.emit({ kind: 'remove', agentId: 'a3' });
  fake.emit({ kind: 'upsert', agent: { id: 'a5', workspaceId: 'w2', archivedAt: '2026-02-01' } });
  assert.deepEqual(fake.calls.slice(3), ['remove a3', 'remove a5']);

  fake.emit({ kind: 'upsert', agent: { id: 'a1', workspaceId: 'w9' } });
  assert.deepEqual(fake.calls.slice(5), ['remove a1', 'add a1@w9']);

  dispose();
  assert.deepEqual(fake.calls.slice(7), ['remove a1']);
  assert.equal(fake.handlers.size, 0);
  fake.emit({ kind: 'upsert', agent: { id: 'a6', workspaceId: 'w1' } });
  assert.equal(fake.calls.length, 8);
});

test('keeps existing pills when the initial listing fails', async () => {
  const fake = fakeClient([]);
  fake.client.paseo.agents.list = async () => { throw new Error('offline'); };
  const dispose = installComposerPills(fake.client, Content, 60 * 60 * 1000);
  fake.emit({ kind: 'upsert', agent: { id: 'a1', workspaceId: 'w1' } });
  await settle();
  assert.deepEqual(fake.calls, ['add a1@w1']);
  dispose();
});
