import type { PluginClientContext, PluginButtonRegistration, PluginButtonContentProps, PluginButtonIconProps } from '@getpaseo/plugin/client';
import { QueryObserver } from '@tanstack/react-query';
import { HeaderQuotaIcon } from './client/overview';
import { UsageDashboard } from './client/dashboard';
import { createConsumptionQuery } from './client/consumption-query';
import { createHeaderPreference } from './client/preference';
import { createUsageQuery } from './client/query';
import { followWorkspaces } from './client/workspaces';
import { headerSummary, isStale } from './shared/usage';

export default function contribute(client: PluginClientContext) {
  const query = createUsageQuery(client.paseo);
  const consumption = createConsumptionQuery(query.client, (contract, input) => client.rpc(contract, input), client.paseo.providers);
  query.client.mount();
  const observer = new QueryObserver(query.client, query.options);
  const preference = createHeaderPreference((contract, input) => client.rpc(contract, input));
  const headers = new Map<string, PluginButtonRegistration>();
  let workspaces = new Set<string>();
  const HeaderIcon = (props: PluginButtonIconProps) => <HeaderQuotaIcon {...props} query={query} preference={preference} />;
  const HeaderContent = (props: PluginButtonContentProps) => <UsageDashboard {...props} query={query} consumption={consumption} preference={preference} />;

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
