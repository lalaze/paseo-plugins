import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const cliNames = new Set(['@getpaseo/cli', '@lalaze/paseo-cli']);
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function locatePaseoInstallation(cliOverride) {
  let cli = cliOverride && resolve(cliOverride);
  if (!cli) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      try {
        const candidate = dirname(dirname(realpathSync(join(directory, 'paseo'))));
        if (cliNames.has(json(join(candidate, 'package.json')).name)) {
          cli = candidate;
          break;
        }
      } catch {
        // Ignore missing entries and wrappers before the actual npm executable.
      }
    }
    if (!cli) throw new Error('Paseo CLI not found; pass --cli /absolute/path/to/the/cli/package');
  }
  const name = json(join(cli, 'package.json')).name;
  if (!cliNames.has(name)) throw new Error(`Not a Paseo CLI package: ${name}`);
  // Forks retain the canonical import through an npm dependency alias.
  const req = createRequire(join(cli, 'package.json'));
  let server = dirname(req.resolve('@getpaseo/server'));
  while (!existsSync(join(server, 'package.json'))) {
    const parent = dirname(server);
    if (parent === server) throw new Error('Cannot find Paseo server package');
    server = parent;
  }
  return { cli, server, req, version: json(join(server, 'package.json')).version };
}
