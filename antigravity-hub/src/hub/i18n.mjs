export function resolveUiLocale(value, env = process.env) {
  const candidates = [value, env.LC_ALL, env.LC_MESSAGES, env.LANG];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const normalized = candidate.replaceAll('_', '-').toLowerCase();
    if (normalized === 'system') continue;
    return normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh-hans') ? 'zh-CN' : 'en';
  }
  return 'en';
}

export function ui(locale, en, zhCN) {
  return locale === 'zh-CN' ? zhCN : en;
}
