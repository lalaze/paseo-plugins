import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { Row } from "../shared/features";
import type { PreferenceField } from "../shared/preferences";
import {
  ActionButton,
  DataView,
  FeatureStatus,
  ObjectForm,
  record,
  rows,
  str,
  useFeature,
  useFeatureMutation,
} from "./features";
import { Banner, Button, Card, CopyButton, Field, Segments, useUi } from "./kit";

const hookFields: PreferenceField[] = [
  { key: "name", label: "Hook 名称", kind: "text" },
  { key: "description", label: "说明", kind: "text" },
  {
    key: "event",
    label: "触发事件",
    kind: "choice",
    choices: [
      ["turn-end", "轮次结束"],
      ["prompt", "发送提示词"],
      ["session-start", "会话开始"],
      ["before-tool", "工具调用前"],
      ["after-tool", "工具调用后"],
    ],
  },
  { key: "matcher", label: "工具匹配规则", kind: "text" },
  { key: "command", label: "执行命令", kind: "multiline" },
  { key: "timeout", label: "超时（秒）", kind: "number" },
  { key: "agents", label: "分发给 Agent（一行一个 ID）", kind: "lines" },
];
const subagentFields: PreferenceField[] = [
  { key: "name", label: "子 Agent 名称", kind: "text" },
  { key: "description", label: "说明", kind: "multiline" },
  { key: "prompt", label: "提示词", kind: "multiline" },
  { key: "skills", label: "使用的技能（一行一个）", kind: "lines" },
  { key: "mcp", label: "使用的 MCP（一行一个）", kind: "lines" },
  { key: "agents", label: "分发给 Agent（一行一个 ID）", kind: "lines" },
];
const mcpFields: PreferenceField[] = [
  { key: "name", label: "MCP 名称", kind: "text" },
  { key: "description", label: "说明", kind: "text" },
  {
    key: "transport",
    label: "协议",
    kind: "choice",
    choices: [
      ["http", "Streamable HTTP"],
      ["sse", "SSE"],
      ["stdio", "stdio"],
    ],
  },
  { key: "command", label: "命令", kind: "text" },
  { key: "args", label: "参数（一行一个）", kind: "lines" },
  { key: "url", label: "地址", kind: "text" },
  { key: "headers", label: "Headers（不修改则保留）", kind: "json" },
  { key: "env", label: "环境变量（不修改则保留）", kind: "json" },
  { key: "agents", label: "分发给 Agent（一行一个 ID）", kind: "lines" },
  { key: "oauth.clientId", label: "OAuth 应用 Client ID（可选）", kind: "text" },
  { key: "oauth.clientSecret", label: "OAuth 应用 Client Secret（留空保留）", kind: "secret" },
  { key: "oauth.callbackPort", label: "OAuth 回调端口（0 自动）", kind: "number" },
  { key: "disabledTools", label: "停用的工具（一行一个）", kind: "lines" },
];
export function LibraryAdvanced() {
  const { s } = useUi();
  const [tab, setTab] = useState("instructions");
  const query = useFeature(
    "library",
    tab === "skills" || tab === "projects" ? {} : { glance: "1" },
  );
  const rtk = useFeature("rtk", {}, tab === "rtk");
  const data = record(query.data);
  const instructions = record(data.instructions);
  const hooks = hookFields.map((field) =>
    field.key === "event"
      ? {
          ...field,
          choices: [
            ...(field.choices || []),
            ...rows(data.hookAgents)
              .filter((a) => !a.no)
              .flatMap((a) =>
                (Array.isArray(a.events) ? a.events : []).map(
                  (event) => [`${a.id}:${event}`, `${a.name || a.id} · ${event}`] as const,
                ),
              ),
          ],
        }
      : field,
  );
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>资源库管理</Text>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { value: "instructions", label: "指令" },
            { value: "mcp", label: "MCP 配置" },
            { value: "skills", label: "技能管理" },
            { value: "hooks", label: "Hooks" },
            { value: "subagents", label: "子 Agent" },
            { value: "rtk", label: "RTK" },
            { value: "projects", label: "项目" },
            { value: "market", label: "发现" },
          ]}
        />
      </Card>
      <FeatureStatus query={query} />
      {rows(data.problems).length ? (
        <Card>
          <Text style={s.sectionTitle}>分发问题</Text>
          <DataView data={data.problems} />
        </Card>
      ) : null}
      {tab === "instructions" ? (
        <>
          <ObjectForm
            title="新建指令集"
            operation="library.sets.save"
            data={{}}
            fields={[
              { key: "name", label: "指令集名称", kind: "text" },
              { key: "file", label: "关联主机文件（可选）", kind: "text" },
            ]}
          />
          {rows(instructions.sets).map((set) => (
            <Card key={str(set.id)}>
              <ObjectForm
                title={str(set.name) || "共享指令"}
                operation="library.instructions"
                fixed={{ set: set.id }}
                data={set}
                fields={[{ key: "text", label: "共享指令 Markdown", kind: "multiline" }]}
              />
              {!set.active ? (
                <ActionButton
                  operation="library.instructions"
                  label="设为当前指令集"
                  body={{ activate: set.id }}
                />
              ) : (
                <Text style={s.small}>当前指令集</Text>
              )}
              <ObjectForm
                title="指令集改名"
                operation="library.instructions"
                data={{ rename: { id: set.id, name: set.name } }}
                fields={[{ key: "rename", label: "指令集 ID 与名称", kind: "json" }]}
              />
              <ActionButton
                operation="library.instructions"
                label="删除指令集"
                body={{ remove: set.id }}
                confirm
              />
            </Card>
          ))}
          <ObjectForm
            title="指令分发与各 Agent 补充"
            operation="library.instructions"
            data={{
              agents: rows(instructions.agents)
                .filter((a) => a.on)
                .map((a) => a.agent),
              extra: Object.fromEntries(
                rows(instructions.agents).map((a) => [str(a.agent), a.extra || ""]),
              ),
            }}
            fields={[
              { key: "agents", label: "接收共享指令的 Agent（一行一个 ID）", kind: "lines" },
              { key: "extra", label: "各 Agent 补充指令（Agent ID → 文本）", kind: "json" },
            ]}
          />
          {rows(instructions.agents).map((a) => (
            <Card key={str(a.agent)}>
              <Text style={s.cardTitle}>{str(a.name)}</Text>
              <Text style={s.small}>{str(a.path)}</Text>
              <ActionButton
                operation="library.instructions.import"
                label="将此 Agent 自有指令移入共享文本"
                body={{ name: a.agent }}
                confirm
              />
              <ActionButton
                operation="library.instructions"
                label="重新写入共享指令"
                body={{ rewrite: [a.agent] }}
              />
            </Card>
          ))}
        </>
      ) : tab === "hooks" || tab === "subagents" ? (
        <>
          <ObjectForm
            key={`new-${tab}`}
            title={tab === "hooks" ? "新建 Hook" : "新建子 Agent"}
            operation={tab === "hooks" ? "library.hooks.save" : "library.subagents.save"}
            data={{ event: "turn-end", agents: rows(data.agents).map((a) => a.id) }}
            fixed={{ old: "" }}
            fields={tab === "hooks" ? hooks : subagentFields}
          />
          {rows(data[tab]).map((item) => (
            <Card key={str(item.name)}>
              <ObjectForm
                title={str(item.name)}
                data={item}
                fixed={{ old: item.name }}
                operation={tab === "hooks" ? "library.hooks.save" : "library.subagents.save"}
                fields={tab === "hooks" ? hooks : subagentFields}
              />
              <ActionButton
                operation={tab === "hooks" ? "library.hooks.remove" : "library.subagents.remove"}
                label={tab === "hooks" ? "删除 Hook" : "删除子 Agent"}
                body={{ name: item.name }}
                confirm
              />
            </Card>
          ))}
          <Card>
            <Text style={s.sectionTitle}>Agent 支持情况</Text>
            <DataView data={tab === "hooks" ? data.hookAgents : data.subagentAgents} />
          </Card>
        </>
      ) : tab === "mcp" ? (
        <>
          {rows(data.servers).map((server) => (
            <Card key={str(server.name)}>
              <ObjectForm
                title={`编辑 ${server.name}`}
                operation="library.servers.save"
                data={server}
                fixed={{ old: server.name }}
                fields={mcpFields}
              />
              <ActionButton
                operation="library.mcp.check"
                label="检查 MCP 连接与工具"
                body={{ names: [server.name], fresh: true }}
                showResult
              />
              {server.transport === "http" ? <McpSignIn server={server} /> : null}
              {server.oauth ? (
                <ActionButton
                  operation="library.servers.save"
                  label="移除此 MCP 的 OAuth 应用配置"
                  body={{ old: server.name, oauth: null }}
                  confirm
                />
              ) : null}
              <ActionButton
                operation="library.mcp.signout"
                label="退出 MCP 账号"
                body={{ name: server.name }}
                confirm
              />
            </Card>
          ))}
          <ObjectForm
            title="导出项目 MCP 配置"
            operation="library.mcp.config"
            data={{}}
            fields={[
              { key: "agent", label: "项目的 Agent ID", kind: "text" },
              { key: "names", label: "MCP 名称（一行一个）", kind: "lines" },
            ]}
          />
          <Card>
            <Text style={s.sectionTitle}>从 Agent 中发现的 MCP</Text>
            {rows(data.foundServers).map((found, index) => {
              const server = record(found.server);
              return (
                <Card key={str(server.name) || index}>
                  <Text style={s.cardTitle}>{str(server.name)}</Text>
                  <DataView data={found} />
                  <ActionButton
                    operation="library.servers.import"
                    label={`导入发现的 MCP ${server.name}`}
                    body={{ name: server.name }}
                    showResult
                  />
                  <ActionButton
                    operation="library.servers.remove-found"
                    label={`移除发现的 MCP ${server.name}`}
                    body={{ name: server.name }}
                    confirm
                  />
                </Card>
              );
            })}
          </Card>
        </>
      ) : tab === "rtk" ? (
        <>
          <FeatureStatus query={rtk} />
          <Card>
            <DataView data={rtk.data} />
            <ActionButton operation="library.rtk.install" label="安装 RTK" showResult />
            <ActionButton operation="library.rtk.upgrade" label="更新 RTK" showResult />
            <ActionButton operation="library.rtk.path" label="将 RTK 加入 Agent PATH" showResult />
          </Card>
          {rows(record(rtk.data).agents).map((agent) => (
            <Card key={str(agent.id)}>
              <Text style={s.cardTitle}>{str(agent.name) || str(agent.id)}</Text>
              <ActionButton
                operation="library.rtk.set"
                label={agent.on ? "为此 Agent 关闭 RTK" : "为此 Agent 启用 RTK"}
                body={{ agent: agent.id, on: !agent.on }}
              />
            </Card>
          ))}
        </>
      ) : tab === "skills" ? (
        <>
          <ActionButton operation="library.skills.check" label="检查技能更新" showResult />
          <ActionButton operation="library.skills.regroup" label="按来源重新分组技能" showResult />
          {rows(data.skills).map((skill) => (
            <Card key={str(skill.name)}>
              <Text style={s.cardTitle}>{str(skill.name)}</Text>
              <DataView data={skill} />
              <ActionButton
                operation="library.skills.update"
                label={`更新技能 ${skill.name}`}
                body={{ names: [skill.name] }}
                showResult
              />
              <ActionButton
                operation="library.skills.replace"
                label={`覆盖本机修改并更新 ${skill.name}`}
                body={{ name: skill.name, replace: true }}
                confirm
                showResult
              />
            </Card>
          ))}
          <ActionButton
            operation="library.skills.update-all"
            label="更新全部技能"
            confirm
            showResult
          />
          <ObjectForm
            title="探测技能来源"
            operation="library.skills.probe"
            data={{}}
            fields={[{ key: "source", label: "技能仓库或目录", kind: "text" }]}
          />
          <ObjectForm
            title="安装指定技能"
            operation="library.skills.install"
            data={{}}
            fields={[
              { key: "source", label: "仓库或目录", kind: "text" },
              { key: "paths", label: "来源中的技能路径（一行一个，空表示全部）", kind: "lines" },
              { key: "agents", label: "接收 Agent（一行一个 ID）", kind: "lines" },
            ]}
          />
          <ObjectForm
            title="导入 Agent 已有技能"
            operation="library.skills.import"
            data={{}}
            fields={[{ key: "names", label: "导入的技能名称（一行一个）", kind: "lines" }]}
          />
          <ObjectForm
            title="技能分组"
            operation="library.skills.group"
            data={{}}
            fields={[
              { key: "name", label: "组名称", kind: "text" },
              { key: "names", label: "技能名称（一行一个）", kind: "lines" },
            ]}
          />
          <ObjectForm
            title="取消技能分组"
            operation="library.skills.ungroup"
            data={{}}
            fields={[
              { key: "name", label: "组名称", kind: "text" },
              { key: "names", label: "技能名称（一行一个）", kind: "lines" },
            ]}
          />
          <ObjectForm
            title="技能分发方式"
            operation="library.skills.how"
            data={{}}
            fields={[
              { key: "agent", label: "Agent ID", kind: "text" },
              {
                key: "how",
                label: "方式",
                kind: "choice",
                choices: [
                  ["link", "链接"],
                  ["copy", "复制"],
                ],
              },
            ]}
          />
          <Card>
            <Text style={s.sectionTitle}>发现的技能</Text>
            {rows(data.foundSkills).map((skill, index) => (
              <Card key={str(skill.name) || index}>
                <Text style={s.cardTitle}>{str(skill.name)}</Text>
                <DataView data={skill} />
                <ActionButton
                  operation="library.skills.import"
                  label={`导入技能 ${skill.name}`}
                  body={{ names: [skill.name] }}
                  showResult
                />
                <ActionButton
                  operation="library.skills.remove-found"
                  label={`移除发现的技能 ${skill.name}`}
                  body={{ name: skill.name }}
                  confirm
                />
              </Card>
            ))}
            {rows(data.newSkills).map((skill, index) => (
              <Card key={str(skill.name) || index}>
                <DataView data={skill} />
                <ActionButton
                  operation="library.skills.add-new"
                  label={`收录新技能 ${skill.name}`}
                  body={{ names: [skill.id] }}
                  showResult
                />
                <ActionButton
                  operation="library.skills.ignore-new"
                  label={`忽略新技能 ${skill.name}`}
                  body={{ names: [skill.id] }}
                />
              </Card>
            ))}
            <DataView data={data.skillGroups} />
          </Card>
        </>
      ) : tab === "projects" ? (
        <>
          <ObjectForm
            title="添加项目"
            operation="library.projects.add"
            data={{}}
            fields={[{ key: "dir", label: "主机上的项目绝对路径", kind: "text" }]}
          />
          {rows(data.projects).map((project) => (
            <Card key={str(project.dir)}>
              <Text style={s.cardTitle}>{str(project.dir)}</Text>
              <DataView data={project} />
              <ObjectForm
                title="项目分发方式"
                operation="library.projects.copy"
                fixed={{ dir: project.dir }}
                data={project}
                fields={[{ key: "copy", label: "分发副本（关闭则链接）", kind: "boolean" }]}
              />
              {(["skill", "server"] as const).map((kind) => (
                <ObjectForm
                  key={kind}
                  title={kind === "skill" ? "项目技能" : "项目 MCP"}
                  operation={
                    kind === "skill" ? "library.projects.skill" : "library.projects.server"
                  }
                  fixed={{ dir: project.dir }}
                  data={{}}
                  fields={[
                    { key: "name", label: "资源库条目名称", kind: "text" },
                    { key: "agents", label: "Agent ID（一行一个）", kind: "lines" },
                  ]}
                />
              ))}
              <ActionButton
                operation="library.projects.remove"
                label="移除项目配置"
                body={{ dir: project.dir, keep: false }}
                confirm
              />
            </Card>
          ))}
        </>
      ) : (
        <LibraryMarket />
      )}
      <Card>
        <View style={s.row}>
          <ActionButton
            operation="library.reveal"
            label="在主机打开资源库"
            body={{ path: data.dir || "" }}
          />
          <ActionButton
            operation="library.reveal"
            label="在主机打开备份"
            body={{ path: data.backups || "" }}
          />
          <ActionButton operation="library.sync" label="重新分发全部资源" confirm />
        </View>
      </Card>
    </>
  );
}
function LibraryMarket() {
  const { s } = useUi();
  const [kind, setKind] = useState("servers");
  const [query, setQuery] = useState("");
  const result = useFeature("libraryMarket", { kind, q: query });
  return (
    <>
      <Card>
        <Segments
          value={kind}
          onChange={setKind}
          options={[
            { value: "servers", label: "MCP 市场" },
            { value: "skills", label: "技能市场" },
          ]}
        />
        <Field label="搜索资源市场" value={query} onChange={setQuery} />
      </Card>
      <FeatureStatus query={result} />
      {record(result.data).error ? <Banner error>{str(record(result.data).error)}</Banner> : null}
      {rows(record(result.data).items).map((item, index) => (
        <Card key={str(item.id) || index}>
          <Text style={s.cardTitle}>{str(item.name) || str(item.id)}</Text>
          <DataView data={item} />
          <MarketInstall kind={kind} item={item} />
        </Card>
      ))}
    </>
  );
}

