import { ui } from './i18n';
import type { RemoteStatus, VerifyStatus, DeliveryStatus } from './schema';

const REMOTE: Record<RemoteStatus, [string, string]> = {
  queued: ['Queued', '排队中'],
  dispatched: ['Dispatched', '已派发'],
  claimed: ['Dot accepted', 'dot 已接收'],
  running: ['Running', '运行中'],
  waiting_user: ['Waiting for you', '等待你的回复'],
  completed: ['Result reported', 'dot 已报告完成'],
  failed: ['Dot reported failure', 'dot 报告失败'],
  stopped: ['Dot reported stopped', 'dot 已回报停止'],
};

const VERIFY: Record<VerifyStatus, [string, string]> = {
  none: ['Not delivered yet', '尚未交付'],
  verifying: ['Verifying commit', '正在验证提交'],
  verified: ['Commit verified', '提交已验证'],
  failed: ['Verification failed', '验证失败'],
};

const DELIVERY: Record<DeliveryStatus, [string, string]> = {
  pending: ['Saved', '已保存'],
  sending: ['Sending', '发送中'],
  delivered: ['Delivered to dot', '已送达 dot'],
  failed: ['Delivery failed', '送达失败'],
};

export function remoteStatusLabel(status: RemoteStatus, opts: { localCancel?: boolean } = {}): string {
  // A queued task canceled locally never reached the dot, so it must not read as a dot-reported stop.
  if (status === 'stopped' && opts.localCancel) return ui('Canceled locally', '已在本地取消');
  const [en, zh] = REMOTE[status];
  return ui(en, zh);
}

export function verifyStatusLabel(status: VerifyStatus): string {
  const [en, zh] = VERIFY[status];
  return ui(en, zh);
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
  const [en, zh] = DELIVERY[status];
  return ui(en, zh);
}

export function messageKindLabel(kind: string): string {
  switch (kind) {
    case 'requirement':
      return ui('Requirement', '需求');
    case 'answer':
      return ui('Answer', '回复');
    case 'question':
      return ui('Question', '提问');
    case 'progress':
      return ui('Progress', '进度');
    case 'result':
      return ui('Result', '成果');
    case 'error':
      return ui('Error', '错误');
    default:
      return ui('Note', '说明');
  }
}
