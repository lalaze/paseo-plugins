// Loopback proxy for Streamable HTTP MCP servers injected by Paseo.
// agy sends MCP-Protocol-Version: 2026-07-28 even after the server negotiated an older
// version at initialize; @modelcontextprotocol/sdk 1.x answers 400 and agy drops every
// tool. Retrying without the header lets the server use the negotiated version.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

// Hop-by-hop or recomputed by fetch; forwarding them corrupts the relayed body.
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'content-length', 'transfer-encoding', 'content-encoding']);

function jsonRpcMethod(body) {
  try { return JSON.parse(body).method; } catch { return undefined; }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export function createMcpProxy() {
  const routes = new Map(), byUpstream = new Map(), listWaiters = new Map();
  let listening = null;

  async function relay(req, res) {
    const token = req.url.slice('/mcp/'.length), upstream = routes.get(token);
    if (!req.url.startsWith('/mcp/') || !upstream) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !DROP_REQUEST.has(name)));
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    if (body && listWaiters.has(token) && jsonRpcMethod(body) === 'tools/list') {
      res.on('close', () => { for (const resolve of listWaiters.get(token) ?? []) resolve(); listWaiters.delete(token); });
    }
    const send = h => fetch(upstream, { method: req.method, headers: h, body, signal: controller.signal });
    let reply = await send(headers);
    if (headers['mcp-protocol-version'] && reply.status === 400) {
      const text = await reply.text();
      if (/Unsupported protocol version/i.test(text)) {
        const { 'mcp-protocol-version': _, ...fallback } = headers;
        reply = await send(fallback);
      } else {
        reply = new Response(text, { status: reply.status, headers: reply.headers });
      }
    }
    const out = {};
    reply.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name)) out[name] = value; });
    res.writeHead(reply.status, out);
    if (!reply.body) { res.end(); return; }
    Readable.fromWeb(reply.body).on('error', () => res.destroy()).pipe(res);
  }

  const server = createServer((req, res) => {
    relay(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP upstream unavailable' }, id: null }));
      else res.destroy();
    });
  });

  return {
    async route(upstream) {
      listening ??= (server.listen(0, '127.0.0.1'), once(server, 'listening'));
      await listening;
      if (!byUpstream.has(upstream)) {
        const token = randomUUID();
        routes.set(token, upstream); byUpstream.set(upstream, token);
      }
      return `http://127.0.0.1:${server.address().port}/mcp/${byUpstream.get(upstream)}`;
    },
    /** Resolves after the next tools/list exchange through this route finishes. */
    toolsListed(upstream) {
      const token = byUpstream.get(upstream);
      if (!token) return Promise.reject(new Error('Unknown MCP route'));
      return new Promise(resolve => {
        if (!listWaiters.has(token)) listWaiters.set(token, new Set());
        listWaiters.get(token).add(resolve);
      });
    },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); if (!server.listening) resolve(); }),
  };
}
