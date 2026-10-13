import { createDotProvider, DOT_PROVIDER_ID, WORKSPACE_ENV } from './server/provider';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { dotBridgeError, parseDotBridgeError } from './shared/errors';
import {
  connectionConfigure,
  connectionStatus,
  connectionTest,
  connectionTokenReveal,
  taskAttachmentRead,
  taskAttachmentChunkRead,
  taskAttachmentUpload,
  taskCancelRequest,
  taskLocalClose,
  taskCreate,
  taskGet,
  taskHistory,
  taskList,
  taskMessageAdd,
  taskPermissionRespond,
  taskRoundCreate,
  taskRoundRetry,
} from './shared/rpc';
import { defaultSettings, dotBridgeSettingsDefinition, type DotBridgeSettings } from './shared/settings';
import { BridgeEngine } from './server/engine';
import { RemoteRuntime } from './server/remote-runtime';
import { RemoteClient } from './server/remote-client';
import { remoteState, remoteConfigure, remoteCreateDevice, remoteRevokeDevice } from './shared/remote';
import { canonicalWorkspace } from './server/local-files';
import { createMcpServer } from './server/mcp-server';
import { BridgeListener } from './server/listener';
import { BridgeStore, resolveDataDir } from './server/store';

const settingsDefinition = dotBridgeSettingsDefinition;
const TICK_MS = 2500;

function report(error: unknown): void {
  console.error('[paseo-dot-bridge]', error);
}

