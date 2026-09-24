import { useState } from 'react';
import { Text, View } from 'react-native';
import { ActionButton } from './controls';
import { ui } from './i18n';
import type { ReplyTranslationProps } from './reply-translation';
import { useTranslation } from './use-translation';

export function ReplyTranslator({ theme, item, openSettings }: ReplyTranslationProps & { openSettings(): void }) {
  const { configured, result, error, busy, copied, runReply, copy } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const colors = theme.colors;
  const toggle = () => {
    if (busy) return;
    if (result) { setExpanded(value => !value); return; }
    setExpanded(true);
    void runReply(item.data.text);
  };
  const label = busy ? ui('Translating…', '翻译中…') : result
    ? expanded ? ui('Hide translation', '收起译文') : ui('Show translation', '展开译文')
    : error ? ui('Retry translation', '重试翻译') : ui('Translate', '翻译');

  return <View style={{ gap: 10, paddingVertical: 6 }}>
    <ActionButton theme={theme} label={label} disabled={busy || !configured} onPress={toggle} style={{ alignSelf: 'flex-start' }} />
    {!configured || error ? <View style={{ gap: 8 }}>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
      <ActionButton theme={theme} label={ui('Translation API settings', '翻译 API 设置')} onPress={openSettings} style={{ alignSelf: 'flex-start' }} />
    </View> : null}
    {expanded && result ? <View style={{ gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Chinese translation', '中文译文')}</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>{result.translation}</Text>
      <ActionButton theme={theme} label={copied ? ui('Copied', '已复制') : ui('Copy translation', '复制译文')} onPress={() => { void copy(); }} style={{ alignSelf: 'flex-start' }} />
    </View> : null}
  </View>;
}
