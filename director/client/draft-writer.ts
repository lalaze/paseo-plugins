import type { DraftState, SettingsDraft } from "../shared/settings-draft";

/** Keep the latest edit while serializing writes; a failed write never discards it. */
export class DraftWriter {
  revision: number;
  error: unknown = null;
  private pending: { draft: SettingsDraft | null } | undefined;
  private running: Promise<void> | undefined;
  constructor(revision: number, private write: (input: DraftState) => Promise<DraftState>, private notify: () => void = () => {}) { this.revision = revision; }
  get busy() { return !!this.pending || !!this.running; }
  enqueue(draft: SettingsDraft | null) {
    this.pending = { draft };
    if (!this.error) void this.start().catch(() => {});
    this.notify();
  }
  private start(): Promise<void> {
    if (this.running) return this.running;
    this.running = Promise.resolve().then(async () => {
      while (this.pending) {
        const job = this.pending; this.pending = undefined;
        try { const result = await this.write({ revision: this.revision, draft: job.draft }); this.revision = result.revision; }
        catch (error) { this.pending ??= job; this.error = error; throw error; }
      }
    }).finally(() => { this.running = undefined; this.notify(); });
    return this.running;
  }
  async flush() { this.error = null; this.notify(); await this.start(); }
}
