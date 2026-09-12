// ACP v1 (including Paseo's untagged stdio form) to Hub protobuf JSON.
import { isAbsolute } from 'node:path';

function pairs(values = [], label) {
  if (!Array.isArray(values)) throw new Error(`Invalid MCP ${label}`);
  const entries = values.map(pair => {
    if (!pair || typeof pair.name !== 'string' || !pair.name || typeof pair.value !== 'string') throw new Error(`Invalid MCP ${label}`);
    return [pair.name, pair.value];
  });
  if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error(`Duplicate MCP ${label}`);
  return Object.fromEntries(entries);
}
export function mcpSpec(servers = [], cwd) {
  if (!isAbsolute(cwd || '')) throw new Error('Session cwd must be absolute');
  if (!Array.isArray(servers)) throw new Error('Invalid MCP servers');
  const names = new Set();
  const specs = servers.map(server => {
    if (!server || typeof server.name !== 'string' || !server.name || names.has(server.name)) throw new Error('Invalid or duplicate MCP server name');
    names.add(server.name);
    const base = { serverName: server.name, forceAllToolsEager: true };
    if (server.type === 'http' || server.type === 'sse') {
      let url; try { url = new URL(server.url); } catch { throw new Error('Invalid MCP URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid MCP URL protocol');
      return { ...base, serverUrl: server.url, headers: pairs(server.headers, 'headers'), disableStandaloneSse: server.type === 'http' };
    }
    if (server.type !== undefined && server.type !== 'stdio') throw new Error('Unsupported MCP transport');
    if (typeof server.command !== 'string' || !server.command || !Array.isArray(server.args ?? []) || (server.args ?? []).some(a => typeof a !== 'string')) throw new Error('Invalid MCP command or args');
    return { ...base, command: server.command, args: server.args ?? [], env: pairs(server.env, 'environment'), cwd };
  });
  // Per-conversation discovery avoids changing the user's global MCP file.
  return { builtinAgent: { defaultAgent: { isInteractive: true }, customizationDiscovery: { mcp: { inheritUser: false, servers: specs } } } };
}

export function promptContent(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('Prompt must contain content');
  const items = [], media = [];
  let bytes = 0;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') { items.push({ text: block.text }); continue; }
    if (block?.type === 'resource_link') {
      const uri = typeof block.uri === 'string' ? block.uri : typeof block.path === 'string' ? block.path : '';
      const label = typeof block.title === 'string' ? block.title : typeof block.name === 'string' ? block.name : '';
      items.push({ text: [label, uri].filter(Boolean).join(' ').trim() || 'resource' });
      continue;
    }
    if (block?.type !== 'image') throw new Error('Unsupported prompt content; expected text or image');
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType)) throw new Error('Unsupported image MIME type');
    if (typeof block.data !== 'string' || !block.data || block.data.length > 28 * 1024 * 1024 || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw new Error('Invalid image base64');
    const buffer = Buffer.from(block.data, 'base64');
    if (buffer.toString('base64') !== block.data) throw new Error('Invalid image base64');
    bytes += buffer.length;
    if (bytes > 20 * 1024 * 1024) throw new Error('Images exceed 20 MiB per prompt');
    media.push({ mimeType: block.mimeType, inlineData: buffer.toString('base64') });
  }
  return { items, ...(media.length ? { media } : {}) };
}
