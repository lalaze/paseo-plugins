import { z } from 'zod';

/** Host collaboration modes. `execute_review` skips design and requires a reviewer profile. */
export const collaborationModeSchema = z.enum(['full', 'execute_review']);
export type CollaborationMode = z.infer<typeof collaborationModeSchema>;

/**
 * Host isolation values. Todo already prepares a task worktree, so a launch uses `local`:
 * the current workspace, not a second collaboration worktree.
 */
export const collaborationIsolationSchema = z.enum(['local', 'worktree']);
export const TASK_COLLABORATION_ISOLATION = 'local' as const;

const profileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const instructionSchema = z.string().max(8000);

export const rolePromptsSchema = z.object({
  plan: instructionSchema.optional(),
  execute: instructionSchema.optional(),
  review: instructionSchema.optional(),
});
export type RolePrompts = z.infer<typeof rolePromptsSchema>;

/** Same examples the host shows before a role prompt has been saved. */
export const promptExamples: RolePrompts = {
  plan: 'Read the project documentation and existing implementation before creating an actionable plan. Prefer existing structures and describe the scope, interfaces, dependencies, and acceptance criteria. Split work according to the user\'s configured task categories. Create the plan only; do not modify source code.',
  execute: 'Read the relevant code and project conventions before editing, and prefer existing implementations. Make only the changes needed for the current task while preserving existing behavior and user work. Run relevant verification afterward, and report what changed, the actual results, and any remaining problems. Do not alter tests to hide failures; explain genuine blockers.',
  review: 'Check each acceptance criterion independently against the actual code, diff, and implementation reports, running tests or builds as needed. Focus on missing behavior, edge cases, regression risk, and verification evidence. For every issue, give the location, required change, and re-verification method. Review only; do not modify source code. Explain the evidence for approval and identify anything not verified instead of treating assumptions as passed.',
};

export const collaborationProfileSchema = z.object({
  id: profileIdSchema,
  label: z.string().min(1).max(120),
  provider: z.string().regex(/^[^/\s]+\/.+$/, '请选择供应商和模型'),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  transport: z.enum(['structured', 'mcp']).default('structured'),
  instructions: instructionSchema.optional(),
});
export type CollaborationProfile = z.infer<typeof collaborationProfileSchema>;

export const collaborationCommandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).max(80).default([]),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
});

/** Host collaboration settings, including roles, models, transport, prompts, and limits. */
export const collaborationSettingsSchema = z.object({
  profiles: z.array(collaborationProfileSchema).min(1).max(30),
  directorProfileId: profileIdSchema,
  workerProfileId: profileIdSchema,
  reviewerProfileId: profileIdSchema.optional(),
  rolePrompts: rolePromptsSchema.optional(),
  categoryOverrides: z.record(z.string(), profileIdSchema).default({}),
  taskOverrides: z.record(z.string(), profileIdSchema).default({}),
  allowDirectorSelection: z.boolean().default(false),
  maxReworks: z.number().int().min(0).max(10).default(2),
  maxAttempts: z.number().int().min(3).max(200).default(40),
  turnTimeoutMs: z.number().int().min(1000).max(7_200_000).default(1_800_000),
  runTimeoutMs: z.number().int().min(1000).max(86_400_000).default(14_400_000),
  requirePlanApproval: z.boolean().default(false),
  verificationCommands: z.array(collaborationCommandSchema).max(12).default([]),
}).superRefine((settings, ctx) => {
  const ids = new Set(settings.profiles.map(profile => profile.id));
  if (ids.size !== settings.profiles.length) ctx.addIssue({ code: 'custom', message: 'AI 配置 ID 不能重复' });
  for (const id of [
    settings.directorProfileId,
    settings.workerProfileId,
    ...(settings.reviewerProfileId ? [settings.reviewerProfileId] : []),
    ...Object.values(settings.categoryOverrides),
    ...Object.values(settings.taskOverrides),
  ]) {
    if (!ids.has(id)) ctx.addIssue({ code: 'custom', message: `不存在的 AI 配置：${id}` });
  }
});
export type CollaborationSettings = z.infer<typeof collaborationSettingsSchema>;

