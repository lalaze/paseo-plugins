import { CommandSchema, Id, ProfileSchema, SettingsSchema, type Command, type Profile, type RolePrompts } from "../shared/schema";
import { ui } from "./i18n";

export const taskCategories = [
  { id: "frontend", label: ui("Frontend", "前端") }, { id: "backend", label: ui("Backend", "后端") }, { id: "tests", label: ui("Tests", "测试") },
  { id: "docs", label: ui("Documentation", "文档") }, { id: "refactor", label: ui("Refactor", "重构") }, { id: "bugfix", label: ui("Bug fix", "问题修复") },
];

export function makeAssignment(kind: "category" | "task", key: string, profileId: string, profiles: Profile[]) {
  key = key.trim();
  if (kind === "category" && (!key || key.length > 80)) throw new Error(ui("Task category names must be 1–80 characters and exactly match the plan.", "任务类型名称需为 1 至 80 个字符，与总纲中的类型完全一致。"));
  if (kind === "task" && !Id.safeParse(key).success) throw new Error(ui("Task IDs must be 1–80 letters, digits, underscores, or hyphens and exactly match the plan.", "任务 ID 需为 1 至 80 个字母、数字、下划线或连字符，与总纲中的 ID 完全一致。"));
  if (!profiles.some(profile => profile.id === profileId && ProfileSchema.safeParse(profile).success)) throw new Error(ui("Choose a fully configured implementation AI first.", "请先选择一个配置完整的执行 AI。"));
  return { key, profileId };
}

export function savedRolePrompts(prompts: RolePrompts): RolePrompts | undefined {
  const entries = Object.entries(prompts).filter(([, value]) => value?.trim());
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const checkPresets: { id: string; title: string; description: string; command: Command }[] = [
  { id: "npm-test", title: ui("Run tests", "运行测试"), description: ui("npm project", "npm 项目"), command: { label: ui("Project tests", "项目测试"), command: "npm", args: ["test"], timeoutMs: 120000 } },
  { id: "npm-build", title: ui("Check build", "检查构建"), description: ui("npm project", "npm 项目"), command: { label: ui("Project build", "项目构建"), command: "npm", args: ["run", "build"], timeoutMs: 120000 } },
  { id: "pnpm-test", title: ui("Run tests", "运行测试"), description: ui("pnpm project", "pnpm 项目"), command: { label: ui("Project tests", "项目测试"), command: "pnpm", args: ["test"], timeoutMs: 120000 } },
  { id: "pnpm-build", title: ui("Check build", "检查构建"), description: ui("pnpm project", "pnpm 项目"), command: { label: ui("Project build", "项目构建"), command: "pnpm", args: ["run", "build"], timeoutMs: 120000 } },
  { id: "pytest", title: ui("Python tests", "Python 测试"), description: ui("pytest project", "pytest 项目"), command: { label: ui("Python tests", "Python 测试"), command: "python", args: ["-m", "pytest"], timeoutMs: 120000 } },
  { id: "go-test", title: ui("Go tests", "Go 测试"), description: ui("Go project", "Go 项目"), command: { label: ui("Go tests", "Go 测试"), command: "go", args: ["test", "./..."], timeoutMs: 120000 } },
];

// Commands still run as an executable + argv, never through a shell. Quotes
// make paths and arguments with spaces practical without enabling operators.
export function parseCommandLine(line: string): { command: string; args: string[] } {
  if (/[\n\r\0]/.test(line)) throw new Error(ui("Enter one command per item; add multiple checks separately.", "每项只填写一条命令；多条检查请分别添加。"));
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = ""; else word += char;
      continue;
    }
    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) throw new Error(ui("A character is required after the trailing backslash.", "命令末尾的反斜杠后缺少字符。"));
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) { word += char; continue; }
      word += next; i++; started = true; continue;
    }
    if (char === "$" || char === "`") throw new Error(ui("Enter literal argument values; variables and command substitutions are not expanded here.", "请填写实际参数值；这里不展开变量或执行命令替换。"));
    if (quote === '"') {
      if (char === '"') quote = ""; else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/[;&|<>]/.test(char)) throw new Error(ui("Add each check command separately; do not use &&, pipes, or redirection.", "请分别添加每条检查命令，不要使用 &&、管道或重定向。"));
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += char; started = true; }
  }
  if (quote) throw new Error(ui("A quote in the command is not closed.", "命令中的引号没有闭合，请补上另一边的引号。"));
  if (started) words.push(word);
  if (!words[0]?.trim()) throw new Error(ui("Enter a check command, such as npm test.", "请填写检查命令，例如 npm test。"));
  return { command: words[0], args: words.slice(1) };
}

