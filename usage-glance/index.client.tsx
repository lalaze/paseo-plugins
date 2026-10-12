import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { QueryClient } from '@tanstack/react-query';
import { ConsumptionPage } from './client/consumption-page';
import { createConsumptionQuery } from './client/consumption-query';
import { startConsumptionSync } from './client/consumption-sync';
import { installConsumptionHeaders } from './client/consumption-header';
import { ConsumptionHeaderIcon } from './client/consumption-header-icon';
import { getHostRegistry } from './client/hosts';
import { readHostIdentity } from './shared/hosts';
import { readWorkspaceConsumption } from './shared/consumption';
import { ui } from './client/i18n';

export default function contribute(client: PluginClientContext) {
  const queryClient = new QueryClient();
  queryClient.mount();
  const consumption = createConsumptionQuery(queryClient, (contract, input) => client.rpc(contract, input), client.paseo.providers);
  const workspaceClient = new QueryClient();
  workspaceClient.mount();
  const workspaceConsumption = createConsumptionQuery(workspaceClient, (contract, input) => client.rpc(contract, input), client.paseo.providers, readWorkspaceConsumption);
  const registry = getHostRegistry();
  const registration = registry.register({ consumption });
  const workspaceRegistry = getHostRegistry(true);
  const workspaceRegistration = workspaceRegistry.register({ consumption: workspaceConsumption });
  const stopConsumptionSync = startConsumptionSync(consumption);
  const fleet = { registry, registration, workspaceRegistry, workspaceRegistration };
  void client.rpc(readHostIdentity, {}).then(identity => { registration.identify(identity); workspaceRegistration.identify(identity); }).catch(() => {});
  const ConsumptionSurface = (props: PluginSurfaceProps) => <ConsumptionPage {...props} fleet={fleet} />;
  const removeSurface = client.addSurface('consumption', ConsumptionSurface);
  const removeSidebar = client.addSidebarItem({ id: 'consumption', title: ui('Token Usage', 'Token 消耗'), icon: 'ChartColumn', surface: 'consumption' });
  const removeCommand = client.addCommandCenterItem({ id: 'open-consumption', title: ui('View Token Usage', '查看 Token 消耗'), icon: 'ChartColumn', context: 'global', keywords: ['token', 'usage', 'consumption', 'heatmap', '消耗', '热力图'], onSelect: () => client.openSurface('consumption') });
  const removeHeaders = installConsumptionHeaders(client, registry, tone => props => <ConsumptionHeaderIcon {...props} tone={tone} />);

  return () => {
    removeHeaders();
    stopConsumptionSync();
    removeCommand();
    removeSidebar();
    removeSurface();
    registration.dispose();
    workspaceRegistration.dispose();
    workspaceConsumption.dispose();
    workspaceClient.unmount();
    workspaceClient.clear();
    consumption.dispose();
    queryClient.unmount();
    queryClient.clear();
  };
}
