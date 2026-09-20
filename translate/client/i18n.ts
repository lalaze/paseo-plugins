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
  return normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh-hans') ? 'zh-CN' : 'en';
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

export function ui<T>(en: T, zhCN: T): T {
  return resolveUiLocale() === 'zh-CN' ? zhCN : en;
}

const chineseErrors: Record<string, string> = {
  'Enter the Translation API URL first': '请先填写翻译 API 地址',
  'The Translation API URL is invalid': '翻译 API 地址格式不正确',
  'The Translation API URL must use HTTP or HTTPS': '翻译 API 地址只支持 HTTP 或 HTTPS',
  'Enter a translation model first': '请先填写翻译模型名',
  'Enter the fallback API URL first': '请先填写备用 API 地址',
  'Enter the fallback model first': '请先填写备用模型名',
  'The fallback API URL is invalid': '备用 API 地址格式不正确',
  'The fallback API URL must use HTTP or HTTPS': '备用 API 地址只支持 HTTP 或 HTTPS',
  'The Translation API returned no translation': '翻译 API 没有返回翻译结果',
  'The Translation API returned an invalid response': '翻译 API 返回格式不正确',
  'The Translation API response is missing choices[0].message.content': '翻译 API 响应中没有 choices[0].message.content',
  'The Translation API returned invalid JSON': '翻译 API 返回的不是有效 JSON',
  'The Translation API timed out. Try again later': '翻译 API 响应超时，请稍后重试',
  'Too many translations are running. Try again later': '同时进行的翻译过多，请稍后重试',
};

export function localizeTranslationError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (resolveUiLocale() !== 'zh-CN') return message;
  if (chineseErrors[message]) return chineseErrors[message];
  const both = /^The Translation API failed on both primary and fallback endpoints \((.*)\)$/.exec(message);
  if (both) return `主接口和备用接口都请求失败（${both[1]}）`;
  const failed = /^Translation API request failed \((\d+)\)(?:: (.*))?$/.exec(message);
  return failed ? `翻译 API 请求失败（${failed[1]}）${failed[2] ? `：${failed[2]}` : ''}` : message;
}
