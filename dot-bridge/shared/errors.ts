/** Stable error codes. The server throws the code; the client shows the translated sentence. */
import { ui, type UiLocale } from './i18n';

const messages = {
  'attachment-invalid': ['The attachment is invalid or failed integrity checks.', '附件格式不合法或完整性检查失败。'],
  'attachment-too-large': ['Use chunks for files over 1 MiB; maximum file size is 20 MiB.', '超过 1 MiB 请使用分块传输，单文件最大 20 MiB。'],
  'attachment-limit': ['A task can hold at most 16 attachments.', '每个任务最多保存 16 个附件。'],
  'attachment-missing': ['This attachment does not belong to the task.', '该附件不属于当前任务。'],
  'store-invalid': ['The saved dot-bridge file failed validation and was left untouched.', 'dot-bridge 存档校验失败，原文件未改动。'],
  'store-locked': ['Another dot-bridge process is using this data directory, so this one will not dispatch tasks.', '另一个 dot-bridge 正在使用同一数据目录，本进程不会派发任务。'],
  'connection-missing': ['No dot connection is configured yet.', '尚未配置 dot 连接。'],
  'connection-unverified': ['The dot connection has not passed the two-way check, so tasks stay queued.', 'dot 连接尚未通过双向检查，任务保持排队。'],
  'connection-invalid': ['The connection settings are not valid.', '连接设置不合法。'],
  'challenge-expired': ['The connection challenge expired or was already used.', '连接验证随机值已过期或已被使用。'],
  'challenge-missing': ['There is no pending connection challenge.', '当前没有待确认的连接随机值。'],
  'task-missing': ['The task no longer exists.', '任务不存在。'],
  'task-rejected': ['This task cannot be changed right now.', '当前不能修改这个任务。'],
  'round-missing': ['The round no longer exists.', '轮次不存在。'],
  'round-stale': ['A report arrived for an older round; it is kept in history and does not change the current round.', '收到旧轮次的回报；已保留在历史中，不改变当前轮次。'],
  'round-open': ['The current round is still working, so a new round cannot start.', '当前轮次仍在进行，不能开始新一轮。'],
  'retry-unavailable': ['This round has nothing to retry: it is still running or its commit is already verified.', '本轮无需重试：仍在进行，或提交已验证。'],
  'base-mismatch': ['The reported base commit is not the round baseline.', '回传的基准提交与本轮基准不一致。'],
  'base-unreachable': ['The base commit is not reachable from the bound remote.', '基准提交无法从绑定远端取得。'],
  'head-unreachable': ['The reported head commit cannot be fetched from the task branch on the bound remote.', '无法从绑定远端的任务分支取得回传的 head 提交。'],
  'branch-moved': ['The task branch moved after the report; submit the result again.', '任务分支在回报后发生了移动，请重新提交成果。'],
  'branch-not-task': ['The reported branch does not belong to this task.', '回传的分支不属于该任务。'],
  'not-ancestor': ['The reported base is not an ancestor of the head commit.', '回传的基准不是 head 提交的祖先。'],
  'pr-mismatch': ['The pull request does not match this task branch and commit.', 'PR 与本任务分支及提交不匹配。'],
  'fork-unsupported': ['The first version only accepts results from the bound repository, not forks.', '首版只接受绑定仓库的成果，不接受 fork。'],
  'claim-unavailable': ['This task has not been dispatched to the current connection, or the round is not current.', '该任务尚未派发给当前连接，或不是当前轮次。'],
  'claim-rejected': ['Only a dispatched task can be claimed.', '只有已派发的任务可以认领。'],
  'claim-required': ['Report a claim before sending progress or a result for this round.', '本轮需要先认领，才能回报进度或成果。'],
  'data-dir-unset': ['Set PASEO_DOT_BRIDGE_DATA_DIR (or PASEO_HOME) so the plugin has a persistent data directory.', '请设置 PASEO_DOT_BRIDGE_DATA_DIR（或 PASEO_HOME），为插件指定持久数据目录。'],
  'pr-unverified': ['The pull request could not be verified against the bound repository.', '无法针对绑定仓库验证该 PR。'],
  'callback-verification-failed': ['The callback endpoint did not echo the verification challenge.', '回调端点没有正确回传验证随机值。'],
  'slots-full': ['Both in-flight slots are occupied, so the task stays queued.', '两个在途槽位已占用，任务保持排队。'],
  'cancel-rejected': ['Only a queued task can be canceled locally.', '只有排队中的任务可以在本地取消。'],
  'stop-rejected': ['A stop request is only available for a dispatched task.', '只有已派发的任务可以请求停止。'],
  'not-subscribed': ['The dot subscription is not active.', 'dot 订阅未生效。'],
  'callback-invalid': ['The callback URL must be HTTPS and resolve to an allowed network address.', '回调地址必须使用 HTTPS，且解析到允许的网络地址。'],
  'delivery-failed': ['Event delivery failed.', '事件投递失败。'],
  'git-failed': ['Reading the result from the bound remote failed.', '从绑定远端读取成果失败。'],
  'workspace-missing': ['The current workspace could not be resolved to a directory.', '无法把当前工作区解析为目录。'],
  'revision-conflict': ['Another client changed this task; reload before saving.', '其他客户端已修改该任务，请刷新后再保存。'],
  'duplicate-mismatch': ['This id was already used with different content.', '该 ID 已用于不同的内容。'],
  'operation-archived': ['This operation is too old to replay; start it again as a new action.', '该操作过旧，无法重放；请作为新操作重新发起。'],
  'checksum-mismatch': ['The stored signature did not match the payload.', '签名与请求正文不匹配。'],
  'payload-too-large': ['The request exceeds the transport size limit.', '请求正文超过传输大小限制。'],
  'readonly-rejected': ['A read-only tool cannot modify bridge state.', '只读工具不能修改桥接状态。'],
} as const;

