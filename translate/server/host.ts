import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read Paseo's public daemon identity; pairing credentials are never accessed. */
export async function readServerId(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configured = env.PASEO_SERVER_ID?.trim();
  if (configured) return configured.slice(0, 200);
  const value = await readFile(join(env.PASEO_HOME || join(home, '.paseo'), 'server-id'), 'utf8').catch(() => '');
  return value.trim().slice(0, 200) || null;
}
