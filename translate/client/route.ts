export type ConversationRoute = { serverId: string; agentId?: string };

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Parse both dedicated agent routes and workspace tabs focused on an agent. */
export function parseConversationRoute(pathname: string, search = '', hash = ''): ConversationRoute | null {
  if (hash.startsWith('#/')) {
    const split = hash.slice(1).split('?');
    pathname = split[0]; search = split[1] ? `?${split.slice(1).join('?')}` : '';
  }
  const direct = pathname.match(/^\/h\/([^/]+)\/agent\/([^/]+)(?:\/|$)/);
  if (direct) return { serverId: decode(direct[1]), agentId: decode(direct[2]) };
  const workspace = pathname.match(/^\/h\/([^/]+)\/workspace\/[^/]+\/?$/);
  if (!workspace) return null;
  const open = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('open');
  const agentId = open?.startsWith('agent:') ? open.slice('agent:'.length).trim() : '';
  return { serverId: decode(workspace[1]), ...(agentId ? { agentId } : {}) };
}
