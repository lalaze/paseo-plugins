import { useState } from "react";
import { Text, View } from "react-native";
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
} from "./features";
import { Card, ChoicePicker, useUi } from "./kit";

const providerFields: PreferenceField[] = [
  {
    key: "routing",
    label: "账号分配策略",
    kind: "choice",
    choices: [
      ["", "智能"],
      ["order", "按顺序"],
      ["rotate", "轮换"],
      ["usage", "最低使用量"],
      ["pace", "每周进度"],
      ["weight", "按权重"],
    ],
  },
  {
    key: "affinity",
    label: "会话保持账号",
    kind: "choice",
    choices: [
      ["", "自动"],
      ["session", "整个会话"],
      ["turn", "单轮"],
      ["off", "每次重新分配"],
      ["strict", "严格保持"],
    ],
  },
  { key: "sink", label: "短期限流后排到队尾", kind: "boolean" },
  { key: "fallback", label: "备用模型（一行一个）", kind: "lines" },
  { key: "accountOrder", label: "账号顺序（一行一个）", kind: "lines" },
  { key: "accountProxies", label: "各账号请求代理", kind: "json" },
  { key: "headers", label: "附加 Headers（填写会替换；不修改则保留）", kind: "json" },
  { key: "extraBody", label: "额外请求参数（填写会替换；不修改则保留）", kind: "json" },
  { key: "modelsURL", label: "模型列表地址", kind: "text" },
  { key: "contexts", label: "模型上下文窗口", kind: "json" },
  { key: "outputs", label: "最大输出 Token（模型 ID → Token，* 表示全部）", kind: "json" },
  { key: "compacts", label: "上下文压缩阈值（模型 ID → Token，* 表示全部）", kind: "json" },
  { key: "modelPrefs", label: "模型显示名称、思考级别与视觉能力", kind: "json" },
  { key: "priceRate", label: "相对于官方价格的倍率", kind: "number" },
  { key: "catalog", label: "模型元数据来源（models.dev 供应商 ID）", kind: "text" },
  { key: "nativeCompaction", label: "由供应商原生压缩", kind: "boolean" },
  { key: "passUserAgent", label: "发送 Agent 原始 User-Agent", kind: "boolean" },
  {
    key: "authHeader",
    label: "Anthropic 认证 Header",
    kind: "choice",
    choices: [
      ["", "两种 Header"],
      ["bearer", "Bearer"],
      ["x-api-key", "x-api-key"],
    ],
  },
  { key: "unredacted", label: "发送未经隐藏的请求", kind: "boolean" },
  { key: "insecureTLS", label: "允许不受信任的证书", kind: "boolean" },
  { key: "searches", label: "供应商提供原生搜索", kind: "boolean" },
  { key: "unlisted", label: "不在模型目录列出", kind: "boolean" },
  { key: "maxConcurrency", label: "最大并发", kind: "number" },
  { key: "maxRPM", label: "每分钟最大请求数", kind: "number" },
  { key: "queueLimit", label: "等待队列长度", kind: "number" },
  { key: "queueWait", label: "最长排队时间（秒）", kind: "number" },
  { key: "quotaRest", label: "额度耗尽后休息时长（分钟）", kind: "number" },
  { key: "quotaResetAt", label: "额度恢复时间（例如 00:00+08:00）", kind: "text" },
  { key: "restCap", label: "失败休息上限（分钟，-1 关闭）", kind: "number" },
  { key: "balanceURL", label: "余额接口地址", kind: "text" },
  { key: "balancePath", label: "余额在返回 JSON 中的路径", kind: "text" },
  {
    key: "balanceMethod",
    label: "余额查询请求方法",
    kind: "choice",
    choices: [
      ["", "GET（默认）"],
      ["GET", "GET"],
      ["POST", "POST"],
    ],
  },
  { key: "accessKeyID", label: "云厂商 Access Key ID / SecretId", kind: "text" },
  { key: "balanceToken", label: "余额令牌（留空保留）", kind: "secret" },
  { key: "secretAccessKey", label: "AWS Secret Access Key（留空保留）", kind: "secret" },
  { key: "vertex", label: "Google Vertex 凭据 / 项目 / 区域", kind: "json" },
  { key: "zhipuTeam", label: "GLM 团队组织与项目", kind: "json" },
];
export function ProviderAdvanced({ id }: { id: string }) {
  const { s } = useUi();
  const query = useFeature("providers");
  const provider = rows(record(query.data).providers).find((p) => p.id === id);
  const logins = rows(record(provider?.account).logins);
  return (
    <>
      <FeatureStatus query={query} />
      {provider ? (
        <>
          <ObjectForm
            title="供应商高级设置"
            operation="provider.save"
            fixed={{ id }}
            data={provider}
            fields={providerFields}
          />
          <ProviderModelPreferences provider={provider} />
          {logins.length ? (
            <>
              <ObjectForm
                title="保持登录账号"
                operation="provider.keeplogin"
                fixed={{ id }}
                data={provider}
                fields={[
                  { key: "keepLogin", label: "保持 Agent 登录到指定账号", kind: "boolean" },
                  {
                    key: "keepLoginAs",
                    label: "固定登录账号",
                    kind: "choice",
                    choices: [
                      ["", "第一个账号"],
                      ...logins.map((l) => [str(l.user), str(l.user)] as const),
                    ],
                  },
                ]}
              />
              {record(provider.account).agent === "codex" ? (
                <ObjectForm
                  title="Codex 登录切换"
                  operation="provider.switchonly"
                  fixed={{ id }}
                  data={provider}
                  fields={[
                    {
                      key: "switchOnly",
                      label: "只切换登录，让 Codex 直接请求 OpenAI",
                      kind: "boolean",
                    },
                  ]}
                />
              ) : null}
            </>
          ) : null}
          {[...logins, ...rows(provider.keyList)].map((account, index) => {
            const ref = str(account.user) || str(account.id);
            const mapKey = account.user ? ref.toLowerCase() : ref;
            const details = {
              ...account,
              alias: record(provider.accountNames)[mapKey] || "",
              cap: record(provider.accountCaps)[mapKey] || 0,
              limit: record(provider.accountConcurrency)[mapKey] ?? 0,
              allow: record(provider.accountModels)[mapKey] || [],
            };
            return (
              <Card key={ref || index}>
                <Text style={s.cardTitle}>
                  {str(account.alias) ||
                    str(account.user) ||
                    str(account.name) ||
                    str(account.masked)}
                </Text>
                <DataView data={details} />
                <ObjectForm
                  title="账号名称"
                  operation="provider.alias"
                  fixed={{ id, account: ref }}
                  data={details}
                  fields={[{ key: "alias", label: "显示名称", kind: "text" }]}
                />
                <ObjectForm
                  title="账号使用上限"
                  operation="provider.cap"
                  fixed={{ id, account: ref }}
                  data={details}
                  fields={[{ key: "cap", label: "额度使用百分比（0 取消上限）", kind: "number" }]}
                />
                {account.id && !account.user ? (
                  <>
                    <ObjectForm
                      title="密钥名称"
                      operation="keys.rename"
                      fixed={{ id, ref }}
                      data={account}
                      fields={[{ key: "name", label: "密钥显示名称", kind: "text" }]}
                    />
                    <ObjectForm
                      title="密钥权重"
                      operation="keys.weight"
                      fixed={{ id, ref }}
                      data={{ weight: account.weight || 1 }}
                      fields={[{ key: "weight", label: "权重（1 至 100）", kind: "number" }]}
                    />
                    <ObjectForm
                      title="密钥协议"
                      operation="keys.protocol"
                      fixed={{ id, ref }}
                      data={account}
                      fields={[
                        {
                          key: "protocol",
                          label: "此密钥使用的协议",
                          kind: "choice",
                          choices: [
                            ["", "跟随供应商"],
                            ["chat", "Chat Completions"],
                            ["responses", "Responses"],
                            ["anthropic", "Anthropic"],
                          ],
                        },
                      ]}
                    />
                    <ObjectForm
                      title="替换密钥值"
                      operation="keys.replace"
                      fixed={{ id, ref }}
                      data={{}}
                      fields={[{ key: "key", label: "新的 API 密钥", kind: "secret" }]}
                    />
                  </>
                ) : null}
                <Text style={s.label}>已设置的窗口上限</Text>
                <DataView data={record(provider.accountWindowCaps)[mapKey]} />
                <ObjectForm
                  title="账号窗口上限"
                  operation="provider.windowcap"
                  fixed={{ id, account: ref }}
                  data={{}}
                  fields={[
                    { key: "window", label: "窗口 ID", kind: "text" },
                    { key: "cap", label: "使用百分比上限", kind: "number" },
                  ]}
                />
                <ActionButton
                  operation="provider.accountconcurrency"
                  label="恢复此账号的供应商并发设置"
                  body={{ id, account: ref, limit: null }}
                />
                <ObjectForm
                  title="账号并发"
                  operation="provider.accountconcurrency"
                  fixed={{ id, account: ref }}
                  data={details}
                  fields={[
                    {
                      key: "limit",
                      label: "最大并发（0 不限制；未设置时跟随供应商）",
                      kind: "number",
                    },
                  ]}
                />
                <ObjectForm
                  title="账号可用模型"
                  operation="provider.accountmodels"
                  fixed={{ id, account: ref }}
                  data={details}
                  fields={[
                    { key: "allow", label: "允许的模型 ID（一行一个，空表示全部）", kind: "lines" },
                  ]}
                />
              </Card>
            );
          })}
          <ObjectForm
            title="检测模型支持的 API"
            operation="provider.detect"
            fixed={{ id }}
            data={{}}
            fields={[
              { key: "model", label: "检测使用的模型 ID（可选）", kind: "text" },
              { key: "detectModels", label: "逐个检测模型（一行一个，可选）", kind: "lines" },
            ]}
          />
          <ActionButton
            operation="provider.balance"
            label="查询供应商余额"
            body={{
              id,
              balanceURL: provider.balanceURL || "",
              balancePath: provider.balancePath || "",
              balanceMethod: provider.balanceMethod || "",
            }}
            showResult
          />
          {provider.move ? (
            <ActionButton
              operation="provider.move"
              label="迁移此内置订阅至对应插件"
              body={{ id }}
              confirm
              showResult
            />
          ) : null}
          <ObjectForm
            title="测试模型"
            operation="provider.test"
            fixed={{ id }}
            data={{}}
            fields={[{ key: "test", label: "要测试的模型 ID（一行一个）", kind: "lines" }]}
          />
          <ActionButton
            operation="provider.unfetch"
            label="清除模型列表缓存"
            body={{ id }}
            confirm
          />
          <ObjectForm
            title="批量导入 API 密钥"
            operation="keys.import"
            fixed={{ id }}
            data={{}}
            fields={[
              { key: "key", label: "API 密钥（一行一个）", kind: "secret" },
              { key: "protocol", label: "协议", kind: "text" },
            ]}
          />
        </>
      ) : null}
    </>
  );
}

