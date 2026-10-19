import { useState } from "react";
import { Text, View } from "react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { signInSchema, type SignIn } from "../shared/rpc";
import type { Row } from "../shared/features";
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
import { Banner, Button, Card, ChoicePicker, Field, useUi } from "./kit";
import { SignInPanel } from "./signin";

export function PluginsAdvanced() {
  const { s, hostId } = useUi();
  const query = useFeature("plugins");
  const providers = useFeature("providers");
  const pages = useFeature("pluginPages");
  const data = record(query.data);
  const [login, setLogin] = useState<Row | null>(null);
  return (
    <>
      <ObjectForm
        title="插件下载来源"
        operation="plugins.mirror"
        data={{ on: data.mirror }}
        fields={[{ key: "on", label: "优先使用国内镜像", kind: "boolean" }]}
      />
      <ActionButton operation="plugins.check" label="只检查插件更新" showResult />
      <ActionButton operation="plugins.update" label="检查并更新全部插件" confirm showResult />
      <FeatureStatus query={query} />
      {rows(data.plugins).map((plugin) => (
        <Card key={str(plugin.spec)}>
          <Text style={s.cardTitle}>{str(plugin.name) || str(plugin.spec)}</Text>
          <ObjectForm
            title="插件参数"
            operation="plugins.options"
            fixed={{ spec: plugin.spec }}
            data={{ options: plugin.options || plugin.optionsExample || {} }}
            fields={[{ key: "options", label: "插件参数 JSON", kind: "json" }]}
          />
          <ActionButton
            operation="plugins.options"
            label="清除此插件参数"
            body={{ spec: plugin.spec, options: null }}
            confirm
          />
          <DataView data={plugin} />
        </Card>
      ))}
      <Card>
        <Text style={s.sectionTitle}>插件提供的账号登录</Text>
        {rows(record(providers.data).plugins).map((p) => (
          <View key={str(p.pid) || str(p.id)} style={s.section}>
            <Button label={`登录 ${p.name || p.id}`} onPress={() => setLogin(p)} />
            {rows(p.options).map((option) => (
              <View key={str(option.key)} style={s.section}>
                <Text style={s.text}>{str(option.label)}</Text>
                <Text style={s.small}>{str(option.description)}</Text>
                <ActionButton
                  operation="settings.plugin-option"
                  label={option.on ? `关闭 ${str(option.label)}` : `开启 ${str(option.label)}`}
                  body={{ provider: p.pid || p.id, key: option.key, on: !option.on }}
                  confirm={Boolean(option.confirm) && !option.on}
                  detail={str(option.confirm)}
                />
              </View>
            ))}
          </View>
        ))}
      </Card>
      {login ? (
        <PluginLogin provider={login} onClose={() => setLogin(null)} hostId={hostId} />
      ) : null}
      <Card>
        <Text style={s.sectionTitle}>扩展页面的数据与设置</Text>
        <FeatureStatus query={pages} />
        <Text style={s.muted}>此处使用原生控件管理扩展页的参数和声明的数据读取。</Text>
      </Card>
      {rows(pages.data).map((p) => (
        <Card key={str(p.key)}>
          <Text style={s.cardTitle}>{str(p.title) || str(p.name)}</Text>
          <PageOptions spec={str(p.spec)} />
          {(Array.isArray(p.reads) ? p.reads : []).map((read) => (
            <ActionButton
              key={String(read)}
              operation="plugin-pages.read"
              label={`查看 ${read}`}
              body={{ spec: p.spec, read, params: {} }}
              showResult
            />
          ))}
        </Card>
      ))}
    </>
  );
}

