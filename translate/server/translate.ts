import type { RpcInput } from '@getpaseo/plugin';
import { translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { validateTranslationSettings } from '../shared/settings';
import { createUsageLedger, parseUsage, type TranslationUsageRecord, type UsageLedger } from './usage';

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
  if (!trimmed) throw new Error('The Translation API returned no translation');
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
  if (!plain) throw new Error('The Translation API returned no translation');
  return { translation: plain.slice(0, 20000), detectedLanguage: null, note: null };
}

function responseContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('The Translation API returned an invalid response');
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
  throw new Error('The Translation API response is missing choices[0].message.content');
}

function apiError(body: string, status: number): Error {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const error = value.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === 'string' ? error.message : typeof value.message === 'string' ? value.message : '';
    if (message) return new Error(`Translation API request failed (${status}): ${message.slice(0, 500)}`);
  } catch {
    // Fall through to the bounded plain-text response.
  }
  const detail = body.trim().replace(/\s+/g, ' ').slice(0, 500);
  return new Error(`Translation API request failed (${status})${detail ? `: ${detail}` : ''}`);
}

type TranslationEndpoint = { apiUrl: string; apiKey: string; model: string; kind: TranslationUsageRecord['endpoint'] };
type RecordUsage = (entry: Omit<TranslationUsageRecord, 'v'>) => void;

async function requestTranslation(endpoint: TranslationEndpoint, prompt: string, fetchImpl: Fetch, recordUsage: RecordUsage): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (endpoint.apiKey.trim()) headers.authorization = `Bearer ${endpoint.apiKey.trim()}`;
    const response = await fetchImpl(endpoint.apiUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        stream: false,
        messages: [
          { role: 'user', content: prompt },
        ],
      }),
    });
    const body = await response.text();
    if (!response.ok) throw apiError(body, response.status);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new Error('The Translation API returned invalid JSON'); }
    // Tokens are billed once the API answered, even if the content turns out unusable.
    recordUsage({ at: new Date().toISOString(), model: endpoint.model, endpoint: endpoint.kind, usage: parseUsage(payload) });
    return responseContent(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('The Translation API timed out. Try again later');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}

export async function translateSelection(input: TranslationInput, fetchImpl: Fetch = globalThis.fetch, recordUsage: RecordUsage = () => {}): Promise<TranslationResult> {
  const settings = validateTranslationSettings(input.settings);
  const target = resolveTarget(input.text, input.target);
  const prompt = buildTranslationPrompt(input.text, target);
  const primary: TranslationEndpoint = { apiUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model, kind: 'primary' };
  try {
    const content = await requestTranslation(primary, prompt, fetchImpl, recordUsage);
    return { ...parseTranslationOutput(content), target, model: primary.model };
  } catch (primaryError) {
    if (!settings.fallbackApiUrl || !settings.fallbackModel) throw primaryError;
    const fallback: TranslationEndpoint = { apiUrl: settings.fallbackApiUrl, apiKey: settings.fallbackApiKey, model: settings.fallbackModel, kind: 'fallback' };
    try {
      const content = await requestTranslation(fallback, prompt, fetchImpl, recordUsage);
      return { ...parseTranslationOutput(content), target, model: fallback.model };
    } catch (fallbackError) {
      throw new Error(`The Translation API failed on both primary and fallback endpoints (${describeError(primaryError)}; ${describeError(fallbackError)})`);
    }
  }
}

export function createTranslationHandler(ledger: UsageLedger = createUsageLedger()) {
  let active = 0;
  // Ledger writes are fire-and-forget: usage statistics must never delay or fail a translation.
  const recordUsage: RecordUsage = entry => { void ledger.record(entry); };
  return async (input: TranslationInput) => {
    if (active >= 3) throw new Error('Too many translations are running. Try again later');
    active++;
    try { return await translateSelection(input, globalThis.fetch, recordUsage); }
    finally { active--; }
  };
}