/** Saved on the task. `null` means collaboration is off. */
export const taskCollaborationSchema = z.object({
  mode: collaborationModeSchema,
  settings: collaborationSettingsSchema,
}).strict().superRefine((collaboration, ctx) => {
  if (collaboration.mode === 'execute_review' && !collaboration.settings.reviewerProfileId) {
    ctx.addIssue({ code: 'custom', message: '执行＋审核模式需要独立审核 Agent，请先在协作设置中指定审核 Agent' });
  }
});
export type TaskCollaboration = z.infer<typeof taskCollaborationSchema>;

export const collaborationCapabilitiesSchema = z.object({
  collaboration: z.boolean(),
  executeReview: z.boolean(),
  inlineModels: z.boolean(),
  worktree: z.boolean(),
}).strict();
export type CollaborationCapabilities = z.infer<typeof collaborationCapabilitiesSchema>;

export const EMPTY_CAPABILITIES: CollaborationCapabilities = {
  collaboration: false,
  executeReview: false,
  inlineModels: false,
  worktree: false,
};

export const collaborationCatalogSchema = z.object({
  capabilities: collaborationCapabilitiesSchema,
  settings: collaborationSettingsSchema.nullable(),
  rolePrompts: rolePromptsSchema,
  promptExamples: rolePromptsSchema,
  error: z.string().nullable(),
}).strict();
export type CollaborationCatalog = z.infer<typeof collaborationCatalogSchema>;

export function unavailableCatalog(error: string): CollaborationCatalog {
  return { capabilities: EMPTY_CAPABILITIES, settings: null, rolePrompts: {}, promptExamples, error };
}

export function capabilitiesFrom(features: Record<string, unknown> | null | undefined): CollaborationCapabilities {
  return {
    collaboration: features?.collaboration === true,
    executeReview: features?.collaborationExecuteReview === true,
    inlineModels: features?.collaborationInlineModels === true,
    worktree: features?.collaborationWorktree === true,
  };
}

const conversationSchema = z.object({
  id: z.string(),
  mode: collaborationModeSchema.optional(),
  isolation: collaborationIsolationSchema.optional(),
  settings: collaborationSettingsSchema.optional(),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  agentId: z.string().optional(),
  title: z.string(),
  error: z.string().optional(),
  confirmation: z.object({ kind: z.enum(['plan', 'final']), noticeId: z.string() }).optional(),
  run: z.object({
    id: z.string(),
    mode: collaborationModeSchema.optional(),
    phase: z.string(),
    control: z.string(),
    message: z.string(),
    done: z.number(),
    total: z.number(),
  }).optional(),
}).passthrough();

/** Public `collaboration.command.response` state. Reads do not include a write of host settings. */
export const collaborationStateSchema = z.object({
  settings: collaborationSettingsSchema.nullable(),
  rolePrompts: rolePromptsSchema.optional(),
  error: z.string().nullable(),
  conversations: z.array(conversationSchema),
});
export type CollaborationState = z.infer<typeof collaborationStateSchema>;

export const collaborationControlSchema = z.enum(['pause', 'resume', 'cancel', 'retry']);
export type CollaborationControlAction = z.infer<typeof collaborationControlSchema>;

/** Commands the adapter may send. Settings and prompt saves are intentionally absent. */
export const collaborationWireCommands = ['status', 'conversation.open', 'conversation.resync', 'run.control'] as const;
export type CollaborationWireCommand = (typeof collaborationWireCommands)[number];

/** Per-host new-task defaults. A missing key has never been saved; `null` is an explicit Off. */
export const COLLABORATION_DEFAULTS_KEY = 'paseo-todo.collaboration-defaults.v1';

export interface CollaborationDefaultStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RoleSelection {
  provider: string;
  model: string;
  /** Catalog permission mode. Null keeps the provider default. */
  modeId: string | null;
  providerLabel: string;
  modelLabel: string;
}

interface ProfileExtra {
  provider: string;
  transport: 'structured' | 'mcp';
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  instructions?: string;
}

interface PreservedCollaboration {
  categoryOverrides: Record<string, string>;
  taskOverrides: Record<string, string>;
  allowDirectorSelection: boolean;
  verificationCommands: CollaborationSettings['verificationCommands'];
  /** Profiles that are not the lead, worker, or reviewer, kept so overrides still resolve. */
  extraProfiles: CollaborationProfile[];
  profileExtras: Partial<Record<'director' | 'worker' | 'reviewer', ProfileExtra>>;
}

