import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { MagpieScreen } from "../client/main";
import { demoColors } from "./fixtures";

const client = new QueryClient();
function Preview() {
  const [compact, setCompact] = useState(window.innerWidth < 700);
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < 700);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const props = {
    host: { id: "demo", label: "Mac mini" },
    theme: {
      colors: {
        ...demoColors,
        surface0:
          new URLSearchParams(window.location.search).get("theme") === "light"
            ? "#f4f4f6"
            : demoColors.surface0,
      },
    },
    layout: { compact },
  } as PluginScreenProps;
  return (
    <QueryClientProvider client={client}>
      <MagpieScreen {...props} />
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
