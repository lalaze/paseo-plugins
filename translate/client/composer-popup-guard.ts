const STYLE_ID = 'paseo-translate-composer-popup-guard';

/**
 * Install separately from the shared overlay registry: another host may own an
 * older controller for this page. Paseo mounts context-window-details only while
 * its hover card is open, so CSS can hide even that controller's body-level
 * buttons before painting, regardless of its inline styles or layout timing.
 */
export function installComposerPopupGuard(): () => void {
  let sheet = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = STYLE_ID;
    document.head.append(sheet);
  }
  sheet.dataset.users = String(Number(sheet.dataset.users ?? 0) + 1);
  sheet.textContent = `
    body:has([data-testid="context-window-details"]:not([hidden], [aria-hidden="true"], [data-state="closed"], [hidden] *, [aria-hidden="true"] *, [data-state="closed"] *))
    :is([data-paseo-translate="launcher"], [data-paseo-translate="english-guard"], [data-paseo-translate="word-toggle"]) {
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  const installed = sheet;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const users = Math.max(0, Number(installed.dataset.users) - 1);
    if (users === 0) installed.remove();
    else installed.dataset.users = String(users);
  };
}
