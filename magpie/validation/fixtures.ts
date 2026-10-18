import { pageDataSchema, readPluginCatalog, type Page } from "../shared/rpc";

export function demoCatalog(source: "suggested" | "github" | "npm") {
  return readPluginCatalog.output.parse({
    items:
      source === "suggested"
        ? [
            {
              spec: "@magpie-community/opencode-workbuddy-auth",
              name: "WorkBuddy",
              description: "连接 WorkBuddy 订阅，让各个 Agent 使用其模型。",
              publisher: "magpie-community",
              community: true,
              source,
              version: "1.2.0",
              kind: "provider",
              providers: ["workbuddy"],
            },
            {
              spec: "@magpie-community/middleware-param-override",
              name: "Param Override",
              description: "为网关请求统一配置参数。",
              community: true,
              source,
              version: "1.0.0",
              kind: "middleware",
            },
          ]
        : source === "github"
          ? [
              {
                spec: "github:example/magpie-tools",
                name: "Example tools",
                description: "GitHub 社区插件示例。",
                source,
                publisher: "example",
                kind: "tools",
                repository: "https://github.com/example/magpie-tools",
              },
            ]
          : [
              {
                spec: "@magpie-community/opencode-workbuddy-auth",
                name: "@magpie-community/opencode-workbuddy-auth",
                source,
                version: "1.2.0",
                description: "WorkBuddy provider",
              },
              {
                spec: "opencode-tencent-auth",
                name: "opencode-tencent-auth",
                source,
                version: "1.0.0",
                description: "WorkBuddy authentication plugin",
              },
            ],
  });
}

