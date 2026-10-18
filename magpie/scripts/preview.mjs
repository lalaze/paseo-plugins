import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["validation/preview.tsx"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', global: "globalThis", __DEV__: "true" },
  alias: {
    "react-native": "react-native-web",
    "@getpaseo/plugin/client/react-native": resolve(root, "validation/native.tsx"),
    "@getpaseo/plugin/client/ui": resolve(root, "validation/ui.tsx"),
    "@getpaseo/plugin/client": resolve(root, "validation/host.tsx"),
  },
});
const js = result.outputFiles[0].contents;
const html =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Magpie 插件 · 原生界面预览</title><style>html,body,#root{margin:0;width:100%;height:100%;background:#111315}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#root{display:flex;padding-top:28px}#demo{position:fixed;top:0;left:0;right:0;height:28px;background:#262119;color:#c4af8c;display:flex;align-items:center;justify-content:center;font-size:11px;z-index:100}input,textarea{font-family:inherit}::-webkit-scrollbar{width:7px;height:5px}::-webkit-scrollbar-thumb{background:#353a42;border-radius:4px}</style></head><body><div id="demo">原生界面交互预览 · 使用示例数据，不会修改真实 Magpie</div><div id="root"></div><script src="/app.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const pathname = new URL(req.url, "http://preview").pathname;
  if (pathname === "/app.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(js);
  } else if (pathname === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } else {
    res.writeHead(404).end();
  }
});
server.listen(Number(process.env.PORT || 8225), "0.0.0.0", () =>
  console.log(`Magpie UI preview: http://100.96.195.115:${server.address().port}`),
);
