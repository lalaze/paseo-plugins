import { currentRound, type Task, type Round } from './schema';
import { ui } from './i18n';

export const CLAIM_TIMEOUT_MS = 2 * 60_000;
export const CLAIM_RETRY_DELAYS = [2 * 60_000, 4 * 60_000, 8 * 60_000] as const;
export const MANUAL_WAKE_COOLDOWN_MS = 60_000;

export function awaitingClaim(task: Task): boolean {
  const round = currentRound(task);
  return task.mode === 'text' && round.remoteStatus === 'dispatched' && !round.claim
    && round.claimedAt === null && !round.stop.requested && !task.cancelRequested;
}

export function claimWaitLabel(round: Round, locale?: 'en' | 'zh-CN'): string | null {
  if (round.remoteStatus !== 'dispatched' || round.claim || round.stop.requested || !round.claimWait?.timedOut) return null;
  const count = round.claimWait.retries;
  return ui(
    `Notification received, but Dot has not claimed this round. Automatic reminders: ${count}/3. ${count >= 3 ? 'Automatic reminders have ended. ' : ''}Open Dot tasks → task details → Wake Dot again, or cancel this round.`,
    `通知已送达，但 Dot 长时间未领取。已自动补发 ${count}/3 次。${count >= 3 ? '自动补发已达上限。' : ''}可在「Dot 任务 → 任务详情」重新唤醒 Dot，或取消本轮。`,
    locale ? { __PASEO_LOCALE__: locale } : undefined,
  );
}
