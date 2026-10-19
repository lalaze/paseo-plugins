import { describe, expect, it } from "vitest";
import {
  act,
  loadPage,
  pluginCatalog,
  signin,
  transcript,
  gatewaySecret,
  type Api,
} from "./service";
import { MagpieApiError } from "./api";
import { readPage, providerDraftSchema, type Action } from "../shared/rpc";

function fixture(responses: Record<string, unknown>) {
  const calls: { path: string; body?: object }[] = [];
  const api: Api = {
    async request(path, body) {
      calls.push({ path, body });
      const value = responses[path];
      if (value instanceof Error) throw value;
      if (!(path in responses)) throw new Error(`Unexpected route: ${path}`);
      return value;
    },
  };
  return { api, calls };
}

describe("native Magpie API projection", () => {
  it("loads sharing and masked gateway keys without polling credentials", async () => {
    const { api, calls } = fixture({
      "/api/providers": {
        gateway: { lan: true, lanURLs: ["http://100.96.195.115:3425"] },
      },
      "/api/caller-keys": {
        keys: [
          {
            id: "laptop",
            name: "Laptop",
            masked: "sk-…demo",
            secret: "must-not-leak",
          },
        ],
      },
    });
    const data = await loadPage(api, readPage.input.parse({ page: "gateway" }));
    expect(data.gateway?.lan).toBe(true);
    expect(data.gateway?.lanURLs).toEqual(["http://100.96.195.115:3425"]);
    expect(data.gatewayKeys[0].name).toBe("Laptop");
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
    expect(calls.map((c) => c.path)).toEqual(["/api/providers", "/api/caller-keys"]);
  });
  it("keeps gateway status available when an older Magpie cannot list keys", async () => {
    const { api } = fixture({
      "/api/providers": { gateway: { running: true } },
      "/api/caller-keys": new MagpieApiError("密钥接口不可用", 404),
    });
    const data = await loadPage(api, readPage.input.parse({ page: "gateway" }));
    expect(data.gateway?.running).toBe(true);
    expect(data.notices).toEqual(["密钥接口不可用"]);
  });
  it("projects community listings including WorkBuddy without forwarding extra upstream fields", async () => {
    const { api, calls } = fixture({
      "/api/plugins/listings": {
        listings: [
          {
            package: "@magpie-community/opencode-workbuddy-auth",
            name: "WorkBuddy",
            community: true,
            summary: { zh: "连接 WorkBuddy", en: "WorkBuddy sign-in" },
            providers: ["workbuddy"],
            npm: {
              version: "1.2.0",
              weekly: 42,
              publisher: "magpie-community",
              repository: "https://github.com/example/plugin",
              token: "must-not-leak",
            },
          },
        ],
      },
    });
    const data = await pluginCatalog(api, { source: "suggested", query: "" });
    expect(calls).toEqual([{ path: "/api/plugins/listings", body: undefined }]);
    expect(data.items[0]).toMatchObject({
      spec: "@magpie-community/opencode-workbuddy-auth",
      name: "WorkBuddy",
      description: "连接 WorkBuddy",
      source: "suggested",
      version: "1.2.0",
      weekly: 42,
    });
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
  });
  it("searches npm with an encoded query and skips requests shorter than two characters", async () => {
    const { api, calls } = fixture({
      "/api/plugins/search?q=workbuddy%20%26%20auth": {
        hits: [
          {
            package: "opencode-tencent-auth",
            description: "WorkBuddy",
            weekly: 15,
            repository: "javascript:bad()",
          },
        ],
      },
    });
    expect(await pluginCatalog(api, { source: "npm", query: "w" })).toEqual({
      items: [],
    });
    expect(calls).toEqual([]);
    const data = await pluginCatalog(api, {
      source: "npm",
      query: "workbuddy & auth",
    });
    expect(data.items[0]).toMatchObject({
      spec: "opencode-tencent-auth",
      source: "npm",
      repository: "",
    });
    expect(calls[0].path).toBe("/api/plugins/search?q=workbuddy%20%26%20auth");
  });
  it("keeps a GitHub plugin's install spec instead of inventing an npm package name", async () => {
    const { api } = fixture({
      "/api/plugins/github": {
        repos: [
          {
            repo: "example/workbuddy",
            spec: "github:example/workbuddy",
            owner: "example",
            url: "https://github.com/example/workbuddy",
            description: "WorkBuddy tools",
            kind: "tools",
          },
        ],
      },
    });
    expect((await pluginCatalog(api, { source: "github", query: "" })).items[0]).toMatchObject({
      spec: "github:example/workbuddy",
      name: "workbuddy",
      publisher: "example",
      kind: "tools",
    });
  });
  it("renders Go's optional option labels and null lists without losing their values", async () => {
    const { api } = fixture({
      "/api/state": {
        agents: [
          {
            id: "codex",
            name: "Codex",
            fields: [
              {
                key: "model",
                value: "original",
                options: [
                  { value: "original" },
                  { value: "remote", label: "Remote model", note: "32k" },
                ],
              },
            ],
          },
        ],
        profiles: null,
        settings: { lanKey: "must-not-leak" },
      },
    });
    const data = await loadPage(api, readPage.input.parse({ page: "agents" }));
    expect(data.agents[0].fields[0].options).toEqual([
      { value: "original", label: "original", note: "" },
      { value: "remote", label: "Remote model", note: "32k" },
    ]);
    expect(data.profiles).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
  });
  it("sends only masked provider keys and never forwards upstream headers or account tokens", async () => {
    const { api } = fixture({
      "/api/providers": {
        providers: [
          {
            id: "vendor",
            name: "Vendor",
            headers: { Authorization: "must-not-leak" },
            key: { masked: "sk-…123" },
            keyList: [{ id: "fingerprint", masked: "sk-…123", key: "must-not-leak" }],
            account: {
              agent: "codex",
              logins: [{ user: "demo", refresh_token: "must-not-leak" }],
            },
            models: null,
          },
        ],
        presets: null,
        gateway: { calls: null },
      },
    });
    const data = await loadPage(api, readPage.input.parse({ page: "providers" }));
    expect(data.providers[0].keyMasked).toBe("sk-…123");
    expect(data.providers[0].accountAgent).toBe("codex");
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
  });
  it("filters sessions before paginating, and reports the full filtered count", async () => {
    const sessions = Array.from({ length: 130 }, (_, i) => ({
      id: String(i),
      agent: "codex",
      title: i % 2 ? "API project" : "Web project",
    }));
    const { api } = fixture({ "/api/sessions": { sessions } });
    const data = await loadPage(
      api,
      readPage.input.parse({ page: "sessions", query: "API", limit: 20 }),
    );
    expect(data.total).toBe(65);
    expect(data.sessions).toHaveLength(20);
    expect(data.sessions.every((s) => s.title === "API project")).toBe(true);
  });
  it("offers the library builtin when the upstream page is disabled", async () => {
    const { api } = fixture({
      "/api/library?glance=1": new MagpieApiError("not found", 404),
      "/api/settings": {
        builtins: [{ id: "library", name: "Library", on: false }],
      },
    });
    const data = await loadPage(api, readPage.input.parse({ page: "library" }));
    expect(data.library).toBeNull();
    expect(data.builtins[0].id).toBe("library");
    expect(data.notices).toHaveLength(1);
  });
  it("projects settings without exporting Web, LAN or vendor secrets", async () => {
    const { api } = fixture({
      "/api/settings": {
        theme: "dark",
        lan: true,
        lanURLs: ["http://100.96.195.115:3425"],
        version: "1.2",
        lanKey: "must-not-leak",
        githubToken: "must-not-leak",
        builtins: [],
      },
    });
    const data = await loadPage(api, readPage.input.parse({ page: "settings" }));
    expect(data.settings?.theme).toBe("dark");
    expect(data.settings?.lan).toBe(true);
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
  });
});

