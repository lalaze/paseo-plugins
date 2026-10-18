import type { ConnectionConfig } from "./config";

export class MagpieApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "MagpieApiError";
  }
}

export class MagpieApi {
  private cookie = "";
  private signingIn: Promise<void> | undefined;
  private pending = new Set<AbortController>();
  private closed = false;

  constructor(private readonly config: Pick<ConnectionConfig, "upstream" | "key">) {}

  private async fetch(url: URL, init: RequestInit = {}) {
    if (this.closed) throw new MagpieApiError("Magpie 插件已停止，请重新打开。");
    const controller = new AbortController();
    this.pending.add(controller);
    const longOperation = /^\/api\/(plugins\/(add|upgrade)|library\/skills\/install)$/.test(
      url.pathname,
    );
    const timer = setTimeout(() => controller.abort(), longOperation ? 330_000 : 30_000);
    try {
      return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    } catch {
      throw new MagpieApiError("无法连接 Magpie，请确认主机上的 Magpie Web 服务正在运行。");
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  private authenticate() {
    if (!this.signingIn) {
      this.signingIn = (async () => {
        const url = new URL("/", this.config.upstream);
        url.searchParams.set("k", this.config.key);
        const response = await this.fetch(url);
        await response.body?.cancel();
        if (!response.ok && response.status !== 302 && response.status !== 303)
          throw new MagpieApiError(
            `Magpie 登录失败（HTTP ${response.status}），请检查 Web 密钥。`,
            response.status,
          );
        const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
        if (!cookies.length)
          throw new MagpieApiError("Magpie 未返回登录 Cookie，请检查 Web 密钥和版本。");
        this.cookie = cookies.join("; ");
      })().finally(() => {
        this.signingIn = undefined;
      });
    }
    return this.signingIn;
  }

  async request(path: string, body?: object): Promise<unknown> {
    if (
      !path.startsWith("/api/") ||
      path.includes("\\") ||
      path.includes("..") ||
      path.includes("#")
    )
      throw new MagpieApiError("无效的 Magpie API 路径。");
    const url = new URL(path, this.config.upstream);
    if (url.origin !== this.config.upstream.origin)
      throw new MagpieApiError("无效的 Magpie API 地址。");
    if (!this.cookie) await this.authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: this.cookie,
          Origin: this.config.upstream.origin,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.cookie = "";
        await this.authenticate();
        continue;
      }
      // JSON endpoints only. Never return the sign-in HTML, redirects, or credentials to a client.
      const content = await response.text();
      let data: unknown;
      try {
        data = content ? JSON.parse(content) : null;
      } catch {
        if (response.ok) throw new MagpieApiError("Magpie 返回了非 JSON 响应，请检查服务地址。");
      }
      if (!response.ok) {
        let message =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : `Magpie 请求失败（HTTP ${response.status}）。`;
        for (const secret of [this.config.key, this.cookie, ...secrets(body)])
          if (secret) message = message.split(secret).join("[已隐藏]");
        throw new MagpieApiError(message.slice(0, 1200), response.status);
      }
      return data;
    }
    throw new MagpieApiError("Magpie 登录已失效，请检查 Web 密钥。", 401);
  }

  close() {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    this.cookie = "";
  }
}

function secrets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    /key|secret|token|authorization/i.test(key) && typeof item === "string"
      ? [item]
      : secrets(item),
  );
}
