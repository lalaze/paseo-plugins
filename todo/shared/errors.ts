import { ui, type UiLocale } from './i18n';

const messages = {
  'store-invalid': ['The saved task file failed validation and was left untouched.', '任务存档校验失败，原文件未改动。'],
  'not-git': ['Choose a git repository.', '请选择一个 Git 仓库。'],
  'branch-missing': ['The target branch does not exist.', '目标分支不存在。'],
  'branch-invalid': ['The branch name cannot be used.', '分支名不可用。'],
  'provider-invalid': ['Choose a provider and model.', '请选择供应商和模型。'],
  'accept-rejected': ['Accept is only available while the task is awaiting review.', '只有待验收或合并失败且绑定仍在的任务可以验收。'],
  'agent-busy': ['The session is still running or waiting for permission, so this review cannot be merged.', '会话仍在执行或等待权限，不能合并这次验收。'],
  'cancel-rejected': ['This task cannot be canceled right now.', '当前不能取消这个任务。'],
  'start-rejected': ['Only a draft can be started.', '只有草稿可以开始。'],
  'retry-rejected': ['This task cannot be retried.', '当前不能重试这个任务。'],
  'continue-rejected': ['This task cannot take a follow-up.', '当前不能继续修改这个任务。'],
  'task-missing': ['The task no longer exists.', '任务不存在。'],
  'prepare-failed': ['Preparing the worktree or session failed.', '准备工作树或会话失败。'],
  'capture-failed': ['The finished turn could not be bound to a commit.', '这一轮结束后无法绑定到提交。'],
  'turn-failed': ['The agent turn failed.', 'Agent 轮次失败。'],
  'turn-canceled': ['The agent turn was canceled.', 'Agent 轮次已取消。'],
  'needs-check-no-operation': ['An in-progress task has no operation id. It was not sent again.', '执行中的任务没有 operation id，没有重新派发。'],
  'needs-check-no-agent': ['An operation id was saved but no session exists. It was not sent again.', '已有 operation id 但没有会话，没有重新派发。'],
  'needs-check-missing-session': ['The session is gone, so success cannot be proven. It was not sent again.', '会话已不在，无法证明成功，没有重新派发。'],
  'needs-check-no-outcome': ['The turn is idle without a recorded success outcome. It was not sent again.', '轮次已空闲，但没有成功 outcome，没有重新派发。'],
  'gateway-unavailable': ['Paseo could not be reached. Nothing was sent again.', '暂时连不上 Paseo，没有重新派发。'],
  'binding-stale': ['The review binding no longer matches the commit, tree, or target branch.', '验收绑定与成果提交、目录树或目标分支不一致。'],
  'merge-conflict': ['The merge conflicts. The task branch was kept and the target worktree was not modified.', '合并有冲突。任务分支已保留，目标工作树没有被修改。'],
  'merge-dirty': ['The target branch worktree is dirty, so the merge was refused.', '目标分支工作树不干净，已拒绝合并。'],
  'merge-verify': ['The ref update could not be verified. The plugin did not reset the worktree.', '引用更新后的校验没有通过，插件没有重置工作树。'],
  'interrupted-merge': ['The merge was interrupted and was not retried automatically.', '合并中断了，没有自动重试。'],
  'empty-prompt': ['Write a task before adding it.', '请先写下任务内容。'],
  'stale-client-review': ['This page is showing an older review binding. Refresh it before accepting.', '页面上的验收绑定已不是当前版本，请刷新后再验收。'],
  'store-locked': ['Another paseo-todo process is using this data directory, so this one will not dispatch tasks.', '另一个 paseo-todo 正在使用同一数据目录，本进程不会派发任务。'],
  'worktree-moved': ['The task directory is not on the task branch in the expected repository.', '任务目录已不在预期仓库的任务分支上。'],
} as const;

export type TodoErrorCode = keyof typeof messages;

export const todoErrorCodes = Object.keys(messages) as TodoErrorCode[];

export function isTodoErrorCode(value: string): value is TodoErrorCode {
  return Object.prototype.hasOwnProperty.call(messages, value);
}

export function explain(code: string, detail?: string | null, locale?: UiLocale): string {
  const known = isTodoErrorCode(code) ? messages[code] : null;
  const text = known ? (locale === 'zh-CN' || (!locale && ui(false, true)) ? known[1] : locale === 'en' ? known[0] : ui(known[0], known[1])) : code;
  const extra = detail?.trim();
  return extra ? `${text} ${extra}` : text;
}

export interface TodoFailure extends Error {
  code: TodoErrorCode;
}

export function todoError(code: TodoErrorCode, detail?: string): TodoFailure {
  const error = new Error(detail ? `todo-error:${code}\n${detail}` : `todo-error:${code}`) as TodoFailure;
  error.name = 'TodoFailure';
  error.code = code;
  return error;
}

export function parseTodoError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const matched = /^todo-error:([a-z0-9-]+)(?:\n([\s\S]*))?$/.exec(message);
  if (!matched) return message;
  return explain(matched[1], matched[2]);
}
