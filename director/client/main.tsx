import { useState } from "react";
import { View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { getSettingsRpc } from "../shared/rpc";
import { SettingsEditor } from "./settings";
import { ErrorText, Label } from "./ui";

export function DirectorSurface({ host, theme, layout, onConfigured }: PluginSurfaceProps & { onConfigured?: () => Promise<void> }) {
  const get = useRpc(getSettingsRpc);
  const settings = useQuery({ queryKey: ["director", host.id, "settings"], queryFn: () => get({}) });
  const [saved, setSaved] = useState(false);
  const [launchError, setLaunchError] = useState<unknown>();
  return <View style={{ flex: 1, padding: layout.compact ? 12 : 24, gap: 12 }}>
    {saved && <Label theme={theme}>协作设置已保存，用于之后新建的主对话。</Label>}
    <ErrorText theme={theme} error={launchError ?? settings.error ?? settings.data?.error} />
    <SettingsEditor hostId={host.id} initial={settings.data?.settings ?? null} cwd="" theme={theme} compact={layout.compact} onSaved={() => { setSaved(true); setLaunchError(undefined); void settings.refetch(); void onConfigured?.().catch(setLaunchError); }} />
  </View>;
}
