import type { RpcInput } from '@getpaseo/plugin';
import { translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { validateTranslationSettings } from '../shared/settings';

type TranslationInput = RpcInput<typeof translateSelectionRpc>;
type Fetch = typeof globalThis.fetch;

const targetLabels: Record<Exclude<TargetLanguage, 'auto'>, string> = {
  'zh-CN': 'Simplified Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian',
};

const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function resolveTarget(text: string, requested: TargetLanguage): Exclude<TargetLanguage, 'auto'> {
  if (requested !== 'auto') return requested;
  // A CJK character carries about a word of meaning, so weigh characters against words of other scripts
  // and let mixed drafts follow the dominant script instead of flipping to English on a few Chinese words.
  const cjk = [...text].filter(character => cjkCharacter.test(character)).length;
  const otherWords = text.match(/[\p{L}\p{N}]+/gu)?.map(word => [...word].filter(character => !cjkCharacter.test(character)).length).filter(Boolean).length ?? 0;
  return cjk > 0 && cjk >= otherWords ? 'en' : 'zh-CN';
}

export function buildTranslationPrompt(text: string, target: Exclude<TargetLanguage, 'auto'>): string {
  return `Translate the following segment into ${targetLabels[target]}, without additional explanation.\n\n${text}`;
}

export function parseTranslationOutput(raw: string): Pick<TranslationResult, 'translation' | 'detectedLanguage' | 'note'> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('翻译 API 没有返回翻译结果');
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)) candidates.unshift(match[1].trim());
  const firstBrace = trimmed.indexOf('{'), lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.unshift(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof value.translation !== 'string' || !value.translation.trim()) continue;
      return {
        translation: value.translation.trim().slice(0, 20000),
        detectedLanguage: typeof value.detectedLanguage === 'string' ? value.detectedLanguage.trim().slice(0, 100) || null : null,
        note: typeof value.note === 'string' ? value.note.trim().slice(0, 1000) || null : null,
      };
    } catch {
      // OpenAI-compatible providers occasionally ignore the requested JSON wrapper.
    }
  }
  const plain = trimmed.replace(/^```(?:\w+)?\s*/i, '').replace(/```$/i, '').trim();
  if (!plain) throw new Error('翻译 API 没有返回翻译结果');
  return { translation: plain.slice(0, 20000), detectedLanguage: null, note: null };
}

function responseContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('翻译 API 返回格式不正确');
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content ?? first?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.map(part => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '').join('');
    if (text) return text;
  }
  throw new Error('翻译 API 响应中没有 choices[0].message.content');
}

function apiError(body: string, status: number): Error {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const error = value.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === 'string' ? error.message : typeof value.message === 'string' ? value.message : '';
    if (message) return new Error(`翻译 API 请求失败（${status}）：${message.slice(0, 500)}`);
  } catch {
    // Fall through to the bounded plain-text response.
  }
  const detail = body.trim().replace(/\s+/g, ' ').slice(0, 500);
  return new Error(`翻译 API 请求失败（${status}）${detail ? `：${detail}` : ''}`);
}

export async function translateSelection(input: TranslationInput, fetchImpl: Fetch = globalThis.fetch): Promise<TranslationResult> {
  const settings = validateTranslationSettings(input.settings);
  const target = resolveTarget(input.text, input.target);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
    const response = await fetchImpl(settings.apiUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        messages: [
          { role: 'user', content: buildTranslationPrompt(input.text, target) },
        ],
      }),
    });
    const body = await response.text();
    if (!response.ok) throw apiError(body, response.status);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new Error('翻译 API 返回的不是有效 JSON'); }
    return { ...parseTranslationOutput(responseContent(payload)), target, model: settings.model };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('翻译 API 响应超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createTranslationHandler() {
  let active = 0;
  return async (input: TranslationInput) => {
    if (active >= 3) throw new Error('同时进行的翻译过多，请稍后重试');
    active++;
    try { return await translateSelection(input); }
    finally { active--; }
  };
}