describe("native Magpie changes", () => {
  it("discards generated credentials from action notices and reveals only the requested gateway key", async () => {
    const { api, calls } = fixture({
      "/api/caller-keys/add-key": {
        secret: "must-not-leak",
        notice: "must-not-leak",
      },
      "/api/caller-keys/copy-key": {
        secret: "requested-secret",
        keys: [{ secret: "other-secret" }],
      },
    });
    expect(
      JSON.stringify(await act(api, { type: "gateway.key.add", name: "Laptop" })),
    ).not.toContain("must-not-leak");
    expect(await gatewaySecret(api, { id: "laptop" })).toEqual({
      secret: "requested-secret",
    });
    expect(calls[1]).toEqual({
      path: "/api/caller-keys/copy-key",
      body: { key: "laptop" },
    });
  });
  it("preserves advanced provider settings and replaces model metadata with the actual model picks", async () => {
    const { api, calls } = fixture({
      "/api/providers": {
        providers: [
          {
            id: "custom",
            name: "Before",
            key: { masked: "masked" },
            headers: { "x-special": "retained" },
            extraBody: { temperature: 0.1 },
            maxConcurrency: 3,
            models: [{ id: "old", on: true }],
          },
        ],
      },
      "/api/provider/save": {},
    });
    const draft = providerDraftSchema.parse({
      id: "custom",
      name: "After",
      models: ["a", "b"],
    });
    await act(api, { type: "provider.save", draft, fresh: false });
    expect(calls[1]).toEqual({
      path: "/api/provider/save",
      body: expect.objectContaining({
        name: "After",
        key: "",
        models: ["a", "b"],
        headers: { "x-special": "retained" },
        extraBody: { temperature: 0.1 },
        maxConcurrency: 3,
        new: false,
      }),
    });
  });
  it("keeps unrelated settings and routing rules when saving a native form", async () => {
    const { api, calls } = fixture({
      "/api/settings": {
        theme: "dark",
        lanKey: "server-only",
        fullContext: true,
      },
      "/api/settings-save": {},
      "/api/groups": {
        groups: [{ id: "fallback", rules: [{ pattern: "code*" }], firstToken: 20 }],
      },
      "/api/groups/save": {},
    });
    // The read and write share a route, so this fixture returns the same settings to both.
    await act(api, {
      type: "settings.save",
      settings: {
        theme: "light",
        lang: "zh",
        currency: "usd",
        proxy: "",
      },
    });
    expect(calls[1].body).toMatchObject({
      lanKey: "server-only",
      fullContext: true,
      theme: "light",
    });
    await act(api, {
      type: "group.save",
      draft: {
        id: "fallback",
        name: "Fallback",
        members: ["a/model"],
        routing: "order",
      },
    });
    expect(calls[3].body).toMatchObject({
      rules: [{ pattern: "code*" }],
      firstToken: 20,
      members: ["a/model"],
    });
  });
  it.each([
    [{ type: "settings.lan", on: true }, "/api/settings/lan", { on: true }],
    [{ type: "settings.textSize", size: 125 }, "/api/settings/text-size", { size: 125 }],
    [{ type: "settings.lan", on: false }, "/api/settings/lan", { on: false }],
    ...["on", "off", "rotate", "remove"].map((operation) => [
      { type: "gateway.key.change", id: "laptop", operation },
      `/api/caller-keys/${operation}-key`,
      { key: "laptop" },
    ]),
    [{ type: "profile", operation: "apply", name: "demo" }, "/api/profile/use", { name: "demo" }],
    [{ type: "agent.connect", id: "codex" }, "/api/agents/connect/codex", {}],
    [
      { type: "agent.set", id: "codex", field: "model", value: "vendor/model" },
      "/api/set",
      { agent: "codex", field: "model", value: "vendor/model" },
    ],
    [
      { type: "login.change", operation: "use", id: "codex", user: "demo" },
      "/api/login/switch",
      { agent: "codex", user: "demo" },
    ],
    [{ type: "provider.toggle", id: "vendor", on: false }, "/api/provider/off", { id: "vendor" }],
    [
      { type: "key.change", id: "vendor", ref: "fp", operation: "off" },
      "/api/keys/off",
      { id: "vendor", ref: "fp" },
    ],
    [
      { type: "plugin.toggle", spec: "@demo/plugin", on: false },
      "/api/plugins/off",
      { spec: "@demo/plugin", off: true },
    ],
    [
      { type: "builtin.toggle", id: "library", on: true },
      "/api/plugins/builtin",
      { id: "library", on: true },
    ],
    [
      { type: "group.toggle", id: "fallback", on: false },
      "/api/groups/switch",
      { id: "fallback", on: false },
    ],
    [
      {
        type: "library.distribute",
        kind: "servers",
        name: "demo",
        agents: ["codex"],
      },
      "/api/library/servers/agents",
      { name: "demo", agents: ["codex"] },
    ],
  ] as [Action, string, object][])(
    "maps %j to Magpie's real operation",
    async (action, path, body) => {
      const { api, calls } = fixture({ [path]: {} });
      await act(api, action);
      expect(calls).toEqual([{ path, body }]);
    },
  );
  it("preserves server-side MCP headers and environment when saving the visible fields", async () => {
    const { api, calls } = fixture({
      "/api/library?glance=1": {
        servers: [
          {
            name: "old",
            headers: { Authorization: "retained" },
            env: { SECRET: "retained" },
            disabledTools: ["danger"],
          },
        ],
      },
      "/api/library/servers/save": {},
    });
    await act(api, {
      type: "library.server.save",
      old: "old",
      name: "new",
      transport: "http",
      url: "https://example.test/mcp",
      command: "",
      args: [],
      agents: ["codex"],
    });
    expect(calls[1].body).toMatchObject({
      old: "old",
      server: {
        name: "new",
        headers: { Authorization: "retained" },
        env: { SECRET: "retained" },
        disabledTools: ["danger"],
      },
    });
  });
  it("passes transcript identifiers as encoded query values and keeps the original content", async () => {
    const path = "/api/sessions/transcript?agent=codex&id=a%26id%3Db";
    const { api } = fixture({
      [path]: {
        parts: [{ role: "assistant", kind: "text", text: "Hello" }],
        cut: false,
      },
    });
    expect((await transcript(api, { agent: "codex", id: "a&id=b" })).parts[0].text).toBe("Hello");
  });
  it("supports remote OAuth callback and cancellation without returning credentials", async () => {
    const { api, calls } = fixture({
      "/api/signin/session/callback": null,
      "/api/signin/session/cancel": null,
    });
    await signin(api, {
      operation: "callback",
      id: "session",
      url: "http://localhost/callback?code=demo",
    });
    expect(calls[0]).toEqual({
      path: "/api/signin/session/callback",
      body: { url: "http://localhost/callback?code=demo" },
    });
    expect((await signin(api, { operation: "cancel", id: "session" })).state).toBe("canceled");
  });
});
