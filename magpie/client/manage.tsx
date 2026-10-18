import { useState } from "react";
import { Text, View } from "react-native";
import type { PageData, Settings } from "../shared/rpc";
import {
  Button,
  Card,
  Chip,
  ChoicePicker,
  ConfirmButton,
  CopyButton,
  Empty,
  Field,
  Segments,
  Toggle,
  useUi,
} from "./kit";

export function Builtins({ data, libraryOnly }: { data: PageData; libraryOnly?: boolean }) {
  const { s, run } = useUi();
  return (
    <>
      {data.builtins
        .filter((b) => !libraryOnly || b.id === "library")
        .map((b) => (
          <Card key={b.id}>
            <View style={s.between}>
              <View style={s.grow}>
                <Text style={s.cardTitle}>{b.name || b.id}</Text>
                <Text style={s.muted}>{b.sub}</Text>
                {b.why ? <Text style={s.small}>{b.why}</Text> : null}
              </View>
              <Toggle
                label={b.on ? "已启用" : "已停用"}
                value={b.on}
                disabled={b.on && b.inUse > 0}
                onChange={(on) => {
                  void run({ type: "builtin.toggle", id: b.id, on });
                }}
              />
            </View>
            {b.inUse > 0 ? <Text style={s.small}>{b.inUse} 项正在使用此功能</Text> : null}
          </Card>
        ))}
    </>
  );
}

export function SettingsPage({ settings }: { settings: Settings | null }) {
  if (!settings) return <Empty title="无法读取设置" icon="Settings" />;
  return (
    <SettingsForm
      key={`${settings.version}-${settings.theme}-${settings.lang}-${settings.currency}-${settings.proxy}-${settings.textSize}`}
      settings={settings}
    />
  );
}
function SettingsForm({ settings }: { settings: Settings }) {
  const { s, run } = useUi();
  const [draft, setDraft] = useState(settings);
  const options = (items: [string, string][]) =>
    items.map(([value, label]) => ({ value, label, note: "" }));
  const validSize = Number.isInteger(draft.textSize) && draft.textSize >= 0 && draft.textSize <= 30;
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>通用设置</Text>
        <Text style={s.muted}>
          主题、语言和字号控制 Magpie Web；插件使用原版配色，深浅模式跟随 Paseo。
        </Text>
        <View style={s.row}>
          <ChoicePicker
            label="Magpie 界面主题"
            value={draft.theme || "system"}
            options={options([
              ["system", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
            ])}
            onChange={(theme) => setDraft({ ...draft, theme })}
          />
          <ChoicePicker
            label="Magpie 界面语言"
            value={draft.lang || "system"}
            options={options([
              ["system", "跟随系统"],
              ["zh", "中文"],
              ["en", "English"],
            ])}
            onChange={(lang) => setDraft({ ...draft, lang })}
          />
        </View>
        <View style={s.row}>
          <ChoicePicker
            label="费用显示货币"
            value={draft.currency || "usd"}
            options={options([
              ["usd", "USD · 美元"],
              ["cny", "CNY · 人民币"],
            ])}
            onChange={(currency) => setDraft({ ...draft, currency })}
          />
          <Field
            label="Magpie 字号（0 使用默认）"
            value={String(draft.textSize)}
            onChange={(value) => setDraft({ ...draft, textSize: Number(value) })}
          />
        </View>
        <Field
          label="请求代理"
          value={draft.proxy}
          onChange={(proxy) => setDraft({ ...draft, proxy })}
          placeholder="留空使用默认代理；direct 直连；或 http://… / socks5://…"
        />
        <Button
          label="保存设置"
          icon="Check"
          primary
          disabled={!validSize}
          onPress={() => {
            void run({
              type: "settings.save",
              settings: {
                theme: draft.theme,
                lang: draft.lang,
                currency: draft.currency,
                proxy: draft.proxy,
                textSize: draft.textSize,
              },
            });
          }}
        />
      </Card>
      <Card>
        <Text style={s.sectionTitle}>关于此 Magpie 实例</Text>
        {[
          { label: "版本", value: settings.version },
          { label: "网关地址", value: settings.gateway },
          { label: "数据目录", value: settings.dir },
        ].map((row) => (
          <View key={row.label} style={s.between}>
            <View style={s.grow}>
              <Text style={s.label}>{row.label}</Text>
              <Text selectable style={s.text}>
                {row.value || "—"}
              </Text>
            </View>
            {row.value ? <CopyButton value={row.value} /> : null}
          </View>
        ))}
      </Card>
    </>
  );
}