export function commandLine(command: Pick<Command, "command" | "args">): string {
  return [command.command, ...command.args].map(value => /^[a-zA-Z0-9_./:@%=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`).join(" ");
}

export function sameCommand(a: Command, b: Command): boolean {
  return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);
}

export function makeCheck(line: string, label: string, minutes: string): Command {
  const parsed = parseCommandLine(line);
  const timeoutMs = Number(minutes) * 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error(ui("The check timeout must be between 1 second and 10 minutes.", "检查时限请填写 1 秒至 10 分钟之间的分钟数。"));
  const result = CommandSchema.safeParse({ ...parsed, label: label.trim() || line.trim(), timeoutMs });
  if (!result.success) throw new Error(ui("Check names are limited to 120 characters and commands to 80 arguments. Shorten them and try again.", "检查名称最多 120 个字符，命令最多 80 个参数。请缩短后重试。"));
  return result.data;
}

export function profileParts(profile?: Profile) {
  const slash = profile?.provider.indexOf("/") ?? -1;
  return { provider: slash < 0 ? "" : profile!.provider.slice(0, slash), model: slash < 0 ? "" : profile!.provider.slice(slash + 1) };
}

export function validateSettings(value: unknown) {
  const result = SettingsSchema.safeParse(value);
  if (result.success) return result.data;
  const names: Record<string, string> = {
    profiles: ui("The AI configuration is incomplete. Choose a provider and model, and check the profile name.", "AI 配置不完整，请选择供应商和模型，并检查配置名称。"),
    directorProfileId: ui("Choose the AI responsible for planning.", "请选择负责设计总纲的 AI。"), workerProfileId: ui("Choose the default implementation AI.", "请选择默认执行 AI。"), reviewerProfileId: ui("Choose a review AI or reuse the planning AI.", "请选择审核 AI，或沿用设计 AI 审核。"),
    verificationCommands: ui("Additional check commands are invalid or exceed the 12-item limit.", "额外检查命令格式不正确，或超过了 12 项上限。"),
    maxReworks: ui("Rework attempts must be an integer from 0 to 10.", "返工次数请填写 0 至 10 的整数。"), turnTimeoutMs: ui("The per-AI timeout must be between 1 second and 120 minutes.", "单次 AI 时限请填写 1 秒至 120 分钟之间的分钟数。"),
    maxAttempts: ui("The total AI call limit must be an integer from 3 to 200.", "AI 总调用上限请填写 3 至 200 的整数。"), runTimeoutMs: ui("The task timeout must be between 1 second and 24 hours.", "任务总时限请填写 1 秒至 24 小时之间的小时数。"),
  };
  throw new Error([...new Set(result.error.issues.map(issue => issue.path[0] === "rolePrompts" ? ui("Role instructions are limited to 8000 characters each.", "每个角色的前置提示词最多 8000 个字符。")
    : issue.path[0] === "profiles" && issue.path[2] === "instructions" ? ui("Additional AI instructions are limited to 8000 characters each.", "每个 AI 的补充提示词最多 8000 个字符。")
      : names[String(issue.path[0])] ?? issue.message))].join("\n"));
}
