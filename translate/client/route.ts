export type ConversationRoute = { serverId: string };

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Parse both dedicated agent routes and workspace tabs focused on an agent. */
export function parseConversationRoute(pathname: string, _search = '', hash = ''): ConversationRoute | null {
  if (hash.startsWith('#/')) {
    pathname = hash.slice(1).split('?')[0];
  }
  const direct = pathname.match(/^\/h\/([^/]+)\/agent\/([^/]+)(?:\/|$)/);
  if (direct) return { serverId: decode(direct[1]) };
  const workspace = pathname.match(/^\/h\/([^/]+)\/workspace\/[^/]+\/?$/);
  if (!workspace) return null;
  return { serverId: decode(workspace[1]) };
}