export type DotBridgeErrorCode = keyof typeof messages;

export const dotBridgeErrorCodes = Object.keys(messages) as DotBridgeErrorCode[];

export function isDotBridgeErrorCode(value: string): value is DotBridgeErrorCode {
  return Object.prototype.hasOwnProperty.call(messages, value);
}

export function explain(code: string, detail?: string | null, locale?: UiLocale): string {
  const known = isDotBridgeErrorCode(code) ? messages[code] : null;
  const text = known
    ? locale === 'zh-CN' || (!locale && ui(false, true))
      ? known[1]
      : locale === 'en'
        ? known[0]
        : ui(known[0], known[1])
    : code;
  const extra = detail?.trim();
  return extra ? `${text} ${extra}` : text;
}

export interface DotBridgeFailure extends Error {
  code: DotBridgeErrorCode;
}

export function dotBridgeError(code: DotBridgeErrorCode, detail?: string): DotBridgeFailure {
  const error = new Error(detail ? `dot-bridge-error:${code}\n${detail}` : `dot-bridge-error:${code}`) as DotBridgeFailure;
  error.name = 'DotBridgeFailure';
  error.code = code;
  return error;
}

export function parseDotBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const matched = /^dot-bridge-error:([a-z0-9-]+)(?:\n([\s\S]*))?$/.exec(message);
  if (!matched) return message;
  return explain(matched[1], matched[2]);
}

/**
 * True when the server made an explicit decision (a conflict, a missing task, a rejected state
 * transition) rather than the request failing uncertainly in transport. A client holding a frozen
 * request for retry must release it on an explicit decision so the next retry uses a fresh id and
 * the latest revision; on an uncertain failure (a lost response) it keeps the frozen request so the
 * action is not applied twice.
 */
export function isExplicitRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^dot-bridge-error:[a-z0-9-]+/.test(message);
}