/**
 * Editable collaboration form. `enabled: false` is Off and stores `null`.
 * Role prompts, permission modes, and limits are the fields the form edits;
 * overrides, verification commands, and profile instructions ride along in `preserved`.
 */
export interface CollaborationDraft {
  enabled: boolean;
  mode: CollaborationMode;
  director: RoleSelection | null;
  worker: RoleSelection | null;
  reviewer: RoleSelection | null;
  prompts: { plan: string; execute: string; review: string };
  maxReworks: number;
  maxAttempts: number;
  turnTimeoutMs: number;
  runTimeoutMs: number;
  requirePlanApproval: boolean;
  ids: { director: string; worker: string; reviewer: string };
  preserved: PreservedCollaboration;
}

export type CollaborationDraftIssueCode =
  | 'loading'
  | 'unavailable'
  | 'inline-models'
  | 'execute-review'
  | 'foreign-provider'
  | 'director-required'
  | 'worker-required'
  | 'reviewer-required'
  | 'reviewer-incomplete'
  | 'prompt-too-long'
  | 'role-prompts'
  | 'command-incomplete'
  | 'invalid';

export interface CollaborationDraftIssue {
  code: CollaborationDraftIssueCode;
  detail: string | null;
}

export interface CollaborationStatusCopy {
  title: readonly [string, string];
  detail: readonly [string, string];
}

const ROLE_IDS = { director: 'director', worker: 'worker', reviewer: 'reviewer' } as const;

export function blankCollaborationDraft(): CollaborationDraft {
  return {
    enabled: false,
    mode: 'full',
    director: null,
    worker: null,
    reviewer: null,
    prompts: { plan: '', execute: '', review: '' },
    maxReworks: 2,
    maxAttempts: 40,
    turnTimeoutMs: 1_800_000,
    runTimeoutMs: 14_400_000,
    requirePlanApproval: false,
    ids: { ...ROLE_IDS },
    preserved: {
      categoryOverrides: {},
      taskOverrides: {},
      allowDirectorSelection: false,
      verificationCommands: [],
      extraProfiles: [],
      profileExtras: {},
    },
  };
}

function selectionFrom(profile: CollaborationProfile | undefined): RoleSelection | null {
  if (!profile) return null;
  const slash = profile.provider.indexOf('/');
  if (slash <= 0) return null;
  return {
    provider: profile.provider.slice(0, slash),
    model: profile.provider.slice(slash + 1),
    modeId: profile.modeId ?? null,
    providerLabel: profile.provider.slice(0, slash),
    modelLabel: profile.label,
  };
}

function extraFrom(profile: CollaborationProfile | undefined): ProfileExtra | null {
  if (!profile) return null;
  return {
    provider: profile.provider,
    transport: profile.transport,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues ? { featureValues: { ...profile.featureValues } } : {}),
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
  };
}

function copyProfile(profile: CollaborationProfile): CollaborationProfile {
  return {
    ...profile,
    ...(profile.featureValues ? { featureValues: { ...profile.featureValues } } : {}),
  };
}

function promptFields(prompts: RolePrompts | undefined): CollaborationDraft['prompts'] {
  return { plan: prompts?.plan ?? '', execute: prompts?.execute ?? '', review: prompts?.review ?? '' };
}

function mergePromptFields(primary: RolePrompts | undefined, fallback: RolePrompts | undefined): CollaborationDraft['prompts'] {
  return {
    plan: primary?.plan ?? fallback?.plan ?? '',
    execute: primary?.execute ?? fallback?.execute ?? '',
    review: primary?.review ?? fallback?.review ?? '',
  };
}

