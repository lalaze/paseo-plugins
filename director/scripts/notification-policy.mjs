// Keep this function self-contained: the patch embeds it in Paseo's dispatcher.
export function shouldMuteDirectorFinish(agent, reason, timeline) {
  if (reason !== 'finished') return false;
  const labels = agent?.labels ?? {};
  if (labels['director-run'] && labels['director-role'] !== 'chat') return true;
  if (!labels['director-conversation'] || labels['director-role'] !== 'chat') return false;
  const message = timeline.findLast(item => item.type === 'user_message');
  if (!message) return false;
  const id = message.clientMessageId ?? message.messageId;
  const text = message.text ?? '';
  if (id?.startsWith('chat-notice:') && text.startsWith(`[paseo-director-chat:${id}]\n`)) {
    try {
      const line = text.split('\n').find(line => line.startsWith('{'));
      const state = JSON.parse(line);
      // Keep requests that actually need the user, and overall completion.
      if (state.confirmation || ['awaiting_acceptance', 'completed'].includes(state.phase) || ['needs_attention', 'waiting_permission'].includes(state.control)) return false;
      return ['planning', 'executing', 'reviewing', 'final_review'].includes(state.phase) && ['running', 'paused'].includes(state.control);
    } catch { return false; } // Unknown messages retain their normal notification.
  }
  if (id && text.startsWith(`[paseo-director:${id}]\n`)) return true;
  return !!id?.startsWith('chat-command:') && text.startsWith('用户已在当前对话启用协作。') && text.includes('\n\n[paseo-director-takeover]\n');
}
