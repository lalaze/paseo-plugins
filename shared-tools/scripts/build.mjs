import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
let compiler = process.env.PASEO_COMPILER;
if (!compiler) {
  for (const base of [join(root, 'package.json'), resolve(dirname(process.execPath), '../lib/node_modules/@getpaseo/cli/package.json')]) {
    try {
      compiler = join(dirname(createRequire(base).resolve('@getpaseo/server')), 'plugins/compiler.js');
      break;
    } catch { /* Try the next installed CLI. */ }
  }
}
await mkdir(join(root, 'dist'), { recursive: true });
if (compiler) {
  const { compilePlugin } = await import(pathToFileURL(compiler).href);
  const result = await compilePlugin({ client: join(root, 'index.client.tsx'), server: join(root, 'index.server.ts') });
  await writeFile(join(root, 'dist/client.js'), result.clientBundle);
  await writeFile(join(root, 'dist/server.js'), result.serverBundle);
  console.log('Paseo compiler: client, server, and import boundaries verified.');
} else {
  for (const target of ['client', 'server']) {
    await build({
      entryPoints: [join(root, `index.${target}.${target === 'client' ? 'tsx' : 'ts'}`)],
      outfile: join(root, `dist/${target}.js`),
      bundle: true,
      platform: target === 'client' ? 'neutral' : 'node',
      format: 'cjs',
      target: 'es2022',
      external: ['@getpaseo/plugin', '@getpaseo/plugin/*', '@getpaseo/client', '@getpaseo/client/*', ...(target === 'client' ? ['react', 'react/*', 'react-native', 'zod'] : [])],
    });
  }
  console.log('esbuild bundles written. Installing into Paseo also runs the host boundary check.');
}
