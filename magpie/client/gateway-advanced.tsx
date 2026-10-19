import { useEffect, useState } from "react";
import type { Row } from "../shared/features";
import { Text, View } from "react-native";
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
import { Button, Card, ChoicePicker, CopyButton, Field, useUi } from "./kit";

export function GatewayAdvanced() {
  const { s } = useUi();
  const query = useFeature("gatewayKeys");
  const permissions = useFeature("gatewayPermissions");
  const preferences = useFeature("preferences");
  const [archiveDate, setArchiveDate] = useState("");
  const [archiveId, setArchiveId] = useState("");
  const [archivePick, setArchivePick] = useState<Record<string, string> | null>(null);
  const archived = useFeature("archive", archivePick || {}, Boolean(archivePick));
  const providers = useFeature("providers");
  const [call, setCall] = useState("");
  const [selectedCall, setSelectedCall] = useState("");
  const callQuery = useFeature("gatewayCall", { id: selectedCall }, Boolean(selectedCall));
  const keys = rows(record(query.data).keys);
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>网关运行管理</Text>
        <ActionButton
          operation="gateway.restart"
          label="启动或重启网关"
          detail="会影响正在执行的网关请求。"
          confirm
          showResult
        />
        <ActionButton
          operation="gateway.take-over"
          label="接管旧版本网关"
          detail="Magpie 会检查占用端口的进程，再决定是否结束旧版本并接管。"
          confirm
          showResult
        />
      </Card>
      <FeatureStatus query={query} />
      <ObjectForm
        title="使用已有密钥值创建网关密钥"
        operation="gateway.key.custom"
        data={{}}
        fields={[
          { key: "name", label: "网关密钥名称", kind: "text" },
          { key: "secret", label: "已有密钥值", kind: "secret" },
        ]}
      />
      {keys.map((key) => (
        <Card key={str(key.id)}>
          <Text style={s.cardTitle}>{str(key.name)}</Text>
          <ObjectForm
            title="密钥名称"
            operation="gateway.key.rename"
            fixed={{ key: key.id }}
            data={key}
            fields={[{ key: "name", label: "名称", kind: "text" }]}
          />
          <ObjectForm
            title="模型权限"
            operation="gateway.key.models"
            fixed={{ key: key.id }}
            data={key}
            fields={[
              { key: "models", label: "允许的模型或模式（一行一个，空表示全部）", kind: "lines" },
            ]}
          />
          <ObjectForm
            title="账号权限"
            operation="gateway.key.accounts"
            fixed={{ key: key.id }}
            data={key}
            fields={[
              {
                key: "accounts",
                label: "允许的供应商/账号 ID（一行一个，空表示全部）",
                kind: "lines",
              },
            ]}
          />
          <ObjectForm
            title="额度可见性"
            operation="gateway.key.quotas"
            fixed={{ key: key.id }}
            data={key}
            fields={[{ key: "quotas", label: "允许远程查看可用账号的额度", kind: "boolean" }]}
          />
          <KeyBudgets item={key} />
        </Card>
      ))}
      <Card>
        <Text style={s.sectionTitle}>可授权的模型与账号</Text>
        <DataView data={permissions.data} />
      </Card>
      <ConnectionExamples data={record(providers.data)} />
      <ObjectForm
        title="请求归档"
        operation="gateway.archive"
        data={{ on: record(preferences.data).requestArchive }}
        fields={[{ key: "on", label: "将请求与响应归档至同步的 S3 Bucket", kind: "boolean" }]}
      />
      <Card>
        <Text style={s.sectionTitle}>读取归档请求</Text>
        <Field label="归档日期（YYYY-MM-DD）" value={archiveDate} onChange={setArchiveDate} />
        <Field label="归档请求 ID" value={archiveId} onChange={setArchiveId} />
        <Button
          label="读取归档"
          disabled={!archiveDate || !archiveId}
          onPress={() => setArchivePick({ date: archiveDate, id: archiveId })}
        />
        {archivePick ? (
          <>
            <FeatureStatus query={archived} />
            <DataView data={archived.data} />
            <ActionButton
              operation="archive.export"
              label="导出归档文件到主机"
              body={archivePick}
              showResult
            />
          </>
        ) : null}
      </Card>
      <Card>
        <Text style={s.sectionTitle}>请求正文检查</Text>
        <Text style={s.muted}>请求正文需要先由 Magpie 开启归档。正文只在主动查看时读取。</Text>
        <Field label="请求 ID" value={call} onChange={setCall} />
        <Button
          label="读取请求正文"
          disabled={!call.trim()}
          onPress={() => setSelectedCall(call.trim())}
        />
        {selectedCall ? (
          <>
            <FeatureStatus query={callQuery} />
            <DataView data={callQuery.data} />
          </>
        ) : null}
      </Card>
    </>
  );
}
function KeyBudgets({ item }: { item: Row }) {
  const limits = item.limit ? [record(item.limit), ...rows(item.moreLimits)] : [];
  const [index, setIndex] = useState("0");
  const count = limits.length;
  const selected = Math.min(Number(index), count, 4);
  useEffect(() => {
    if (Number(index) > count) setIndex(String(count));
  }, [count, index]);
  const limit = limits[selected] || { period: "day", tokens: 0, cost: 0, cacheReads: false };
  const used = Array.isArray(item.usedAll)
    ? item.usedAll[selected]
    : selected === 0
    ? item.used
    : null;
  return (
    <>
      <ChoicePicker
        label="预算窗口"
        value={String(selected)}
        options={[
          ...limits.map((limit, i) => ({
            value: String(i),
            label: `窗口 ${i + 1} · ${limit.period}${
              limit.days ? ` / ${limit.days} 天` : limit.hours ? ` / ${limit.hours} 小时` : ""
            }`,
            note: "",
          })),
          ...(count < 5
            ? [{ value: String(count), label: "添加预算窗口", note: "最多 5 个，各窗口同时生效" }]
            : []),
        ]}
        onChange={setIndex}
      />
      <ObjectForm
        key={`${item.id}-${selected}`}
        title="密钥预算"
        operation="gateway.key.limit"
        fixed={{ key: item.id, index: selected }}
        data={limit}
        fields={[
          {
            key: "period",
            label: "额度窗口",
            kind: "choice",
            choices: [
              ["day", "每日"],
              ["week", "每周"],
              ["month", "每月"],
              ["days", "每 N 天"],
              ["hours", "每 N 小时"],
            ],
          },
          { key: "days", label: "天数（仅每 N 天生效）", kind: "number" },
          { key: "hours", label: "小时数（仅每 N 小时生效）", kind: "number" },
          { key: "tokens", label: "Token 上限（0 不限制）", kind: "number" },
          { key: "cost", label: "费用上限（USD，0 不限制）", kind: "number" },
          { key: "cacheReads", label: "计入缓存读取 Token", kind: "boolean" },
        ]}
      />
      {used ? <DataView data={used} /> : null}
      {selected < count ? (
        <>
          <ActionButton
            key={`reset-${selected}`}
            operation="gateway.key.reset"
            label="重置此预算窗口用量"
            body={{ key: item.id, index: selected }}
            confirm
          />
          <ActionButton
            key={`remove-${selected}`}
            operation="gateway.key.limit"
            label="移除此预算窗口"
            body={{ key: item.id, index: selected, limit: null }}
            confirm
          />
        </>
      ) : null}
    </>
  );
}
function ConnectionExamples({ data }: { data: ReturnType<typeof record> }) {
  const { s } = useUi();
  const models = rows(data.providers).flatMap((p) =>
    rows(p.models).map((m) => ({
      value: `${p.id}/${m.id}`,
      label: `${m.name || m.id} · ${p.name}`,
      note: "",
    })),
  );
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [api, setApi] = useState("responses");
  const [language, setLanguage] = useState("curl");
  const base = url || str(record(data.gateway).url);
  const selected = model || models[0]?.value || "provider/model";
  const endpoint =
    api === "responses"
      ? "/v1/responses"
      : api === "anthropic"
      ? "/v1/messages"
      : api === "gemini"
      ? `/v1beta/models/${selected}:generateContent`
      : "/v1/chat/completions";
  const payload =
    api === "responses"
      ? { model: selected, input: "hi" }
      : api === "gemini"
      ? { contents: [{ parts: [{ text: "hi" }] }] }
      : {
          model: selected,
          ...(api === "anthropic" ? { max_tokens: 1024 } : {}),
          messages: [{ role: "user", content: "hi" }],
        };
  const code =
    language === "curl"
      ? `curl ${JSON.stringify(
          base + endpoint,
        )} \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer <gateway-key>' \\\n  -d '${JSON.stringify(
          payload,
        )}'`
      : language === "python"
      ? `import requests\nr = requests.post(${JSON.stringify(
          base + endpoint,
        )}, headers={"Authorization": "Bearer <gateway-key>"}, json=${JSON.stringify(
          payload,
        )})\nprint(r.json())`
      : language === "node"
      ? `const r = await fetch(${JSON.stringify(
          base + endpoint,
        )}, {\n  method: "POST",\n  headers: {"Content-Type": "application/json", "Authorization": "Bearer <gateway-key>"},\n  body: JSON.stringify(${JSON.stringify(
          payload,
        )})\n});\nconsole.log(await r.json());`
      : `export ${
          api === "anthropic"
            ? "ANTHROPIC_BASE_URL"
            : api === "gemini"
            ? "GOOGLE_GEMINI_BASE_URL"
            : "OPENAI_BASE_URL"
        }=${base}${api === "responses" || api === "chat" ? "/v1" : ""}\nexport ${
          api === "anthropic"
            ? "ANTHROPIC_AUTH_TOKEN"
            : api === "gemini"
            ? "GEMINI_API_KEY"
            : "OPENAI_API_KEY"
        }=<gateway-key>`;
  return (
    <Card>
      <Text style={s.sectionTitle}>连接示例与模型目录</Text>
      <Field label="连接地址（可选）" value={url} onChange={setUrl} placeholder={base} />
      <ChoicePicker label="示例模型" value={selected} options={models} onChange={setModel} />
      <ChoicePicker
        label="API 协议"
        value={api}
        options={[
          ["responses", "Responses"],
          ["chat", "Chat Completions"],
          ["anthropic", "Anthropic Messages"],
          ["gemini", "Gemini"],
        ].map(([value, label]) => ({ value, label, note: "" }))}
        onChange={setApi}
      />
      <ChoicePicker
        label="代码语言"
        value={language}
        options={[
          ["curl", "curl"],
          ["python", "Python"],
          ["node", "Node.js"],
          ["shell", "环境变量"],
        ].map(([value, label]) => ({ value, label, note: "" }))}
        onChange={setLanguage}
      />
      <Text selectable style={s.text}>
        {code}
      </Text>
      <CopyButton value={code} label="复制连接示例" />
      <CopyButton value={models.map((m) => m.value).join("\n")} label="复制全部模型 ID" />
    </Card>
  );
}
