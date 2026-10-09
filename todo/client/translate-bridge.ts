/** Same symbol paseo-translate publishes on the page. This plugin only reads it. */
const TRANSLATION_BRIDGE_KEY = Symbol.for('lalaze.paseo-translate.registry.v1');

export type TaskTranslation = { translation: string };

/** A connected translation client for one Paseo host. */
export type TranslationBridge = {
  readonly closed?: boolean;
  available(serverId: string): boolean;
  translate(serverId: string, text: string, target?: 'auto'): Promise<TaskTranslation> | null;
  subscribe(listener: () => void): () => void;
};

/** The running paseo-translate client, or null when that plugin is not connected. */
export function translationBridge(): TranslationBridge | null {
  const registry = (globalThis as { [TRANSLATION_BRIDGE_KEY]?: TranslationBridge })[TRANSLATION_BRIDGE_KEY];
  if (!registry || registry.closed) return null;
  if (typeof registry.available !== 'function' || typeof registry.translate !== 'function' || typeof registry.subscribe !== 'function') return null;
  return registry;
}
