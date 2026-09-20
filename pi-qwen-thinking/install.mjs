import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { thinkingLevelMap } from "./index.js";

const { values } = parseArgs({ options: {
  "agent-dir": { type: "string", default: join(homedir(), ".pi", "agent") },
  "default-thinking": { type: "string" },
} });
if (values["default-thinking"] !== undefined && !Object.hasOwn(thinkingLevelMap, values["default-thinking"])) {
  throw new Error("Unsupported --default-thinking value");
}
const agentDir = values["agent-dir"];
const modelsPath = join(agentDir, "models.json");
const originalModels = await readFile(modelsPath, "utf8");
const models = JSON.parse(originalModels);
const targets = [];
for (const [provider, config] of Object.entries(models.providers || {})) {
  for (const model of config.models || []) {
    const compat = { ...config.compat, ...model.compat };
    if (model.id !== "qwen3.8-flash-next" || (model.api ?? config.api) !== "openai-completions"
      || compat.thinkingFormat !== "qwen-chat-template") continue;
    model.reasoning = true;
    model.thinkingLevelMap = { ...thinkingLevelMap };
    targets.push(`${provider}/${model.id}`);
  }
}
if (!targets.length) throw new Error("No matching Qwen model; no files changed");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(agentDir, "backups", `qwen-thinking-${stamp}`);
await mkdir(backup, { recursive: true, mode: 0o700 });
await writeFile(join(backup, "models.json"), originalModels, { mode: 0o600 });
const sourceDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(agentDir, "extensions", "qwen-thinking");
await mkdir(extensionDir, { recursive: true, mode: 0o700 });

async function replace(path, contents) {
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

for (const name of ["index.js", "package.json"]) {
  const dest = join(extensionDir, name);
  try { await copyFile(dest, join(backup, `extension-${name}`)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await replace(dest, await readFile(join(sourceDir, name)));
}
await replace(modelsPath, JSON.stringify(models, null, 2) + "\n");
if (values["default-thinking"] !== undefined) {
  const path = join(agentDir, "settings.json");
  const original = await readFile(path, "utf8");
  const settings = JSON.parse(original);
  await writeFile(join(backup, "settings.json"), original, { mode: 0o600 });
  settings.defaultThinkingLevel = values["default-thinking"];
  await replace(path, JSON.stringify(settings, null, 2) + "\n");
}
console.log(JSON.stringify({ targets, extensionDir, backup,
  defaultThinking: values["default-thinking"] ?? "unchanged", thinkingLevelMap }, null, 2));
