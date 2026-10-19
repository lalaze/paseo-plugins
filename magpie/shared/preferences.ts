export type PreferenceKind =
  | "boolean"
  | "number"
  | "text"
  | "multiline"
  | "lines"
  | "json"
  | "choice"
  | "secret"
  | "model";
export type PreferenceField = {
  key: string;
  label: string;
  kind: PreferenceKind;
  choices?: readonly (readonly [string, string])[];
  operation?: string;
  argument?: string;
  hint?: string;
};
export type PreferenceSection = { id: string; label: string; fields: PreferenceField[] };
const toggle = (
  key: string,
  label: string,
  operation?: string,
  argument = "on",
): PreferenceField => ({ key, label, kind: "boolean", operation, argument });
const text = (
  key: string,
  label: string,
  kind: PreferenceKind = "text",
  operation?: string,
  argument?: string,
): PreferenceField => ({ key, label, kind, operation, argument });
const choice = (
  key: string,
  label: string,
  choices: readonly (readonly [string, string])[],
  operation?: string,
  argument?: string,
): PreferenceField => ({ key, label, kind: "choice", choices, operation, argument });
const model = (key: string, label: string, operation?: string): PreferenceField =>
  text(key, label, "model", operation, "model");
const warm = [
  ["", "关闭"],
  ["week", "周窗口重置后"],
  ["all", "周与五小时窗口重置后"],
] as const;
export const preferenceSections: PreferenceSection[] = [
  {
    id: "general",
    label: "通用",
    fields: [
      toggle("colorblind", "色觉辅助配色"),
      text("uiFont", "界面字体", "json"),
      text("codeFont", "代码字体", "json"),
      choice(
        "gatewayMode",
        "网关模式",
        [
          ["", "自动"],
          ["on", "开启"],
          ["off", "关闭"],
        ],
        "settings.gateway-mode",
        "mode",
      ),
      choice("tray", "点击菜单栏图标", [
        ["panel", "打开面板"],
        ["window", "打开窗口"],
      ]),
      toggle("dock", "在 Dock 显示"),
      toggle("dockWindow", "有窗口时在 Dock 显示"),
      toggle("lightweight", "轻量模式"),
      toggle("login", "登录时启动", "settings.login"),
      toggle("keepAwake", "防止主机休眠"),
      toggle("keepAwakeDisplay", "同时保持屏幕开启"),
      toggle("noWSLAgents", "关闭 WSL Agent 检测"),
      text("sessionTerminal", "会话终端"),
      choice(
        "plainNamesMode",
        "模型名称中的供应商",
        [
          ["off", "始终显示"],
          ["own", "保留自定义名称"],
          ["on", "隐藏"],
        ],
        "settings.plain-names",
        "mode",
      ),
      toggle("codexAgentsV1", "Codex 子 Agent 使用其他模型", "settings.codex-agents-v1"),
      toggle("fullContext", "使用完整上下文窗口", "settings.full-context"),
      text("compactAt", "上下文压缩阈值（Token）", "number", "settings.full-context", "at"),
      toggle("codexAsyncCompact", "Codex 后台压缩", "settings.codex-async-compact"),
      text(
        "codexAsyncCompactPercent",
        "后台压缩阈值（%）",
        "number",
        "settings.codex-async-compact",
        "percent",
      ),
      model("codexTitles", "Codex 会话标题模型", "settings.codex-titles"),
      model("codexDescriptions", "Codex 会话描述模型", "settings.codex-descriptions"),
      model("codexPredictions", "Codex 输入预测模型", "settings.codex-predictions"),
      model("codexAutoReview", "Codex 自动审批模型", "settings.codex-auto-review"),
    ],
  },
  {
    id: "usage",
    label: "额度",
    fields: [
      text("trayUsages", "菜单栏显示的额度", "lines"),
      text("trayUsageEvery", "菜单栏刷新间隔（分钟）", "number"),
      toggle("trayNoLogos", "隐藏订阅图标"),
      toggle("trayNoBird", "隐藏 Magpie 图标"),
      toggle("trayPace", "显示额度使用进度偏差"),
      toggle("trayNoCost", "隐藏菜单栏费用"),
      toggle("quotaLeft", "额度显示剩余量", "settings.quota-left"),
      choice(
        "quotaReads",
        "额度读取时机",
        [
          ["", "自动"],
          ["asked", "仅在请求时"],
        ],
        "settings.quota-reads",
        "reads",
      ),
      toggle("chineseUnits", "使用中文数字单位"),
      text("usageAlert", "额度使用提醒（%）", "number"),
      text("balanceAlert", "低余额提醒", "number"),
      text("resetReminder", "重置前提醒（分钟）", "number"),
      text("turnDoneAlert", "任务完成提醒（秒）", "number"),
      choice("codexWarmup", "Codex 重置后预热", warm),
      choice("claudeWarmup", "Claude 重置后预热", warm),
      text("codexWarmAts", "Codex 每日预热时间（一行一个）", "lines"),
      text("claudeWarmAts", "Claude 每日预热时间（一行一个）", "lines"),
      toggle("workbuddyCheckin", "WorkBuddy 每日签到"),
      toggle("traeCheckin", "Trae 每日签到"),
      toggle("minimaxCheckin", "MiniMax 每日签到"),
      toggle("qoderCheckin", "Qoder 每日签到"),
    ],
  },
  {
    id: "network",
    label: "网络与共享",
    fields: [
      text("port", "网关端口", "number", "settings.port", "port"),
      toggle("bareModelIDs", "同时提供不带供应商的模型 ID", "settings.bare-ids"),
      text("corsOrigins", "允许的网页来源（一行一个）", "lines", "settings.cors", "origins"),
      text("allowIPs", "允许访问的 IP / CIDR（一行一个）", "lines", "settings.allowips", "ips"),
    ],
  },
  {
    id: "models",
    label: "模型",
    fields: [
      model("vision", "图片识别模型"),
      text("visionEffort", "图片识别思考级别"),
      model("imageGen", "图片生成模型"),
      model("searcher", "联网搜索模型"),
      text("searcherEffort", "搜索模型思考级别"),
      text("searchFirst", "搜索来源优先级"),
      toggle("memberModel", "在回答中显示实际成员模型"),
      toggle("noLoopGuard", "关闭重复工具调用保护"),
      toggle("claudeLeanPrompt", "Claude 精简提示词"),
      choice("refusalRetries", "被拒绝后重试次数", [
        ["null", "尝试所有剩余账户"],
        ["0", "不重试"],
        ["1", "1"],
        ["2", "2"],
        ["3", "3"],
      ]),
      text(
        "disabledModels",
        "停用的模型（一行一个）",
        "lines",
        "settings.disabled-models",
        "models",
      ),
    ],
  },
  {
    id: "privacy",
    label: "隐私",
    fields: [
      toggle("noAccountDiscovery", "不读取 Agent 的订阅登录", "settings.account-discovery", "off"),
      toggle("redact", "隐藏请求中的密钥"),
      toggle("redactPersonal", "隐藏个人信息"),
      text("redactKinds", "个人信息类型设置", "json"),
      text("redactWords", "需要隐藏的词（一行一个）", "lines"),
      text("redactRules", "自定义隐藏规则", "json", "settings.redact-rules", "rules"),
      toggle("noStats", "关闭匿名使用统计"),
      toggle("noUsageStats", "关闭 Agent、供应商和模型统计"),
    ],
  },
  {
    id: "otel",
    label: "可观测性",
    fields: [
      toggle("otel.enabled", "导出 OpenTelemetry"),
      text("otel.endpoint", "OTLP 地址"),
      text("otel.headers", "OTLP 认证 Headers（留空保留）", "secret"),
      toggle("otel.metrics", "导出指标"),
      toggle("otel.bodies", "导出请求与响应正文"),
      toggle("otel.bodiesWhole", "导出完整正文"),
      toggle("otel.sessions", "导出会话"),
    ],
  },
  { id: "sync", label: "同步与备份", fields: [] },
  {
    id: "about",
    label: "关于",
    fields: [
      toggle("noUpdatePill", "隐藏更新提示"),
      toggle("noAutoUpdate", "关闭自动检查更新"),
      text("updateEvery", "检查更新间隔（分钟）", "number"),
      toggle("noAutoDownload", "关闭自动下载更新"),
      toggle("autoRestart", "自动重启完成更新"),
      text("updateMirror", "更新下载镜像", "text", "settings.update-mirror", "mirror"),
    ],
  },
];
export const preferenceFields = preferenceSections.flatMap((section) => section.fields);
