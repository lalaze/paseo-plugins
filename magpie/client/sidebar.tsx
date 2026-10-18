import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";

export function MagpieSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return (
    <SidebarRow
      icon="Bird"
      label="Magpie"
      active={currentScreen?.screenId === "main"}
      onPress={open}
    />
  );
}
