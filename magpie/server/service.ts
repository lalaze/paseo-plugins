import { z } from "zod";
import {
  actionSchema,
  pageDataSchema,
  readPage,
  signInSchema,
  readTranscript,
  readPluginCatalog,
  type Action,
} from "../shared/rpc";
import { MagpieApiError } from "./api";

export interface Api {
  request(path: string, body?: object): Promise<unknown>;
}
type ReadInput = z.infer<typeof readPage.input>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MagpieApiError("Magpie 返回了无法识别的数据格式。");
  return value as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new MagpieApiError("Magpie 返回了无法识别的列表格式。");
  return value.map(object);
}
function string(value: unknown) {
  return typeof value === "string" ? value : "";
}
function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function nils(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(nils);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, nils(v)]),
    );
  return value;
}
function provider(row: Record<string, unknown>) {
  return {
    ...row,
    keyMasked: row.key && typeof row.key === "object" ? string(object(row.key).masked) : "",
    keys: row.keyList,
    logins: row.account && typeof row.account === "object" ? object(row.account).logins : [],
    accountAgent: row.account && typeof row.account === "object" ? object(row.account).agent : "",
    models: list(row.models).map((m) => ({ ...m, name: string(m.name) || string(m.id) })),
  };
}
function calls(gateway: Record<string, unknown>) {
  return {
    ...gateway,
    calls: list(gateway.calls).map((c) => ({
      ...c,
      ...(c.usage && typeof c.usage === "object"
        ? { input: object(c.usage).input, output: object(c.usage).output }
        : {}),
    })),
  };
}

export async function pluginCatalog(api: Api, value: z.infer<typeof readPluginCatalog.input>) {
  const input = readPluginCatalog.input.parse(value);
  const q = input.query.trim();
  if (input.source === "npm" && q.length < 2) return { items: [] };
  const path =
    input.source === "suggested"
      ? "/api/plugins/listings"
      : input.source === "github"
        ? "/api/plugins/github"
        : `/api/plugins/search?q=${encodeURIComponent(q)}`;
  const data = object(await api.request(path));
  const rows = list(
    input.source === "suggested"
      ? data.listings
      : input.source === "github"
        ? data.repos
        : data.hits,
  );
  const publicURL = (value: unknown) => {
    try {
      const u = new URL(string(value));
      return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : "";
    } catch {
      return "";
    }
  };
  return readPluginCatalog.output.parse({
    items: rows.flatMap((row) => {
      const github = input.source === "github";
      const metadata = input.source === "suggested" && row.npm ? object(row.npm) : row;
      const summary = row.summary && typeof row.summary === "object" ? object(row.summary) : {};
      const spec = string(github ? row.spec : row.package);
      if (!spec) return [];
      return [
        {
          spec,
          name: string(row.name) || (github ? string(row.repo).split("/").pop() : "") || spec,
          description:
            string(summary.zh) ||
            string(summary.en) ||
            string(row.description) ||
            string(metadata.description),
          kind: string(row.kind) || "provider",
          community: Boolean(row.community),
          source: input.source,
          version: string(metadata.version),
          publisher: string(github ? row.owner : metadata.publisher),
          repository: publicURL(github ? row.url : metadata.repository),
          providers: strings(row.providers),
          weekly:
            typeof metadata.weekly === "number" && Number.isFinite(metadata.weekly)
              ? metadata.weekly
              : 0,
        },
      ];
    }),
  });
}

