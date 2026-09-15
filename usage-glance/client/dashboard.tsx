import { useState } from 'react';
import { View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Overview } from './overview';
import { Consumption } from './consumption';
import type { ConsumptionQuery } from './consumption-query';
import type { UsageQuery } from './query';
import type { HeaderPreference } from './preference';
import { DashboardTabs } from './dashboard-tabs';
import { FleetDashboard, type FleetContext } from './fleet-dashboard';

type DashboardProps = PluginHostProps & { query: UsageQuery; consumption: ConsumptionQuery; preference: HeaderPreference; fleet?: FleetContext };
export function UsageDashboard(props: DashboardProps) {
  return props.fleet ? <FleetDashboard {...props} fleet={props.fleet} /> : <SingleHostDashboard {...props} />;
}
function SingleHostDashboard(props: DashboardProps) {
  const [tab, setTab] = useState<'quota' | 'consumption'>('quota');
  return <View style={{ width: '100%', gap: 12 }}>
    <DashboardTabs tab={tab} onSelect={setTab} theme={props.theme} layout={props.layout} />
    {tab === 'quota' ? <Overview {...props} popover /> : <Consumption theme={props.theme} layout={props.layout} query={props.consumption} />}
  </View>;
}
