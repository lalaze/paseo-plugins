import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { usePaseo } from "@getpaseo/plugin/client";
import type { Profile } from "../shared/schema";
import { profileParts } from "./settings-model";
import { Choice, Field, Label, outline, type Theme } from "./ui";
import { InstructionsEditor } from "./instructions-editor";
import { permissionChoices } from "./permission-model";
import { ui } from "./i18n";

export type Catalog = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["waitForReady"]>>;

export function Disclosure({ title, summary, children, theme, defaultOpen = false }: { title: string; summary: string; children: ReactNode; theme: Theme; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <View style={{ borderTopWidth: 1, borderColor: outline(theme, "panel"), paddingTop: 12, gap: 12 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", gap: 12, alignItems: "center", minHeight: 44 }}>
      <View style={{ flex: 1, gap: 3 }}><Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{title}</Text><Label theme={theme} muted>{summary}</Label></View>
      <Label theme={theme} muted>{open ? ui("Collapse ▴", "收起 ▴") : ui("Expand ▾", "展开 ▾")}</Label>
    </Pressable>
    {open && children}
  </View>;
}

export function SelectionCard({ title, description, detail, selected, onPress, theme, disabled = false, role = "checkbox" }: { title: string; description: string; detail?: string; selected: boolean; onPress: () => void; theme: Theme; disabled?: boolean; role?: "checkbox" | "radio" }) {
  return <Pressable accessibilityRole={role} accessibilityLabel={detail ? `${title} · ${detail}` : title} accessibilityState={{ checked: selected, disabled }} aria-checked={selected} aria-disabled={disabled} disabled={disabled} onPress={onPress} style={{ borderWidth: 2, borderColor: selected ? theme.colors.accent : outline(theme), backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface0, borderRadius: 10, padding: 13, gap: 5, minHeight: 72, opacity: disabled ? 0.5 : 1 }}>
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
      <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 17 }}>{selected ? "✓" : "○"}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{title}</Text>
    </View>
    <Label theme={theme} muted>{description}</Label>
    {detail && <Label theme={theme}>{detail}</Label>}
  </Pressable>;
}

export function ProfileEditor({ profile, catalog, onChange, theme, mainChat = false }: { mainChat?: boolean; profile?: Profile; catalog?: Catalog; onChange: (patch: Partial<Profile>) => void; theme: Theme }) {
  const parts = profileParts(profile);
  const entry = catalog?.entries.find(e => e.provider === parts.provider);
  const model = entry?.models?.find(m => m.id === parts.model);
  const providerOptions = (catalog?.entries ?? []).filter(e => e.status === "ready").map(e => ({ id: e.provider, label: e.provider }));
  const modelOptions = (entry?.models ?? []).map(m => ({ id: m.id, label: m.label ?? m.id }));
  // Preserve a saved selection even while provider discovery is loading or unavailable.
  if (parts.provider && !providerOptions.some(p => p.id === parts.provider)) providerOptions.unshift({ id: parts.provider, label: ui(`${parts.provider} (saved, currently unavailable)`, `${parts.provider}（已保存，当前未就绪）`) });
  if (parts.model && !modelOptions.some(m => m.id === parts.model)) modelOptions.unshift({ id: parts.model, label: ui(`${parts.model} (saved)`, `${parts.model}（已保存）`) });
  const permissions = permissionChoices(entry, profile?.modeId);
  const thinking = [{ id: "", label: ui("Use model default", "使用模型默认强度") }, ...(model?.thinkingOptions ?? []).map(o => ({ id: o.id, label: o.label }))];
  if (profile?.thinkingOptionId && !thinking.some(m => m.id === profile.thinkingOptionId)) thinking.push({ id: profile.thinkingOptionId, label: ui(`${profile.thinkingOptionId} (saved)`, `${profile.thinkingOptionId}（已保存）`) });
  return <View style={{ gap: 14 }}>
    <Choice theme={theme} label={ui("AI provider / tool", "AI 供应商 / 工具")} value={parts.provider} options={providerOptions} onChange={id => onChange({ provider: `${id}/`, modeId: undefined, thinkingOptionId: undefined })} />
    <Choice theme={theme} label={ui("Model", "使用模型")} value={parts.model} options={modelOptions} onChange={id => onChange({ provider: `${parts.provider}/${id}`, thinkingOptionId: undefined })} />
    {!parts.provider && <Label theme={theme} muted>{ui("Choose a provider to see its available models.", "先选供应商，下面会显示它可用的模型。")}</Label>}
    <Choice theme={theme} label={ui("Permissions", "执行权限")} disabled={!parts.provider} value={profile?.modeId ?? ""} options={permissions.options} onChange={id => onChange({ modeId: id || undefined })} />
    <Label theme={theme} muted>{permissions.unavailable ? ui("The saved permission mode is unavailable. Choose another; it will not be replaced automatically.", "已保存的权限模式当前不可用，请重新选择；不会自动替换成其他权限。") : ui("Applies to new collaboration sessions for this AI and does not inherit this chat's permissions. Following the default reads the provider default when the session is created; an explicit choice remains fixed.", "用于这个 AI 新建的协作会话，不继承当前聊天的权限。跟随默认会在创建会话时读取供应商默认模式；明确选择后固定使用该模式。")}</Label>
    {!!permissions.description && <Label theme={theme} muted>{permissions.description}</Label>}
    <Disclosure theme={theme} title={ui("Advanced model settings", "模型高级设置")} summary={ui(`${profile?.transport === "mcp" ? "MCP tool handoff" : "compatible handoff"} · adjust reasoning and extra instructions`, `${profile?.transport === "mcp" ? "MCP 工具交接" : "默认兼容交接"} · 推理强度和补充提示词可单独调整`)}>
      <Field theme={theme} label={ui("AI name", "AI 昵称")} value={profile?.label ?? ""} onChange={label => onChange({ label })} placeholder={ui("Example: Frontend implementer", "例如：前端执行者")} />
      <InstructionsEditor theme={theme} label={ui("Additional instructions for this AI", "这个 AI 的补充提示词")} description={ui("Used together with the current role instructions for every task assigned to this AI. ", "与当前角色的前置提示词一起使用，适用于所有分配给这个 AI 的任务。") } value={profile?.instructions ?? ""} onChange={instructions => onChange({ instructions: instructions || undefined })} />
      <Choice theme={theme} label={ui("Reasoning effort", "推理强度")} value={profile?.thinkingOptionId ?? ""} options={thinking} onChange={id => onChange({ thinkingOptionId: id || undefined })} />
      {mainChat ? <Label theme={theme} muted>{ui("The main conversation manages tasks through MCP tools; implementation and review roles can use their own handoff modes.", "主对话通过 MCP 工具管理任务；执行与审核角色仍可单独选择交接方式。")}</Label> : <Choice theme={theme} label={ui("Task handoff mode", "AI 如何交接任务")} value={profile?.transport ?? "structured"} options={[{ id: "structured", label: ui("Compatible mode (default)", "兼容模式（默认）") }, { id: "mcp", label: ui("MCP tool mode", "MCP 工具模式") }]} onChange={id => onChange({ transport: id as Profile["transport"] })} />}
      <Label theme={theme} muted>{ui("MCP mode requires the selected AI to support HTTP MCP. Keep compatible mode if unsure.", "MCP 模式需要所选 AI 支持 HTTP MCP；不确定时保留兼容模式即可。")}</Label>
    </Disclosure>
  </View>;
}
