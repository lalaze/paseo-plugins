import type { DraftState, SettingsDraft } from "../shared/settings-draft";

/** Keep the latest edit while serializing writes; a failed write never discards it. */
// Keep this a factory so the client bundle works through Hermes eval.
export function createDraftWriter(revision: number, write: (input: DraftState) => Promise<DraftState>, notify: () => void = () => {}) {
  let error: unknown = null;
  let pending: { draft: SettingsDraft | null } | undefined;
  let running: Promise<void> | undefined;
  function enqueue(draft: SettingsDraft | null) {
    pending = { draft };
    if (!error) void start().catch(() => {});
    notify();
  }
  function start(): Promise<void> {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (pending) {
        const job = pending; pending = undefined;
        try { const result = await write({ revision, draft: job.draft }); revision = result.revision; }
        catch (failure) { pending ??= job; error = failure; throw failure; }
      }
    }).finally(() => { running = undefined; notify(); });
    return running;
  }
  async function commit<T extends { draft: DraftState }>(save: (revision: number) => Promise<T>): Promise<T> {
    await flush();
    const result = await save(revision);
    revision = result.draft.revision;
    notify();
    return result;
  }
  async function flush() { error = null; notify(); await start(); }
  return { enqueue, commit, flush, get revision() { return revision; }, get error() { return error; }, get busy() { return !!pending || !!running; } };
}
