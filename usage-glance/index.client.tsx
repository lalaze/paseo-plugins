import { useEffect } from 'react';
import type { PluginClientContext, PluginButtonRegistration, PluginButtonContentProps, PluginButtonIconProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { HeaderQuotaIcon, Overview } from './client/overview';
import { ConsumptionPage } from './client/consumption-page';
import { createConsumptionQuery } from './client/consumption-query';
import { startConsumptionSync } from './client/consumption-sync';
import { createHeaderPreference } from './client/preference';
import { createUsageQuery } from './client/query';
import { followWorkspaces } from './client/workspaces';
import { getHostRegistry } from './client/hosts';
import { readHostIdentity } from './shared/hosts';
import { readWorkspaceConsumption } from './shared/consumption';
import { headerSummary, isStale } from './shared/usage';

export default function contribute(client: PluginClientContext) {
  const query = createUsageQuery(client.paseo);
  const consumption = createConsumptionQuery(query.client, (contract, input) => client.rpc(contract, input), client.paseo.providers);
  const workspaceClient = new QueryClient();
  workspaceClient.mount();
  const workspaceConsumption = createConsumptionQuery(workspaceClient, (contract, input) => client.rpc(contract, input), client.paseo.providers, readWorkspaceConsumption);
  query.client.mount();
  const observer = new QueryObserver(query.client, query.options);
  const preference = createHeaderPreference((contract, input) => client.rpc(contract, input));
  const registry = getHostRegistry();
  const registration = registry.register({ consumption });
  const workspaceRegistry = getHostRegistry(true);
  const workspaceRegistration = workspaceRegistry.register({ consumption: workspaceConsumption });
  const stopConsumptionSync = startConsumptionSync(consumption);
  const fleet = { registry, registration, workspaceRegistry, workspaceRegistration };
  void client.rpc(readHostIdentity, {}).then(identity => { registration.identify(identity); workspaceRegistration.identify(identity); }).catch(() => {});
  const headers = new Map<string, PluginButtonRegistration>();
  let workspaces = new Set<string>();
  const HeaderIcon = (props: PluginButtonIconProps) => {
    useEffect(() => { registration.identify(props.host, true); workspaceRegistration.identify(props.host, true); }, [props.host.id, props.host.label]);
    return <HeaderQuotaIcon {...props} query={query} preference={preference} />;
  };
  const HeaderContent = (props: PluginButtonContentProps) => <Overview {...props} query={query} preference={preference} popover />;
  const ConsumptionSurface = (props: PluginSurfaceProps) => <ConsumptionPage {...props} fleet={fleet} />;
  const removeSurface = client.addSurface('consumption', ConsumptionSurface);
  const removeSidebar = client.addSidebarItem({ id: 'consumption', title: 'Token 消耗', icon: 'ChartColumn', surface: 'consumption' });
  const removeCommand = client.addCommandCenterItem({ id: 'open-consumption', title: '查看 Token 消耗', icon: 'ChartColumn', context: 'global', keywords: ['token', 'usage', '消耗', '热力图'], onSelect: () => client.openSurface('consumption') });

  function sync() {
    const result = observer.getCurrentResult();
    const stale = result.isError || isStale(result.data);
    const header = headerSummary(result.data?.providers ?? [], preference.get());
    const headerLabel = result.isPending ? '额度 · 读取中…' : stale ? '额度 · 待更新' : header.label;
    const headerTitle = stale ? '额度待更新，点击查看上次数据并重试' : result.isPending ? '正在读取额度' : header.detail;
    for (const [id, registration] of headers) {
      if (!workspaces.has(id)) { registration.remove(); headers.delete(id); }
    }
    for (const workspaceId of workspaces) {
      const existing = headers.get(workspaceId);
      if (existing) existing.update({ label: headerLabel, title: headerTitle });
      else headers.set(workspaceId, client.addHeaderButton({
        id: 'usage', workspaceId,
        button: { label: headerLabel, title: headerTitle, icon: HeaderIcon, behavior: { kind: 'popover', Content: HeaderContent } },
      }));
    }
  }
  const unsubscribeQuery = observer.subscribe(sync);
  const unsubscribePreference = preference.subscribe(sync);
  const stopWorkspaces = followWorkspaces(client.paseo, latest => { workspaces = new Set(latest); sync(); });
  return () => {
    stopConsumptionSync();
    removeCommand();
    removeSidebar();
    removeSurface();
    registration.dispose();
    workspaceRegistration.dispose();
    workspaceConsumption.dispose();
    workspaceClient.unmount();
    workspaceClient.clear();
    stopWorkspaces();
    consumption.dispose();
    unsubscribePreference();
    unsubscribeQuery();
    observer.destroy();
    for (const registration of headers.values()) registration.remove();
    headers.clear();
    query.client.unmount();
    query.client.clear();
  };
}