export function LibraryPage({ data, query }: { data: PageData; query: string }) {
  const { s, run } = useUi();
  const [tab, setTab] = useState<"servers" | "skills">("servers");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [source, setSource] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const library = data.library;
  if (!library) return <Builtins data={data} libraryOnly />;
  const rows = library[tab].filter((item) =>
    `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <View style={s.between}>
        <Segments
          value={tab}
          options={[
            { value: "servers", label: `MCP 服务器 · ${library.servers.length}` },
            { value: "skills", label: `技能 · ${library.skills.length}` },
          ]}
          onChange={(value) => {
            setTab(value as typeof tab);
            setAdding(false);
          }}
        />
        <Button
          label={tab === "servers" ? "添加 MCP" : "安装技能"}
          icon="Plus"
          onPress={() => {
            setAdding(!adding);
            setAgents([]);
          }}
        />
      </View>
      {adding ? (
        <Card>
          <Text style={s.sectionTitle}>{tab === "servers" ? "添加 MCP 服务器" : "安装技能"}</Text>
          {tab === "servers" ? (
            <>
              <View style={s.row}>
                <Field label="服务器名称" value={name} onChange={setName} />
                <ChoicePicker
                  label="连接方式"
                  value={transport}
                  options={[
                    { value: "http", label: "Streamable HTTP", note: "" },
                    { value: "sse", label: "SSE", note: "" },
                    { value: "stdio", label: "本地命令", note: "" },
                  ]}
                  onChange={(v) => setTransport(v as typeof transport)}
                />
              </View>
              {transport === "stdio" ? (
                <>
                  <Field label="启动命令" value={command} onChange={setCommand} placeholder="npx" />
                  <Field label="命令参数（一行一个）" value={args} onChange={setArgs} multiline />
                </>
              ) : (
                <Field
                  label="服务器 URL"
                  value={url}
                  onChange={setUrl}
                  placeholder="https://example.com/mcp"
                />
              )}
            </>
          ) : (
            <Field
              label="技能来源"
              value={source}
              onChange={setSource}
              placeholder="GitHub 仓库链接或主机上的目录"
            />
          )}
          <Text style={s.label}>分发给 Agent</Text>
          <View style={s.row}>
            {library.agents.map((a) => (
              <Toggle
                key={a.id}
                label={a.name}
                value={agents.includes(a.id)}
                onChange={(on) =>
                  setAgents(on ? [...agents, a.id] : agents.filter((id) => id !== a.id))
                }
              />
            ))}
          </View>
          <View style={s.row}>
            <Button
              label={tab === "servers" ? "保存 MCP" : "安装技能"}
              primary
              disabled={
                tab === "servers"
                  ? !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())
                  : !source.trim()
              }
              onPress={() => {
                const action =
                  tab === "servers"
                    ? {
                        type: "library.server.save" as const,
                        old: "",
                        name,
                        transport,
                        url,
                        command,
                        args: args.split("\n").filter(Boolean),
                        agents,
                      }
                    : { type: "library.skill.install" as const, source, agents };
                void run(action).then((ok) => {
                  if (ok) {
                    setAdding(false);
                    setName("");
                    setSource("");
                  }
                });
              }}
            />
            <Button label="取消" onPress={() => setAdding(false)} />
          </View>
        </Card>
      ) : null}
      {!rows.length ? (
        <Empty
          title={tab === "servers" ? "没有匹配的 MCP 服务器" : "没有匹配的技能"}
          icon={tab === "servers" ? "Server" : "BookOpen"}
        />
      ) : null}
      {rows.map((item) => (
        <Card key={item.name}>
          <View style={s.between}>
            <View style={s.grow}>
              <Text style={s.cardTitle}>{item.name}</Text>
              <Text style={s.muted}>
                {item.description || item.url || item.command || item.source}
              </Text>
            </View>
            {item.transport ? <Chip label={item.transport} /> : null}
          </View>
          <View style={s.row}>
            {library.agents.map((a) => (
              <Toggle
                key={a.id}
                label={a.name}
                value={item.agents.includes(a.id)}
                onChange={(on) => {
                  void run({
                    type: "library.distribute",
                    kind: tab,
                    name: item.name,
                    agents: on ? [...item.agents, a.id] : item.agents.filter((id) => id !== a.id),
                  });
                }}
              />
            ))}
          </View>
          <ConfirmButton
            label={tab === "servers" ? "删除 MCP" : "删除技能"}
            onConfirm={() => {
              void run({ type: "library.remove", kind: tab, name: item.name });
            }}
          />
        </Card>
      ))}
      {library.dir ? <Text style={s.small}>Magpie 资料库 · {library.dir}</Text> : null}
    </>
  );
}
