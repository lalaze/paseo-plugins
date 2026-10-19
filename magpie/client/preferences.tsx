import { useState } from "react";
import { Text, View } from "react-native";
import { preferenceSections, type PreferenceField } from "../shared/preferences";
import {
  ObjectForm,
  FeatureStatus,
  ActionButton,
  DataView,
  record,
  rows,
  str,
  useFeature,
} from "./features";
import { Button, Card, ChoicePicker, CopyButton, Field, Segments, useUi } from "./kit";

export function AdvancedPreferences() {
  const { s } = useUi();
  const [section, setSection] = useState("general");
  const [search, setSearch] = useState("");
  const query = useFeature("preferences");
  const providers = useFeature("providers");
  const raw = record(query.data);
  const data: ReturnType<typeof record> = {
    ...raw,
    tray: raw.tray || "panel",
    plainNamesMode:
      raw.plainNamesMode || (raw.plainNames ? (raw.plainOwnNames ? "own" : "on") : "off"),
  };
  const models = rows(record(providers.data).providers).flatMap((p) =>
    rows(p.models).map((m) => ({
      value: `${p.id}/${m.id}`,
      label: `${str(m.name) || m.id} · ${p.name}`,
      note: "",
    })),
  );
  const selected = preferenceSections.find((s) => s.id === section)!;
  const fields = (
    search.trim() ? preferenceSections.flatMap((section) => section.fields) : selected.fields
  )
    .filter((f) => !["uiFont", "codeFont"].includes(f.key))
    .filter((f) => `${f.label} ${f.key}`.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>全部设置</Text>
        <Segments
          value={section}
          onChange={setSection}
          options={preferenceSections.map((s) => ({ value: s.id, label: s.label }))}
        />
        <Field
          label="搜索全部设置"
          value={search}
          onChange={setSearch}
          placeholder="名称或设置键，例如 Codex、提醒、模型"
        />
      </Card>
      <FeatureStatus query={query} />
      {query.data ? (
        <>
          {fields.length ? (
            <ObjectForm
              key={`${section}-${search.trim() ? "search" : "all"}`}
              title={search.trim() ? "搜索结果" : selected.label}
              fields={fields}
              data={data}
              models={models}
              operation="preferences.patch"
            />
          ) : null}
          {section === "general" ? (
            <Card>
              <Text style={s.muted}>
                字体发现属于 Magpie 桌面服务；Web 服务不提供主机字体列表。字体设置仅在桌面模式生效。
              </Text>
            </Card>
          ) : null}
          {section === "network" ? (
            <>
              <ObjectForm
                title="GitHub 访问令牌"
                data={{}}
                operation="settings.github-token"
                fields={[{ key: "token", label: "GitHub Token（留空移除）", kind: "secret" }]}
              />
              <Text style={s.small}>
                {str(data.githubTokenMask)} {str(data.githubTokenFrom)}
              </Text>
            </>
          ) : null}
          {section === "models" ? <SearchPreferences data={data} /> : null}
          {section === "otel" ? (
            <ActionButton
              operation="preferences.patch"
              label="清除 OTLP 认证 Headers"
              body={{ "otel.headers": null }}
              confirm
            />
          ) : null}
          {section === "usage" ? <AccountSchedules data={data} /> : null}
          {section === "sync" ? <SyncPreferences /> : null}
          {section === "about" ? (
            <Card>
              <Text style={s.sectionTitle}>主机与更新</Text>
              <DataView data={{ version: data.version, gateway: data.gateway, dir: data.dir }} />
              <ActionButton operation="settings.reveal" label="在主机打开配置目录" />
              <UpdateControls />
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function SearchPreferences({ data }: { data: ReturnType<typeof record> }) {
  const { s } = useUi();
  const list = rows(data.searchAPIs);
  return (
    <>
      <ObjectForm
        title="添加搜索服务"
        operation="settings.search-api"
        data={{}}
        fields={[
          {
            key: "vendor",
            label: "服务",
            kind: "choice",
            choices: [
              ["tavily", "Tavily"],
              ["brave", "Brave"],
              ["exa", "Exa"],
              ["firecrawl", "Firecrawl"],
              ["you", "You.com"],
              ["deepseek", "DeepSeek"],
              ["searxng", "SearXNG"],
            ],
          },
          { key: "key", label: "API 密钥", kind: "secret" },
          { key: "url", label: "服务地址（可选）", kind: "text" },
          {
            key: "pick",
            label: "密钥顺序",
            kind: "choice",
            choices: [
              ["", "轮换"],
              ["order", "依次使用"],
            ],
          },
        ]}
      />
      {list.map((api, index) => (
        <Card key={str(api.vendor) || index}>
          <Text style={s.cardTitle}>{str(api.name) || str(api.vendor)}</Text>
          <DataView data={api} />
          <ActionButton
            operation="settings.search-api"
            label={api.off ? "启用搜索服务" : "停用搜索服务"}
            body={{ vendor: api.vendor, on: Boolean(api.off) }}
          />
          {index > 0 ? (
            <ActionButton
              operation="settings.search-api"
              label="上移搜索服务"
              body={{
                arrange: [
                  ...list.slice(0, index - 1).map((a) => a.vendor),
                  api.vendor,
                  list[index - 1].vendor,
                  ...list.slice(index + 1).map((a) => a.vendor),
                ],
              }}
            />
          ) : null}
          <ActionButton
            operation="settings.search-quota"
            label="查询搜索额度"
            body={{ vendor: api.vendor, fresh: true }}
            showResult
          />
          <ActionButton
            operation="settings.search-api"
            label="移除搜索服务"
            body={{ vendor: api.vendor, remove: true }}
            confirm
          />
        </Card>
      ))}
      {[
        ["图片识别 MCP", "/mcp/magpie/vision"],
        ["联网搜索 MCP", "/mcp/magpie/search"],
      ].map(([label, path]) => (
        <Card key={path}>
          <Text style={s.cardTitle}>{label}</Text>
          <CopyButton value={`${str(data.gateway)}${path}`} />
        </Card>
      ))}
    </>
  );
}
function AccountSchedules({ data }: { data: ReturnType<typeof record> }) {
  const { s } = useUi();
  return (
    <>
      {(Array.isArray(data.codexUsers) ? data.codexUsers : []).map((user) => (
        <Card key={String(user)}>
          <Text style={s.cardTitle}>{String(user)}</Text>
          <ObjectForm
            title="账号每日预热"
            operation="settings.codex-warm-at"
            fixed={{ user }}
            data={{ at: record(data.codexWarmAtOf)[String(user)] }}
            fields={[{ key: "at", label: "每日预热时间", kind: "text" }]}
          />
          <ObjectForm
            title="自动使用重置"
            operation="settings.codex-auto-reset"
            fixed={{ user }}
            data={{
              on:
                Array.isArray(data.codexAutoReset) &&
                data.codexAutoReset.includes(String(user).toLowerCase()),
              when: record(data.codexAutoResetOnly)[String(user).toLowerCase()] || "",
            }}
            fields={[
              { key: "on", label: "自动使用重置", kind: "boolean" },
              {
                key: "when",
                label: "触发条件",
                kind: "choice",
                choices: [
                  ["", "额度不足或重置将过期"],
                  ["week", "额度不足时"],
                  ["expiring", "重置将过期时"],
                ],
              },
            ]}
          />
          <ObjectForm
            title="积分使用"
            operation="settings.codex-credits"
            fixed={{ user }}
            data={{
              on:
                !Array.isArray(data.codexNoCredits) ||
                !data.codexNoCredits.includes(String(user).toLowerCase()),
            }}
            fields={[{ key: "on", label: "允许使用付费积分", kind: "boolean" }]}
          />
        </Card>
      ))}
      {rows(data.checkinPlugins).map((plugin) => (
        <ObjectForm
          key={str(plugin.id)}
          title={`${str(plugin.name) || str(plugin.id)} 每日签到`}
          operation="settings.plugin-checkin"
          fixed={{ provider: plugin.id }}
          data={{ on: plugin.on }}
          fields={[{ key: "on", label: "启用插件每日签到", kind: "boolean" }]}
        />
      ))}
      {rows(data.checkinAccounts).map((account) => (
        <ObjectForm
          key={str(account.key)}
          title={`${str(account.name) || str(account.user) || str(account.key)} 签到`}
          operation="settings.checkin-account"
          fixed={{ key: account.key }}
          data={{ on: account.on !== false }}
          fields={[{ key: "on", label: "启用此账号每日签到", kind: "boolean" }]}
        />
      ))}
    </>
  );
}
const syncFields: PreferenceField[] = [
  {
    key: "kind",
    label: "同步服务",
    kind: "choice",
    choices: [
      ["webdav", "WebDAV"],
      ["s3", "S3"],
      ["github", "GitHub"],
    ],
  },
  { key: "url", label: "地址 / Bucket / GitHub 仓库", kind: "text" },
  { key: "user", label: "用户名 / S3 Access Key", kind: "text" },
  { key: "password", label: "密码 / S3 Secret Key / GitHub Token（留空保留）", kind: "secret" },
  { key: "passphrase", label: "加密口令（留空保留）", kind: "secret" },
  { key: "endpoint", label: "S3 Endpoint", kind: "text" },
  { key: "pathStyle", label: "S3 Path-style 寻址", kind: "boolean" },
  { key: "region", label: "S3 Region", kind: "text" },
  { key: "branch", label: "GitHub 分支", kind: "text" },
  { key: "folder", label: "同步目录", kind: "text" },
  { key: "keys", label: "同步 API 密钥", kind: "boolean" },
  { key: "agents", label: "同步 Agent 模型", kind: "boolean" },
  { key: "library", label: "同步资源库", kind: "boolean" },
  { key: "usage", label: "同步用量", kind: "boolean" },
];
function SyncPreferences() {
  const { s } = useUi();
  const query = useFeature("sync");
  const data = record(query.data);
  return (
    <>
      <FeatureStatus query={query} />
      <Card>
        <Text style={s.sectionTitle}>同步状态</Text>
        <DataView data={data} />
        <ActionButton operation="sync.now" label="立即同步" showResult />
        <ActionButton operation="sync.off" label="停用同步" confirm />
        <ActionButton
          operation="sync.restore"
          label="从服务器恢复"
          detail="用服务器的配置替换此主机配置；Magpie 会先保留当前配置以便撤销。"
          confirm
          showResult
        />
        <ActionButton operation="sync.undo" label="撤销恢复" confirm showResult />
        <ActionButton
          operation="sync.upload"
          label="用此主机配置替换服务器文件"
          confirm
          showResult
        />
        <ActionButton operation="sync.dismiss" label="清除同步通知" />
      </Card>
      <ObjectForm
        title="同步连接"
        operation="sync.save"
        data={{ kind: "webdav", ...data }}
        fields={syncFields}
      />
      <ObjectForm
        title="自动同步"
        operation="sync.auto"
        data={{ minutes: data.auto ?? 3 }}
        fields={[{ key: "minutes", label: "间隔（分钟，0 关闭）", kind: "number" }]}
      />
      <ObjectForm
        title="导出加密备份到主机"
        operation="backup.export"
        data={{ keys: true, library: true }}
        fields={[
          { key: "pass", label: "备份加密口令", kind: "secret" },
          { key: "keys", label: "包含 API 密钥", kind: "boolean" },
          { key: "library", label: "包含资源库", kind: "boolean" },
        ]}
      />
      <ObjectForm
        title="导入加密备份"
        operation="backup.import"
        data={{ agents: false, library: true }}
        fields={[
          { key: "path", label: "备份文件在主机上的路径", kind: "text" },
          { key: "agents", label: "恢复 Agent 模型配置", kind: "boolean" },
          { key: "library", label: "恢复资源库", kind: "boolean" },
          { key: "pass", label: "备份加密口令", kind: "secret" },
        ]}
      />
    </>
  );
}

function UpdateControls() {
  const query = useFeature("update");
  const cli = useFeature("cli");
  return (
    <>
      <FeatureStatus query={query} />
      <DataView data={query.data} />
      <ActionButton operation="update.check" label="检查 Magpie 更新" showResult />
      <ActionButton
        operation="update.install"
        label="安装 Magpie 更新"
        detail="更新可能重启 Magpie，影响正在执行的请求。"
        confirm
        showResult
      />
      <FeatureStatus query={cli} />
      <DataView data={cli.data} />
      <ObjectForm
        title="主机命令行入口"
        operation="cli.setup"
        data={{}}
        fields={[{ key: "shell", label: "Shell（例如 zsh / bash / fish）", kind: "text" }]}
      />
      <ActionButton operation="proxy.check" label="检查当前代理与直连" showResult />
    </>
  );
}
