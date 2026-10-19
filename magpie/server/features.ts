import { z } from "zod";
import {
  featureRoutes,
  operationRoutes,
  readFeature,
  mutateFeature,
  type Json,
  type Row,
} from "../shared/features";
import { preferenceFields } from "../shared/preferences";
import type { Api } from "./service";
import { MagpieApiError } from "./api";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";

export function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
// Magpie's authenticated API has richer objects than the native overview.
// Keep credential material out of polling, including custom headers and nested auth.
export function publicData(value: unknown, parent = ""): Json {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => publicData(v, parent));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, v]) => {
        if (key === "secret" && typeof v === "boolean") return [[key, v]];
        if (
          /^(?:__proto__|constructor|prototype|headers|extraBody|env|auth|credentials|accessToken|refreshToken|secret|password|githubToken|lanKey)$/i.test(
            key,
          )
        )
          return [];
        if (/(?:secret|password|token)$/i.test(key) && typeof v === "string") return [];
        if (
          key === "key" &&
          typeof v === "string" &&
          (v.startsWith("sk-") || parent === "provider")
        )
          return [];
        return [[key, publicData(v, key)]];
      }),
    );
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "boolean" || typeof value === "string" ? value : null;
}
const queryNames = new Set([
  "id",
  "key",
  "agent",
  "provider",
  "account",
  "user",
  "period",
  "days",
  "q",
  "query",
  "page",
  "limit",
  "offset",
  "status",
  "model",
  "from",
  "to",
  "day",
  "date",
  "after",
  "refresh",
  "kind",
  "name",
  "session",
  "purpose",
  "computer",
  "source",
  "route",
  "wait",
  "glance",
  "callerKey",
  "cwd",
  "spec",
  "at",
  "asked",
  "via",
  "failed",
  "retried",
]);
export async function featureRead(api: Api, value: z.infer<typeof readFeature.input>) {
  const input = readFeature.input.parse(value);
  let path: string = featureRoutes[input.feature];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query)) {
    if (!queryNames.has(key) || value.length > 4096) throw new MagpieApiError("无效的查询参数。");
    if (key === "id" && path.includes("{id}")) {
      if (!value || value.length > 500 || /[\\/]/.test(value))
        throw new MagpieApiError("无效的资源 ID。");
      path = path.replace("{id}", encodeURIComponent(value));
    } else if (input.feature === "libraryMarket" && key === "kind") {
      if (!["servers", "skills"].includes(value)) throw new MagpieApiError("无效的资源类型。");
      path = `library/market/${value}`;
    } else params.set(key, value);
  }
  if (path.includes("{id}")) throw new MagpieApiError("缺少资源 ID。");
  if (input.feature === "pluginPageOptions") {
    const spec = params.get("spec");
    if (!spec) throw new MagpieApiError("缺少插件标识。");
    return { data: publicData(await api.request("/api/plugin-pages/options", { spec })) };
  }
  let data = publicData(await api.request(`/api/${path}${params.size ? `?${params}` : ""}`));
  if (input.feature === "preferences") {
    const settings = row(data);
    data = {
      ...settings,
      tray: settings.tray || "panel",
      plainNamesMode: settings.plainNames ? (settings.plainOwnNames ? "own" : "on") : "off",
    };
  }
  return { data };
}
function assignPath(target: Row, path: string, value: Json) {
  const parts = path.split(".");
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part)))
    throw new MagpieApiError("无效的字段名称。");
  let next = target;
  for (const part of parts.slice(0, -1)) {
    next[part] = { ...row(next[part]) };
    next = row(next[part]);
  }
  next[parts.at(-1)!] = value;
}
async function savePreferences(api: Api, patch: Row) {
  const current = row(await api.request("/api/settings"));
  const next: Row = { ...current };
  const operations = new Map<string, Row>();
  for (const [key, value] of Object.entries(patch)) {
    const field = preferenceFields.find((f) => f.key === key);
    if (!field) throw new MagpieApiError(`未知的设置项：${key}`);
    if (field.kind === "boolean" && typeof value !== "boolean")
      throw new MagpieApiError("开关设置需要布尔值。");
    if (field.kind === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      throw new MagpieApiError("请输入有效数字。");
    if (
      field.kind === "lines" &&
      (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    )
      throw new MagpieApiError("列表项需要文本。");
    if (key === "refusalRetries" && !(value === null || [0, 1, 2, 3].includes(Number(value))))
      throw new MagpieApiError("无效的重试次数。");
    if (field.choices && !field.choices.some(([choice]) => choice === String(value)))
      throw new MagpieApiError(`无效的设置选项：${field.label}`);
    if (field.kind === "secret" && value === "") continue;
    if (key === "otel.headers" && typeof value === "string") {
      const headers: Row = {};
      for (const item of value.split(",").filter((v) => v.trim())) {
        const index = item.indexOf("=");
        if (index < 1) throw new MagpieApiError("Headers 使用逗号分隔的 name=value 格式。");
        headers[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
      }
      assignPath(next, key, headers);
    } else if (key === "plainNamesMode") {
      next.plainNames = value !== "off";
      next.plainOwnNames = value === "own";
    } else assignPath(next, key, value);
    if (field.operation) {
      const route = operationRoutes[field.operation as keyof typeof operationRoutes];
      if (!route) throw new MagpieApiError("设置接口不存在。");
      const body = operations.get(route) || {};
      body[field.argument || "on"] = value;
      operations.set(route, body);
    }
  }
  // Validate every field before any mutation. Preserve fields not exposed by this page.
  await api.request("/api/settings", next);
  for (const [route, body] of operations) {
    if (route === "settings/full-context") {
      body.on = next.fullContext ?? false;
      body.at = next.compactAt ?? 0;
    }
    if (route === "settings/codex-async-compact") {
      body.on = next.codexAsyncCompact ?? false;
      body.percent = next.codexAsyncCompactPercent ?? 0;
    }
    await api.request(`/api/${route}`, body);
  }
  return publicData(await api.request("/api/settings"));
}
export async function featureMutate(api: Api, value: z.infer<typeof mutateFeature.input>) {
  const input = mutateFeature.input.parse(value);
  if (input.operation === "preferences.patch")
    return { data: await savePreferences(api, input.body) };
  let body: Row = input.body;
  if (input.operation === "signin.import" && Array.isArray(body.files)) {
    body = {
      ...body,
      files: await Promise.all(
        body.files.map(async (file) => {
          if (typeof file !== "string") throw new MagpieApiError("账号文件需要文本路径。");
          if (!file.startsWith("/") && !file.startsWith("~/")) return file;
          const path = file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file;
          const metadata = await stat(path);
          if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
            throw new MagpieApiError("账号文件不能超过 8 MiB。");
          return readFile(path, "utf8");
        }),
      ),
    };
  }
  if (input.operation === "gateway.key.limit" && !("limit" in body)) {
    const { key, index, ...limit } = body;
    body = { key, index: index ?? 0, limit };
  }
  if (input.operation === "backup.import") {
    if (typeof body.path !== "string" || !body.path) throw new MagpieApiError("请输入备份路径。");
    const path = body.path.startsWith("~/") ? `${homedir()}/${body.path.slice(2)}` : body.path;
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024)
      throw new MagpieApiError("备份需要是 64 MiB 以内的文件。");
    body = { ...body, data: (await readFile(path)).toString("base64") };
    delete body.path;
  }
  if (input.operation === "sync.save") {
    body = { ...body };
    const kind = body.kind;
    let url = String(body.url || "").trim();
    const folder = String(body.folder || "").replace(/^\/+|\/+$/g, "");
    if (kind === "github" && !url.startsWith("github://"))
      url = `github://${url.replace(/^https:\/\/github.com\//i, "").replace(/\.git$/, "")}${
        folder ? `/${folder}` : ""
      }`;
    if (kind === "s3" && !url.startsWith("s3://")) url = `s3://${url}${folder ? `/${folder}` : ""}`;
    body.url = url;
    delete body.kind;
    delete body.folder;
  }
  if (
    ["library.hooks.save", "library.subagents.save", "library.servers.save"].includes(
      input.operation,
    )
  ) {
    const container =
      input.operation === "library.hooks.save"
        ? "hook"
        : input.operation === "library.subagents.save"
        ? "subagent"
        : "server";
    const data = row(await api.request("/api/library?glance=1"));
    const collection =
      container === "hook" ? "hooks" : container === "subagent" ? "subagents" : "servers";
    const existing = Array.isArray(data[collection])
      ? data[collection].map(row).find((r) => r.name === body.old)
      : undefined;
    const { old = "", ...changes } = body;
    const updated: Row = { ...existing };
    for (const [key, value] of Object.entries(changes)) assignPath(updated, key, value);
    body = { old, [container]: updated };
  }
  if (input.operation === "library.instructions" && typeof body.set === "string") {
    body = { texts: { [body.set]: String(body.text || "") } };
  }
  if (input.operation === "library.sets.save" && typeof body.name === "string") {
    body = {
      create: {
        id: `s${Date.now().toString(36)}`,
        name: body.name,
        ...(body.file ? { file: body.file } : {}),
      },
    };
  }
  if (["provider.save", "provider.modelprefs"].includes(input.operation)) {
    const providers = row(await api.request("/api/providers")).providers;
    const existing = Array.isArray(providers)
      ? providers.map(row).find((p) => p.id === body.id)
      : undefined;
    if (!existing) throw new MagpieApiError("供应商不存在，请刷新。");
    if (input.operation === "provider.modelprefs") {
      const { id, model, ...changes } = body;
      if (typeof model !== "string" || !model) throw new MagpieApiError("请选择模型。");
      const pref: Row = {};
      const modelRow = Array.isArray(existing.models)
        ? existing.models.map(row).find((entry) => entry.id === model)
        : undefined;
      if (Object.keys(changes).some((key) => key.startsWith("price.")))
        pref.price = { ...row(modelRow?.price || modelRow?.list) };
      const limits: Row = {};
      for (const [key, value] of Object.entries(changes)) {
        const map = (
          { context: "contexts", output: "outputs", compact: "compacts" } as Record<string, string>
        )[key];
        if (map) limits[map] = { ...row(existing[map]), [model]: value };
        else assignPath(pref, key, value);
      }
      body = { id, ...limits, modelPrefs: { [model]: pref } };
    }
    body = { ...existing, ...body, key: typeof body.key === "string" ? body.key : "", new: false };
    body.models = existing.chosen || [];
    if (typeof body.balanceToken !== "string") body.balanceToken = "";
  }
  if (
    ["plugins.options", "plugin-pages.options"].includes(input.operation) &&
    body.options !== null &&
    body.options !== undefined
  ) {
    let current: unknown;
    if (input.operation === "plugin-pages.options")
      current = await api.request("/api/plugin-pages/options", { spec: body.spec });
    else {
      const plugins = row(await api.request("/api/plugins")).plugins;
      current = (
        Array.isArray(plugins)
          ? plugins.map(row).find((plugin) => plugin.spec === body.spec)
          : undefined
      )?.options;
    }
    body = { ...body, options: restoreHidden(row(current), row(body.options)) };
  }
  if (input.operation === "groups.save") {
    const groups = row(await api.request("/api/groups")).groups;
    const existing = Array.isArray(groups)
      ? groups.map(row).find((g) => g.id === body.id)
      : undefined;
    if (!existing) throw new MagpieApiError("路由组不存在，请刷新。");
    body = { ...existing, ...body };
  }
  let path: string = operationRoutes[input.operation];
  if (path.includes("{id}")) {
    if (typeof body.id !== "string" || !body.id || /[\\/]/.test(body.id))
      throw new MagpieApiError("无效的资源 ID。");
    path = path.replace("{id}", encodeURIComponent(body.id));
    body = { ...body };
    delete body.id;
  }
  if (
    ["quota.refresh", "usage.export", "sessions.export", "archive.export"].includes(input.operation)
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body))
      if (queryNames.has(key) && typeof value === "string") params.set(key, value);
    if (params.size) path += `?${params}`;
  }
  const result = await api.request(`/api/${path}`, body);
  const data = row(result);
  // A sync can return HTTP 200 while reporting a failed transfer.
  if (typeof data.error === "string" && data.error) throw new MagpieApiError(data.error);
  if (input.operation === "sessions.relocate" && typeof data.token === "string")
    return { data: { ...row(publicData(result)), token: data.token } };
  return { data: publicData(result) };
}

// Options are projected without credentials. Editing visible options must retain
// hidden credential values; an explicit null still clears the whole option set.
function restoreHidden(current: Row, changed: Row): Row {
  const next = { ...changed };
  for (const [key, value] of Object.entries(current)) {
    if (!(key in row(publicData({ [key]: value })))) next[key] = value;
    else if (key in next && value && typeof value === "object" && !Array.isArray(value))
      next[key] = restoreHidden(row(value), row(next[key]));
  }
  return next;
}
