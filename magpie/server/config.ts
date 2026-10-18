import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const launchConfiguration = z.object({
  EnvironmentVariables: z.object({ MAGPIE_WEB_KEY: z.string().min(16) }),
});

export class MagpieConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MagpieConnectionError";
  }
}

export interface ConnectionConfig {
  upstream: URL;
  key: string;
}

function httpOrigin(value: string) {
  const url = new URL(value);
  const http = url.protocol === "http:" || url.protocol === "https:";
  const hasSuffix = url.pathname !== "/" || url.search !== "" || url.hash !== "";
  if (!http || hasSuffix || url.username || url.password) {
    throw new MagpieConnectionError(
      "Magpie addresses must be HTTP(S) origins without credentials, paths or query strings.",
    );
  }
  return url;
}

export async function readConfig(): Promise<ConnectionConfig> {
  let key = process.env.MAGPIE_WEB_KEY;
  if (!key && process.platform === "darwin") {
    const path = join(homedir(), "Library/LaunchAgents/com.yetone.magpie.serve.plist");
    try {
      const { stdout } = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
      key = launchConfiguration.parse(JSON.parse(stdout)).EnvironmentVariables.MAGPIE_WEB_KEY;
    } catch (cause) {
      throw new MagpieConnectionError(
        "无法读取 Magpie Web 登录密钥。请在 Paseo 主机环境中设置 MAGPIE_WEB_KEY。",
        { cause },
      );
    }
  }
  if (!key) throw new MagpieConnectionError("请在 Paseo 主机环境中设置 MAGPIE_WEB_KEY。");
  const upstream = httpOrigin(process.env.PASEO_MAGPIE_UPSTREAM ?? "http://127.0.0.1:3430");
  return { upstream, key };
}
