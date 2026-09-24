import { useEffect, useRef, useState } from 'react';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { copyText } from '@getpaseo/plugin/client/react-native';
import { MAX_SOURCE_LENGTH, translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { translationSettings, validateTranslationSettings } from '../shared/settings';
import { localizeTranslationError, ui } from './i18n';
import { splitReply } from './reply-translation';

export { MAX_SOURCE_LENGTH };

export const targets: readonly { value: TargetLanguage; en: string; zh: string }[] = [
  { value: 'auto', en: 'Auto', zh: '自动' },
  { value: 'zh-CN', en: 'Chinese', zh: '中文' },
  { value: 'en', en: 'English', zh: '英语' },
  { value: 'ja', en: 'Japanese', zh: '日语' },
  { value: 'ko', en: 'Korean', zh: '韩语' },
  { value: 'fr', en: 'French', zh: '法语' },
  { value: 'de', en: 'German', zh: '德语' },
  { value: 'es', en: 'Spanish', zh: '西班牙语' },
  { value: 'ru', en: 'Russian', zh: '俄语' },
];

export function targetLabel(target: Exclude<TargetLanguage, 'auto'>) {
  const option = targets.find(item => item.value === target);
  return option ? ui(option.en, option.zh) : target;
}

/** Source/target/result state shared by the standalone page and the composer pill. */
export function useTranslation() {
  const settings = useSettings(translationSettings);
  const translate = useRpc(translateSelectionRpc);
  const [source, setSourceValue] = useState('');
  const [target, setTargetValue] = useState<TargetLanguage>('auto');
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);

  useEffect(() => () => { request.current++; }, []);

  const clear = () => { setResult(null); setError(null); setCopied(false); };
  const setSource = (value: string) => { setSourceValue(value); clear(); };
  const setTarget = (value: TargetLanguage) => { setTargetValue(value); clear(); };

  /** Translates `text` (the current source by default) into the current target. */
  const run = async (text = source, wholeReply = false) => {
    const trimmed = text.trim();
    if (!trimmed || settings.status !== 'ready' || busy) return;
    const sequence = ++request.current;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const configured = validateTranslationSettings(settings.values);
      const chunks = wholeReply ? splitReply(trimmed) : [trimmed];
      const translations: TranslationResult[] = [];
      for (const chunk of chunks) {
        if (sequence !== request.current) return;
        if (!chunk.trim()) continue;
        translations.push(await translate({ text: chunk, target: wholeReply ? 'zh-CN' : target, settings: configured }));
      }
      const translated = { ...translations[0], translation: translations.map(part => part.translation).join('\n\n') };
      if (sequence === request.current) setResult(translated);
    } catch (reason) {
      if (sequence === request.current) setError(localizeTranslationError(reason));
    } finally {
      if (sequence === request.current) setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await copyText(result.translation);
      setCopied(true);
      setError(null);
    } catch (reason) {
      setCopied(false);
      setError(localizeTranslationError(reason));
    }
  };

  const configured = settings.status === 'ready';
  return { settings, configured, source, setSource, target, setTarget, result, error, setError, busy, copied, run, runReply: (text: string) => run(text, true), copy, canTranslate: configured && source.trim().length > 0 && !busy };
}
