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
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const request = useRef(0);
  const active = useRef(false);
  const copiedReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef<{
    text: string; target: TargetLanguage; revision: string; chunks: string[]; results: TranslationResult[];
  } | null>(null);
  const clearCopiedReset = () => {
    if (copiedReset.current) clearTimeout(copiedReset.current);
    copiedReset.current = undefined;
  };

  useEffect(() => () => { request.current++; active.current = false; clearCopiedReset(); }, []);

  const clear = () => {
    request.current++;
    active.current = false;
    attempt.current = null;
    clearCopiedReset();
    setBusy(false); setProgress(null); setResult(null); setError(null); setCopied(false);
  };
  const setSource = (value: string) => { setSourceValue(value); clear(); };
  const setTarget = (value: TargetLanguage) => { setTargetValue(value); clear(); };

  /** Translates `text` (the current source by default) into the current target. */
  const run = async (text = source, wholeReply = false) => {
    const trimmed = text.trim();
    if (!trimmed || settings.status !== 'ready' || active.current) return;
    const sequence = ++request.current;
    active.current = true;
    setBusy(true);
    setError(null);
    clearCopiedReset();
    setCopied(false);
    try {
      const configured = validateTranslationSettings(settings.values);
      const requestedTarget = wholeReply ? 'zh-CN' : target;
      const revision = String(settings.revision);
      let pending = attempt.current;
      if (!pending || pending.text !== trimmed || pending.target !== requestedTarget || pending.revision !== revision) {
        pending = { text: trimmed, target: requestedTarget, revision, chunks: wholeReply ? splitReply(trimmed).filter(chunk => chunk.trim()) : [trimmed], results: [] };
        attempt.current = pending;
        setResult(null);
      }
      setProgress({ completed: pending.results.length, total: pending.chunks.length });
      for (let index = pending.results.length; index < pending.chunks.length; index++) {
        if (sequence !== request.current) return;
        const translated = await translate({ text: pending.chunks[index], target: requestedTarget, settings: configured });
        if (sequence !== request.current) return;
        pending.results.push(translated);
        setResult({ ...pending.results[0], translation: pending.results.map(part => part.translation).join('\n\n') });
        setProgress({ completed: pending.results.length, total: pending.chunks.length });
      }
    } catch (reason) {
      if (sequence === request.current) setError(localizeTranslationError(reason));
    } finally {
      if (sequence === request.current) { active.current = false; setBusy(false); }
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await copyText(result.translation);
      clearCopiedReset();
      setCopied(true);
      setError(null);
      copiedReset.current = setTimeout(() => { copiedReset.current = undefined; setCopied(false); }, 1600);
    } catch (reason) {
      clearCopiedReset();
      setCopied(false);
      setError(localizeTranslationError(reason));
    }
  };

  const configured = settings.status === 'ready';
  const complete = !!result && !!progress && progress.completed === progress.total && !busy;
  return { settings, configured, source, setSource, target, setTarget, result, error, setError, busy, copied, progress, complete, run, runReply: (text: string) => run(text, true), copy, canTranslate: configured && source.trim().length > 0 && !busy };
}
