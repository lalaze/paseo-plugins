import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** Read Paseo's public, stable daemon identity; never read pairing credentials. */
export async function hostIdentity(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const id = env.PASEO_SERVER_ID?.trim() || await readFile(join(env.PASEO_HOME || join(home, '.paseo'), 'server-id'), 'utf8').then(value => value.trim(), () => null);
  return { id: id && id.length <= 200 ? id : null, label: hostname().slice(0, 200) || 'Paseo 主机' };
}
