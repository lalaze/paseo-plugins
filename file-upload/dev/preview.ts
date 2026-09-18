// Isolated preview harness: host hooks are mocked; all file operations use the real backend.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileService } from '../server/files.server';
import * as contracts from '../shared/files.shared';
const root = await mkdtemp(path.join(tmpdir(), 'paseo-transfer-preview-'));
await mkdir(path.join(root, 'uploads/assets/imgs'), { recursive: true });
await writeFile(path.join(root, 'uploads/assets/imgs/example.txt'), 'Tree preview\n');
await writeFile(path.join(root, 'README.txt'), 'Paseo file-transfer preview\n');
const service = new FileService(), token = randomUUID();
const result = await build({ entryPoints: ['dev/main.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [{ name: 'preview-host', setup(builder) {
  builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: path.resolve('dev/sdk.ts') }));
  builder.onResolve({ filter: /^react-native$/ }, () => ({ path: path.resolve('dev/native.tsx') }));
} }] });
const js = result.outputFiles[0].text;
const contractList = [contracts.listFiles, contracts.startUpload, contracts.uploadChunk, contracts.finishUpload, contracts.cancelUpload, contracts.downloadChunk];
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/' && request.method === 'GET') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="preview-token" content="${token}"><title>Paseo File Transfer Preview</title></head><body style="margin:0;background:#171b22"><div id="root" style="max-width:820px;height:100dvh;margin:auto"></div><script src="/app.js"></script></body></html>`); return;
  }
  if (request.url === '/app.js' && request.method === 'GET') { response.setHeader('Content-Type', 'application/javascript'); response.end(js); return; }
  if (request.url !== '/rpc' || request.method !== 'POST' || request.headers['x-preview-token'] !== token) { response.writeHead(403).end(); return; }
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 300_000) throw new Error('Request too large'); }
    const requestData = JSON.parse(body);
    const contract = contractList.find(item => item.name === requestData.method);
    if (!contract) throw new Error('Unknown method');
    const input = contract.input.parse(requestData.input);
    // Each branch parses its specific contract again to retain exact types.
    let output: unknown;
    switch (contract.name) {
      case 'list-files': { const i = contracts.listFiles.input.parse(input); output = await service.list(root, i.path); break; }
      case 'start-upload': { const i = contracts.startUpload.input.parse(input); output = await service.start(root, i.path, i.size); break; }
      case 'upload-chunk': { const i = contracts.uploadChunk.input.parse(input); output = await service.chunk(i.id, i.offset, i.data); break; }
      case 'finish-upload': { const i = contracts.finishUpload.input.parse(input); output = await service.finish(i.id); break; }
      case 'cancel-upload': { const i = contracts.cancelUpload.input.parse(input); output = await service.cancel(i.id); break; }
      case 'download-chunk': { const i = contracts.downloadChunk.input.parse(input); output = await service.download(root, i.path, i.offset, i.version); break; }
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(contract.output.parse(output)));
  } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(Number(process.env.PORT ?? 4173), '0.0.0.0', () => console.log(`Preview: http://100.96.195.115:${process.env.PORT ?? 4173}\nTemporary workspace: ${root}`));
async function shutdown() { server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