function ProviderModelPreferences({ provider }: { provider: ReturnType<typeof record> }) {
  const { s } = useUi();
  const models = rows(provider.models);
  const [selected, setSelected] = useState("");
  const model = models.find((model) => model.id === selected);
  const priceFields: PreferenceField[] = [
    ["input", "输入"],
    ["output", "输出"],
    ["cache_read", "缓存读取"],
    ["cache_write", "缓存写入"],
    ["cache_write_1h", "一小时缓存写入"],
  ].map(([key, label]) => ({
    key: `price.${key}`,
    label: `${label}价格（USD / 百万 Token）`,
    kind: "number",
  }));
  return (
    <Card>
      <Text style={s.sectionTitle}>逐模型设置</Text>
      <ChoicePicker
        label="要调整的模型"
        value={selected}
        options={[
          { value: "", label: "选择一个模型", note: "" },
          ...models.map((model) => ({
            value: str(model.id),
            label: str(model.name) || str(model.id),
            note: "",
          })),
        ]}
        onChange={setSelected}
      />
      {model ? (
        <>
          <ObjectForm
            key={selected}
            title="模型参数"
            operation="provider.modelprefs"
            fixed={{ id: provider.id, model: selected }}
            data={{
              ...model,
              name: model.name,
              efforts: model.kept || model.efforts || [],
              context: record(provider.contexts)[selected] || model.context,
              output: record(provider.outputs)[selected] || model.output,
              compact: record(provider.compacts)[selected] || 0,
              price: model.price || model.list || {},
            }}
            fields={[
              { key: "name", label: "模型显示名称（清空恢复默认）", kind: "text" },
              { key: "efforts", label: "提供的思考级别（一行一个，空表示默认）", kind: "lines" },
              { key: "reasonless", label: "此模型不接受思考级别请求", kind: "boolean" },
              { key: "images", label: "此模型能接收图片", kind: "boolean" },
              {
                key: "api",
                label: "模型请求协议",
                kind: "choice",
                choices: [
                  ["", "自动"],
                  ["chat", "Chat Completions"],
                  ["responses", "Responses"],
                  ["anthropic", "Anthropic"],
                  ["gemini", "Gemini"],
                ],
              },
              { key: "same", label: "与哪个模型视为同名（用于自动路由组）", kind: "text" },
              {
                key: "kind",
                label: "模型生成内容类型",
                kind: "choice",
                choices: [
                  ["", "自动"],
                  ["image", "图片"],
                  ["video", "视频"],
                ],
              },
              { key: "context", label: "模型上下文窗口（Token，0 默认）", kind: "number" },
              { key: "output", label: "最大回复长度（Token，0 默认）", kind: "number" },
              { key: "compact", label: "上下文压缩阈值（Token，0 默认）", kind: "number" },
              ...priceFields,
            ]}
          />
          <ActionButton
            operation="provider.modelprefs"
            label="恢复模型官方价格"
            body={{ id: provider.id, model: selected, ownPrice: true }}
            confirm
          />
          <ActionButton
            operation="provider.modelprefs"
            label="恢复模型默认图片能力"
            body={{ id: provider.id, model: selected, ownImages: true }}
          />
        </>
      ) : null}
    </Card>
  );
}
