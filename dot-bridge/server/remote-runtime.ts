import { networkInterfaces } from 'node:os';
import { isTailscaleIp, isTailscaleOrigin } from '../shared/tailscale';
import { remoteConfigSchema, type RemoteConfig } from '../shared/remote';
import type { BridgeEngine } from './engine';
import { RemoteCenter } from './remote-center';
import { RemoteClient } from './remote-client';
import { RemoteStateStore } from './remote-state';
import { remoteUrl } from './remote-http';

export class RemoteRuntime {
  readonly state: RemoteStateStore;
  readonly center: RemoteCenter;
  client: RemoteClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private serviceError: string | null = null;
  private configuration: Promise<void> = Promise.resolve();
  constructor(readonly engine: BridgeEngine, readonly dir: string, tick: () => Promise<void>) {
    this.state = new RemoteStateStore(dir); this.center = new RemoteCenter(this.state, engine, tick);
  }
  async start() {
    // A corrupt state file remains a hard failure. A listener failure must not disable settings RPC.
    await this.state.load();
    if (!this.closed) await this.applyConfigured();
  }
  private async applyConfigured(preserveClient = false) {
    try { await this.apply(preserveClient); this.serviceError = null; }
    catch { this.serviceError = 'Multi-machine service could not start; correct the address/port in settings and save again'; }
  }
  private async apply(preserveClient = false) {
    if (preserveClient && this.client && this.state.read().config.mode === 'remote' && !this.closed) {
      // Provider sessions retain this instance. File scopes are read live from state.
      void this.client.pump();
      return;
    }
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.center.stop(); if (this.client) await this.client.close(); this.client = null;
    if (this.closed) return;
    const config = this.state.read().config;
    if (config.mode === 'center') await this.center.start();
    if (config.mode === 'remote') {
      this.client = new RemoteClient(this.state, this.dir);
      await this.client.pump();
      this.timer = setInterval(() => { void this.client?.pump(); }, 1500); this.timer.unref();
    }
  }
  backend() { if (this.state.read().config.mode === 'remote') { if (!this.client) throw new Error('Remote backend is unavailable'); return this.client; } return this.engine; }
  status() {
    const stored = this.state.read();
    return { config: stored.config, devices: stored.devices.map(({ tokenHash: _hash, ...device }) => device),
      connected: stored.config.mode === 'remote' ? this.client?.connected ?? false : stored.config.mode === 'center' ? !!this.center.endpoint : this.engine.readyToDispatch(),
      tailscaleAddress: Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && isTailscaleIp(address.address))?.address ?? '',
      endpoint: this.center.endpoint, error: this.serviceError ?? (stored.config.mode === 'remote' ? this.client?.error ?? null : stored.config.mode === 'center' ? this.center.error : null), tokenConfigured: !!stored.token };
  }
  async configure(config: RemoteConfig, token?: string) {
    const run = this.configuration.then(async () => {
      if (this.closed) throw new Error('Bridge is closing');
      const next = remoteConfigSchema.parse(config), previous = this.state.read();
      if (next.transport === 'tailscale') {
        if (next.mode === 'center' && !isTailscaleIp(next.host)) throw new Error('Tailscale center must listen on its own 100.64–100.127 address');
        if (next.mode === 'remote' && !isTailscaleOrigin(next.url)) throw new Error('Enter http://<center Tailscale IP>:<port>');
      }
      if (next.transport !== 'tailscale' && next.writeFiles && !next.readFiles) throw new Error('File editing also requires file reading');
      if (next.mode === 'remote') {
        next.url = remoteUrl(next.url, next.transport === 'tailscale' || next.privateHttp);
        if (next.transport !== 'tailscale' && !(token ?? previous.token)) throw new Error('Enter the device credential');
        if (next.transport !== 'tailscale' && !next.workspaceIds.length) throw new Error('Select at least one local workspace');
      }
      const changedPeer = next.transport !== previous.config.transport || next.url !== previous.config.url || (token !== undefined && token !== previous.token);
      const active = previous.cache.some(task => ['queued', 'dispatched', 'claimed', 'running', 'waiting_user'].includes(task.status));
      if ((changedPeer || next.mode !== previous.config.mode) && (active || previous.stops.length || previous.results.length)) throw new Error('Finish or stop remote tasks before changing the connection');
      await this.state.mutate(draft => {
        draft.config = next; if (token !== undefined) draft.token = token;
        if (changedPeer) { draft.cache = []; draft.bindings = []; draft.stops = []; draft.deliveries = []; }
      });
      await this.applyConfigured(previous.config.mode === 'remote' && next.mode === 'remote' && !changedPeer);
    });
    this.configuration = run.catch(() => undefined);
    await run; return this.status();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.center.stop(); await this.client?.close(); await this.configuration; await this.state.flush();
  }
}
