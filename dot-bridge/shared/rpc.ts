/** Client and server share these definitions, so a renamed field fails typecheck on both sides. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { attachmentContentSchema, attachmentSchema } from './attachments';
import { connectionSchema, resultSchema, taskSchema, uuidSchema, verificationSchema } from './schema';

const operationIdSchema = z.string().uuid();
const revisionSchema = z.number().int().nonnegative();

export const connectionFactsSchema = z
  .object({
    /** The plugin's own MCP HTTP server is bound. */
    localBridge: z.boolean(),
    /** An events/subscribe call is stored and unexpired. */
    subscribed: z.boolean(),
    /** A connection-test event was delivered to the callback with HTTP 2xx. */
    callbackVerified: z.boolean(),
    /** The dot called confirm_dot_connection with the live challenge. */
    dotVerified: z.boolean(),
    /** An active, callback-verified paseo.dot.task_changed route exists for this connection. */
    taskRoute: z.boolean(),
    /** Every precondition for dispatching work is met (bridge + task route + dot confirmation). */
    ready: z.boolean(),
    lastCallbackAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const connectionStatus = defineRpc({
  name: 'connection-status',
  input: z.object({}).strict(),
  output: z
    .object({
      connection: connectionSchema.nullable(),
      facts: connectionFactsSchema,
      bridge: z
        .object({
          listening: z.boolean(),
          host: z.string(),
          port: z.number().int().nonnegative(),
          endpoint: z.string(),
          error: z.string().nullable(),
        })
        .strict(),
      instructions: z.string(),
    })
    .strict(),
});

export const connectionConfigure = defineRpc({
  name: 'connection-configure',
  input: z
    .object({
      operationId: operationIdSchema,
      revision: revisionSchema,
      name: z.string().min(1).max(200),
      publicBaseUrl: z.string().max(2000),
    })
    .strict(),
  output: z.object({ connection: connectionSchema }).strict(),
});

export const connectionTest = defineRpc({
  name: 'connection-test',
  input: z.object({ operationId: operationIdSchema }).strict(),
  output: z.object({ challenge: z.string(), expiresAt: z.number().int().nonnegative(), delivered: z.boolean() }).strict(),
});

/** Reveals the MCP bearer token so the user can paste it into the ChatGPT plugin. Never stored in settings. */
export const connectionTokenReveal = defineRpc({
  name: 'connection-token-reveal',
  input: z.object({}).strict(),
  output: z.object({ token: z.string(), configured: z.boolean() }).strict(),
});

export const taskCreate = defineRpc({
  name: 'task-create',
  input: z
    .object({
      operationId: operationIdSchema,
      workspaceId: z.string().min(1).max(200),
      title: z.string().min(1).max(200),
      requirement: z.string().min(1).max(20_000),
      acceptance: z.string().max(20_000).default(''),
      mode: z.literal('text').default('text'),
    })
    .strict(),
  output: z.object({ task: taskSchema }).strict(),
});

export const taskList = defineRpc({
  name: 'task-list',
  input: z.object({ workspaceId: z.string().min(1).max(200).nullable().default(null) }).strict(),
  output: z.object({ tasks: z.array(taskSchema), dataDir: z.string(), loadError: z.string().nullable() }).strict(),
});

export const taskGet = defineRpc({
  name: 'task-get',
  input: z.object({ id: uuidSchema }).strict(),
  output: z.object({ task: taskSchema }).strict(),
});

/**
 * Pages a task's complete result history (every round's latest result plus its per-round history),
 * so a long history is queryable without loading the whole task. Results are never truncated.
 */
export const taskHistory = defineRpc({
  name: 'task-history',
  input: z.object({ id: uuidSchema, cursor: z.string().max(100).nullable().default(null) }).strict(),
  output: z
    .object({
      records: z.array(
        z.object({ roundId: uuidSchema, result: resultSchema, verification: verificationSchema, current: z.boolean() }).strict(),
      ),
      cursor: z.string().nullable(),
    })
    .strict(),
});

export const taskMessageAdd = defineRpc({
  name: 'task-message-add',
  input: z
    .object({ operationId: operationIdSchema, id: uuidSchema, revision: revisionSchema, body: z.string().min(1).max(20_000), kind: z.enum(['requirement', 'answer']) })
    .strict(),
  output: z.object({ task: taskSchema }).strict(),
});

export const taskCancelRequest = defineRpc({
  name: 'task-cancel-request',
  input: z.object({ operationId: operationIdSchema, id: uuidSchema, revision: revisionSchema }).strict(),
  output: z.object({ task: taskSchema }).strict(),
});

export const taskRoundCreate = defineRpc({
  name: 'task-round-create',
  input: z.object({ operationId: operationIdSchema, id: uuidSchema, revision: revisionSchema }).strict(),
  output: z.object({ task: taskSchema }).strict(),
});

/**
 * Re-queues the current round in place after a failed, stopped or unverified delivery, keeping the
 * same taskId, branch and fixed base. The explicit recovery path; it never creates a replacement task.
 */
export const taskRoundRetry = defineRpc({
  name: 'task-round-retry',
  input: z.object({ operationId: operationIdSchema, id: uuidSchema, revision: revisionSchema }).strict(),
  output: z.object({ task: taskSchema }).strict(),
});

export const taskAttachmentUpload = defineRpc({
  name: 'task-attachment-upload',
  input: attachmentContentSchema.extend({ operationId: operationIdSchema, id: uuidSchema, roundId: uuidSchema, revision: revisionSchema }),
  output: z.object({ attachment: attachmentSchema }).strict(),
});
export const taskAttachmentRead = defineRpc({
  name: 'task-attachment-read',
  input: z.object({ id: uuidSchema, attachmentId: uuidSchema }).strict(),
  output: z.object({ attachment: attachmentSchema, encoding: z.enum(['utf8', 'base64']), content: z.string() }).strict(),
});
