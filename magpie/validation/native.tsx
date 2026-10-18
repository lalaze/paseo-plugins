import { createElement } from "react";
export { ScrollView, TextInput } from "react-native-web";
export { Modal } from "./modal";
export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
const paths: Record<string, string> = {
  Bird: "M16 7h.01M3.4 18H2l4-4 4-9 5 2 6 1-4 3-1 5-4 5-5-1-3.6-2Z M7 16l6-5",
  Terminal: "m4 6 5 6-5 6m8 0h8",
  MessagesSquare: "M4 4h16v12H9l-5 4V4Z M8 8h8m-8 4h5",
  BookOpen: "M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v15",
  KeyRound: "M15 3a6 6 0 1 1-4 10l-7 7H1v-3l7-7a6 6 0 0 1 7-7Zm1 4h.01",
  GitBranch: "M6 3v12a4 4 0 0 0 8 0V6M6 7h.01M14 3h.01M6 20h.01",
  Server: "M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01",
  ChartNoAxesColumn: "M4 20V10m8 10V4m8 16v-7",
  Puzzle:
    "M9 3H3v6h3a3 3 0 1 1 0 6H3v6h6v-3a3 3 0 1 1 6 0v3h6v-6h-3a3 3 0 1 1 0-6h3V3h-6v3a3 3 0 1 1-6 0V3Z",
  Settings:
    "M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2M16 8l2-2M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
  RefreshCw: "M20 11a8 8 0 1 0-2 7M20 4v7h-7",
  Plus: "M12 4v16M4 12h16",
  Check: "m4 12 5 5L20 6",
  X: "m5 5 14 14M19 5 5 19",
  ChevronDown: "m6 9 6 6 6-6",
  ChevronRight: "m9 6 6 6-6 6",
  PanelLeft: "M3 4h18v16H3zM9 4v16",
  ScanLine: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18",
  SlidersHorizontal: "M3 6h7m4 0h7M3 18h13m4 0h1M10 3v6m6 6v6",
  LogIn: "M14 4h6v16h-6M3 12h12m-5-5 5 5-5 5",
  ChevronUp: "m6 15 6-6 6 6",
  ArrowLeft: "M20 12H4m6-6-6 6 6 6",
  ArrowUp: "M12 20V4m-6 6 6-6 6 6",
  Copy: "M8 8h13v13H8zM16 4V1H1v15h3",
  ToggleRight: "M8 5h8a7 7 0 0 1 0 14H8A7 7 0 0 1 8 5Zm8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  ToggleLeft: "M8 5h8a7 7 0 0 1 0 14H8A7 7 0 0 1 8 5Zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
};
export function Icon({
  name,
  size = 16,
  color = "currentColor",
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: 1.7,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    createElement("path", {
      d: paths[name] || "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v5m0 3h.01",
    }),
  );
}
