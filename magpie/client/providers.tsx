import { useState } from "react";
import { Text, View } from "react-native";
import type { PageData, Provider, ProviderDraft } from "../shared/rpc";
import { ProviderAdvanced } from "./provider-advanced";
import { ProviderManagement } from "./provider-management";
import {
  Banner,
  BrandIcon,
  Button,
  Dialog,
  Chip,
  ChoicePicker,
  ConfirmButton,
  Empty,
  Field,
  IconButton,
  StatusDot,
  Toggle,
  number,
  useUi,
} from "./kit";

function draftOf(provider?: Provider): ProviderDraft {
  return {
    id: provider?.id || "",
    name: provider?.name || "",
    preset: provider?.preset || "",
    chat: provider?.chat || "",
    responses: provider?.responses || "",
    anthropic: provider?.anthropic || "",
    gemini: provider?.gemini || "",
    baseAPI: provider ? provider.baseAPI : "chat",
    key: "",
    models: provider?.chosen || [],
    noModels: provider?.noModels || false,
  };
}

export function ProvidersPage({
  data,
  query,
  startSignIn,
}: {
  data: PageData;
  query: string;
  startSignIn(agent: string): void;
}) {
  const { s, compact, run } = useUi();
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [fresh, setFresh] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = (p?: Provider) => {
    setFresh(!p);
    setExpanded(p?.id || null);
    setEditing(draftOf(p));
  };
  const selected = data.providers.find((p) => p.id === expanded);
  const close = () => {
    setEditing(null);
    setExpanded(null);
  };
  const filtered = data.providers.filter((p) =>
    `${p.name} ${p.host} ${p.models.map((m) => m.name).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      {editing || selected ? (
        <Dialog
          title={
            editing
              ? fresh
                ? "添加供应商"
                : `编辑 ${selected?.name || editing.name}`
              : `${selected!.name} · 模型与账户`
          }
          onClose={close}
        >
          {editing ? (
            <ProviderForm
              key={fresh ? "new" : editing.id}
              draft={editing}
              data={data}
              fresh={fresh}
              onChange={setEditing}
              onClose={() => {
                if (fresh) close();
                else setEditing(null);
              }}
            />
          ) : (
            <ProviderDetails
              provider={selected!}
              onEdit={() => open(selected)}
              startSignIn={(agent) => {
                close();
                startSignIn(agent);
              }}
              onDeleted={close}
            />
          )}
        </Dialog>
      ) : null}
      {!filtered.length ? (
        <Empty
          icon="KeyRound"
          title="尚无匹配的供应商"
          hint="添加 API 供应商，或使用下方订阅登录。"
        />
      ) : null}
      {filtered.length ? (
        <View style={s.list}>
          {filtered.map((p, index) => (
            <View key={p.id} style={[s.listItem, index === 0 && { borderTopWidth: 0 }]}>
              <View style={s.listHead}>
                <View style={s.iconTile}>
                  <BrandIcon id={p.accountAgent || p.preset || p.name} />
                </View>
                <View style={s.grow}>
                  <Text style={s.cardTitle}>{p.name}</Text>
                  <Text numberOfLines={1} style={s.small}>
                    {p.host || p.id} · {p.exposed} 个模型
                  </Text>
                </View>
                {!compact ? (
                  <View style={{ width: 125 }}>
                    <StatusDot
                      good={!p.off && p.ready}
                      label={p.off ? "已停用" : p.keyMasked || (p.ready ? "可用" : "待配置")}
                    />
                  </View>
                ) : null}
                <Toggle
                  label={`使用 ${p.name}`}
                  hideLabel
                  value={!p.off}
                  onChange={(on) => {
                    void run({ type: "provider.toggle", id: p.id, on });
                  }}
                />
                <IconButton
                  label="模型与账户"
                  icon="ChevronRight"
                  onPress={() => {
                    setEditing(null);
                    setExpanded(p.id);
                  }}
                />
              </View>
              {compact ? (
                <View style={{ paddingLeft: 34 }}>
                  <StatusDot
                    good={!p.off && p.ready}
                    label={p.off ? "已停用" : p.keyMasked || (p.ready ? "可用" : "待配置")}
                  />
                </View>
              ) : null}
              {p.listError ? <Banner error>{p.listError}</Banner> : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={s.between}>
        <Button label="添加供应商" icon="Plus" onPress={() => open()} />
        <Text style={s.small}>
          {data.providers.length} 个供应商 · {data.providers.reduce((n, p) => n + p.exposed, 0)}{" "}
          个可用模型
        </Text>
      </View>
      <View style={s.section}>
        <Text style={s.sectionTitle}>订阅账户</Text>
        <Text style={s.muted}>使用 Magpie 的登录流程连接订阅；授权链接会在当前设备打开。</Text>
        <View style={s.row}>
          {[
            { id: "codex", name: "ChatGPT / Codex" },
            { id: "claude", name: "Claude" },
            { id: "gemini", name: "Gemini CLI" },
            { id: "antigravity", name: "Antigravity" },
            { id: "copilot", name: "GitHub Copilot" },
          ].map((a) => (
            <Button key={a.id} label={a.name} icon="LogIn" onPress={() => startSignIn(a.id)} />
          ))}
        </View>
      </View>
      <ProviderManagement />
    </>
  );
}

function ProviderDetails({
  provider: p,
  onEdit,
  startSignIn,
  onDeleted,
}: {
  provider: Provider;
  onEdit(): void;
  startSignIn(agent: string): void;
  onDeleted(): void;
}) {
  const { s, c, run } = useUi();
  return (
    <View style={s.section}>
      <View style={s.row}>
        <Button label="编辑" icon="SlidersHorizontal" onPress={onEdit} />
        <Button
          label="刷新模型"
          icon="RefreshCw"
          onPress={() => {
            void run({ type: "provider.fetch", id: p.id });
          }}
        />
        {p.accountAgent ? (
          <Button
            label="添加登录账户"
            icon="UserPlus"
            onPress={() => startSignIn(p.accountAgent)}
          />
        ) : null}
      </View>
      <View style={s.row}>
        {p.models.map((m) => (
          <View key={m.id} style={s.chip}>
            <Text style={[s.small, m.on && { color: c.foreground }]}>
              {m.name}
              {m.context ? ` · ${number(m.context)}` : ""}
              {m.images ? " · 视觉" : ""}
              {m.on ? "" : " · 隐藏"}
            </Text>
          </View>
        ))}
      </View>
      {p.keys.length ? <Text style={s.label}>API 密钥</Text> : null}
      {p.keys.map((k) => (
        <View key={k.id} style={[s.tableRow, { flexWrap: "wrap" }]}>
          <View style={s.grow}>
            <Text style={s.text}>{k.name || k.masked}</Text>
            <Text style={s.small}>{k.masked}</Text>
          </View>
          {k.active ? (
            <Chip label="当前" good />
          ) : (
            <Button
              label="设为当前"
              onPress={() => {
                void run({
                  type: "key.change",
                  id: p.id,
                  ref: k.id,
                  operation: "use",
                });
              }}
            />
          )}
          <Toggle
            label="启用密钥"
            value={k.on}
            onChange={(on) => {
              void run({
                type: "key.change",
                id: p.id,
                ref: k.id,
                operation: on ? "on" : "off",
              });
            }}
          />
          <ConfirmButton
            label="删除密钥"
            onConfirm={() => {
              void run({
                type: "key.change",
                id: p.id,
                ref: k.id,
                operation: "remove",
              });
            }}
          />
        </View>
      ))}
      {!p.accountAgent ? <AddKey id={p.id} /> : null}
      {p.logins.map((login) => (
        <View key={login.user} style={[s.tableRow, { flexWrap: "wrap" }]}>
          <View style={s.grow}>
            <Text style={s.text}>{login.user}</Text>
            <Text style={s.small}>
              {login.plan}
              {login.lapsed ? ` · ${login.lapsed}` : ""}
            </Text>
          </View>
          {login.active ? (
            <Chip label="当前账户" good />
          ) : (
            <Button
              label="切换账户"
              onPress={() => {
                void run({
                  type: "login.change",
                  id: login.agent || p.accountAgent,
                  user: login.user,
                  operation: "use",
                });
              }}
            />
          )}
          <Toggle
            label="启用账户"
            value={login.on}
            onChange={(on) => {
              void run({
                type: "login.change",
                id: login.agent || p.accountAgent,
                user: login.user,
                operation: on ? "on" : "off",
              });
            }}
          />
          <ConfirmButton
            label="移除账户"
            detail={`从 Magpie 移除 ${login.user} 的登录；此账户不再用于接下来的请求。`}
            onConfirm={() => {
              void run({
                type: "login.change",
                id: login.agent || p.accountAgent,
                user: login.user,
                operation: "remove",
              });
            }}
          />
        </View>
      ))}
      <ConfirmButton
        label="删除供应商"
        detail={`删除 ${p.name} 及其保存的 API 配置，正在使用其模型的 Agent 可能被重新分配。`}
        onConfirm={() => {
          void run({ type: "provider.delete", id: p.id }).then((ok) => {
            if (ok) onDeleted();
          });
        }}
      />
      <ProviderAdvanced id={p.id} />
    </View>
  );
}

function AddKey({ id }: { id: string }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const { s, run } = useUi();
  return (
    <View style={s.row}>
      <Field label="密钥名称" value={name} onChange={setName} placeholder="可选" />
      <Field label="新 API 密钥" value={key} onChange={setKey} secure placeholder="sk-…" />
      <Button
        label="添加密钥"
        disabled={!key.trim()}
        onPress={() => {
          void run({ type: "key.add", id, name, key }).then((ok) => {
            if (ok) {
              setKey("");
              setName("");
            }
          });
        }}
      />
    </View>
  );
}

function ProviderForm({
  draft,
  data,
  fresh,
  onChange,
  onClose,
}: {
  draft: ProviderDraft;
  data: PageData;
  fresh: boolean;
  onChange(draft: ProviderDraft): void;
  onClose(): void;
}) {
  const { s, run } = useUi();
  const existing = data.providers.find((p) => p.id === draft.id);
  const remote = draft.preset === "remote-magpie";
  const patch = (change: Partial<ProviderDraft>) => onChange({ ...draft, ...change });
  const presetOptions = [
    { value: "", label: "自定义供应商", note: "" },
    ...data.presets
      .filter((p) => ["vendor", "relay", "local", "remote", "partner"].includes(p.kind))
      .map((p) => ({ value: p.id, label: p.name, note: p.kind })),
  ];
  return (
    <View style={s.section}>
      {fresh ? (
        <ChoicePicker
          label="供应商预设"
          value={draft.preset}
          options={presetOptions}
          onChange={(value) => {
            const p = data.presets.find((x) => x.id === value);
            patch({
              preset: value,
              name: p?.name || "",
              chat: p?.chat || "",
              responses: p?.responses || "",
              anthropic: p?.anthropic || "",
              gemini: p?.gemini || "",
            });
          }}
        />
      ) : null}
      <View style={s.row}>
        <Field label="显示名称" value={draft.name} onChange={(name) => patch({ name })} />
        <Field
          label={fresh ? "API 密钥" : "替换 API 密钥（留空保留）"}
          value={draft.key}
          onChange={(key) => patch({ key })}
          secure
        />
      </View>
      <View style={s.row}>
        <Field
          label={remote ? "远程 Magpie 地址" : "Chat Completions 地址"}
          value={draft.chat}
          onChange={(chat) => patch({ chat })}
          placeholder={remote ? "http://100.96.195.115:3425" : "https://api.example.com/v1"}
        />
        {!remote ? (
          <Field
            label="Responses 地址"
            value={draft.responses}
            onChange={(responses) => patch({ responses })}
            placeholder="https://api.example.com/v1"
          />
        ) : null}
      </View>
      {remote ? (
        <Text style={s.muted}>
          填写共享主机的网关地址和网关密钥。此机器的 Agent
          使用远程模型时，由共享主机选择账户并消耗额度。
        </Text>
      ) : (
        <View style={s.row}>
          <Field
            label="Anthropic 地址"
            value={draft.anthropic}
            onChange={(anthropic) => patch({ anthropic })}
            placeholder="https://api.anthropic.com"
          />
          <Field
            label="Gemini 地址"
            value={draft.gemini}
            onChange={(gemini) => patch({ gemini })}
            placeholder="https://generativelanguage.googleapis.com/v1beta"
          />
        </View>
      )}
      {existing ? (
        <View style={s.section}>
          <Text style={s.label}>向 Agent 提供的模型</Text>
          <Text style={s.small}>未指定模型时使用供应商的完整列表；也可以逐个勾选。</Text>
          <View style={s.row}>
            <Toggle
              label="使用全部模型"
              value={!draft.noModels && draft.models.length === 0}
              onChange={(all) => patch({ models: [], noModels: !all })}
            />
          </View>
          <View style={s.row}>
            {existing.models.map((m) => {
              const checked =
                !draft.noModels && (draft.models.length === 0 || draft.models.includes(m.id));
              return (
                <Button
                  key={m.id}
                  label={`${checked ? "✓ " : ""}${m.name}`}
                  onPress={() => {
                    const selected =
                      !draft.noModels && draft.models.length === 0
                        ? existing.models.map((x) => x.id)
                        : draft.models;
                    const models = selected.includes(m.id)
                      ? selected.filter((x) => x !== m.id)
                      : [...selected, m.id];
                    patch({ models, noModels: models.length === 0 });
                  }}
                />
              );
            })}
          </View>
        </View>
      ) : (
        <Field
          label="模型 ID（可选，一行一个）"
          value={draft.models.join("\n")}
          onChange={(value) =>
            patch({
              models: value
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
          multiline
          placeholder="留空让 Magpie 自动获取模型列表"
        />
      )}
      <View style={s.row}>
        <Button
          label="保存供应商"
          icon="Check"
          primary
          disabled={!draft.name.trim()}
          onPress={() => {
            void run({ type: "provider.save", draft, fresh }).then((ok) => {
              if (ok) onClose();
            });
          }}
        />
        <Button label="取消" onPress={onClose} />
      </View>
    </View>
  );
}