function McpSignIn({ server }: { server: Row }) {
  const { s, hostId } = useUi();
  const mutation = useFeatureMutation();
  const cache = useQueryClient();
  const [id, setId] = useState("");
  const [initial, setInitial] = useState<Row>({});
  const [following, setFollowing] = useState(false);
  const query = useFeature("mcpSigninStatus", { id }, Boolean(id), following);
  const state = query.data ? record(query.data) : initial;
  const phase = str(state.state);
  useEffect(() => {
    if (!["done", "failed", "canceled"].includes(phase)) return;
    setFollowing(false);
    if (phase === "done")
      void cache.invalidateQueries({ queryKey: ["magpie-feature", hostId, "library"] });
  }, [phase, cache, hostId]);
  const begin = async () => {
    const value = await mutation.execute("library.mcp.signin", { name: server.name });
    if (value) setFollowing(true);
  };
  useEffect(() => {
    const value = record(mutation.result);
    if (value.id && value.state) {
      setInitial(value);
      setId(str(value.id));
    }
  }, [mutation.result]);
  return (
    <View style={s.section}>
      <Text style={s.label}>MCP 账号授权</Text>
      {following ? (
        <>
          <Text style={s.muted}>请在浏览器完成授权，授权状态会自动更新。</Text>
          {state.url ? (
            <View style={s.row}>
              <ExternalLink href={str(state.url)}>打开 MCP 授权页面</ExternalLink>
              <CopyButton label="复制 MCP 授权链接" value={str(state.url)} />
            </View>
          ) : null}
          <Button
            label="取消 MCP 授权"
            disabled={mutation.busy}
            onPress={() => {
              void mutation.execute("library.mcp.cancel", { id }).then((ok) => {
                if (ok) {
                  setFollowing(false);
                  setId("");
                  setInitial({ state: "canceled" });
                }
              });
            }}
          />
        </>
      ) : (
        <Button
          label={record(server.signIn).signedIn ? "重新授权 MCP 账号" : "MCP 账号授权"}
          disabled={mutation.busy}
          onPress={() => {
            void begin();
          }}
        />
      )}
      {phase === "done" ? <Banner>MCP 授权完成，已分发给使用此服务的 Agent。</Banner> : null}
      {phase === "canceled" ? <Text style={s.muted}>授权已取消。</Text> : null}
      {state.error || mutation.error || query.error ? (
        <Banner error>{str(state.error) || mutation.error || query.error?.message}</Banner>
      ) : null}
    </View>
  );
}

