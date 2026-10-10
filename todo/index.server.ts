import type { PluginServerContext } from '@getpaseo/plugin/server';
import { todoError } from './shared/errors';
import { acceptTask, cancelTask, cleanupTask, continueTask, createTask, deleteTask, listTasks, readBranches, readCatalog, readCollaborationCatalog, readHostIdentity, readTask, retryTask, startQueue, startTask, updateTaskCollaboration } from './shared/rpc';
import type { TurnKind } from './shared/machine';
import { readBranches as branchesFor, readCatalog as catalogFor } from './server/catalog';
import { TodoEngine } from './server/engine';
import { createGit } from './server/git';
import { hostIdentity } from './server/host-identity';
import { PaseoTodoGateway } from './server/paseo';
import { ReconnectingAgents } from './server/reconnecting';
import { TaskStore, todoDataDir } from './server/store';

/** Engine work triggered by daemon events has no caller to hand an error to, so it is logged rather than left unhandled. */
function report(error: unknown): void {
  console.error('[paseo-todo]', error);
}

/** Opens the task store, recovers the queue, then serves the RPCs. Daemon events that fail are logged; they do not reject an RPC. */
export default function contribute(server: PluginServerContext) {
  let engine: TodoEngine | null = null;
  let stopped = false;
  const gateway = new ReconnectingAgents(() => PaseoTodoGateway.connect());
  const pending: Array<() => void> = [];
  const ready = (async () => {
    const store = await TaskStore.open(todoDataDir());
    if (stopped) { await store.dispose(); return; }
    engine = new TodoEngine({ store, git: createGit(), agents: gateway, collaboration: gateway });
    for (const job of pending.splice(0)) job();
    // A failed recovery leaves the affected tasks as they were; it must not take the RPCs down with it.
    await engine.recover().catch(report);
  })();
  ready.catch(report);

  const useEngine = async () => {
    await ready;
    if (!engine) throw todoError('store-locked');
    return engine;
  };
  const afterReady = (job: () => void) => { if (engine) job(); else pending.push(job); };

  server.handle(listTasks, async ({ repository }) => {
    const current = await useEngine();
    return repository ? current.listIn(repository) : current.list();
  });
  server.handle(readHostIdentity, () => hostIdentity());
  server.handle(readTask, async ({ id }) => (await useEngine()).read(id));
  server.handle(readCatalog, async () => catalogFor(await gateway.api()));
  server.handle(readCollaborationCatalog, async () => (await useEngine()).collaborationCatalog());
  server.handle(updateTaskCollaboration, async ({ id, collaboration }) => ({ task: await (await useEngine()).updateCollaboration(id, collaboration) }));
  server.handle(readBranches, async ({ repository }) => branchesFor(createGit(), repository));
  server.handle(createTask, async input => ({ task: await (await useEngine()).createTask(input) }));
  server.handle(startQueue, async ({ repository }) => ({ tasks: await (await useEngine()).startQueue(repository) }));
  server.handle(cleanupTask, async ({ id }) => ({ task: await (await useEngine()).cleanup(id) }));
  server.handle(startTask, async ({ id }) => ({ task: await (await useEngine()).startTask(id) }));
  server.handle(cancelTask, async ({ id }) => ({ task: await (await useEngine()).cancel(id) }));
  server.handle(deleteTask, async ({ id }) => ({ task: await (await useEngine()).deleteTask(id) }));
  server.handle(retryTask, async ({ id }) => ({ task: await (await useEngine()).retry(id) }));
  server.handle(continueTask, async ({ id, prompt }) => ({ task: await (await useEngine()).continue(id, prompt) }));
  server.handle(acceptTask, async ({ id, review }) => ({ task: await (await useEngine()).accept(id, review) }));

  const stopStarted = server.on('agent.turn_started', event => {
    afterReady(() => { engine?.onTurnStarted({ agentId: event.agent.id, turnId: event.turnId }).catch(report); });
  });
  const stopTurn = server.on('agent.turn_ended', event => {
    afterReady(() => {
      const outcome = event.outcome.kind === 'failed'
        ? { kind: 'failed' as TurnKind, error: event.outcome.error.message }
        : event.outcome.kind === 'canceled'
          ? { kind: 'canceled' as TurnKind, error: event.outcome.reason }
          : { kind: 'completed' as TurnKind };
      engine?.onTurnEnded({ agentId: event.agent.id, turnId: event.turnId, outcome }).catch(report);
    });
  });
  const stopPermission = server.on('agent.permission_requested', event => {
    afterReady(() => { engine?.onPermissionRequested(event.agent.id, event.request.id).catch(report); });
  });
  const stopResolved = server.on('agent.permission_resolved', event => {
    afterReady(() => { engine?.onPermissionResolved(event.agent.id, event.requestId).catch(report); });
  });

  return () => {
    stopped = true;
    stopStarted();
    stopTurn();
    stopPermission();
    stopResolved();
    void ready.catch(() => undefined).then(async () => {
      await engine?.dispose();
      await gateway.close();
    }).catch(report);
  };
}
