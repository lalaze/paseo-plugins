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
  'The current workspace is unavailable': '当前工作区不可用',
  'File paths must stay within the current workspace': '文件路径必须位于当前工作区内',
  'Internal files cannot be accessed': '无法访问内部文件',
  'Symbolic links are not supported': '不支持符号链接',
  'The maximum file size is 100 MiB': '单文件最大 100 MiB',
  'Too many uploads are active; try again later': '同时进行的上传过多，请稍后重试',
  'A file with this name already exists; rename it before uploading': '同名文件已存在，请重命名后再上传',
  'The upload session has expired; start the upload again': '上传会话已过期，请重新开始上传',
  'The upload is being processed': '上传正在处理中',
  'Invalid upload chunk': '上传分片无效',
  'Unable to write the file': '无法写入文件',
  'The file upload is incomplete': '文件上传不完整',
  'The destination directory has changed': '目标目录已发生变化',
  'Only regular files up to 100 MiB can be downloaded': '只能下载不超过 100 MiB 的普通文件',
  'The file changed during download; try again': '下载期间文件发生变化，请重试',
  'Invalid download offset': '下载位置无效',
};

export function localizeFileError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return resolveUiLocale() === 'zh-CN' ? chineseErrors[message] ?? message : message;
}
