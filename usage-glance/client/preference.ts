import { settingsRpc } from '@getpaseo/plugin';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { headerSettings } from '../shared/settings';

const rpcContracts = settingsRpc(headerSettings.id);

export function createHeaderPreference(rpc: PluginClientContext['rpc']) {
  let providerId: string | null = null;
  let revision = 'missing';
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };

  async function load() {
    try {
      const result = await rpc(rpcContracts.read, {});
      if (result.status !== 'ready') return;
      providerId = headerSettings.schema.parse(result.values).providerId;
      revision = result.revision;
      emit();
    } catch {
      // Keep the last known selection if the host settings document cannot be read.
    }
  }

  async function save(next: string | null, retried = false) {
    const previous = providerId;
    providerId = next;
    emit();
    try {
      const result = await rpc(rpcContracts.write, { revision, values: { providerId: next } });
      if (result.status === 'saved') {
        providerId = headerSettings.schema.parse(result.values).providerId;
        revision = result.revision;
        emit();
        return;
      }
      if (result.status === 'conflict' && !retried) {
        await load();
        await save(next, true);
        return;
      }
      providerId = previous;
      emit();
    } catch {
      providerId = previous;
      emit();
    }
  }

  void load();
  return {
    get: () => providerId,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save,
    load,
  };
}

export type HeaderPreference = ReturnType<typeof createHeaderPreference>;
