const STORAGE_KEY = 'lalaze.paseo-translate.click-words.v1';
const CHANGE_EVENT = 'paseo-translate:click-words-changed';
let sessionEnabled = true;

/** A reading preference for this client, independent of a host's API configuration. */
export function wordTranslationEnabled(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) !== 'false'; }
  catch { return sessionEnabled; }
}

export function setWordTranslationEnabled(enabled: boolean) {
  sessionEnabled = enabled;
  try { window.localStorage.setItem(STORAGE_KEY, String(enabled)); }
  catch { /* The switch still works for this session when storage is unavailable. */ }
  window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT, { detail: enabled }));
}

export function subscribeWordTranslation(listener: (enabled: boolean) => void): () => void {
  const changed = (event: Event) => listener((event as CustomEvent<boolean>).detail);
  const stored = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener(wordTranslationEnabled());
  };
  window.addEventListener(CHANGE_EVENT, changed);
  window.addEventListener('storage', stored);
  return () => {
    window.removeEventListener(CHANGE_EVENT, changed);
    window.removeEventListener('storage', stored);
  };
}
