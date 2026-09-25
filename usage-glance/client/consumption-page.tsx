import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import type { HostRegistration, HostRegistry } from './hosts';
import { HostPicker } from './host-picker';
import { Consumption } from './consumption';
import { createMultiHostConsumption } from './multi-host-consumption';
import { ui } from './i18n';

type FleetContext = { registry: HostRegistry; registration: HostRegistration; workspaceRegistry: HostRegistry; workspaceRegistration: HostRegistration };
export function ConsumptionPage({ theme, host, layout, fleet }: PluginSurfaceProps & { fleet: FleetContext }) {
  const hosts = useSyncExternalStore(fleet.registry.subscribe, fleet.registry.getSnapshot, fleet.registry.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  // Keep the QueryClient stable: mounted query observers stay subscribed when scope changes.
  const query = useMemo(() => createMultiHostConsumption(fleet.registry, null), [fleet.registry]);
  const workspaceQuery = useMemo(() => createMultiHostConsumption(fleet.workspaceRegistry, null, query.client), [fleet.workspaceRegistry, query]);
  const selectHost = (id: string | null) => { query.select(id); workspaceQuery.select(id); setSelected(id); };
  useEffect(() => { fleet.registration.identify(host, true); fleet.workspaceRegistration.identify(host, true); }, [fleet.registration, fleet.workspaceRegistration, host.id, host.label]);
  useEffect(() => { query.mount(); return () => query.dispose(); }, [query]);
  useEffect(() => { workspaceQuery.mount(); return () => workspaceQuery.dispose(); }, [workspaceQuery]);
  const visible = hosts.filter(host => selected === null || host.id === selected);
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28 }}>
    <View style={{ width: '100%', maxWidth: 880, alignSelf: 'center', gap: 24 }}>
      <View style={{ flexDirection: layout.compact ? 'column' : 'row', alignItems: layout.compact ? 'stretch' : 'center', gap: 16 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 26, fontWeight: '700' }}>{ui('Token Usage', 'Token 消耗')}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{ui('Usage summary and monthly model heatmap', '用量汇总与月度模型热力图')}</Text>
        </View>
        <View style={{ width: layout.compact ? '100%' : 280, maxWidth: '100%' }}><HostPicker hosts={hosts} selected={selected} onSelect={selectHost} theme={theme} /></View>
      </View>
      <View style={{ padding: layout.compact ? 14 : 24, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border }}>
        {!visible.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, padding: 12 }}>{ui('Waiting for connected hosts to load the usage plugin…', '等待已连接主机加载统计插件…')}</Text> : <Consumption query={query} workspaceQuery={workspaceQuery} theme={theme} layout={layout} scopeLabel={selected === null ? ui('Cross-host usage', '跨主机消耗') : visible[0].label} />}
      </View>
    </View>
  </ScrollView>;
}
