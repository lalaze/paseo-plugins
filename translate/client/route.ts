export type ConversationRoute = { serverId: string; agentId?: string };

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Parse both dedicated agent routes and workspace tabs focused on an agent. */
export function parseConversationRoute(pathname: string, search = '', hash = ''): ConversationRoute | null {
  if (hash.startsWith('#/')) {
    const hashRoute = hash.slice(1), separator = hashRoute.indexOf('?');
    pathname = separator >= 0 ? hashRoute.slice(0, separator) : hashRoute;
    search = separator >= 0 ? hashRoute.slice(separator) : '';
  }
  const direct = pathname.match(/^\/h\/([^/]+)\/agent\/([^/]+)(?:\/|$)/);
  if (direct) return { serverId: decode(direct[1]), agentId: decode(direct[2]) };
  const workspace = pathname.match(/^\/h\/([^/]+)\/workspace\/[^/]+\/?$/);
  if (!workspace) return null;
  const params = new URLSearchParams(search);
  const open = params.get('open'), agent = params.get('agentId') ?? params.get('agent');
  const agentId = open?.startsWith('agent:') ? open.slice('agent:'.length) : agent ?? undefined;
  return { serverId: decode(workspace[1]), ...(agentId ? { agentId: decode(agentId) } : {}) };
}
