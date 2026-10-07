import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAgent, type PluginButtonContentProps, type PluginClientContext } from '@getpaseo/plugin/client';
import { ScrollView, TextInput, useToast } from '@getpaseo/plugin/client/react-native';
import { ActionButton, TargetPicker, TranslationProgress } from './controls';
import { isEnglishCompatibleDraft } from './english';
import { localizeTranslationError, ui } from './i18n';
import { latestAssistantText } from './reply';
import { MAX_SOURCE_LENGTH, targetLabel, useTranslation } from './use-translation';

/** Offered by app builds with the composer draft patch; older apps leave it undefined. */
export type ComposerDraft = { getText(target: { agentId: string }): string; replaceText(target: { agentId: string }, text: string): void };
type Props = PluginButtonContentProps & { paseo: Pick<PluginClientContext['paseo'], 'agents'>; composer?: ComposerDraft; openSettings(): void };

export const LIVE_TRANSLATION_DELAY_MS = 600;

/** Keeps draft translation separate from reading an AI reply in the native sheet. */
export function ComposerTranslator({ theme, close, paseo, composer, openSettings, ...props }: Props) {
  const agentId = props.context === 'agent' ? props.agentId : '';
  // With composer access the sheet works like a keyboard's translate bar: it
  // starts from the typed draft, translates as you pause, and fills the input.
  const inline = !!composer && !!agentId;
  const draft = useTranslation();
  const reply = useTranslation();
  const [mode, setMode] = useState<'draft' | 'reply'>('draft');
  const [fetching, setFetching] = useState(false);
  const [sending, setSending] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const [incompleteReply, setIncompleteReply] = useState(false);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  const fetchingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const toast = useToast();
  const running = useAgent(agentId, agent => agent.status === 'running' || agent.status === 'initializing') ?? false;
  const current = mode === 'draft' ? draft : reply;
  const { settings, configured, result, error, busy: translating, copied, progress, complete } = current;
  const busy = draft.busy || reply.busy || fetching || sending;
  const colors = theme.colors;

  // Text that already reads as English was most likely filled in by this sheet.
  const [prefill] = useState(() => {
    const typed = inline ? composer.getText({ agentId }) : '';
    return typed.trim() && !isEnglishCompatibleDraft(typed) ? typed.slice(0, MAX_SOURCE_LENGTH) : '';
  });
  useEffect(() => { if (prefill) draft.setSource(prefill); }, []);

  useEffect(() => {
    if (!inline || mode !== 'draft' || !draft.configured || !draft.source.trim()) return;
    const timer = setTimeout(() => { void draft.run(draft.source); }, draft.source === prefill ? 0 : LIVE_TRANSLATION_DELAY_MS);
    return () => clearTimeout(timer);
  }, [inline, mode, draft.configured, draft.source, draft.target]);

  const fill = () => {
    if (!inline || !draft.result || !draft.complete || busy) return;
    composer.replaceText({ agentId }, draft.result.translation);
    close();
  };

  const loadLatestReply = async () => {
    if (!agentId || busy || fetchingRef.current || !configured) return;
    fetchingRef.current = true;
    setFetching(true);
    reply.setError(null);
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 80 });
      if (!mounted.current) return;
      const latest = latestAssistantText(page.entries.map(entry => entry.item));
      if (!latest) { reply.setError(ui('This conversation has no AI reply to translate yet', '当前对话还没有可翻译的 AI 回复')); return; }
      if (latest.text !== replyText) {
        reply.setSource(latest.text);
        setReplyText(latest.text);
        setShowOriginal(false);
      }
      setIncompleteReply(running);
      await reply.runReply(latest.text);
    } catch (reason) {
      if (mounted.current) reply.setError(localizeTranslationError(reason));
    } finally {
      fetchingRef.current = false;
      if (mounted.current) setFetching(false);
    }
  };

  const send = async () => {
    if (mode !== 'draft' || !draft.result || !draft.complete || !agentId || busy || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    draft.setError(null);
    try {
      await paseo.agents.ref(agentId).send(draft.result.translation);
      // The sent translation replaces the draft it came from.
      if (inline && prefill && composer.getText({ agentId }).slice(0, MAX_SOURCE_LENGTH) === prefill) composer.replaceText({ agentId }, '');
      toast.show(ui('Translation sent to this conversation', '译文已发送到当前对话'), { variant: 'success' });
      if (mounted.current) close();
    } catch (reason) {
      if (mounted.current) draft.setError(localizeTranslationError(reason));
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 16, gap: 14 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 17, fontWeight: '700' }}>{ui('Translate', '翻译')}</Text>
      <ActionButton theme={theme} label={ui('API Settings', 'API 设置')} onPress={openSettings} style={{ paddingHorizontal: 12 }} />
    </View>

    <View accessibilityRole="tablist" style={{ flexDirection: 'row', padding: 4, gap: 4, borderRadius: 12, backgroundColor: colors.surface1 }}>
      {(['draft', 'reply'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: mode === value, disabled: busy }} disabled={busy} onPress={() => setMode(value)}
        style={({ pressed }) => ({ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: mode === value ? colors.surface2 : 'transparent', opacity: pressed ? 0.7 : 1 })}>
        <Text style={{ color: mode === value ? colors.accent : colors.foregroundMuted, fontWeight: '600' }}>{value === 'draft' ? ui('Write a message', '写消息') : ui('Read a reply', '读回复')}</Text>
      </Pressable>)}
    </View>

    {settings.status === 'loading' ? <Text style={{ color: colors.foregroundMuted }}>{ui('Loading Translation API settings…', '正在读取翻译 API 设置…')}</Text> : null}
    {settings.status === 'error' || settings.status === 'invalid' ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{localizeTranslationError(settings.error)}</Text> : null}

    {mode === 'draft' ? <View style={{ gap: 10 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{inline
        ? ui('Translates when you pause typing. Fill the message box, then edit or send as usual.', '停顿后自动翻译。填入输入框后可以继续修改，再正常发送。')
        : ui('Write or paste your message here. Review the translation before sending.', '在这里写下或粘贴消息，翻译后查看译文，再发送。')}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{ui('Your message', '想发送的消息')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{draft.source.length}/{MAX_SOURCE_LENGTH}</Text>
      </View>
      <TextInput
        accessibilityLabel={ui('Text to translate', '需要翻译的文字')}
        editable={inline ? !sending : !busy}
        autoFocus={inline && !prefill}
        value={draft.source}
        onChangeText={draft.setSource}
        multiline
        maxLength={MAX_SOURCE_LENGTH}
        autoCapitalize="sentences"
        autoCorrect
        placeholder={ui('Enter or paste a message…', '输入或粘贴要发送的消息…')}
        placeholderTextColor={colors.foregroundMuted}
        textAlignVertical="top"
        style={{ minHeight: 110, maxHeight: 200, padding: 12, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, fontSize: 16, lineHeight: 23, opacity: !inline && busy ? 0.7 : 1 }}
      />
      <TargetPicker compact theme={theme} value={draft.target} onChange={draft.setTarget} disabled={inline ? sending : busy} />
      {inline ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{translating ? ui('Translating…', '翻译中…') : ''}</Text>
        <ActionButton theme={theme} disabled={sending || !draft.source} label={ui('Clear', '清空')} onPress={() => draft.setSource('')} style={{ paddingHorizontal: 12 }} />
      </View> : <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton theme={theme} primary disabled={!draft.canTranslate || busy} label={translating ? ui('Translating…', '翻译中…') : ui('Translate message', '翻译消息')} onPress={() => { void draft.run(); }} style={{ flexGrow: 1 }} />
        <ActionButton theme={theme} disabled={busy || !draft.source} label={ui('Clear', '清空')} onPress={() => draft.setSource('')} />
      </View>}
    </View> : <View style={{ gap: 10 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{ui('Translate the latest AI reply into Chinese. Long replies are translated in full.', '将最新的 AI 回复译成中文，长回复也会翻译全文。')}</Text>
      <ActionButton theme={theme} primary disabled={!agentId || !configured || busy} label={fetching && !translating ? ui('Loading reply…', '读取回复中…') : translating ? ui('Translating…', '翻译中…') : ui('Translate latest reply', '翻译最新回复')} onPress={() => { void loadLatestReply(); }} />
      {replyText ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(`Original · ${replyText.length} characters`, `原文 · ${replyText.length} 字`)}</Text>
          <ActionButton theme={theme} label={showOriginal ? ui('Hide original', '收起原文') : ui('Show original', '查看原文')} onPress={() => setShowOriginal(value => !value)} style={{ paddingHorizontal: 12 }} />
        </View>
        {showOriginal ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 }}>{replyText}</Text> : null}
        {incompleteReply ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{ui('The AI was still replying when this text was loaded. Refresh after it finishes for the full reply.', '读取时 AI 仍在回复，完成后可再次点击翻译最新回复。')}</Text> : null}
      </View> : null}
    </View>}

    <TranslationProgress theme={theme} progress={progress} busy={translating} />
    {error ? <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 20 }}>{error}</Text>
      {mode === 'reply' && replyText ? <ActionButton theme={theme} disabled={busy} label={ui('Continue translation', '继续翻译')} onPress={() => { void reply.runReply(replyText); }} style={{ alignSelf: 'flex-start' }} /> : null}
      {mode === 'draft' && inline && draft.source.trim() ? <ActionButton theme={theme} disabled={busy} label={ui('Retry', '重试')} onPress={() => { void draft.run(); }} style={{ alignSelf: 'flex-start' }} /> : null}
    </View> : null}

    {result ? <View style={{ gap: 12, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: colors.foreground, fontWeight: '700' }}>{ui(`Translation · ${targetLabel(result.target)}`, `译文 · ${targetLabel(result.target)}`)}</Text>
        <ActionButton theme={theme} disabled={!complete || busy} label={copied ? ui('Copied', '已复制') : ui('Copy', '复制')} color={copied ? colors.statusSuccess : undefined} onPress={() => { void current.copy(); }} style={{ paddingHorizontal: 12 }} />
      </View>
      {mode === 'draft' && inline ? <View style={{ flexDirection: 'row', gap: 8 }}>
        <ActionButton theme={theme} primary disabled={busy || !complete} label={ui('Fill message box', '填入输入框')} onPress={fill} style={{ flexGrow: 1 }} />
        <ActionButton theme={theme} disabled={busy || !complete} label={sending ? ui('Sending…', '发送中…') : ui('Send', '发送')} onPress={() => { void send(); }} />
      </View> : mode === 'draft' ? <ActionButton theme={theme} primary disabled={!agentId || busy || !complete} label={sending ? ui('Sending…', '发送中…') : ui('Send translation', '发送译文')} onPress={() => { void send(); }} /> : null}
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>{result.translation}</Text>
    </View> : null}
  </ScrollView>;
}
