import { z } from 'zod';
import { ATTACHMENT_PAGE_SIZE, attachmentSchema } from './attachments';
import { taskSchema, type Task } from './schema';
import { dotBridgeError } from './errors';

export const attachmentSummarySchema = z.object({
  total: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
}).strict();
export const attachmentPageSchema = attachmentSummarySchema.extend({
  attachments: z.array(attachmentSchema).max(ATTACHMENT_PAGE_SIZE),
  nextCursor: z.string().nullable(),
});
export type AttachmentPage = z.infer<typeof attachmentPageSchema>;

/** Logical file sizes, not physical disk usage (blobs may be deduplicated). */
export function attachmentSummary(task: Pick<Task, 'attachments'>) {
  return { total: task.attachments.length, totalBytes: task.attachments.reduce((sum, item) => sum + item.size, 0) };
}

/** Newest first. An attachment anchor survives appends/progress updates without gaps or duplicates. */
export function attachmentPage(task: Pick<Task, 'id' | 'attachments'>, cursor: string | null = null): AttachmentPage {
  let end = task.attachments.length;
  if (cursor !== null) {
    const [taskId, attachmentId, extra] = cursor.split(':');
    end = task.attachments.findIndex(item => item.id === attachmentId);
    if (taskId !== task.id || extra !== undefined || end < 0) throw dotBridgeError('task-rejected', 'Invalid attachment cursor; restart from the latest page');
  }
  const start = Math.max(0, end - ATTACHMENT_PAGE_SIZE);
  const attachments = task.attachments.slice(start, end).reverse();
  return { ...attachmentSummary(task), attachments,
    nextCursor: start > 0 ? `${task.id}:${task.attachments[start]!.id}` : null };
}

/** UI transport only. Never store this partial view or use it for provider/remote archive sync. */
export const taskPanelSchema = taskSchema.extend({ attachmentSummary: attachmentSummarySchema });
export function taskPanelView(task: Task): z.infer<typeof taskPanelSchema> {
  return { ...task, attachments: task.attachments.slice(-ATTACHMENT_PAGE_SIZE), attachmentSummary: attachmentSummary(task) };
}
