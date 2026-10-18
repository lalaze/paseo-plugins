import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MagpieScreen } from "./client/main";
import { MagpieSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Magpie", Component: MagpieScreen });
  client.addSidebarHeaderItem({ id: "magpie", title: "Magpie", Component: MagpieSidebar });
  return () => {};
}
