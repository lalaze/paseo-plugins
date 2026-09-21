import { useEffect } from 'react';
import type { PluginClientContext, PluginButtonRegistration, PluginButtonIconProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Modal } from '@getpaseo/plugin/client/react-native';
import { Pressable, View } from 'react-native';
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
import { ui } from './client/i18n';
import { createQuotaDialogController, useQuotaDialog } from './client/quota-dialog';
import { useDialogTooltipShield } from './client/dialog-shield';

export default function contribute(client: PluginClientContext) {
  const quotaDialog = createQuotaDialogController();
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
  const QuotaDialog = (props: PluginButtonIconProps & { onOpenChange(open: boolean): void }) => {
    const shield = useDialogTooltipShield();
    return <Modal title={ui('Quota details', '额度明细')} open onOpenChange={props.onOpenChange}>
      <Modal.Content><View ref={shield}><Overview {...props} query={query} preference={preference} popover /></View></Modal.Content>
    </Modal>;
  };
  const HeaderIcon = (props: PluginButtonIconProps) => {
    useEffect(() => { registration.identify(props.host, true); workspaceRegistration.identify(props.host, true); }, [props.host.id, props.host.label]);
    const dialog = useQuotaDialog(quotaDialog, props.workspaceId);
    return <>
      <HeaderQuotaIcon {...props} query={query} preference={preference} />
      {/* Portal events still bubble through the icon's React ancestors. */}
      {dialog.open ? <Pressable accessible={false} focusable={false} onPress={event => event.stopPropagation()}>
        <QuotaDialog {...props} onOpenChange={dialog.onOpenChange} />
      </Pressable> : null}
    </>;
  };
  const ConsumptionSurface = (props: PluginSurfaceProps) => <ConsumptionPage {...props} fleet={fleet} />;
  const removeSurface = client.addSurface('consumption', ConsumptionSurface);
  const removeSidebar = client.addSidebarItem({ id: 'consumption', title: ui('Token Usage', 'Token 消耗'), icon: 'ChartColumn', surface: 'consumption' });
  const removeCommand = client.addCommandCenterItem({ id: 'open-consumption', title: ui('View Token Usage', '查看 Token 消耗'), icon: 'ChartColumn', context: 'global', keywords: ['token', 'usage', 'consumption', 'heatmap', '消耗', '热力图'], onSelect: () => client.openSurface('consumption') });

  function sync() {
    const result = observer.getCurrentResult();
    const stale = result.isError || isStale(result.data);
    const header = headerSummary(result.data?.providers ?? [], preference.get());
    const headerLabel = result.isPending ? ui('Quota · Loading…', '额度 · 读取中…') : stale ? ui('Quota · Update needed', '额度 · 待更新') : header.label;
    const headerTitle = stale ? ui('Quota needs updating. Click to view the previous data and retry.', '额度待更新，点击查看上次数据并重试') : result.isPending ? ui('Loading quota', '正在读取额度') : header.detail;
    for (const [id, registration] of headers) {
      if (!workspaces.has(id)) { registration.remove(); headers.delete(id); }
    }
    for (const workspaceId of workspaces) {
      const existing = headers.get(workspaceId);
      if (existing) existing.update({ label: headerLabel, title: headerTitle });
      else headers.set(workspaceId, client.addHeaderButton({
        id: 'usage', workspaceId,
        button: { label: headerLabel, title: headerTitle, icon: HeaderIcon, behavior: { kind: 'action', onPress: () => quotaDialog.toggle(workspaceId) } },
      }));
    }
  }
  const unsubscribeQuery = observer.subscribe(sync);
  const unsubscribePreference = preference.subscribe(sync);
  const stopWorkspaces = followWorkspaces(client.paseo, latest => { workspaces = new Set(latest); sync(); });
  return () => {
    quotaDialog.dispose();
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