/** A saved task snapshot, including Off. Enabled is true only when a snapshot exists. */
export function draftFromCollaboration(value: TaskCollaboration | null): CollaborationDraft {
  if (!value) return blankCollaborationDraft();
  const { settings } = value;
  const directorIsWorker = settings.directorProfileId === settings.workerProfileId;
  const roleIds = new Set<string>([settings.workerProfileId]);
  if (!directorIsWorker) roleIds.add(settings.directorProfileId);
  if (settings.reviewerProfileId) roleIds.add(settings.reviewerProfileId);
  const byId = new Map(settings.profiles.map(profile => [profile.id, profile]));
  const directorProfile = directorIsWorker && value.mode === 'execute_review' ? undefined : byId.get(settings.directorProfileId);
  const workerProfile = byId.get(settings.workerProfileId);
  const reviewerProfile = settings.reviewerProfileId ? byId.get(settings.reviewerProfileId) : undefined;
  const profileExtras: PreservedCollaboration['profileExtras'] = {};
  const directorExtra = extraFrom(directorProfile);
  const workerExtra = extraFrom(workerProfile);
  const reviewerExtra = extraFrom(reviewerProfile);
  if (directorExtra) profileExtras.director = directorExtra;
  if (workerExtra) profileExtras.worker = workerExtra;
  if (reviewerExtra) profileExtras.reviewer = reviewerExtra;
  return {
    enabled: true,
    mode: value.mode,
    director: selectionFrom(directorProfile),
    worker: selectionFrom(workerProfile),
    reviewer: selectionFrom(reviewerProfile),
    prompts: promptFields(settings.rolePrompts),
    maxReworks: settings.maxReworks,
    maxAttempts: settings.maxAttempts,
    turnTimeoutMs: settings.turnTimeoutMs,
    runTimeoutMs: settings.runTimeoutMs,
    requirePlanApproval: settings.requirePlanApproval,
    ids: {
      director: directorIsWorker && value.mode === 'execute_review' ? ROLE_IDS.director : settings.directorProfileId,
      worker: settings.workerProfileId,
      reviewer: settings.reviewerProfileId ?? ROLE_IDS.reviewer,
    },
    preserved: {
      categoryOverrides: { ...settings.categoryOverrides },
      taskOverrides: { ...settings.taskOverrides },
      allowDirectorSelection: settings.allowDirectorSelection,
      verificationCommands: settings.verificationCommands.map(command => ({ ...command, args: [...command.args] })),
      extraProfiles: settings.profiles.filter(profile => !roleIds.has(profile.id)).map(copyProfile),
      profileExtras,
    },
  };
}

/**
 * New tasks and the settings form start here.
 * A saved snapshot wins over the host catalog. Off and "never saved" both stay off,
 * and the catalog only prefills the form so turning collaboration on does not invent a second host's models.
 */
export function inheritCollaborationDraft(
  saved: TaskCollaboration | null | undefined,
  catalog: { settings: CollaborationSettings | null; rolePrompts?: RolePrompts },
): CollaborationDraft {
  if (saved) return draftFromCollaboration(saved);
  if (!catalog.settings) return blankCollaborationDraft();
  const seeded = draftFromCollaboration({
    mode: 'full',
    settings: catalog.settings,
  });
  return { ...seeded, enabled: false, prompts: mergePromptFields(catalog.settings.rolePrompts, catalog.rolePrompts) };
}

function leadProfileReferenced(draft: CollaborationDraft): boolean {
  const id = draft.ids.director;
  return Object.values(draft.preserved.categoryOverrides).includes(id)
    || Object.values(draft.preserved.taskOverrides).includes(id);
}

function complete(selection: RoleSelection | null): selection is RoleSelection {
  return Boolean(selection && selection.provider.trim() && selection.model.trim());
}

function issue(code: CollaborationDraftIssueCode, detail: string | null = null): CollaborationDraftIssue {
  return { code, detail };
}

function buildProfile(id: string, selection: RoleSelection, extra: ProfileExtra | undefined): CollaborationProfile {
  const provider = `${selection.provider}/${selection.model}`;
  const same = extra?.provider === provider;
  const modeId = selection.modeId;
  return {
    id,
    label: selection.modelLabel.trim() || selection.model,
    provider,
    ...(modeId ? { modeId } : {}),
    ...(same && extra?.thinkingOptionId ? { thinkingOptionId: extra.thinkingOptionId } : {}),
    ...(same && extra?.featureValues ? { featureValues: { ...extra.featureValues } } : {}),
    transport: same ? extra.transport : 'mcp',
    ...(same && extra?.instructions ? { instructions: extra.instructions } : {}),
  };
}

function cleanPrompts(prompts: CollaborationDraft['prompts']): { prompts?: RolePrompts; error: CollaborationDraftIssue | null } {
  const next: RolePrompts = {};
  for (const key of ['plan', 'execute', 'review'] as const) {
    const value = prompts[key];
    if (!value.trim()) continue;
    if (value.length > 8000) return { error: issue('prompt-too-long') };
    next[key] = value;
  }
  return { prompts: Object.keys(next).length ? next : undefined, error: null };
}

