import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRpc, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { copyText } from '@getpaseo/plugin/client/react-native';
import { translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { translationSettings, validateTranslationSettings } from '../shared/settings';
import { localizeTranslationError, ui } from './i18n';

const targets: readonly { value: TargetLanguage; en: string; zh: string }[] = [
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

function targetLabel(target: Exclude<TargetLanguage, 'auto'>) {
  const option = targets.find(item => item.value === target);
  return option ? ui(option.en, option.zh) : target;
}

type Props = PluginSurfaceProps & { openSettings(): void };

export function TranslationSurface({ theme, layout, openSettings }: Props) {
  const settings = useSettings(translationSettings);
  const translate = useRpc(translateSelectionRpc);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState<TargetLanguage>('auto');
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);

  useEffect(() => () => { request.current++; }, []);

  const changeSource = (value: string) => {
    setSource(value);
    setResult(null);
    setError(null);
    setCopied(false);
  };

  const changeTarget = (value: TargetLanguage) => {
    setTarget(value);
    setResult(null);
    setError(null);
    setCopied(false);
  };

  const run = async () => {
    const text = source.trim();
    if (!text || settings.status !== 'ready' || busy) return;
    const sequence = ++request.current;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const configured = validateTranslationSettings(settings.values);
      const translated = await translate({ text, target, settings: configured });
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

  const colors = theme.colors;
  const configured = settings.status === 'ready';
  const canTranslate = configured && source.trim().length > 0 && !busy;
  const actionStyle = (primary: boolean, disabled = false) => ({
    minHeight: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: primary ? 0 : 1,
    borderColor: colors.border,
    backgroundColor: primary ? colors.accent : colors.surface2,
    opacity: disabled ? 0.5 : 1,
  });

  return <ScrollView
    keyboardShouldPersistTaps="handled"
    style={{ flex: 1, backgroundColor: colors.surface0 }}
    contentContainerStyle={{ width: '100%', maxWidth: 820, alignSelf: 'center', padding: layout.compact ? 16 : 28, gap: 18 }}
  >
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, fontWeight: '700' }}>{ui('Translate', '翻译')}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
        {ui('Paste or enter text here. Translation runs on the current Paseo host using your configured API.', '在这里粘贴或输入文字，当前 Paseo 主机会使用已配置的 API 完成翻译。')}
      </Text>
    </View>

    {settings.status === 'loading' ? <Text style={{ color: colors.foregroundMuted }}>{ui('Loading Translation API settings…', '正在读取翻译 API 设置…')}</Text> : null}
    {settings.status === 'error' || settings.status === 'invalid' ? <View style={{ gap: 10, padding: 14, borderRadius: 10, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.statusDanger }}>{localizeTranslationError(settings.error)}</Text>
      <Pressable accessibilityRole="button" onPress={openSettings} style={({ pressed }) => ({ ...actionStyle(false), alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 })}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Open API Settings', '打开 API 设置')}</Text>
      </Pressable>
    </View> : null}

    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Source text', '原文')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{source.length}/5000</Text>
      </View>
      <TextInput
        accessibilityLabel={ui('Text to translate', '需要翻译的文字')}
        editable={!busy}
        value={source}
        onChangeText={changeSource}
        multiline
        maxLength={5000}
        autoCapitalize="sentences"
        autoCorrect
        placeholder={ui('Enter or paste text…', '输入或粘贴文字…')}
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        style={{ minHeight: layout.compact ? 150 : 190, padding: 13, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, fontSize: 16, lineHeight: 23, opacity: busy ? 0.7 : 1 }}
      />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canTranslate }} disabled={!canTranslate} onPress={() => { void run(); }} style={({ pressed }) => ({ ...actionStyle(true, !canTranslate), minWidth: 112, opacity: !canTranslate ? 0.5 : pressed ? 0.75 : 1 })}>
          <Text style={{ color: colors.accentForeground, fontWeight: '700' }}>{busy ? ui('Translating…', '翻译中…') : ui('Translate', '翻译')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !source }} disabled={busy || !source} onPress={() => changeSource('')} style={({ pressed }) => ({ ...actionStyle(false, busy || !source), opacity: busy || !source ? 0.5 : pressed ? 0.7 : 1 })}>
          <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Clear', '清空')}</Text>
        </Pressable>
        {configured ? <Pressable accessibilityRole="button" onPress={openSettings} style={({ pressed }) => ({ ...actionStyle(false), opacity: pressed ? 0.7 : 1 })}>
          <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('API Settings', 'API 设置')}</Text>
        </Pressable> : null}
      </View>
    </View>

    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Target language', '目标语言')}</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {targets.map(option => {
          const selected = target === option.value;
          return <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: busy }}
            disabled={busy}
            onPress={() => changeTarget(option.value)}
            style={({ pressed }) => ({ minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, borderRadius: 20, backgroundColor: selected ? colors.surface2 : colors.surface1, opacity: busy ? 0.6 : pressed ? 0.7 : 1 })}
          >
            <Text style={{ color: selected ? colors.accent : colors.foreground, fontWeight: selected ? '700' : '500' }}>{ui(option.en, option.zh)}</Text>
          </Pressable>;
        })}
      </View>
    </View>

    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 20 }}>{error}</Text> : null}

    {result ? <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontWeight: '700' }}>{ui('Translation', '译文')}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(`Target: ${targetLabel(result.target)}`, `目标：${targetLabel(result.target)}`)}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => { void copy(); }} style={({ pressed }) => ({ ...actionStyle(false), opacity: pressed ? 0.7 : 1 })}>
          <Text style={{ color: copied ? colors.statusSuccess : colors.foreground, fontWeight: '600' }}>{copied ? ui('Copied', '已复制') : ui('Copy', '复制')}</Text>
        </Pressable>
      </View>
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>{result.translation}</Text>
    </View> : null}
  </ScrollView>;
}
