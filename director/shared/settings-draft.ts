import { z } from "zod";
import { CommandSchema, Id, ProfileSchema, SettingsSchema, type Settings } from "./schema";

// Drafts also retain incomplete fields which are not valid saved settings yet.
const DraftText = z.string().max(32000);
const DraftProfile = ProfileSchema.extend({ label: DraftText, provider: DraftText, instructions: DraftText.optional() });
export const SettingsFormSchema = z.object({
  step: z.number().int().min(0).max(2), profiles: z.array(DraftProfile).max(100),
  director: z.string(), worker: z.string(), reviewer: z.string(), separateReview: z.boolean(),
  rolePrompts: z.object({ plan: DraftText.optional(), execute: DraftText.optional(), review: DraftText.optional() }),
  overrides: z.record(z.string(), Id), taskOverrides: z.record(z.string(), Id),
  ruleKind: z.enum(["category", "task"]), ruleKey: DraftText, ruleProfile: z.string(), extraProfile: DraftProfile.nullable(),
  checks: z.array(CommandSchema).max(12), showCommand: z.boolean(), editingCheck: z.number().int().min(0).max(11).nullable(),
  checkLabel: DraftText, checkLine: DraftText, checkMinutes: DraftText,
  maxReworks: DraftText, turnMinutes: DraftText, maxAttempts: DraftText, runHours: DraftText,
  approval: z.boolean(), allowSelection: z.boolean(),
});
export type SettingsForm = z.infer<typeof SettingsFormSchema>;
export const SettingsDraftSchema = z.object({ version: z.literal(1), base: SettingsSchema.nullable(), form: SettingsFormSchema });
export type SettingsDraft = z.infer<typeof SettingsDraftSchema>;
export const DraftStateSchema = z.object({ revision: z.number().int().nonnegative(), draft: SettingsDraftSchema.nullable() });
export type DraftState = z.infer<typeof DraftStateSchema>;

export function settingsForm(initial: Settings | null): SettingsForm {
  return {
    step: 0, profiles: initial?.profiles ?? [], director: initial?.directorProfileId ?? "", worker: initial?.workerProfileId ?? "",
    reviewer: initial?.reviewerProfileId ?? "", separateReview: !!initial?.reviewerProfileId, rolePrompts: initial?.rolePrompts ?? {},
    overrides: initial?.categoryOverrides ?? {}, taskOverrides: initial?.taskOverrides ?? {},
    ruleKind: "category", ruleKey: "frontend", ruleProfile: "", extraProfile: null,
    checks: initial?.verificationCommands ?? [], showCommand: false, editingCheck: null, checkLabel: "", checkLine: "", checkMinutes: "2",
    maxReworks: String(initial?.maxReworks ?? 2), turnMinutes: String((initial?.turnTimeoutMs ?? 1800000) / 60000),
    maxAttempts: String(initial?.maxAttempts ?? 40), runHours: String((initial?.runTimeoutMs ?? 14400000) / 3600000),
    approval: initial?.requirePlanApproval ?? false, allowSelection: initial?.allowDirectorSelection ?? false,
  };
}

export function documentKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function formChanged(form: SettingsForm, initial: Settings | null): boolean {
  return documentKey({ ...form, step: 0 }) !== documentKey(settingsForm(initial));
}
