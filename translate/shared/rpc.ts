import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { translationSettings } from './settings';

export const MAX_SOURCE_LENGTH = 5000;

export const targetLanguageSchema = z.enum(['auto', 'zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']);
export type TargetLanguage = z.infer<typeof targetLanguageSchema>;

export const runtimeInfoRpc = defineRpc({
  name: 'translate.runtime.info',
  input: z.object({}),
  output: z.object({ serverId: z.string().min(1).max(200).nullable() }),
});

export const translateSelectionRpc = defineRpc({
  name: 'translate.selection',
  input: z.object({
    text: z.string().trim().min(1).max(MAX_SOURCE_LENGTH),
    target: targetLanguageSchema.default('auto'),
    settings: translationSettings.schema,
  }),
  output: z.object({
    translation: z.string().min(1).max(20000),
    detectedLanguage: z.string().max(100).nullable(),
    target: targetLanguageSchema.exclude(['auto']),
    note: z.string().max(1000).nullable(),
    model: z.string().min(1).max(300),
  }),
});

export type TranslationResult = z.infer<typeof translateSelectionRpc.output>;
