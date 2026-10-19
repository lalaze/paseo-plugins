import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MagpieApi } from "./api";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("Magpie host-only authentication", () => {
  it("deduplicates authentication, preserves POST bodies and renews expired cookies", async () => {
    let signins = 0;
    let expired = false;
    const requests: { method: string; cookie: string; origin: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname === "/") {
        expect(url.searchParams.get("k")).toBe("host-only-key-12345");
        signins++;
        res
          .writeHead(303, { "Set-Cookie": `session=private-${signins}; HttpOnly`, Location: "/" })
          .end();
        return;
      }
      if (expired) {
        expired = false;
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method!,
        cookie: req.headers.cookie!,
        origin: req.headers.origin!,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    const upstream = await listen(server);
    const api = new MagpieApi({ upstream, key: "host-only-key-12345" });
    cleanups.push(() => api.close());
    await Promise.all([api.request("/api/state"), api.request("/api/providers")]);
    await api.request("/api/usage/requests?period=2026-10-01..2026-10-18");
    expect(signins).toBe(1);
    expired = true;
    await api.request("/api/set", { agent: "codex", field: "model", value: "demo/model" });
    expect(signins).toBe(2);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      cookie: "session=private-2",
      origin: upstream.origin,
      body: JSON.stringify({ agent: "codex", field: "model", value: "demo/model" }),
    });
  });
  it("never follows upstream redirects or exposes secret values from an error", async () => {
    const server = createServer((req, res) => {
      if (req.url!.startsWith("/?")) {
        res.writeHead(303, { "Set-Cookie": "session=private; HttpOnly" }).end();
        return;
      }
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "bad host-only-key-12345 and sk-submitted-secret" }));
    });
    const api = new MagpieApi({ upstream: await listen(server), key: "host-only-key-12345" });
    cleanups.push(() => api.close());
    await expect(api.request("/api/provider/save", { key: "sk-submitted-secret" })).rejects.toThrow(
      "bad [已隐藏] and [已隐藏]",
    );
    await expect(api.request("https://example.test/api/state")).rejects.toThrow("无效");
    await expect(api.request("/api/../settings")).rejects.toThrow("无效");
    await expect(api.request("/api/%2e%2e/settings")).rejects.toThrow("无效");
    api.close();
    await expect(api.request("/api/state")).rejects.toThrow("已停止");
  });
});