/** Opens the store, starts the bridge, then serves the RPCs. Daemon events that fail are logged, not rethrown. */
export default function contribute(server: PluginServerContext) {
  let engine: BridgeEngine | null = null;
  let remote: RemoteRuntime | null = null;
  let store: BridgeStore | null = null;
  let bridge: BridgeListener | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let settingsWatch: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // Aborted on unload so in-flight callbacks and git fetches are cancelled immediately.
  const lifecycle = new AbortController();
  let current: DotBridgeSettings = defaultSettings;
  let dataDirError: string | null = null;
  const pending: Array<() => void> = [];

  const settings = server.registerSettings(settingsDefinition);
  const stopSettings = settings.subscribe(state => {
    if (state.status === 'ready') current = state.values;
  });
  // The stored settings are read once before the bridge starts, so the listen host/port and the
  // in-flight cap come from the user's values, never from a race with the defaults.
  const initialSettings = settings.read().then(state => {
    if (state.status === 'ready') current = state.values;
  }).catch(report);

  const ready = (async () => {
    await initialSettings;
    const dir = resolveDataDir();
    if (!dir) {
      dataDirError = 'data-dir-unset';
      return;
    }
    store = await BridgeStore.open(dir);
    if (stopped) {
      await store.dispose();
      return;
    }
    engine = new BridgeEngine({
      store,
      getMaxInFlight: () => current.maxInFlightTasks,
      getAppendTaskAuthorization: () => current.appendTaskAuthorization,
      signal: lifecycle.signal,
    });
    await engine.init();
    remote = new RemoteRuntime(engine, dir, tick);
    await remote.start();
    bridge = new BridgeListener({
      create: (host, port) => createMcpServer({ engine: engine!, host, port, getToken: () => engine?.mcpToken() ?? '',
        settleRemoteStop: taskId => { if (!remote) throw new Error('Remote gateway unavailable'); return remote.center.settleStop(taskId); },
        remoteFiles: (kind, input) => { if (!remote) throw new Error('Remote gateway unavailable'); return remote.center.requestFile(kind, input); },
      }),
      listening: value => engine?.setBridgeListening(value),
      report,
    });
    await startBridge();
    for (const job of pending.splice(0)) job();
    await engine.recover().catch(report);
    // The contribution may have been removed while startup was still running.
    if (stopped) return;
    timer = setInterval(() => { void tick(); }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
    settingsWatch = setInterval(() => {
      if (stopped || !engine || !bridge) return;
      void startBridge().catch(report);
    }, TICK_MS);
    if (typeof settingsWatch.unref === 'function') settingsWatch.unref();
  })();
  ready.catch(report);

  /** Builds a fresh server with the current listen settings; a settings change rebinds the socket. */
  async function startBridge(): Promise<void> {
    if (!bridge || stopped) return;
    await bridge.ensure(current.listenHost, current.listenPort);
  }

  async function tick(): Promise<void> {
    if (!engine || stopped) return;
    await engine.dispatchTick().catch(report);
    await engine.deliverTick().catch(report);
  }

  const useEngine = async (): Promise<BridgeEngine> => {
    await ready;
    if (!engine) throw dotBridgeError(store?.loadError === 'store-locked' ? 'store-locked' : 'data-dir-unset');
    return engine;
  };

  const useBackend = async () => { await useEngine(); return remote ? remote.backend() : engine!; };
  const useRemote = async () => { await useEngine(); if (!remote) throw new Error('Remote service unavailable'); return remote; };
  server.handle(remoteState, async () => (await useRemote()).status());
  server.handle(remoteConfigure, async ({ config, token }) => (await useRemote()).configure(config, token));
  server.handle(remoteCreateDevice, async ({ confirm: _confirm, ...input }) => (await useRemote()).center.createDevice(input));
  server.handle(remoteRevokeDevice, async ({ id }) => { const service = await useRemote(); await service.center.revokeDevice(id); return service.status(); });

  const removeProviderHook = server.before('agent.session_open', async ({ request }, context) => {
    if (request.provider !== DOT_PROVIDER_ID) return;
    const listing = await context.paseo.workspaces.list();
    const workspace = listing.entries.find(entry => entry.id === request.workspaceId)
      ?? listing.entries.find(entry => (entry.workspaceDirectory ?? entry.projectRootPath) === request.cwd);
    const directory = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
    if (!workspace || !directory || canonicalWorkspace(directory) !== canonicalWorkspace(request.cwd)) throw dotBridgeError('workspace-missing', request.cwd);
    return { ...request, cwd: canonicalWorkspace(directory), env: { ...request.env, [WORKSPACE_ENV]: workspace.id } };
  });
  server.registerProvider(createDotProvider({ engine: useBackend, tick, signal: lifecycle.signal }));

  server.handle(connectionStatus, async () => {
    const current = await useEngine();
    const address = bridge?.address() ?? { listening: false, host: '', port: 0, endpoint: '', error: null };
    return {
      connection: current.connection(),
      facts: current.connectionFacts(),
      bridge: { listening: address.listening, host: address.host, port: address.port, endpoint: address.endpoint, error: address.error },
      instructions: current.instructions(),
    };
  });
  server.handle(connectionConfigure, async ({ operationId, revision, name, publicBaseUrl }) => ({
    connection: await (await useEngine()).configureConnection({ operationId, revision, name, publicBaseUrl }),
  }));
  server.handle(connectionTest, async ({ operationId }) => {
    const current = await useEngine();
    const { challenge, expiresAt, eventId } = await current.startConnectionTest(operationId);
    await current.deliverTick().catch(report);
    // "delivered" reflects this test event's own delivery, never another subscription's history.
    return { challenge, expiresAt, delivered: current.eventDelivered(eventId) };
  });
  server.handle(connectionTokenReveal, async () => {
    const current = await useEngine();
    return { token: current.mcpToken(), configured: current.mcpToken().length > 0 };
  });
  server.handle(taskCreate, async (input, context) => {
    const current = await useBackend();
    const listing = await context.paseo.workspaces.list();
    const workspace = listing.entries.find(entry => entry.id === input.workspaceId);
    const directory = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
    if (!directory) throw dotBridgeError('workspace-missing', input.workspaceId);
    if (current instanceof RemoteClient) {
      const result = await current.providerPrompt({ id: input.operationId, operationId: input.operationId, clientMessageId: 'panel:' + input.operationId, workspaceId: input.workspaceId, cwd: canonicalWorkspace(directory), body: input.requirement, systemPrompt: input.acceptance, attachments: [] });
      return { task: result.task };
    }
    const task = await current.createTask({ ...input, mode: 'text', repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '', workspaceRoot: canonicalWorkspace(directory) });
    void tick();
    return { task };
  });
  server.handle(taskList, async ({ workspaceId }) => {
    await ready;
    if (!engine) return { tasks: [], dataDir: resolveDataDir() ?? '', loadError: dataDirError ?? store?.loadError ?? null };
    const tasks = (await useBackend()).tasks().filter(task => (workspaceId ? task.workspaceId === workspaceId : true));
    return { tasks, dataDir: store?.dir ?? '', loadError: store?.loadError ?? null };
  });
  server.handle(taskGet, async ({ id }) => ({ task: (await useBackend()).task(id) }));
  server.handle(taskPermissionRespond, async input => {
    const permission = await (await useBackend()).respondPermission(input);
    void tick();
    return { permission };
  });
  server.handle(taskHistory, async ({ id, cursor }) => (await useBackend()).historyForTask(id, cursor));
  server.handle(taskMessageAdd, async input => {
    const task = await (await useBackend()).addMessage(input);
    void tick();
    return { task };
  });
  server.handle(taskAttachmentUpload, async input => {
    const result = await (await useBackend()).uploadAttachment({ ...input, actor: 'user' });
    void tick();
    return result;
  });
  server.handle(taskAttachmentRead, async input => (await useBackend()).readAttachment(input.id, input.attachmentId));
  server.handle(taskAttachmentChunkRead, async input => (await useBackend()).readAttachmentChunk(input.id, input.attachmentId, input.index));
  server.handle(taskCancelRequest, async input => {
    const task = await (await useBackend()).cancelRequest(input);
    void tick();
    return { task };
  });
  server.handle(taskLocalClose, async input => {
    const task = await (await useBackend()).closeLocal(input);
    void tick();
    return { task };
  });
  server.handle(taskRoundCreate, async input => {
    const task = await (await useBackend()).createRound(input);
    void tick();
    return { task };
  });
  server.handle(taskRoundRetry, async input => {
    const task = await (await useBackend()).retryRound(input);
    void tick();
    return { task };
  });

  return () => {
    stopped = true;
    removeProviderHook();
    stopSettings();
    if (timer) clearInterval(timer);
    if (settingsWatch) clearInterval(settingsWatch);
    // Abort in-flight callback/DNS/recover/Git work at once, then release the listening port and the
    // store lock immediately — never gated on `ready`, which could still be awaiting a lookup the
    // signal cannot interrupt on its own. `dispose` waits for pending writes before releasing the
    // lock, and cleanup never starts a new listen or runs a task (startBridge/tick re-check stopped).
    lifecycle.abort();
    if (remote) void remote.close().catch(report);
    engine?.dispose();
    engine?.setBridgeListening(false);
    const bridgeNow = bridge;
    bridge = null;
    if (bridgeNow) void bridgeNow.stop().catch(report);
    const storeNow = store;
    if (storeNow) void storeNow.dispose().catch(report);
    // If startup opens the store/bridge after this point, stop them as soon as they appear.
    void ready.catch(() => undefined).then(async () => {
      await remote?.close().catch(report);
      engine?.dispose();
      const lateBridge = bridge;
      bridge = null;
      if (lateBridge) await lateBridge.stop().catch(report);
      if (store && store !== storeNow) await store.dispose().catch(report);
    }).catch(report);
  };
}

export { parseDotBridgeError };
