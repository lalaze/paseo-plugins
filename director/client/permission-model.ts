import type { AgentMode, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { ui } from "./i18n";

type PermissionCatalog = Pick<ProviderSnapshotEntry, "modes" | "defaultModeId" | "status">;

function modeLabel(mode: AgentMode): string {
  const labels: Record<string, string> = {
    "default permissions": ui("Default permissions", "默认权限"),
    "auto-review": ui("Auto review", "自动审核"),
    "full access": ui("Full access", "完全访问"),
  };
  const translated = labels[mode.label.toLowerCase()];
  return translated ? ui(`${translated} (${mode.label})`, `${translated}（${mode.label}）`) : mode.label;
}

export function permissionChoices(entry?: PermissionCatalog, modeId?: string) {
  const defaultMode = entry?.modes?.find(mode => mode.id === entry.defaultModeId);
  const defaultLabel = defaultMode ? modeLabel(defaultMode) : entry?.defaultModeId;
  const options = [
    { id: "", label: defaultLabel ? ui(`Follow provider default: ${defaultLabel}`, `跟随供应商默认：${defaultLabel}`) : ui("Follow provider default", "跟随供应商默认") },
    ...(entry?.modes ?? []).map(mode => ({ id: mode.id, label: modeLabel(mode) })),
  ];
  const unavailable = !!modeId && entry?.status === "ready" && entry.modes !== undefined && !entry.modes.some(mode => mode.id === modeId);
  if (modeId && !options.some(mode => mode.id === modeId)) options.push({ id: modeId, label: ui(`${modeId} (saved${unavailable ? ", currently unavailable" : ""})`, `${modeId}（已保存${unavailable ? "，当前不可用" : ""}）`) });
  return { options, unavailable, description: entry?.modes?.find(mode => mode.id === (modeId || entry.defaultModeId))?.description };
}
