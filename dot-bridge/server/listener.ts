import type { McpServerHandle } from './mcp-server';

/** Serializes rebinding and retries transient bind failures, including unchanged settings. */
export class BridgeListener {
  private handle: McpServerHandle | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private host = '';
  private port = -1;
  private failures = 0;
  private retryAt = 0;
  private error: string | null = null;

  constructor(private readonly options: {
    create(host: string, port: number): McpServerHandle;
    listening(value: boolean): void;
    report(error: unknown): void;
    now?: () => number;
  }) {}

  ensure(host: string, port: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const same = host === this.host && port === this.port;
    if (same && (this.handle?.address().listening || this.now() < this.retryAt)) return Promise.resolve();
    if (!same) this.failures = 0;
    this.running = this.bind(host, port).finally(() => { this.running = null; });
    return this.running;
  }

  address() {
    const value = this.handle?.address() ?? { listening: false, host: this.host, port: Math.max(0, this.port), endpoint: '', error: null };
    return { ...value, error: this.error ?? value.error };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.options.listening(false);
    await this.running;
    await this.handle?.stop();
    this.handle = null;
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  private async bind(host: string, port: number): Promise<void> {
    this.options.listening(false);
    this.host = host; this.port = port;
    try {
      await this.handle?.stop();
      if (this.stopped) return;
      const handle = this.options.create(host, port);
      this.handle = handle;
      await handle.start();
      if (this.stopped) { await handle.stop(); return; }
      this.error = null; this.retryAt = 0; this.failures = 0;
      this.options.listening(true);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + Math.min(30_000, 2500 * 2 ** Math.min(this.failures++, 4));
      this.options.report(error);
    }
  }
}