function cleanCommands(commands: CollaborationSettings['verificationCommands']): { commands: CollaborationSettings['verificationCommands']; error: CollaborationDraftIssue | null } {
  const kept: CollaborationSettings['verificationCommands'] = [];
  for (const command of commands) {
    const label = command.label.trim();
    const executable = command.command.trim();
    if (!label && !executable && command.args.length === 0) continue;
    if (!label || !executable) return { commands: [], error: issue('command-incomplete') };
    kept.push({ ...command, label, command: executable, args: [...command.args] });
  }
  return { commands: kept, error: null };
}

/** `collaboration: null` is Off. An issue means the form must stay put and must not be stored. */
export function snapshotFromDraft(draft: CollaborationDraft): { collaboration: TaskCollaboration | null; error: CollaborationDraftIssue | null } {
  if (!draft.enabled) return { collaboration: null, error: null };
  if (draft.mode === 'full' && !complete(draft.director)) return { collaboration: null, error: issue('director-required') };
  if (!complete(draft.worker)) return { collaboration: null, error: issue('worker-required') };
  if (draft.mode === 'execute_review' && !complete(draft.reviewer)) return { collaboration: null, error: issue('reviewer-required') };
  if (draft.reviewer && !complete(draft.reviewer)) return { collaboration: null, error: issue('reviewer-incomplete') };
  const prompts = cleanPrompts(draft.prompts);
  if (prompts.error) return { collaboration: null, error: prompts.error };
  const commands = cleanCommands(draft.preserved.verificationCommands);
  if (commands.error) return { collaboration: null, error: commands.error };

  const profiles: CollaborationProfile[] = [];
  const worker = buildProfile(draft.ids.worker, draft.worker as RoleSelection, draft.preserved.profileExtras.worker);
  profiles.push(worker);
  const addRole = (profile: CollaborationProfile, role: 'director' | 'reviewer'): string => {
    const existing = profiles.find(item => item.id === profile.id);
    if (existing && JSON.stringify(stable(existing)) === JSON.stringify(stable(profile))) return existing.id;
    if (existing) {
      const reserved = new Set([...Object.values(draft.ids), ...[...profiles, ...draft.preserved.extraProfiles].map(item => item.id)]);
      let id: string = role;
      let suffix = 1;
      while (reserved.has(id)) id = `${role}-${suffix++}`;
      profile = { ...profile, id };
    }
    profiles.push(profile);
    return profile.id;
  };
  let directorProfileId = draft.ids.worker;
  // Execute + review has no lead row. A selection left over from the full flow must not open a separate conversation.
  if (draft.mode === 'full') {
    const director = buildProfile(
      draft.ids.director,
      draft.director as RoleSelection,
      draft.preserved.profileExtras.director,
    );
    directorProfileId = addRole(director, 'director');
  } else if (draft.director && leadProfileReferenced(draft)) {
    addRole(
      buildProfile(draft.ids.director, draft.director, draft.preserved.profileExtras.director),
      'director',
    );
  }
  let reviewerProfileId: string | undefined;
  if (draft.reviewer) {
    const reviewer = buildProfile(draft.ids.reviewer, draft.reviewer, draft.preserved.profileExtras.reviewer);
    reviewerProfileId = addRole(reviewer, 'reviewer');
  }
  const seen = new Set(profiles.map(profile => profile.id));
  for (const extra of draft.preserved.extraProfiles) {
    if (seen.has(extra.id)) continue;
    profiles.push(copyProfile(extra));
    seen.add(extra.id);
  }
  const parsed = taskCollaborationSchema.safeParse({
    mode: draft.mode,
    settings: {
      profiles,
      directorProfileId,
      workerProfileId: worker.id,
      ...(reviewerProfileId ? { reviewerProfileId } : {}),
      ...(prompts.prompts ? { rolePrompts: prompts.prompts } : {}),
      categoryOverrides: draft.preserved.categoryOverrides,
      taskOverrides: draft.preserved.taskOverrides,
      allowDirectorSelection: draft.preserved.allowDirectorSelection,
      maxReworks: draft.maxReworks,
      maxAttempts: draft.maxAttempts,
      turnTimeoutMs: draft.turnTimeoutMs,
      runTimeoutMs: draft.runTimeoutMs,
      requirePlanApproval: draft.requirePlanApproval,
      verificationCommands: commands.commands,
    },
  });
  if (!parsed.success) return { collaboration: null, error: issue('invalid', parsed.error.issues.map(item => item.message).join('; ')) };
  return { collaboration: parsed.data, error: null };
}