export async function loadPage(api: Api, input: ReadInput) {
  const out: Record<string, unknown> = { page: input.page, notices: [] };
  const notices: string[] = [];
  const read = async (path: string) => object(await api.request(path));
  switch (input.page) {
    case "agents": {
      const state = await read("/api/state");
      out.agents = list(state.agents).map((a) => ({
        ...a,
        drift: Boolean(a.drift),
        fields: list(a.fields).map((f) => ({
          ...f,
          label: string(f.label) || string(f.key),
          options: list(f.options).map((o) => ({
            ...o,
            label: string(o.label) || string(o.value) || "默认",
          })),
        })),
      }));
      out.profiles = state.profiles;
      if (state.notice) notices.push(string(state.notice));
      break;
    }
    case "providers":
    case "gateway": {
      const data = await read("/api/providers");
      out.providers = list(data.providers).map(provider);
      out.presets = data.presets;
      if (data.gateway) out.gateway = calls(object(data.gateway));
      if (data.fileError) notices.push(string(data.fileError));
      break;
    }
    case "routing": {
      const data = await read("/api/groups");
      out.groups = list(data.groups).map((g) => ({ ...g, disabled: Boolean(g.disabled) }));
      out.models = list(data.models).map((m) => ({
        value: m.id,
        label: `${string(m.name)} · ${string(m.providerName)}`,
        note: string(m.id),
      }));
      break;
    }
    case "usage": {
      const data = await read(`/api/usage?period=${input.period}`);
      out.usage = data;
      if (input.quotas) {
        try {
          const quotas = await api.request("/api/usage/quotas");
          out.quotas = Array.isArray(quotas) ? quotas : object(quotas).quotas;
        } catch (error) {
          notices.push(error instanceof Error ? error.message : "额度读取失败。");
        }
      }
      break;
    }
    case "sessions": {
      const data = await read("/api/sessions");
      const query = input.query.trim().toLowerCase();
      const sessions = list(data.sessions).filter(
        (s) =>
          !query ||
          [s.title, s.cwd, s.name, s.agent, s.id].some((v) =>
            string(v).toLowerCase().includes(query),
          ),
      );
      out.total = sessions.length;
      out.sessions = sessions
        .slice(0, input.limit)
        .map((s) => ({ ...s, title: string(s.title) || "未命名会话" }));
      break;
    }
    case "library": {
      try {
        const data = await read("/api/library?glance=1");
        const item = (row: Record<string, unknown>) => ({
          ...row,
          source:
            row.source && typeof row.source === "object"
              ? string(object(row.source).repo) || string(object(row.source).dir)
              : string(row.source),
          agents: strings(row.agents),
        });
        out.library = {
          ...data,
          servers: list(data.servers).map(item),
          skills: list(data.skills).map(item),
        };
      } catch (error) {
        if (!(error instanceof MagpieApiError) || error.status !== 404) throw error;
        notices.push("Magpie 的资料库功能尚未启用，可在下方启用内置资料库插件。");
        const settings = await read("/api/settings");
        out.builtins = settings.builtins;
      }
      break;
    }
    case "plugins": {
      const [data, settings] = await Promise.all([read("/api/plugins"), read("/api/settings")]);
      out.plugins = list(data.plugins).map((p) => ({
        ...p,
        name: string(p.name) || string(p.spec),
      }));
      out.builtins = settings.builtins;
      if (data.error) notices.push(string(data.error));
      break;
    }
    case "settings": {
      const settings = await read("/api/settings");
      out.settings = settings;
      break;
    }
  }
  out.notices = notices;
  // This projection drops upstream-only fields, including headers, raw settings and auth data.
  return pageDataSchema.parse(nils(out));
}

