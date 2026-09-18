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
    englishLockModels: z.string().trim().max(2000).default('claude, anthropic'),
  }),
});

export type TranslationSettings = z.infer<typeof translationSettings.schema>;

export function validateTranslationSettings(settings: TranslationSettings): TranslationSettings {
  const parsed = translationSettings.schema.parse(settings);
  if (!parsed.apiUrl) throw new Error('Enter the Translation API URL first');
  let url: URL;
  try { url = new URL(parsed.apiUrl); }
  catch { throw new Error('The Translation API URL is invalid'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The Translation API URL must use HTTP or HTTPS');
  if (!parsed.model) throw new Error('Enter a translation model first');
  return parsed;
}
