import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const translationSettings = defineSettings({
  id: 'api',
  scope: 'host',
  version: 1,
  schema: z.object({
    apiUrl: z.string().trim().max(2048).default('https://api.openai.com/v1/chat/completions'),
    apiKey: z.string().max(8192).default(''),
    model: z.string().trim().max(300).default(''),
    fallbackApiUrl: z.string().trim().max(2048).default(''),
    fallbackApiKey: z.string().max(8192).default(''),
    fallbackModel: z.string().trim().max(300).default(''),
    englishLockModels: z.string().trim().max(2000).default('claude, anthropic'),
  }),
});

export type TranslationSettings = z.infer<typeof translationSettings.schema>;

function validateApiUrl(value: string, invalidMessage: string, protocolMessage: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(invalidMessage); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(protocolMessage);
}

export function validateTranslationSettings(settings: TranslationSettings): TranslationSettings {
  const parsed = translationSettings.schema.parse(settings);
  if (!parsed.apiUrl) throw new Error('Enter the Translation API URL first');
  validateApiUrl(parsed.apiUrl, 'The Translation API URL is invalid', 'The Translation API URL must use HTTP or HTTPS');
  if (!parsed.model) throw new Error('Enter a translation model first');
  if (parsed.fallbackApiUrl || parsed.fallbackModel) {
    if (!parsed.fallbackApiUrl) throw new Error('Enter the fallback API URL first');
    if (!parsed.fallbackModel) throw new Error('Enter the fallback model first');
    validateApiUrl(parsed.fallbackApiUrl, 'The fallback API URL is invalid', 'The fallback API URL must use HTTP or HTTPS');
  }
  return parsed;
}