function PluginLogin({
  provider,
  onClose,
  hostId,
}: {
  provider: Row;
  onClose(): void;
  hostId: string;
}) {
  const { s } = useUi();
  const mutation = useFeatureMutation();
  const methods = rows(provider.methods);
  const [method, setMethod] = useState("0");
  const [inputs, setInputs] = useState<Row>({});
  const [answer, setAnswer] = useState("");
  const [key, setKey] = useState("");
  const [started, setStarted] = useState(false);
  const [completed, setCompleted] = useState(false);
  const result = record(mutation.result);
  const prompt = record(result.prompt);
  const pid = provider.pid || provider.id || "";
  const begin = async () => {
    if (
      await mutation.execute("plugin-signin.prompt", {
        provider: pid,
        method: Number(method),
        inputs,
      })
    )
      setStarted(true);
  };
  const respond = async () => {
    const next = { ...inputs, [str(prompt.key)]: answer };
    if (
      await mutation.execute("plugin-signin.prompt", {
        provider: pid,
        method: Number(method),
        inputs,
        key: prompt.key,
        value: answer,
      })
    ) {
      setInputs(next);
      setAnswer("");
    }
  };
  const start = async () => {
    if (
      await mutation.execute("plugin-signin.start", {
        provider: pid,
        method: Number(method),
        inputs,
        ...(key ? { key } : {}),
      })
    ) {
      setStarted(false);
      setCompleted(true);
    }
  };
  const flow = result.id && result.state ? signInSchema.safeParse(result) : null;
  if (flow?.success && flow.data.id && flow.data.state !== "done")
    return <SignInPanel initial={flow.data} hostId={hostId} onClose={onClose} onDone={onClose} />;
  return (
    <Card>
      <Text style={s.sectionTitle}>登录 {str(provider.name)}</Text>
      <ChoicePicker
        label="登录方式"
        value={method}
        options={methods.map((m, i) => ({
          value: String(i),
          label: str(m.label) || str(m.name) || `方式 ${i + 1}`,
          note: str(m.type),
        }))}
        onChange={(value) => {
          setMethod(value);
          setInputs({});
          setStarted(false);
        }}
      />
      {completed && result.state === "done" ? (
        <Banner>账号已连接。</Banner>
      ) : !started ? (
        <Button
          label="开始插件授权"
          disabled={mutation.busy}
          onPress={() => {
            void begin();
          }}
        />
      ) : prompt.key ? (
        <>
          <Text style={s.text}>{str(prompt.message) || str(prompt.label)}</Text>
          {Array.isArray(prompt.options) ? (
            <ChoicePicker
              label="授权问题"
              value={answer}
              options={rows(prompt.options).map((o) => ({
                value: str(o.value),
                label: str(o.label) || str(o.value),
                note: str(o.hint),
              }))}
              onChange={setAnswer}
            />
          ) : (
            <Field
              label="授权问题答案"
              value={answer}
              onChange={setAnswer}
              secure={prompt.type === "password"}
            />
          )}
          <Button
            label="提交授权答案"
            onPress={() => {
              void respond();
            }}
          />
        </>
      ) : (
        <>
          {methods[Number(method)]?.type === "api" ? (
            <Field label="插件 API 密钥" value={key} onChange={setKey} secure />
          ) : null}
          <Button
            label="继续账号授权"
            disabled={mutation.busy}
            onPress={() => {
              void start();
            }}
          />
        </>
      )}
      {mutation.error ? <Banner error>{mutation.error}</Banner> : null}
      {result.state === "done" ? <Banner>账号已连接。</Banner> : null}
      <Button label="关闭插件登录" onPress={onClose} />
    </Card>
  );
}

function PageOptions({ spec }: { spec: string }) {
  const query = useFeature("pluginPageOptions", { spec }, Boolean(spec));
  return (
    <>
      <FeatureStatus query={query} />
      {query.data ? (
        <ObjectForm
          title="扩展页参数"
          operation="plugin-pages.options"
          fixed={{ spec }}
          data={{ options: query.data }}
          fields={[{ key: "options", label: "页面参数 JSON", kind: "json" }]}
        />
      ) : null}
    </>
  );
}
