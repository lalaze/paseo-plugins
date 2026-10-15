/** Tailscale's IPv4 allocation (100.64.0.0/10). DNS/proxy headers are not peer identity. */
export function isTailscaleIp(value: string): boolean {
  const host = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}
export function isTailscaleOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && isTailscaleIp(url.hostname) && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname); }
  catch { return false; }
}
/** Direct connections must terminate on the tailnet interface and originate there too. */
export function tailscalePeer(localAddress: string | undefined, remoteAddress: string | undefined): string | null {
  return localAddress && remoteAddress && isTailscaleIp(localAddress) && isTailscaleIp(remoteAddress)
    ? remoteAddress.replace(/^::ffff:/, '') : null;
}
