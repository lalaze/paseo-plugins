import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** The daemon's server id is the id the app knows this host by, so the client can match tasks to its hosts. */
export async function hostIdentity(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<{ id: string | null; label: string }> {
  const fromEnv = env.PASEO_SERVER_ID?.trim();
  const id = fromEnv || await readFile(join(env.PASEO_HOME || join(home, '.paseo'), 'server-id'), 'utf8').then(value => value.trim(), () => null);
  return { id: id && id.length <= 200 ? id : null, label: hostname().slice(0, 200) || 'Paseo host' };
}
