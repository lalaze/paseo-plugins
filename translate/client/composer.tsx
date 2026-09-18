import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAgent, type PluginButtonContentProps, type PluginClientContext } from '@getpaseo/plugin/client';
import { ScrollView, TextInput, useToast } from '@getpaseo/plugin/client/react-native';
import { ActionButton, TargetPicker } from './controls';
import { localizeTranslationError, ui } from './i18n';
import { latestAssistantText } from './reply';
import { MAX_SOURCE_LENGTH, targetLabel, useTranslation } from './use-translation';

type Props = PluginButtonContentProps & { paseo: Pick<PluginClientContext['paseo'], 'agents'>; openSettings(): void };

/** Popover behind the composer pill: translate a draft and send it, or translate the latest AI reply. */
export function ComposerTranslator(props: Props) {
  const { theme, close, paseo, openSettings } = props;
  const agentId = props.context === 'agent' ? props.agentId : '';
  const { settings, configured, source, setSource, target, setTarget, result, error, setError, busy: translating, copied, run, copy, canTranslate } = useTranslation();
  const toast = useToast();
  const [fetching, setFetching] = useState(false);
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<{ truncated: boolean } | null>(null);
  const running = useAgent(agentId, agent => agent.status === 'running' || agent.status === 'initializing') ?? false;
  const busy = translating || fetching || sending;
  const colors = theme.colors;

  const changeSource = (value: string) => { setSource(value); setReply(null); };

  const loadLatestReply = async () => {
    if (!agentId || busy || !configured) return;
    setFetching(true);
    setError(null);
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 80 });
      const latest = latestAssistantText(page.entries.map(entry => entry.item));
      if (!latest) { setError(ui('This conversation has no AI reply to translate yet', '当前对话还没有可翻译的 AI 回复')); return; }
      setSource(latest.text);
      setReply({ truncated: latest.truncated });
      await run(latest.text);
    } catch (reason) {
      setError(localizeTranslationError(reason));
    } finally {
      setFetching(false);
    }
  };

  const send = async () => {
    if (!result || !agentId || busy) return;
    setSending(true);
    setError(null);
    try {
      await paseo.agents.ref(agentId).send(result.translation);
      toast.show(ui('Translation sent to this conversation', '译文已发送到当前对话'), { variant: 'success' });
      close();
    } catch (reason) {
      setError(localizeTranslationError(reason));
      setSending(false);
    }
  };

  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 17, fontWeight: '700' }}>{ui('Translate', '翻译')}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        {ui('Translate a draft and send it, or translate the latest AI reply. Nothing is sent until you tap Send.', '翻译草稿后发送，或翻译最新的 AI 回复；点击「发送」之前不会发出任何消息。')}
      </Text>
    </View>

    {settings.status === 'loading' ? <Text style={{ color: colors.foregroundMuted }}>{ui('Loading Translation API settings…', '正在读取翻译 API 设置…')}</Text> : null}
    {settings.status === 'error' || settings.status === 'invalid' ? <View style={{ gap: 10, padding: 12, borderRadius: 10, backgroundColor: colors.surface1 }}>
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
        onChangeText={changeSource}
        multiline
        maxLength={MAX_SOURCE_LENGTH}
        autoCapitalize="sentences"
        autoCorrect
        placeholder={ui('Enter or paste text…', '输入或粘贴文字…')}
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        style={{ minHeight: 110, maxHeight: 220, padding: 12, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, fontSize: 16, lineHeight: 23, opacity: busy ? 0.7 : 1 }}
      />
      {reply?.truncated ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{ui(`The reply was longer than ${MAX_SOURCE_LENGTH} characters; only the beginning is translated.`, `回复超过 ${MAX_SOURCE_LENGTH} 个字符，仅翻译开头部分。`)}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton theme={theme} primary disabled={!canTranslate || busy} label={translating && !fetching ? ui('Translating…', '翻译中…') : ui('Translate', '翻译')} onPress={() => { void run(); }} style={{ minWidth: 100 }} />
        <ActionButton theme={theme} disabled={!agentId || !configured || busy} label={fetching ? ui('Loading reply…', '读取回复中…') : ui('Latest reply', '最新回复')} onPress={() => { void loadLatestReply(); }} />
        <ActionButton theme={theme} disabled={busy || !source} label={ui('Clear', '清空')} onPress={() => changeSource('')} />
      </View>
    </View>

    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Target language', '目标语言')}</Text>
      <TargetPicker theme={theme} value={target} onChange={setTarget} disabled={busy} />
    </View>

    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 20 }}>{error}</Text> : null}

    {result ? <View style={{ gap: 12, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface1 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: colors.foreground, fontWeight: '700' }}>{ui('Translation', '译文')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(`Target: ${targetLabel(result.target)}`, `目标：${targetLabel(result.target)}`)}</Text>
        {reply && running ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{ui('The AI is still replying; the translated reply may be incomplete.', 'AI 仍在回复，译文可能不完整。')}</Text> : null}
      </View>
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>{result.translation}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton theme={theme} primary disabled={!agentId || busy} label={sending ? ui('Sending…', '发送中…') : ui('Send', '发送')} onPress={() => { void send(); }} style={{ minWidth: 100 }} />
        <ActionButton theme={theme} label={copied ? ui('Copied', '已复制') : ui('Copy', '复制')} color={copied ? colors.statusSuccess : undefined} onPress={() => { void copy(); }} />
      </View>
    </View> : null}
  </ScrollView>;
}
