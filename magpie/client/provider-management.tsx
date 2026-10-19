import { useState } from "react";
import { Text, View } from "react-native";
import type { Row } from "../shared/features";
import { signInSchema, type SignIn } from "../shared/rpc";
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
import { Banner, Button, Card, ChoicePicker, Field, Toggle, useUi } from "./kit";
import { SignInPanel } from "./signin";

const subscriptions: [string, string][] = [
  ["claude", "Claude"],
  ["codex", "ChatGPT / Codex"],
  ["chatgpt-api", "ChatGPT API"],
  ["cursor", "Cursor"],
  ["grok", "Grok / SuperGrok"],
  ["copilot", "GitHub Copilot"],
  ["zcode", "GLM Coding Plan"],
  ["workbuddy", "WorkBuddy"],
  ["workbuddy-ai", "WorkBuddy AI"],
  ["commandcode-plan", "Command Code"],
  ["qoder", "Qoder 国际版"],
  ["qoder-cn", "Qoder 国内版"],
  ["devin", "Devin"],
  ["zed", "Zed"],
  ["factory", "Factory"],
  ["mimo-app", "Xiaomi MiMo"],
  ["kiro", "Kiro"],
  ["gemini", "Gemini CLI"],
  ["antigravity", "Antigravity"],
];
export function ProviderManagement() {
  const { s, hostId } = useUi();
  const query = useFeature("providers");
  const [imports, setImports] = useState(false);
  const sources = useFeature("importSources", {}, imports);
  const data = record(query.data);
  const [agent, setAgent] = useState("codex");
  const [site, setSite] = useState("");
  const [proxy, setProxy] = useState("");
  const [initial, setInitial] = useState<SignIn | null>(null);
  const mutation = useFeatureMutation();
  const start = async () => {
    await mutation.execute("signin.start", {
      agent,
      ...(site ? { site } : {}),
      ...(proxy ? { proxy } : {}),
    });
  };
  const flow = mutation.result ? signInSchema.safeParse(mutation.result) : null;
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>更多订阅账号</Text>
        <ChoicePicker
          label="订阅服务"
          value={agent}
          options={subscriptions.map(([value, label]) => ({ value, label, note: "" }))}
          onChange={setAgent}
        />
        {agent === "zcode" ? (
          <ChoicePicker
            label="GLM 账号地区"
            value={site}
            options={[
              { value: "zai", label: "Z.ai", note: "" },
              { value: "bigmodel", label: "智谱 BigModel", note: "" },
            ]}
            onChange={setSite}
          />
        ) : (
          <Field label="登录站点（可选）" value={site} onChange={setSite} />
        )}
        <Field label="登录使用的代理（可选）" value={proxy} onChange={setProxy} />
        <Button
          label="连接此订阅"
          disabled={mutation.busy}
          onPress={() => {
            void start();
          }}
        />
        {mutation.error ? <Banner error>{mutation.error}</Banner> : null}
      </Card>
      {flow?.success && flow.data.id ? (
        <SignInPanel
          key={flow.data.id}
          initial={flow.data}
          hostId={hostId}
          onClose={mutation.clear}
          onDone={() => {
            mutation.clear();
            void query.refetch();
          }}
        />
      ) : null}
      <ObjectForm
        title="从主机文件导入账号"
        operation="signin.import"
        data={{ agent }}
        fields={[
          { key: "agent", label: "导入的订阅服务", kind: "choice", choices: subscriptions },
          { key: "files", label: "主机上的账号文件路径（一行一个）", kind: "lines" },
        ]}
      />
      <ObjectForm
        title="供应商排列顺序"
        operation="providers.arrange"
        data={{ order: rows(data.providers).map((p) => p.id) }}
        fields={[{ key: "order", label: "供应商 ID（一行一个）", kind: "lines" }]}
      />
      <Card>
        <Text style={s.sectionTitle}>从其他应用导入供应商</Text>
        <Button label="扫描其他应用的供应商" onPress={() => setImports(true)} />
        {imports ? (
          <>
            <FeatureStatus query={sources} />
            {rows(sources.data).map((source) => (
              <Card key={str(source.id)}>
                <Text style={s.cardTitle}>{str(source.name)}</Text>
                {source.error ? <Banner error>{str(source.error)}</Banner> : null}
                {rows(source.items).map((item) => (
                  <ImportCandidate key={str(item.ref)} source={str(source.id)} item={item} />
                ))}
              </Card>
            ))}
          </>
        ) : null}
      </Card>
      <ActionButton
        operation="provider.keychain"
        label="重新请求读取 macOS 中的 Codex 登录"
        showResult
      />
      {rows(data.excluded).map((p) => (
        <Card key={str(p.provider)}>
          <Text style={s.cardTitle}>{str(p.agentName) || str(p.provider)}</Text>
          <DataView data={p} />
          <ActionButton
            operation="provider.show"
            label="重新显示此订阅"
            body={{ id: p.provider }}
          />
          <ActionButton
            operation="provider.tuck"
            label="隐藏此移除的订阅"
            body={{ id: p.provider }}
          />
          <ActionButton
            operation="provider.forget"
            label="永久移除此订阅登录"
            body={{ id: p.provider }}
            confirm
          />
        </Card>
      ))}
    </>
  );
}

function ImportCandidate({ source, item }: { source: string; item: Row }) {
  const { s } = useUi();
  const mutation = useFeatureMutation();
  const provider = record(item.provider);
  const [selected, setSelected] = useState(false);
  const [mode, setMode] = useState(item.keyOf ? "key" : "add");
  const [name, setName] = useState(str(provider.name));
  const blocked = Boolean(item.skip || item.status === "same");
  return (
    <View style={s.section}>
      <Text style={s.cardTitle}>{str(provider.name) || str(provider.id)}</Text>
      <Text style={s.small}>
        {str(item.from)} ·{" "}
        {str(provider.chat) || str(provider.responses) || str(provider.anthropic)} ·{" "}
        {item.status === "same" ? "已存在" : str(item.status)}
      </Text>
      {blocked ? (
        <Text style={s.muted}>{str(item.skip) || "此配置已经导入。"}</Text>
      ) : (
        <>
          <Toggle
            label={`选择导入 ${str(provider.name) || str(item.ref)}`}
            value={selected}
            onChange={setSelected}
          />
          {selected ? (
            <>
              <ChoicePicker
                label="导入方式"
                value={mode}
                options={[
                  { value: "add", label: "新增供应商", note: "" },
                  ...(item.status === "taken" && !item.reserved
                    ? [{ value: "replace", label: "替换同 ID 供应商", note: str(item.existing) }]
                    : []),
                  ...(item.keyOf
                    ? [{ value: "key", label: "加入已有供应商的密钥", note: str(item.keyOf) }]
                    : []),
                ]}
                onChange={setMode}
              />
              <Field label="导入后的名称" value={name} onChange={setName} />
              <ActionButton
                operation="providers.import"
                label={`导入 ${str(item.ref)}`}
                body={{
                  picks: [
                    {
                      source,
                      ref: item.ref,
                      mode,
                      ...(name && name !== provider.name ? { name } : {}),
                    },
                  ],
                }}
                confirm
                showResult
              />
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
