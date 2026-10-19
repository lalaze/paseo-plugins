import { demoData } from "./fixtures";
import type { Feature, Json, Row } from "../shared/features";

export function demoFeature(feature: Feature): Json {
  const demo = demoData("agents");
  switch (feature) {
    case "preferences":
      return {
        ...demo.settings!,
        fx: { rate: 7.1 },
        codexUsers: ["demo@example.test"],
        codexAutoReset: ["demo@example.test"],
        codexAutoResetOnly: { "demo@example.test": "expiring" },
        codexNoCredits: [],
        codexWarmAts: ["08:00"],
        disabledModels: [],
        redactRules: [],
      };
    case "providers":
      return {
        providers: demo.providers.map((p) => ({
          ...p,
          keyList: p.keys,
          chosen: [],
          account:
            p.id === "openai"
              ? { agent: "codex", logins: [{ user: "demo@example.test", active: true, on: true }] }
              : null,
        })),
        plugins: [
          {
            id: "demo-plugin",
            pid: "demo-plugin",
            name: "示例插件",
            methods: [{ type: "api", label: "API 密钥" }],
          },
        ],
        gateway: demo.gateway,
      };
    case "agents":
      return {
        agents: demo.agents,
        settings: { agentOrder: ["codex", "claude"], agentsHidden: [], agentsShown: [] },
      };
    case "agentCli":
      return {
        agents: { codex: { id: "codex", name: "Codex", version: "0.1.0", latest: "0.2.0" } },
      };
    case "agentInstalls":
      return [
        { id: "example-agent", name: "Example Agent", command: "npm install -g example-agent" },
      ];
    case "agentModels":
      return {
        only: false,
        ownHidden: false,
        models: [
          { id: "openai/gpt-4.1", name: "GPT-4.1" },
          { id: "deepseek/v3", name: "DeepSeek V3", hidden: true },
        ],
      };
    case "agentPreview":
      return { changes: [{ path: "~/.config/example", before: "magpie", after: "original" }] };
    case "gatewayKeys":
      return {
        keys: demo.gatewayKeys.map((k) => ({
          ...k,
          limit: { period: "day", tokens: 100000 },
          moreLimits: [{ period: "week", tokens: 700000, cost: 20 }],
          usedAll: [
            { tokens: 2500, limit: 100000 },
            { tokens: 3000, limit: 700000 },
          ],
        })),
      };
    case "gatewayPermissions":
      return {
        models: [{ id: "codex/gpt-4.1", name: "GPT-4.1" }],
        accounts: [{ id: "codex/account-demo", name: "demo@example.test" }],
      };
    case "groups":
      return {
        groups: demo.groups,
        pools: [
          { provider: "openai", name: "OpenAI", routing: "order", who: ["demo@example.test"] },
        ],
        templates: [],
      };
    case "routing":
      return {
        totals: { requests: 1, rerouted: 0, errors: 0 },
        routes: [
          {
            id: 1,
            agent: "Codex",
            model: "openai/gpt-4.1",
            status: 200,
            order: [{ user: "demo@example.test" }],
            tries: [{ status: 200 }],
          },
        ],
      };
    case "library":
      return {
        ...demo.library!,
        backups: "~/.config/magpie/backups",
        hooks: [
          {
            name: "notify",
            description: "通知",
            event: "turn-end",
            command: "echo done",
            agents: ["codex"],
          },
        ],
        subagents: [
          {
            name: "reviewer",
            description: "代码审查",
            prompt: "Review changes",
            skills: [],
            mcp: [],
            agents: ["codex"],
          },
        ],
        instructions: {
          sets: [{ id: "shared", name: "共享指令", text: "Write clear code.", active: true }],
          agents: [{ agent: "codex", name: "Codex", on: true, extra: "" }],
        },
        projects: [],
        hookAgents: [],
        subagentAgents: [],
      };
    case "rtk":
      return {
        path: "/usr/local/bin/rtk",
        version: "0.1.0",
        agents: [{ id: "codex", name: "Codex", on: false }],
      };
    case "libraryMarket":
      return {
        items: [
          { id: "demo", name: "示例资源", description: "可安装的示例资源", source: "example/demo" },
        ],
      };
    case "sessions":
      return {
        agent: "codex",
        agents: [{ agent: "codex", name: "Codex", count: 1 }],
        sessions: [
          {
            id: "demo-session",
            title: "示例会话",
            cwd: "/demo/project",
            deletable: true,
            agent: "codex",
            resume: "codex resume demo-session",
          },
        ],
        trash: [{ key: "trash-demo", id: "old-session", title: "已删除的示例会话" }],
        recording: false,
      };
    case "sessionSearch":
      return { hits: [{ id: "demo-session", text: "找到的示例消息" }] };
    case "plugins":
      return {
        plugins: [{ spec: "@demo/middleware", name: "示例中间件", options: { enabled: true } }],
        mirror: false,
      };
    case "pluginPages":
      return [{ key: "demo-page", spec: "@demo/page", title: "示例扩展页", reads: [] }];
    case "pluginPageOptions":
      return { theme: "dark", nested: { enabled: true } };
    case "mcpSigninStatus":
      return { id: "mcp-demo", state: "waiting", url: "https://auth.example.test/authorize" };
    case "sync":
      return { on: false, keys: true, agents: true, library: true, auto: 3 };
    case "quotas":
      return demo.quotas;
    case "requests":
      return {
        rows: [
          {
            model: "GPT-4.1",
            agent: "codex",
            status: 200,
            in: 100,
            out: 50,
            t: "2026-10-18T12:00:00Z",
          },
        ],
        calls: 1,
        total: 1,
        input: 100,
        output: 50,
        cost: 0.01,
        series: [{ label: "10-18", input: 100, output: 50 }],
        by: { account: [{ name: "demo@example.test", calls: 1 }] },
      };
    case "context":
      return {
        days: 7,
        agents: [
          {
            agent: "codex",
            median: 32000,
            window: 200000,
            cache: 0.6,
            baseline: 8000,
            growth: 1200,
            compacts: 1,
            shares: { system: 0.25, tools: 0.15, messages: 0.6 },
          },
        ],
        sessions: [
          {
            agent: "codex",
            key: "codex:demo-session",
            title: "示例会话",
            model: "GPT-4.1",
            requests: 5,
            peak: 48000,
            window: 200000,
            points: [12000, 18000, 32000, 48000, 16000].map((tokens, i) => ({
              time: `2026-10-18T12:0${i}:00Z`,
              tokens,
            })),
          },
        ],
      };
    case "tune":
      return {
        days: 7,
        agents: [
          {
            agent: "codex",
            advice: [
              {
                knob: "compact",
                setting: { value: "180000" },
                compact: { best: 160000, current: 180000, window: 200000 },
              },
            ],
          },
        ],
      };
    case "usageSessions":
      return {
        count: 4,
        median: 20000,
        p90: 80000,
        days: [1, 2, 1, 3, 0, 2, 1],
        messages: [2, 4, 2, 6, 0, 4, 2],
        output: [100, 300, 150, 500, 0, 300, 100],
        top: {
          tokens: [
            {
              key: "codex:demo-session",
              agent: "codex",
              id: "demo-session",
              title: "示例会话",
              cwd: "/demo/project",
              cost: 0.1,
            },
          ],
        },
        tools: { calls: 10, top: [{ name: "shell", calls: 8 }] },
        skills: { calls: 2, top: [] },
      };
    case "sessionStats":
      return {
        agents: { codex: "Codex", claude: "Claude Code" },
        days: [
          {
            date: "2026-10-18",
            usage: [{ agent: "codex", model: "GPT-4.1", cwd: "/demo/project", cost: 0.1 }],
          },
        ],
      };
    case "usageHeatmap":
      return {
        from: "2026-10-01",
        to: "2026-10-18",
        days: Array.from({ length: 18 }, (_, i) => ({
          date: `2026-10-${String(i + 1).padStart(2, "0")}`,
          tokens: (i % 5) * 1000,
          calls: i % 5,
        })),
      };
    case "sessionDetail":
      return { key: "codex:demo-session", title: "示例会话", tokens: 20000, messages: 10 };
    default:
      return {};
  }
}
