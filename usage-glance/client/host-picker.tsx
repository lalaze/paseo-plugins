import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { HostEntry } from './hosts';

export function HostPicker({ hosts, selected, onSelect, theme }: { hosts: readonly HostEntry[]; selected: string | null; onSelect: (id: string | null) => void; theme: PluginHostProps['theme'] }) {
  const [open, setOpen] = useState(false);
  const host = hosts.find(host => host.id === selected);
  const choose = (id: string | null) => { onSelect(id); setOpen(false); };
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="选择统计主机" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.surface0 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>{selected === null ? '全部主机' : host?.label ?? '主机暂不可用'}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{selected === null ? `已发现 ${hosts.length} 台 · 已连接 ${hosts.filter(host => host.online).length} 台` : host?.online ? '已连接 · 本机 Providers 范围' : '未连接 · 显示上次记录'}</Text>
      </View>
      <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{open ? '收起' : '切换'}</Text>
    </Pressable>
    {open ? <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 6, gap: 4 }}>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        <Pressable accessibilityRole="button" accessibilityLabel="统计全部主机" accessibilityState={{ selected: selected === null }} onPress={() => choose(null)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', borderRadius: 8, backgroundColor: selected === null ? theme.colors.surface2 : 'transparent' }}><Text style={{ color: theme.colors.foreground, fontSize: 12 }}>全部主机</Text></Pressable>
        {hosts.map(host => <Pressable key={host.id} accessibilityRole="button" accessibilityLabel={`统计主机 ${host.label}`} accessibilityState={{ selected: selected === host.id }} onPress={() => choose(host.id)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', gap: 4, borderRadius: 8, backgroundColor: selected === host.id ? theme.colors.surface2 : 'transparent' }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{host.label}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{host.online ? '已连接' : '未连接 · 缓存记录'}</Text>
        </Pressable>)}
      </ScrollView>
      <Text style={{ padding: 8, fontSize: 11, lineHeight: 17, color: theme.colors.foregroundMuted }}>其他主机未出现时，请在该主机更新此插件并保持连接。</Text>
    </View> : null}
  </View>;
}
