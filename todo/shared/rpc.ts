/** Client and server share these definitions, so a renamed field fails typecheck on both sides. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { collaborationCatalogSchema, taskCollaborationSchema } from './collaboration';
import { branchSchema, catalogSchema, diffSchema, reviewBindingSchema, taskSchema } from './schema';

const idInput = z.object({ id: z.string().uuid() }).strict();
const taskOutput = z.object({ task: taskSchema }).strict();

export const listTasks = defineRpc({
  name: 'list-tasks',
  input: z.object({ repository: z.string().min(1).optional() }).strict(),
  output: z.object({ tasks: z.array(taskSchema), loadError: z.string().nullable(), dataDir: z.string() }).strict(),
});

export const readHostIdentity = defineRpc({
  name: 'read-host-identity',
  input: z.object({}).strict(),
  output: z.object({ id: z.string().min(1).max(200).nullable(), label: z.string().min(1).max(200) }).strict(),
});

export const readTask = defineRpc({
  name: 'read-task',
  input: idInput,
  output: z.object({ task: taskSchema, diff: diffSchema }).strict(),
});

export const readCatalog = defineRpc({
  name: 'read-catalog',
  input: z.object({}).strict(),
  output: catalogSchema,
});

export const readBranches = defineRpc({
  name: 'read-branches',
  input: z.object({ repository: z.string().min(1) }).strict(),
  output: z.object({ branches: z.array(branchSchema), head: branchSchema.nullable() }).strict(),
});

export const createTask = defineRpc({
  name: 'create-task',
  input: z.object({
    title: z.string().min(1).max(200),
    prompt: z.string().min(1).max(20_000),
    repository: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    projectName: z.string().min(1).max(200).nullable(),
    targetBranch: branchSchema,
    provider: z.string().min(3).max(300),
    modeId: z.string().min(1).max(200).nullable(),
    collaboration: taskCollaborationSchema.nullable().optional(),
  }).strict(),
  output: taskOutput,
});

export const readCollaborationCatalog = defineRpc({
  name: 'read-collaboration-catalog',
  input: z.object({}).strict(),
  output: collaborationCatalogSchema,
});

export const updateTaskCollaboration = defineRpc({
  name: 'update-task-collaboration',
  input: z.object({ id: z.string().uuid(), collaboration: taskCollaborationSchema.nullable() }).strict(),
  output: taskOutput,
});

export const startQueue = defineRpc({
  name: 'start-queue',
  input: z.object({ repository: z.string().min(1).nullable() }).strict(),
  output: z.object({ tasks: z.array(taskSchema) }).strict(),
});

export const cleanupTask = defineRpc({ name: 'cleanup-task', input: idInput, output: taskOutput });
export const startTask = defineRpc({ name: 'start-task', input: idInput, output: taskOutput });
export const cancelTask = defineRpc({ name: 'cancel-task', input: idInput, output: taskOutput });
export const retryTask = defineRpc({ name: 'retry-task', input: idInput, output: taskOutput });
export const continueTask = defineRpc({
  name: 'continue-task',
  input: z.object({ id: z.string().uuid(), prompt: z.string().min(1).max(20_000) }).strict(),
  output: taskOutput,
});
export const acceptTask = defineRpc({
  name: 'accept-task',
  input: z.object({ id: z.string().uuid(), review: reviewBindingSchema }).strict(),
  output: taskOutput,
});
