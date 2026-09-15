import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { HostEntry } from './hosts';

export function HostPicker({ hosts, selected, onSelect, theme }: { hosts: readonly HostEntry[]; selected: string | null; onSelect: (id: string | null) => void; theme: PluginHostProps['theme'] }) {
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const viewport = useWindowDimensions();
  const open = anchor !== null;
  const close = () => setAnchor(null);
  useEffect(close, [viewport.width, viewport.height]);
  const host = hosts.find(host => host.id === selected);
  const choose = (id: string | null) => { onSelect(id); close(); };
  const below = anchor ? viewport.height - anchor.y - anchor.height - 14 : 0;
  const above = anchor ? anchor.y - 14 : 0;
  const down = below >= 300 || below >= above;
  const width = Math.min(anchor?.width ?? 280, viewport.width - 16);
  return <View>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="选择统计主机" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => {
      if (open) close();
      else trigger.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
    }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.surface0 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>{selected === null ? '全部主机' : host?.label ?? '主机暂不可用'}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{selected === null ? `已发现 ${hosts.length} 台 · 已连接 ${hosts.filter(host => host.online).length} 台` : host?.online ? '已连接 · 本机 Providers 范围' : '未连接 · 显示上次记录'}</Text>
      </View>
      <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{open ? '收起' : '切换'}</Text>
    </Pressable>
    <Modal transparent animationType="none" visible={open} onRequestClose={close} accessibilityLabel="选择统计主机">
      {anchor ? <>
        <Pressable accessible={false} focusable={false} onPress={close} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: Math.max(8, Math.min(anchor.x, viewport.width - width - 8)), width, ...(down ? { top: anchor.y + anchor.height + 6 } : { bottom: viewport.height - anchor.y + 6 }), maxHeight: Math.max(0, down ? below : above), backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 6, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
          <ScrollView style={{ maxHeight: 300, flexShrink: 1 }} nestedScrollEnabled>
            <Pressable accessibilityRole="button" accessibilityLabel="统计全部主机" accessibilityState={{ selected: selected === null }} onPress={() => choose(null)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', borderRadius: 8, backgroundColor: selected === null ? theme.colors.surface2 : 'transparent' }}><Text style={{ color: theme.colors.foreground, fontSize: 12 }}>全部主机</Text></Pressable>
            {hosts.map(host => <Pressable key={host.id} accessibilityRole="button" accessibilityLabel={`统计主机 ${host.label}`} accessibilityState={{ selected: selected === host.id }} onPress={() => choose(host.id)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', gap: 4, borderRadius: 8, backgroundColor: selected === host.id ? theme.colors.surface2 : 'transparent' }}>
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12 }}>{host.label}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{host.online ? '已连接' : '未连接 · 缓存记录'}</Text>
            </Pressable>)}
            <Text style={{ padding: 8, fontSize: 11, lineHeight: 17, color: theme.colors.foregroundMuted }}>其他主机未出现时，请在该主机更新此插件并保持连接。</Text>
          </ScrollView>
        </View>
      </> : null}
    </Modal>
  </View>;
}
