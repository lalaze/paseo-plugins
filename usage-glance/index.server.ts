import type { PluginServerContext } from '@getpaseo/plugin/server';
import { headerSettings } from './shared/settings';

export default function contribute(server: PluginServerContext) {
  server.registerSettings(headerSettings);
  return () => {};
}
