export type UiLocale = 'en' | 'zh-CN';

type Runtime = {
  __PASEO_LOCALE__?: unknown;
  document?: { documentElement?: { lang?: string } };
  localStorage?: { getItem(key: string): string | null };
  navigator?: { language?: string; languages?: readonly string[] };
};

const APP_SETTINGS_KEY = '@paseo:app-settings';

function paseoLanguage(runtime: Runtime): string | null {
  if (typeof runtime.__PASEO_LOCALE__ === 'string') return runtime.__PASEO_LOCALE__;
  try {
    const raw = runtime.localStorage?.getItem(APP_SETTINGS_KEY);
    if (!raw) return null;
    const settings = JSON.parse(raw) as { language?: unknown; state?: { language?: unknown } };
    const language = settings.language ?? settings.state?.language;
    return typeof language === 'string' && language !== 'system' ? language : null;
  } catch {
    return null;
  }
}

function supported(locale: string | null | undefined): UiLocale | null {
  if (!locale) return null;
  const normalized = locale.replaceAll('_', '-').toLowerCase();
  return normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh-hans') ? 'zh-CN' : 'en';
}

export function resolveUiLocale(runtime = globalThis as unknown as Runtime): UiLocale {
  const selected = paseoLanguage(runtime);
  if (selected) return supported(selected) ?? 'en';
  const candidates = [...(runtime.navigator?.languages ?? []), runtime.navigator?.language, runtime.document?.documentElement?.lang];
  for (const candidate of candidates) {
    const locale = supported(candidate);
    if (locale) return locale;
  }
  try { return supported(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'; }
  catch { return 'en'; }
}

export function ui<T>(en: T, zhCN: T): T {
  return resolveUiLocale() === 'zh-CN' ? zhCN : en;
}

const errorMessages: Record<string, string> = {
  '另一个 AI 协作实例正在使用此数据库': 'Another AI collaboration instance is using this database.',
  '另一窗口已更新设置草稿。请先重新读取草稿，再继续编辑。': 'Another window updated the settings draft. Reload the draft before continuing.',
  '已生效的设置在另一窗口有更新。请先重新读取设置，再应用你的修改。': 'Another window updated the active settings. Reload them before applying your changes.',
  '协作会话不存在': 'The collaboration conversation does not exist.',
  '任务不存在': 'The task does not exist.',
  '任务状态已变化，请刷新后重试': 'The task state changed. Refresh and try again.',
  '无法读取 Paseo 配置文件': 'The Paseo configuration file could not be read.',
  'AI 协作后台已关闭': 'The AI collaboration service has stopped.',
  '原工作区已不可用，请打开项目工作区后重新发起任务': 'The original workspace is unavailable. Open a project workspace and start the task again.',
  '工作区已不可用，无法保留名称': 'The workspace is unavailable, so its name could not be preserved.',
  '工作区目录已变化，请检查后重新发起任务': 'The workspace directory changed. Check it and start the task again.',
  '项目路径与当前工作区不一致，请使用当前目录或选择独立工作区': 'The project path does not match the current workspace. Use the current directory or choose an independent workspace.',
  '当前目录已有未结束的 AI 协作任务，请先完成或取消该任务': 'This directory already has an unfinished AI collaboration task. Complete or cancel it first.',
  '仓库路径必须是绝对路径': 'The repository path must be absolute.',
  '请在项目根目录的工作区启动，或选择独立工作区执行': 'Start from a workspace at the project root, or use an independent workspace.',
  '仓库存在未解决的合并冲突，请先解决冲突后再启动 AI 协作': 'The repository has unresolved merge conflicts. Resolve them before starting AI collaboration.',
  '独立工作区从当前提交创建，不包含未提交改动。要审核或修复当前改动，请选择「在当前工作区执行」或「使用已有工作区」': 'An independent workspace starts from the current commit and excludes uncommitted changes. To review or fix current changes, run in the current workspace or use an existing workspace.',
  '当前对话已不可用，无法原地接管': 'The current conversation is unavailable and cannot be taken over in place.',
  '当前对话不属于此工作区': 'The current conversation does not belong to this workspace.',
  '执行或审核子会话不能接管为主对话': 'An implementation or review sub-conversation cannot become the main conversation.',
  '请先在当前对话选择模型，再启用协作': 'Choose a model in the current conversation before enabling collaboration.',
  '当前对话已绑定另一协作会话': 'The current conversation is already linked to another collaboration.',
  '主 Agent 保存的权限模式不可用，请在设置中重新选择': 'The saved permission mode for the main agent is unavailable. Choose it again in settings.',
  '当前接入不支持原地接管': 'The current integration does not support taking over this conversation in place.',
  '当前对话无法接管': 'The current conversation cannot be taken over.',
  '原对话已不可用，无法原地接管': 'The original conversation is unavailable and cannot be taken over in place.',
  '尚未启动任务': 'The task has not started.',
  '确认请求已过期，请先读取当前方案或成果': 'The confirmation request expired. Read the current plan or result first.',
  '连接中断': 'Connection interrupted.',
};

function englishDirectorError(line: string): string {
  const prefix = line.startsWith('Error: ') ? 'Error: ' : '';
  const value = prefix ? line.slice(prefix.length) : line;
  if (errorMessages[value]) return prefix + errorMessages[value];
  const unavailable = /^指定的 AI 不可用：(.+)；请检查 Paseo 的供应商登录与模型配置$/.exec(value);
  if (unavailable) return `${prefix}Selected AI unavailable: ${unavailable[1]}. Check the provider sign-in and model configuration in Paseo.`;
  const mainUnavailable = /^主 Agent 不可用：(.+)；请检查模型及 MCP 接入$/.exec(value);
  if (mainUnavailable) return `${prefix}Main agent unavailable: ${mainUnavailable[1]}. Check the model and MCP connection.`;
  const permission = /^指定的执行权限不可用：(.+)（(.+)）；请检查供应商配置或重新选择权限后新建任务$/.exec(value);
  if (permission) return `${prefix}The selected permission mode ${permission[1]} is unavailable for ${permission[2]}. Check the provider or choose another mode before creating a new task.`;
  const branch = /^工作区已切换分支，请切回 (.+) 后重试$/.exec(value);
  if (branch) return `${prefix}The workspace switched branches. Switch back to ${branch[1]} and try again.`;
  return /[\u3400-\u9fff]/u.test(value)
    ? `${prefix}The operation could not be completed. Check the current Paseo conversation and try again.`
    : line;
}

export function localizeDirectorMessage(message: string): string {
  if (resolveUiLocale() === 'zh-CN') return message;
  return message.split('\n').map(englishDirectorError).join('\n');
}