export const demoColors = {
  surface0: "#111315",
  surface1: "#191c20",
  surface2: "#23272d",
  foreground: "#eceef1",
  foregroundMuted: "#9299a4",
  border: "#2a2f36",
  accent: "#dbb575",
  statusDanger: "#ef7c78",
  statusSuccess: "#7bc9a4",
  statusWarning: "#e6ba72",
};
export function demoData(page: Page) {
  return pageDataSchema.parse({
    page,
    agents: [
      {
        id: "codex",
        name: "Codex",
        wired: true,
        source: "使用 Magpie 的模型",
        fields: [
          {
            key: "model",
            label: "模型",
            value: "openai/gpt-4.1",
            options: [
              { value: "openai/gpt-4.1", label: "GPT-4.1 · OpenAI" },
              { value: "deepseek/v3", label: "DeepSeek V3" },
            ],
          },
          {
            key: "effort",
            label: "思考强度",
            value: "high",
            options: [
              { value: "high", label: "高" },
              { value: "medium", label: "中" },
              { value: "low", label: "低" },
            ],
          },
        ],
      },
      {
        id: "claude",
        name: "Claude Code",
        wired: true,
        source: "开发与长任务",
        fields: [
          {
            key: "model",
            label: "模型",
            value: "deepseek/v3",
            options: [
              { value: "deepseek/v3", label: "DeepSeek V3" },
              { value: "openai/gpt-4.1", label: "GPT-4.1 · OpenAI" },
            ],
          },
        ],
      },
      {
        id: "cursor",
        name: "Cursor",
        source: "使用原有提供商",
        fields: [
          {
            key: "model",
            label: "模型",
            value: "auto",
            options: [
              { value: "auto", label: "自动" },
              { value: "openai/gpt-4.1", label: "GPT-4.1 · OpenAI" },
            ],
          },
        ],
      },
      { id: "gemini", name: "Gemini CLI", source: "尚未接入", fields: [] },
    ],
    profiles: [
      { name: "日常开发", summary: "Codex · GPT-4.1 / Claude Code · DeepSeek V3", inUse: true },
    ],
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        host: "api.openai.com",
        chat: "https://api.openai.com/v1",
        ready: true,
        keyMasked: "sk-…demo",
        exposed: 2,
        models: [
          { id: "gpt-4.1", name: "GPT-4.1", on: true, context: 1048576, images: true },
          { id: "o4-mini", name: "o4-mini", on: true, context: 200000 },
        ],
        keys: [
          { id: "demo-fingerprint", name: "工作密钥", masked: "sk-…demo", active: true, on: true },
        ],
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        host: "api.deepseek.com",
        chat: "https://api.deepseek.com",
        ready: true,
        exposed: 2,
        models: [
          { id: "v3", name: "DeepSeek V3", on: true, context: 128000 },
          { id: "r1", name: "DeepSeek R1", on: true, context: 128000 },
        ],
      },
    ],
    presets: [
      { id: "openai", name: "OpenAI", kind: "vendor", chat: "https://api.openai.com/v1" },
      { id: "deepseek", name: "DeepSeek", kind: "vendor", chat: "https://api.deepseek.com" },
    ],
    groups: [
      {
        id: "daily",
        name: "日常编程",
        routing: "order",
        members: ["openai/gpt-4.1", "deepseek/v3"],
        ready: true,
      },
    ],
    models: [
      { value: "openai/gpt-4.1", label: "GPT-4.1 · OpenAI" },
      { value: "deepseek/v3", label: "DeepSeek V3 · DeepSeek" },
    ],
    gateway: {
      url: "http://127.0.0.1:3425",
      running: true,
      models: 4,
      mine: true,
      calls: [
        {
          id: 2,
          time: "2026-10-18T13:42:00Z",
          agent: "Codex",
          model: "gpt-4.1",
          provider: "OpenAI",
          status: 200,
          ms: 2450,
          input: 14600,
          output: 1200,
        },
        {
          id: 1,
          time: "2026-10-18T13:39:00Z",
          agent: "Claude Code",
          model: "v3",
          provider: "DeepSeek",
          status: 200,
          ms: 1480,
          input: 8300,
          output: 950,
        },
      ],
    },
    usage: {
      calls: 126,
      input: 1240000,
      output: 184000,
      cache_read: 2350000,
      cache_write: 160000,
      cost: 4.283,
      series: [12, 18, 9, 31, 26, 14, 38, 46, 32, 59, 45, 72].map((n, i) => ({
        label: `${String(i * 2).padStart(2, "0")}:00`,
        input: n * 1000,
        output: n * 150,
        calls: n,
      })),
      agents: [
        { id: "codex", name: "Codex", calls: 86, input: 840000, output: 124000, cost: 3.18 },
        { id: "claude", name: "Claude Code", calls: 40, input: 400000, output: 60000, cost: 1.103 },
      ],
      models: [
        { id: "gpt-4.1", name: "GPT-4.1", calls: 86, input: 840000, output: 124000, cost: 3.18 },
        { id: "v3", name: "DeepSeek V3", calls: 40, input: 400000, output: 60000, cost: 1.103 },
      ],
    },
    sessions: [
      {
        agent: "codex",
        id: "demo-session",
        name: "Codex",
        title: "实现新的任务队列与状态更新",
        cwd: "~/projects/workbench",
        last: "2026-10-18T13:42:00Z",
        input: 48000,
        output: 6200,
        cost: 0.18,
        resume: "codex resume demo-session",
        transcript: true,
      },
    ],
    total: 1,
    library: {
      dir: "~/.config/magpie/library",
      servers: [
        {
          name: "文档检索",
          transport: "http",
          url: "https://docs.example.test/mcp",
          agents: ["codex", "claude"],
        },
      ],
      skills: [
        {
          name: "代码审查",
          description: "检查变更风险、边界条件和测试覆盖",
          source: "example/skills",
          agents: ["codex"],
        },
      ],
      agents: [
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude Code" },
      ],
    },
    plugins: [
      {
        spec: "@example/magpie-provider",
        name: "Example provider",
        version: "1.2.0",
        providers: ["Example"],
      },
    ],
    builtins: [
      { id: "sessions", name: "Sessions", sub: "读取 Agent 会话", on: true, inUse: 1 },
      { id: "library", name: "Library", sub: "共享 MCP 与技能", on: true },
      { id: "usage", name: "Usage", sub: "用量统计", on: true },
    ],
    settings: {
      theme: "dark",
      lang: "zh",
      currency: "usd",
      proxy: "",
      textSize: 13,
      version: "demo",
      dir: "~/.config/magpie",
      gateway: "http://127.0.0.1:3425",
    },
  });
}
