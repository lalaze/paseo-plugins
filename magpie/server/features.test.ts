import { describe, expect, it } from "vitest";
import { featureRead, featureMutate, publicData } from "./features";
import { readFeature, mutateFeature } from "../shared/features";
import type { Api } from "./service";

function fixture(values: Record<string, unknown>) {
  const calls: { path: string; body?: object }[] = [];
  const api: Api = {
    async request(path, body) {
      calls.push({ path, body });
      if (!(path in values)) throw new Error(`Unexpected route: ${path}`);
      return values[path];
    },
  };
  return { calls, api };
}
describe("native feature operations", () => {
  it("rejects unknown routes and parameters before making a request", async () => {
    const { api, calls } = fixture({});
    expect(() => readFeature.input.parse({ feature: "../../credentials" })).toThrow();
    expect(() => mutateFeature.input.parse({ operation: "arbitrary.path" })).toThrow();
    await expect(
      featureRead(api, { feature: "preferences", query: { arbitrary: "x" } }),
    ).rejects.toThrow("无效");
    await expect(
      featureRead(api, { feature: "agentModels", query: { id: "../codex" } }),
    ).rejects.toThrow("无效");
    expect(calls).toEqual([]);
  });
  it("removes nested credentials while preserving numeric token counts and masked keys", () => {
    const data = publicData({
      key: "sk-top-secret",
      headers: { Authorization: "Bearer secret" },
      otel: { endpoint: "https://collector.test", headers: { token: "secret" } },
      account: { accessToken: "secret", refreshToken: "secret" },
      env: { API_KEY: "secret" },
      keys: [{ id: "key-id", masked: "sk-…demo", secret: "secret" }],
      tokens: 100,
      token: "secret",
      inputs: [{ key: "apiKey", secret: true }],
    });
    expect(JSON.stringify(data)).not.toContain("top-secret");
    expect(JSON.stringify(data)).not.toContain('"token":"secret"');
    expect(data).toMatchObject({
      tokens: 100,
      keys: [{ id: "key-id", masked: "sk-…demo" }],
      inputs: [{ key: "apiKey", secret: true }],
    });
  });
  it("preserves hidden settings and OTLP authentication while changing just the endpoint", async () => {
    const { api, calls } = fixture({
      "/api/settings": {
        proxy: "direct",
        fullContext: true,
        otel: { endpoint: "before", headers: { Authorization: "server-only" }, metrics: true },
      },
    });
    await featureMutate(api, {
      operation: "preferences.patch",
      body: { "otel.endpoint": "https://new.test", "otel.headers": "" },
    });
    expect(calls[1].body).toMatchObject({
      proxy: "direct",
      fullContext: true,
      otel: {
        endpoint: "https://new.test",
        headers: { Authorization: "server-only" },
        metrics: true,
      },
    });
  });
  it("uses dedicated routes for protected settings and preserves related compaction fields", async () => {
    const { api, calls } = fixture({
      "/api/settings": { fullContext: false, compactAt: 200000 },
      "/api/settings/full-context": {},
      "/api/settings/quota-reads": {},
    });
    await featureMutate(api, {
      operation: "preferences.patch",
      body: { compactAt: 250000, quotaReads: "asked" },
    });
    expect(calls).toContainEqual({
      path: "/api/settings/full-context",
      body: { on: false, at: 250000 },
    });
    expect(calls).toContainEqual({ path: "/api/settings/quota-reads", body: { reads: "asked" } });
  });
  it("validates the whole preference patch before any writes", async () => {
    const { api, calls } = fixture({ "/api/settings": {} });
    await expect(
      featureMutate(api, {
        operation: "preferences.patch",
        body: { keepAwake: true, arbitrarySecret: "bad" },
      }),
    ).rejects.toThrow("未知");
    expect(calls.every((c) => c.body === undefined)).toBe(true);
  });
  it("preserves provider secrets and sends model IDs rather than projected model metadata", async () => {
    const { api, calls } = fixture({
      "/api/providers": {
        providers: [
          {
            id: "demo",
            key: { masked: "masked" },
            balanceToken: { takes: true, set: true },
            chosen: ["a"],
            models: [{ id: "a", context: 1000 }],
            headers: { Authorization: "retained" },
          },
        ],
      },
      "/api/provider/save": {},
    });
    await featureMutate(api, {
      operation: "provider.save",
      body: { id: "demo", routing: "order" },
    });
    expect(calls[1].body).toMatchObject({
      key: "",
      balanceToken: "",
      models: ["a"],
      headers: { Authorization: "retained" },
      routing: "order",
      new: false,
    });
  });
  it("keeps MCP environment and headers when editing a server", async () => {
    const { api, calls } = fixture({
      "/api/library?glance=1": {
        servers: [{ name: "demo", env: { TOKEN: "retained" }, headers: { "x-key": "retained" } }],
      },
      "/api/library/servers/save": {},
    });
    await featureMutate(api, {
      operation: "library.servers.save",
      body: { old: "demo", name: "demo", url: "https://new.test" },
    });
    expect(calls[1].body).toMatchObject({
      old: "demo",
      server: {
        name: "demo",
        env: { TOKEN: "retained" },
        headers: { "x-key": "retained" },
        url: "https://new.test",
      },
    });
  });
  it("wraps hook fields and instruction texts in Magpie's expected structures", async () => {
    const { api, calls } = fixture({
      "/api/library?glance=1": { hooks: [] },
      "/api/library/hooks/save": {},
      "/api/library/instructions/save": {},
    });
    await featureMutate(api, {
      operation: "library.hooks.save",
      body: { old: "", name: "notify", event: "turn-end", command: "echo done" },
    });
    expect(calls[1].body).toEqual({
      old: "",
      hook: { name: "notify", event: "turn-end", command: "echo done" },
    });
    await featureMutate(api, {
      operation: "library.instructions",
      body: { set: "shared", text: "Clear code" },
    });
    expect(calls[2].body).toEqual({ texts: { shared: "Clear code" } });
  });
  it("preserves group rules while adding the missing manual pick and weights", async () => {
    const { api, calls } = fixture({
      "/api/groups": {
        groups: [
          {
            id: "daily",
            members: ["a/model"],
            rules: [{ intent: "code", to: "a/model" }],
            firstToken: 30,
          },
        ],
      },
      "/api/groups/save": {},
    });
    await featureMutate(api, {
      operation: "groups.save",
      body: { id: "daily", pick: "a/model", weights: { "a/model": 3 } },
    });
    expect(calls[1].body).toMatchObject({
      pick: "a/model",
      weights: { "a/model": 3 },
      rules: [{ intent: "code", to: "a/model" }],
      firstToken: 30,
    });
  });
  it("builds gateway budget envelopes and encoded refresh query strings", async () => {
    const { api, calls } = fixture({
      "/api/caller-keys/limit-key": {},
      "/api/usage/quotas/refresh?provider=codex&account=a%26b": {},
    });
    await featureMutate(api, {
      operation: "gateway.key.limit",
      body: { key: "laptop", period: "hours", hours: 5, tokens: 10000 },
    });
    expect(calls[0].body).toEqual({
      key: "laptop",
      index: 0,
      limit: { period: "hours", hours: 5, tokens: 10000 },
    });
    await featureMutate(api, {
      operation: "quota.refresh",
      body: { provider: "codex", account: "a&b" },
    });
    expect(calls[1].path).toBe("/api/usage/quotas/refresh?provider=codex&account=a%26b");
  });
  it("reads extension options through the authenticated POST contract and retains hidden secrets on edit", async () => {
    const { api, calls } = fixture({
      "/api/plugin-pages/options": {
        theme: "dark",
        password: "retained",
        nested: { token: "retained", visible: true },
      },
    });
    const result = await featureRead(api, {
      feature: "pluginPageOptions",
      query: { spec: "@demo/page" },
    });
    expect(result.data).toEqual({ theme: "dark", nested: { visible: true } });
    await featureMutate(api, {
      operation: "plugin-pages.options",
      body: { spec: "@demo/page", options: { theme: "light", nested: { visible: false } } },
    });
    expect(calls.at(-1)).toEqual({
      path: "/api/plugin-pages/options",
      body: {
        spec: "@demo/page",
        options: {
          theme: "light",
          password: "retained",
          nested: { token: "retained", visible: false },
        },
      },
    });
  });
  it("normalizes derived preferences and does not write the pseudo field", async () => {
    const { api, calls } = fixture({
      "/api/settings": { plainNames: true, plainOwnNames: true },
      "/api/settings/plain-names": {},
    });
    expect((await featureRead(api, { feature: "preferences", query: {} })).data).toMatchObject({
      tray: "panel",
      plainNamesMode: "own",
    });
    await featureMutate(api, { operation: "preferences.patch", body: { plainNamesMode: "off" } });
    expect(calls[2].body).toEqual({ plainNames: false, plainOwnNames: false });
    expect(calls[3]).toEqual({ path: "/api/settings/plain-names", body: { mode: "off" } });
  });
  it("merges OAuth application edits without losing its existing secret", async () => {
    const { api, calls } = fixture({
      "/api/library?glance=1": {
        servers: [
          {
            name: "demo",
            oauth: { clientId: "old", clientSecret: "retained", callbackPort: 1234 },
          },
        ],
      },
      "/api/library/servers/save": {},
    });
    await featureMutate(api, {
      operation: "library.servers.save",
      body: { old: "demo", "oauth.clientId": "new" },
    });
    expect(calls[1].body).toEqual({
      old: "demo",
      server: {
        name: "demo",
        oauth: { clientId: "new", clientSecret: "retained", callbackPort: 1234 },
      },
    });
  });
  it("exports every matching request with failure and custom-range parameters", async () => {
    const { api, calls } = fixture({
      "/api/usage/requests/export?period=2026-10-01..2026-10-18&failed=1&via=through": {
        path: "~/Downloads/demo.csv",
      },
    });
    await featureMutate(api, {
      operation: "usage.export",
      body: { period: "2026-10-01..2026-10-18", failed: "1", via: "through" },
    });
    expect(calls[0].path).toContain("failed=1&via=through");
  });
  it("changes one model's limit and price while preserving its other prices and provider models", async () => {
    const { api, calls } = fixture({
      "/api/providers": {
        providers: [
          {
            id: "demo",
            chosen: ["a", "b"],
            contexts: { b: 64000 },
            models: [{ id: "a", list: { input: 1, output: 3, cache_read: 0.1 } }],
          },
        ],
      },
      "/api/provider/save": {},
    });
    await featureMutate(api, {
      operation: "provider.modelprefs",
      body: { id: "demo", model: "a", context: 128000, "price.input": 2 },
    });
    expect(calls[1].body).toMatchObject({
      models: ["a", "b"],
      contexts: { a: 128000, b: 64000 },
      modelPrefs: { a: { price: { input: 2, output: 3, cache_read: 0.1 } } },
    });
  });
  it("builds S3 sync config with the actual passphrase field", async () => {
    const { api, calls } = fixture({ "/api/davsync/save": { on: true } });
    await featureMutate(api, {
      operation: "sync.save",
      body: { kind: "s3", url: "bucket", folder: "/backups/", passphrase: "pass", keys: true },
    });
    expect(calls[0].body).toEqual({ url: "s3://bucket/backups", passphrase: "pass", keys: true });
  });
});
