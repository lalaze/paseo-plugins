import { createElement } from 'react';
import type { PluginButtonContentProps, PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { registerTranslationClient } from './client/selection';
import { TranslationSettingsScreen } from './client/settings';
import { TranslationSurface } from './client/translator';
import { ComposerTranslator } from './client/composer';
import { installComposerPills } from './client/pills';
import { ui } from './client/i18n';
import { runtimeInfoRpc } from './shared/rpc';

export default function contribute(client: PluginClientContext) {
  let disposed = false, unregister = () => {};
  const unregisterSettings = client.addSettingsScreen({ id: 'translate-settings', title: ui('Translation API', '翻译 API'), icon: 'Settings', Component: TranslationSettingsScreen });
  const Surface = (props: PluginSurfaceProps) => createElement(TranslationSurface, { ...props, openSettings: () => client.openSettings('translate-settings') });
  const unregisterSurface = client.addSurface('translate', Surface);
  const unregisterSidebar = client.addSidebarItem({ id: 'translate', title: ui('Translate', '翻译'), icon: 'Languages', surface: 'translate' });
  const unregisterCommand = client.addCommandCenterItem({ id: 'open-translate', title: ui('Translate text', '翻译文字'), icon: 'Languages', context: 'global', keywords: ['translate', 'translation', '翻译'], onSelect: () => client.openSurface('translate') });
  // Desktop and Web get the DOM launcher beside the composer; iOS/Android get a native composer pill instead.
  const Composer = (props: PluginButtonContentProps) => createElement(ComposerTranslator, { ...props, paseo: client.paseo, openSettings: () => { props.close(); client.openSettings('translate-settings'); } });
  const uninstallPills = typeof document === 'undefined' ? installComposerPills(client, Composer) : () => {};
  void client.rpc(runtimeInfoRpc, {}).then(({ serverId }) => {
    if (!disposed && serverId) unregister = registerTranslationClient(serverId, client);
  }).catch(() => {});
  return () => { disposed = true; unregister(); uninstallPills(); unregisterCommand(); unregisterSidebar(); unregisterSurface(); unregisterSettings(); };
}
