import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { HostRegistration, HostRegistry } from './hosts';
import { HostPicker } from './host-picker';
import { HostQuotas } from './host-quotas';
import { Consumption } from './consumption';
import { createMultiHostConsumption } from './multi-host-consumption';
import { DashboardTabs } from './dashboard-tabs';
import { Overview } from './overview';

export type FleetContext = { registry: HostRegistry; registration: HostRegistration };
export function FleetDashboard({ theme, host, layout, fleet }: PluginHostProps & { fleet: FleetContext }) {
  const hosts = useSyncExternalStore(fleet.registry.subscribe, fleet.registry.getSnapshot, fleet.registry.getSnapshot);
  const [tab, setTab] = useState<'quota' | 'consumption'>('quota');
  const [selected, setSelected] = useState<string | null>(null);
  const query = useMemo(() => createMultiHostConsumption(fleet.registry, selected), [fleet.registry, selected]);
  useEffect(() => { fleet.registration.identify(host, true); }, [fleet.registration, host.id, host.label]);
  useEffect(() => { query.mount(); return () => query.dispose(); }, [query]);
  const visible = hosts.filter(host => selected === null || host.id === selected);
  return <View style={{ width: '100%', gap: 12 }}>
    <DashboardTabs tab={tab} onSelect={setTab} theme={theme} layout={layout} />
    <HostPicker hosts={hosts} selected={selected} onSelect={setSelected} theme={theme} />
    {!visible.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, padding: 12 }}>等待已连接主机加载统计插件…</Text> : tab === 'quota' ? selected !== null && visible[0].runtime ? <Overview theme={theme} host={visible[0]} layout={layout} query={visible[0].runtime.query} preference={visible[0].runtime.preference} popover /> : <HostQuotas hosts={visible} registry={fleet.registry} theme={theme} /> : <Consumption query={query} theme={theme} layout={layout} scopeLabel={selected === null ? '跨主机消耗' : visible[0].label} />}
  </View>;
}
