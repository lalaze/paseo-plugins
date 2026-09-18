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
  const cleanups: (() => void)[] = [unregisterSettings];
  if (typeof document === 'undefined') {
    // iOS/Android: only the native composer pill; its popover covers drafts and the latest reply.
    const Composer = (props: PluginButtonContentProps) => createElement(ComposerTranslator, { ...props, paseo: client.paseo, openSettings: () => { props.close(); client.openSettings('translate-settings'); } });
    cleanups.push(installComposerPills(client, Composer));
  } else {
    // Desktop and Web: the DOM launcher beside the composer, plus the standalone page from the command center.
    const Surface = (props: PluginSurfaceProps) => createElement(TranslationSurface, { ...props, openSettings: () => client.openSettings('translate-settings') });
    cleanups.push(client.addSurface('translate', Surface));
    cleanups.push(client.addCommandCenterItem({ id: 'open-translate', title: ui('Translate text', '翻译文字'), icon: 'Languages', context: 'global', keywords: ['translate', 'translation', '翻译'], onSelect: () => client.openSurface('translate') }));
  }
  void client.rpc(runtimeInfoRpc, {}).then(({ serverId }) => {
    if (!disposed && serverId) unregister = registerTranslationClient(serverId, client);
  }).catch(() => {});
  return () => { disposed = true; unregister(); for (const cleanup of cleanups.reverse()) cleanup(); };
}
