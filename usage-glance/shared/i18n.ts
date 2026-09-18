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

export function uiNumberLocale(): string {
  return resolveUiLocale() === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function localizeHostLabel(label: string): string {
  return label === 'Paseo host' ? ui('Paseo host', 'Paseo 主机') : label;
}

export function localizeModelLabel(label: string): string {
  return label === 'Unrecorded model' ? ui('Unrecorded model', '未记录模型') : label;
}

const englishUsageMessages: Record<string, string> = {
  '部分用量尚未完成 Workspace 归属，已保留每日总量，请查看分类说明或稍后刷新。': 'Some usage could not yet be assigned to a workspace. Daily totals were preserved; inspect the category details or refresh later.',
  '部分记录可能未被采集，请检查本机 CLI 记录是否完整': 'Some records may not have been collected. Check whether the local CLI records are complete.',
  '用量记录格式不兼容': 'The usage record format is incompatible.',
  '用量记录缺少有效 token 数': 'The usage record is missing a valid token count.',
  '用量记录的 token 合计不一致': 'The usage record token totals do not match.',
  '用量记录缺少有效日期': 'The usage record is missing a valid date.',
  '模型名称过长': 'The model name is too long.',
  '模型名称缺失': 'The model name is missing.',
  '模型明细与每日合计不一致': 'Model details do not match the daily total.',
  '采集器未返回每日用量': 'The collector did not return daily usage.',
  '采集器文件缺失，请重新安装插件': 'The collector file is missing. Reinstall the plugin.',
  '采集器未返回有效用量数据': 'The collector did not return valid usage data.',
  '读取超时，请稍后重试': 'The read timed out. Try again later.',
  '本机用量读取失败，请检查数据目录和读取权限': 'Local usage could not be read. Check the data directory and permissions.',
  '本机记录暂时无法读取，请稍后重试': 'Local records are temporarily unavailable. Try again later.',
  '本机 Pi 用量记录无法读取，请检查格式和读取权限': 'Local Pi usage records could not be read. Check their format and permissions.',
  '数据库缺少生成用量': 'The database does not contain generation usage.',
  'Antigravity 数据库无法读取，请检查读取权限或稍后重试': 'The Antigravity database could not be read. Check permissions or try again later.',
  'Antigravity 元数据格式不兼容': 'The Antigravity metadata format is incompatible.',
  'Antigravity 元数据不完整': 'The Antigravity metadata is incomplete.',
  'Antigravity 数值溢出': 'An Antigravity value is out of range.',
  'Antigravity token 数超出范围': 'The Antigravity token count is out of range.',
  'Antigravity 标识格式不兼容': 'The Antigravity identifier format is incompatible.',
  'Antigravity 生成记录格式不兼容': 'The Antigravity generation record format is incompatible.',
};

function englishUsagePart(part: string): string {
  const trimmed = part.trim();
  if (englishUsageMessages[trimmed]) return englishUsageMessages[trimmed];
  let match = /^(\d+) 个 Pi 文件或记录未能读取，统计可能不完整$/.exec(trimmed);
  if (match) return `${match[1]} Pi files or records could not be read; totals may be incomplete.`;
  match = /^(\d+) 个文件或记录未能读取$/.exec(trimmed);
  if (match) return `${match[1]} files or records could not be read.`;
  match = /^(\d+) 条记录缺少日期，未计入$/.exec(trimmed);
  if (match) return `${match[1]} records had no date and were excluded.`;
  match = /^(\d+) 条记录按会话日期归类$/.exec(trimmed);
  if (match) return `${match[1]} records were assigned using the session date.`;
  match = /^会话明细 ([^；]+)；每日合计 ([^。]+)。差异项（明细 \/ 每日）：(.+)。$/.exec(trimmed);
  if (match) {
    const differences = match[3].replaceAll('输入', 'input').replaceAll('输出', 'output').replaceAll('缓存读取', 'cache read').replaceAll('缓存写入', 'cache write').replaceAll('推理', 'reasoning').replaceAll('未提供', 'not provided');
    return `Session details: ${match[1]}; daily total: ${match[2]}. Differences (details / daily): ${differences}.`;
  }
  return trimmed;
}

export function localizeUsageMessage(message: string): string {
  if (resolveUiLocale() === 'zh-CN') return message;
  const whole = englishUsagePart(message);
  if (whole !== message.trim()) return whole;
  return message.split('；').map(englishUsagePart).join(' ');
}
