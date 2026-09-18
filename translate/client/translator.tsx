import { ScrollView, Text, TextInput, View } from 'react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ActionButton, TargetPicker } from './controls';
import { localizeTranslationError, ui } from './i18n';
import { MAX_SOURCE_LENGTH, targetLabel, useTranslation } from './use-translation';

type Props = PluginSurfaceProps & { openSettings(): void };

export function TranslationSurface({ theme, layout, openSettings }: Props) {
  const { settings, configured, source, setSource, target, setTarget, result, error, busy, copied, run, copy, canTranslate } = useTranslation();
  const colors = theme.colors;

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
      {layout.platform !== 'web' ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
        {ui('Inside a conversation, tap the "Translate" pill next to the composer to translate a draft or the latest AI reply.', '在对话中点击输入框旁的「译」，可以翻译草稿或最新的 AI 回复。')}
      </Text> : null}
    </View>

    {settings.status === 'loading' ? <Text style={{ color: colors.foregroundMuted }}>{ui('Loading Translation API settings…', '正在读取翻译 API 设置…')}</Text> : null}
    {settings.status === 'error' || settings.status === 'invalid' ? <View style={{ gap: 10, padding: 14, borderRadius: 10, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.statusDanger }}>{localizeTranslationError(settings.error)}</Text>
      <ActionButton theme={theme} label={ui('Open API Settings', '打开 API 设置')} onPress={openSettings} style={{ alignSelf: 'flex-start' }} />
    </View> : null}

    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Source text', '原文')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{source.length}/{MAX_SOURCE_LENGTH}</Text>
      </View>
      <TextInput
        accessibilityLabel={ui('Text to translate', '需要翻译的文字')}
        editable={!busy}
        value={source}
        onChangeText={setSource}
        multiline
        maxLength={MAX_SOURCE_LENGTH}
        autoCapitalize="sentences"
        autoCorrect
        placeholder={ui('Enter or paste text…', '输入或粘贴文字…')}
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        style={{ minHeight: layout.compact ? 150 : 190, padding: 13, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, fontSize: 16, lineHeight: 23, opacity: busy ? 0.7 : 1 }}
      />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton theme={theme} primary disabled={!canTranslate} label={busy ? ui('Translating…', '翻译中…') : ui('Translate', '翻译')} onPress={() => { void run(); }} style={{ minWidth: 112 }} />
        <ActionButton theme={theme} disabled={busy || !source} label={ui('Clear', '清空')} onPress={() => setSource('')} />
        {configured ? <ActionButton theme={theme} label={ui('API Settings', 'API 设置')} onPress={openSettings} /> : null}
      </View>
    </View>

    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Target language', '目标语言')}</Text>
      <TargetPicker theme={theme} value={target} onChange={setTarget} disabled={busy} />
    </View>

    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 20 }}>{error}</Text> : null}

    {result ? <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontWeight: '700' }}>{ui('Translation', '译文')}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(`Target: ${targetLabel(result.target)}`, `目标：${targetLabel(result.target)}`)}</Text>
        </View>
        <ActionButton theme={theme} label={copied ? ui('Copied', '已复制') : ui('Copy', '复制')} color={copied ? colors.statusSuccess : undefined} onPress={() => { void copy(); }} />
      </View>
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>{result.translation}</Text>
    </View> : null}
  </ScrollView>;
}
