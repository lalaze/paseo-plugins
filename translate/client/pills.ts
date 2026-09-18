import type { ComponentType } from 'react';
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';
import { followAgents } from './agents';
import { ui } from './i18n';

type PillClient = Pick<PluginClientContext, 'addComposerPill'> & { paseo: Pick<PluginClientContext['paseo'], 'agents'> };
type Pill = { workspaceId: string; registration: PluginButtonRegistration };

/** Adds a native "译" pill to every active conversation's composer; used where the DOM launcher cannot run. */
export function installComposerPills(client: PillClient, Content: ComponentType<PluginButtonContentProps>, intervalMs?: number) {
  const pills = new Map<string, Pill>();
  const button = { title: ui('Translate text or the latest AI reply', '翻译文字或最新的 AI 回复'), label: ui('Translate', '译'), icon: 'Languages', behavior: { kind: 'popover' as const, Content } };
  const stop = followAgents(client.paseo.agents, agents => {
    for (const [agentId, pill] of pills) {
      if (agents.get(agentId) === pill.workspaceId) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, workspaceId] of agents) {
      if (!pills.has(agentId)) pills.set(agentId, { workspaceId, registration: client.addComposerPill({ id: 'translate', workspaceId, agentId, button }) });
    }
  }, intervalMs);
  return () => {
    stop();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
