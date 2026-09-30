export type UiLocale = 'en' | 'zh-CN';

type Runtime = {
  __PASEO_LOCALE__?: unknown;
  document?: { documentElement?: { lang?: string } };
  localStorage?: { getItem(key: string): string | null };
  navigator?: { language?: string; languages?: readonly string[] };
};

const APP_SETTINGS_KEY = '@paseo:app-settings';

function paseoLanguage(runtime: Runtime): string | null {
  if (typeof runtime.__PASEO_LOCALE__ === 'string') return runtime.__PASEO_LOCALE__;
  try {
    const raw = runtime.localStorage?.getItem(APP_SETTINGS_KEY);
    if (!raw) return null;
    const settings = JSON.parse(raw) as { language?: unknown; state?: { language?: unknown } };
    const language = settings.language ?? settings.state?.language;
    return typeof language === 'string' && language !== 'system' ? language : null;
  } catch {
    return null;
  }
}

function supported(locale: string | null | undefined): UiLocale | null {
  if (!locale) return null;
  const normalized = locale.replaceAll('_', '-').toLowerCase();
  return normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh-hans') ? 'zh-CN' : normalized.startsWith('en') ? 'en' : null;
}

export function resolveUiLocale(runtime = globalThis as unknown as Runtime): UiLocale {
  const selected = paseoLanguage(runtime);
  if (selected) return supported(selected) ?? 'en';
  const candidates = [...(runtime.navigator?.languages ?? []), runtime.navigator?.language, runtime.document?.documentElement?.lang];
  for (const candidate of candidates) {
    const locale = supported(candidate);
    if (locale) return locale;
  }
  try { return supported(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'; }
  catch { return 'en'; }
}

export function ui<T>(en: T, zhCN: T, runtime?: Runtime): T {
  return resolveUiLocale(runtime) === 'zh-CN' ? zhCN : en;
}