/** Capability failures block an enabled draft. Off stays valid so the user can still save a normal task. */
export function collaborationBlock(
  draft: Pick<CollaborationDraft, 'enabled' | 'mode'>,
  catalog: { capabilities: CollaborationCapabilities; error: string | null } | null,
): CollaborationDraftIssue | null {
  if (!draft.enabled) return null;
  if (!catalog) return issue('loading');
  if (!catalog.capabilities.collaboration) return issue('unavailable', catalog.error);
  if (!catalog.capabilities.inlineModels) return issue('inline-models', catalog.error);
  if (draft.mode === 'execute_review' && !catalog.capabilities.executeReview) return issue('execute-review', catalog.error);
  return null;
}

/** A host-reported error that does not, by itself, mean collaboration is missing. */
export function collaborationWarning(catalog: { capabilities: CollaborationCapabilities; error: string | null } | null): string | null {
  if (!catalog?.error || !catalog.capabilities.collaboration) return null;
  return catalog.error;
}

export function foreignProviderIds(draft: CollaborationDraft, providerIds: readonly string[]): string[] {
  const known = new Set(providerIds);
  const selected: RoleSelection[] = [];
  if (draft.mode === 'full' && draft.director) selected.push(draft.director);
  if (draft.worker) selected.push(draft.worker);
  if (draft.reviewer) selected.push(draft.reviewer);
  return [...new Set(selected.map(item => item.provider).filter(id => id && !known.has(id)))];
}

/** Current hosts replace inline role prompts with their global prompts. Never silently lose an explicit task prompt. */
export function rolePromptsCompatible(expected: RolePrompts | undefined, actual: RolePrompts | undefined): boolean {
  return (['plan', 'execute', 'review'] as const).every(role => {
    const text = expected?.[role]?.trim();
    return !text || text === actual?.[role]?.trim();
  });
}

