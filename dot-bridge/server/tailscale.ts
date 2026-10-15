import { randomUUID } from 'node:crypto';
import { isTailscaleIp, tailscalePeer } from '../shared/tailscale';
import type { RemoteStateStore } from './remote-state';

/** Only accepted socket addresses can authenticate; forwarded headers and body fields are ignored. */
export async function authenticateTailscale(state: RemoteStateStore, localAddress: string | undefined, remoteAddress: string | undefined) {
  const config = state.read().config;
  const peer = tailscalePeer(localAddress, remoteAddress);
  if (config.mode !== 'center' || config.transport !== 'tailscale' || !isTailscaleIp(config.host)
    || localAddress?.replace(/^::ffff:/, '') !== config.host || !peer) return undefined;
  const existing = state.read().devices.find(device => device.tailscaleIp === peer);
  if (existing) return existing.revoked ? undefined : existing;
  return state.mutate(draft => {
    // Concurrent first requests share one durable identity. Revocation never silently re-enrolls.
    if (draft.config.mode !== 'center' || draft.config.transport !== 'tailscale' || draft.config.host !== config.host) return undefined;
    const prior = draft.devices.find(device => device.tailscaleIp === peer);
    if (prior) return prior.revoked ? undefined : prior;
    const device = { id: randomUUID(), name: 'Tailscale · ' + peer, tailscaleIp: peer, workspaceIds: [],
      capabilities: { chat: true, attachments: true, readFiles: true, writeFiles: true },
      revoked: false, createdAt: Date.now(), tokenHash: '' };
    draft.devices.push(device); return device;
  });
}