function MarketInstall({ kind, item }: { kind: string; item: Row }) {
  const { s } = useUi();
  const mutation = useFeatureMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState("");
  const [error, setError] = useState("");
  const inputs = rows(item.inputs);
  return (
    <View style={s.section}>
      {inputs.map((input) => (
        <View key={str(input.key)} style={s.section}>
          <Field
            label={str(input.label) || str(input.key)}
            secure={Boolean(input.secret)}
            value={values[str(input.key)] || ""}
            placeholder={str(input.placeholder)}
            onChange={(value) => setValues({ ...values, [str(input.key)]: value })}
          />
          <Text style={s.small}>
            {str(input.description)}
            {input.required ? "（必填）" : ""}
          </Text>
        </View>
      ))}
      <Field label="接收 Agent ID（一行一个）" value={agents} multiline onChange={setAgents} />
      <Button
        label={`安装 ${str(item.title) || str(item.name) || str(item.id)}`}
        disabled={mutation.busy || Boolean(item.have)}
        onPress={() => {
          if (inputs.some((input) => input.required && !values[str(input.key)]?.trim())) {
            setError("请填写必需参数。");
            return;
          }
          setError("");
          void mutation.execute(
            kind === "servers" ? "library.market.server" : "library.market.skill",
            {
              id: kind === "servers" ? item.id : item.skillId || item.id,
              ...(kind === "skills" ? { source: item.source || "" } : { values }),
              agents: agents
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
            },
          );
        }}
      />
      {error || mutation.error ? <Banner error>{error || mutation.error}</Banner> : null}
      {mutation.result !== undefined ? <Banner>已安装到资源库。</Banner> : null}
    </View>
  );
}