export async function act(api: Api, value: Action) {
  const action = actionSchema.parse(value);
  let result: unknown;
  const post = (path: string, body: object = {}) => api.request(`/api/${path}`, body);
  switch (action.type) {
    case "agent.set":
      result = await post("set", { agent: action.id, field: action.field, value: action.value });
      break;
    case "agent.connect":
    case "agent.disconnect":
    case "agent.reapply":
      result = await post(`agents/${action.type.split(".")[1]}/${encodeURIComponent(action.id)}`);
      break;
    case "agents.rescan":
      result = await post("agents/rescan");
      break;
    case "profile":
      result = await post(`profile/${action.operation === "apply" ? "use" : action.operation}`, {
        name: action.name,
      });
      break;
    case "provider.save": {
      const draft = action.draft;
      const data = object(await api.request("/api/providers"));
      const existing = action.fresh
        ? undefined
        : list(data.providers).find((p) => p.id === draft.id);
      if (!action.fresh && !existing) throw new MagpieApiError("提供商已不存在，请刷新后重试。");
      result = await post("provider/save", {
        ...existing,
        ...draft,
        ...(draft.id ? {} : { id: slug(draft.name) }),
        new: action.fresh,
      });
      break;
    }
    case "provider.toggle":
      result = await post(`provider/${action.on ? "on" : "off"}`, { id: action.id });
      break;
    case "provider.delete":
      result = await post("provider/delete", { id: action.id });
      break;
    case "provider.fetch":
      result = await post("provider/models", { id: action.id });
      break;
    case "key.add":
      result = await post("keys/add", { id: action.id, name: action.name, key: action.key });
      break;
    case "key.change":
      result = await post(`keys/${action.operation}`, { id: action.id, ref: action.ref });
      break;
    case "login.change":
      result = await post(
        `login/${action.operation === "use" ? "switch" : action.operation === "remove" ? "forget" : action.operation}`,
        { agent: action.id, user: action.user },
      );
      break;
    case "group.save": {
      const data = object(await api.request("/api/groups"));
      const existing = list(data.groups).find((g) => g.id === action.draft.id);
      result = await post("groups/save", { ...existing, ...action.draft });
      break;
    }
    case "group.delete":
      result = await post("groups/delete", { id: action.id });
      break;
    case "group.toggle":
      result = await post("groups/switch", { id: action.id, on: action.on });
      break;
    case "plugin.add":
      result = await post("plugins/add", { spec: action.spec });
      break;
    case "plugin.toggle":
      result = await post("plugins/off", { spec: action.spec, off: !action.on });
      break;
    case "plugin.remove":
      result = await post("plugins/remove", { spec: action.spec });
      break;
    case "plugin.upgrade":
      result = await post("plugins/upgrade", { spec: action.spec });
      break;
    case "builtin.toggle":
      result = await post("plugins/builtin", { id: action.id, on: action.on });
      break;
    case "settings.save": {
      const settings = object(await api.request("/api/settings"));
      result = await post("settings", { ...settings, ...action.settings });
      break;
    }
    case "library.server.save": {
      const data = object(await api.request("/api/library?glance=1"));
      const existing = list(data.servers).find((s) => s.name === action.old);
      result = await post("library/servers/save", {
        old: action.old,
        server: {
          ...existing,
          name: action.name,
          transport: action.transport,
          url: action.url,
          command: action.command,
          args: action.args,
          agents: action.agents,
        },
      });
      break;
    }
    case "library.distribute":
      result = await post(`library/${action.kind}/agents`, {
        name: action.name,
        agents: action.agents,
      });
      break;
    case "library.remove":
      result = await post(`library/${action.kind}/remove`, { name: action.name });
      break;
    case "library.skill.install":
      result = await post("library/skills/install", {
        source: action.source,
        agents: action.agents,
      });
      break;
  }
  const notice =
    result && typeof result === "object" && !Array.isArray(result)
      ? string(object(result).notice)
      : "";
  return { notice: notice || "已保存到 Magpie。" };
}

export function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || `provider-${Date.now().toString(36)}`
  );
}

export async function transcript(api: Api, input: z.infer<typeof readTranscript.input>) {
  const data = await api.request(
    `/api/sessions/transcript?agent=${encodeURIComponent(input.agent)}&id=${encodeURIComponent(input.id)}`,
  );
  return readTranscript.output.parse(nils(data));
}

export async function signin(
  api: Api,
  input:
    | { operation: "start"; agent: string }
    | { operation: "status" | "cancel"; id: string }
    | { operation: "callback"; id: string; url: string },
) {
  let data: unknown;
  switch (input.operation) {
    case "start":
      data = await api.request("/api/signin", { agent: input.agent });
      break;
    case "status":
      data = await api.request(`/api/signin/${encodeURIComponent(input.id)}`);
      break;
    case "cancel":
      await api.request(`/api/signin/${encodeURIComponent(input.id)}/cancel`, {});
      return signInSchema.parse({ id: input.id, state: "canceled" });
    case "callback":
      await api.request(`/api/signin/${encodeURIComponent(input.id)}/callback`, { url: input.url });
      return signInSchema.parse({ id: input.id, state: "waiting" });
  }
  return signInSchema.parse(nils(data));
}
