import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { ActionButton, TranslationProgress } from './controls';
import { ui } from './i18n';
import type { ReplyTranslationProps } from './reply-translation';
import { useTranslation } from './use-translation';

export function ReplyTranslator({ theme, item, openSettings }: ReplyTranslationProps & { openSettings(): void }) {
  const { settings, configured, result, error, busy, copied, progress, complete, runReply, copy } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const colors = theme.colors;
  const toggle = () => {
    if (busy) return;
    if (complete) { setExpanded(value => !value); return; }
    setExpanded(true);
    void runReply(item.data.text);
  };
  const label = busy ? ui('Translating…', '翻译中…') : complete
    ? expanded ? ui('Hide translation', '收起译文') : ui('Show translation', '展开译文')
    : error ? progress?.completed ? ui('Continue translation', '继续翻译') : ui('Retry translation', '重试翻译') : ui('Translate', '翻译');

  return <View style={{ gap: 8 }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy || !configured, busy, ...(complete ? { expanded } : {}) }}
      disabled={busy || !configured}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      onPress={toggle}
      style={{ alignSelf: 'flex-start' }}
    >
      {({ pressed }) => <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        minHeight: 34, paddingHorizontal: 13, paddingVertical: 7,
        borderRadius: 999, borderWidth: 1,
        borderColor: complete && expanded ? colors.accent : colors.border,
        backgroundColor: pressed ? colors.surface2 : 'transparent',
        opacity: !configured ? 0.5 : pressed ? 0.75 : 1,
      }}>
        {busy ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="Languages" size={16} color={colors.accent} />}
        <Text style={{ color: complete && expanded ? colors.accent : colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: '600' }}>{label}</Text>
        {complete ? <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} color={expanded ? colors.accent : colors.foregroundMuted} /> : null}
      </View>}
    </Pressable>
    {settings.status !== 'loading' && (!configured || error) ? <View style={{ gap: 8 }}>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
      <ActionButton theme={theme} label={ui('Translation API settings', '翻译 API 设置')} onPress={openSettings} style={{ alignSelf: 'flex-start' }} />
    </View> : null}
    <TranslationProgress theme={theme} progress={progress} busy={busy} />
    {expanded && result ? <View style={{ borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25, paddingHorizontal: 16, paddingVertical: 14 }}>{result.translation}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? ui('Copied', '已复制') : ui('Copy translation', '复制译文')}
        accessibilityState={{ disabled: busy || !complete }}
        disabled={busy || !complete}
        hitSlop={8}
        onPress={() => { void copy(); }}
        style={({ pressed }) => ({
          position: 'absolute', top: 12, right: 6, width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderRadius: 6,
          opacity: busy || !complete ? 0.4 : pressed ? 0.55 : 1,
        })}
      >
        <Icon name={copied ? 'Check' : 'Copy'} size={16} color={copied ? colors.statusSuccess : colors.foregroundMuted} />
      </Pressable>
    </View> : null}
  </View>;
}