/** First reason an enabled draft must not be stored or started. Null when Off or ready. */
export function collaborationDraftIssue(
  draft: CollaborationDraft,
  catalog: { capabilities: CollaborationCapabilities; error: string | null; rolePrompts?: RolePrompts } | null,
  providerIds: readonly string[] | null,
): CollaborationDraftIssue | null {
  if (!draft.enabled) return null;
  const blocked = collaborationBlock(draft, catalog);
  if (blocked) return blocked;
  if (providerIds) {
    const foreign = foreignProviderIds(draft, providerIds);
    if (foreign.length) return issue('foreign-provider', foreign.join(', '));
  }
  const snap = snapshotFromDraft(draft);
  if (snap.error) return snap.error;
  if (catalog?.rolePrompts && !rolePromptsCompatible(snap.collaboration?.settings.rolePrompts, catalog.rolePrompts)) return issue('role-prompts');
  return null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function sameCollaborationDraft(left: CollaborationDraft, right: CollaborationDraft): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function storedDefault(
  map: Readonly<Record<string, TaskCollaboration | null>>,
  hostId: string,
): TaskCollaboration | null | undefined {
  return Object.prototype.hasOwnProperty.call(map, hostId) ? map[hostId] : undefined;
}

export function readCollaborationDefaults(store: CollaborationDefaultStore | null): Record<string, TaskCollaboration | null> {
  if (!store) return {};
  try {
    const raw = store.getItem(COLLABORATION_DEFAULTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, TaskCollaboration | null> = {};
    for (const [hostId, value] of Object.entries(parsed)) {
      if (!hostId) continue;
      if (value === null) {
        result[hostId] = null;
        continue;
      }
      const collaboration = taskCollaborationSchema.safeParse(value);
      if (collaboration.success) result[hostId] = collaboration.data;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCollaborationDefault(
  store: CollaborationDefaultStore,
  hostId: string,
  value: TaskCollaboration | null,
): void {
  const current = readCollaborationDefaults(store);
  current[hostId] = value;
  store.setItem(COLLABORATION_DEFAULTS_KEY, JSON.stringify(current));
}

export function collaborationModeLabel(mode: CollaborationMode | 'off'): readonly [string, string] {
  if (mode === 'full') return ['Full flow', '完整流程'];
  if (mode === 'execute_review') return ['Execute + review', '执行＋审核'];
  return ['Off', '关闭'];
}

export const COLLABORATION_ROLE_LABELS: Record<'director' | 'worker' | 'reviewer', readonly [string, string]> = {
  director: ['Lead agent', '主 Agent'],
  worker: ['Worker', '执行 Agent'],
  reviewer: ['Reviewer', '审核 Agent'],
} as const;

/**
 * What the board can say from the fields the engine actually stores.
 * Design, execution, review, and plan approval stay in progress.
 * Session acceptance is separate from the todo merge.
 */
export function collaborationStatus(task: {
  collaboration: TaskCollaboration | null;
  collaborationPhase: string | null;
  collaborationControl: string | null;
  collaborationAcceptance: 'pending' | 'accepted' | null;
}): CollaborationStatusCopy | null {
  if (!task.collaboration) return null;
  const phase = task.collaborationPhase;
  const control = task.collaborationControl;
  if (task.collaborationAcceptance === 'pending' || phase === 'awaiting_acceptance') {
    return {
      title: ['Waiting in the session', '协作待会话验收'],
      detail: ['Open the session and accept the result there before merging this task. This page will not accept it for you.', '请先打开会话完成验收，再合并这个待办。这个页面不会代你验收。'],
    };
  }
  if (task.collaborationAcceptance === 'accepted' || phase === 'completed') {
    return {
      title: ['Accepted in the session', '会话已验收'],
      detail: ['The session acceptance is done. Merging still needs the binding shown here.', '会话里的验收已经完成。合并仍要核对这个页面上的成果绑定。'],
    };
  }
  if (control === 'waiting_permission') {
    return {
      title: ['Waiting for permission', '协作等待授权'],
      detail: ['A collaboration agent is waiting for a permission decision in the session.', '协作里的 Agent 正在会话中等待权限确认。'],
    };
  }
  if (control === 'needs_attention') {
    return {
      title: ['Collaboration needs you', '协作需要处理'],
      detail: ['Collaboration is blocked. It was not turned into a todo review.', '协作已受阻，没有进入待办验收。'],
    };
  }
  if (control === 'canceled') {
    return {
      title: ['Collaboration stopped', '协作已停止'],
      detail: ['The collaboration run is stopped. Retry uses this task\'s saved settings.', '协作已停止。重试会沿用这个任务已保存的设置。'],
    };
  }
  if (control === 'paused') {
    return {
      title: ['Collaboration paused', '协作已暂停'],
      detail: ['If this is waiting for plan approval, open the session and approve it there. This page will not approve it for you.', '如果这是在等批准方案，请打开会话批准。这个页面不会代你批准。'],
    };
  }
  const phases: Record<string, CollaborationStatusCopy> = {
    planning: {
      title: ['Designing', '设计中'],
      detail: ['The lead agent is designing. A finished turn does not finish this collaboration.', '主 Agent 正在设计。某一轮结束不会结束这次协作。'],
    },
    executing: {
      title: ['Executing', '执行中'],
      detail: ['A worker is executing. A finished turn does not finish this collaboration.', '执行 Agent 正在工作。某一轮结束不会结束这次协作。'],
    },
    reviewing: {
      title: ['Reviewing', '审核中'],
      detail: ['A reviewer is checking the work. A finished turn does not finish this collaboration.', '审核 Agent 正在检查。某一轮结束不会结束这次协作。'],
    },
    final_review: {
      title: ['Final review', '最终审核'],
      detail: ['Final review is still running. A finished turn does not finish this collaboration.', '最终审核仍在进行。某一轮结束不会结束这次协作。'],
    },
  };
  if (phase && phases[phase]) return phases[phase];
  if (phase || control) {
    return {
      title: ['Collaboration running', '协作进行中'],
      detail: ['A finished turn of the main agent does not finish this collaboration.', '主 Agent 某一轮结束不会结束这次协作。'],
    };
  }
  return null;
}

/** Card and queue Start must not drop an open edit of this task. */
export function collaborationEditBlocksStart(
  unsaved: { hostId: string; id: string } | null,
  task: { hostId: string; id: string },
): boolean {
  return Boolean(unsaved && unsaved.hostId === task.hostId && unsaved.id === task.id);
}
