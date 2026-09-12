import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const requireCli = createRequire(resolve(dirname(process.execPath), '../lib/node_modules/@getpaseo/cli/package.json'));
const compiler = process.env.PASEO_COMPILER ?? join(dirname(requireCli.resolve('@getpaseo/server')), 'plugins/compiler.js');
const { compilePlugin } = await import(pathToFileURL(compiler).href);
const result = await compilePlugin({ client: join(root, 'index.client.tsx'), server: join(root, 'index.server.ts') });
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/client.js'), result.clientBundle);
if (result.serverBundle) await writeFile(join(root, 'dist/server.js'), result.serverBundle);
console.log('Paseo client and server bundles and import boundaries verified.');
