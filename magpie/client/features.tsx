import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import {
  readFeature,
  mutateFeature,
  type Feature,
  type Operation,
  type Json,
  type Row,
} from "../shared/features";
import { readJob } from "../shared/rpc";
import type { PreferenceField } from "../shared/preferences";
import {
  Banner,
  Button,
  Card,
  ChoicePicker,
  ConfirmButton,
  CopyButton,
  Field,
  Toggle,
  useUi,
} from "./kit";

export function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function at(data: Row, path: string): Json | undefined {
  let next: Json | undefined = data;
  for (const part of path.split(".")) next = record(next)[part];
  return next;
}
export function useFeature(
  feature: Feature,
  query: Record<string, string> = {},
  enabled = true,
  live = false,
) {
  const { hostId } = useUi();
  const rpc = useRpc(readFeature);
  return useQuery({
    queryKey: ["magpie-feature", hostId, feature, query],
    queryFn: async () => (await rpc({ feature, query })).data,
    enabled,
    retry: false,
    staleTime: 10_000,
    refetchInterval: live ? 5000 : false,
  });
}
export function useFeatureMutation() {
  const { hostId } = useUi();
  const rpc = useRpc(mutateFeature);
  const job = useRpc(readJob);
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Json | undefined>();
  const execute = async (operation: Operation, body: Row = {}) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const value = await rpc({ operation, body });
      if (value.jobId) {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const status = await job({ id: value.jobId });
          if (status.state === "failed") throw new Error(status.error);
          if (status.state === "done") {
            value.data = status.data ?? null;
            break;
          }
        }
      }
      setResult(value.data);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["magpie-feature", hostId] }),
        cache.invalidateQueries({ queryKey: ["magpie", hostId] }),
      ]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    execute,
    busy,
    error,
    result,
    clear: () => {
      setResult(undefined);
      setError("");
    },
  };
}

function stringifyField(field: PreferenceField, value: Json | undefined): string {
  if (field.kind === "secret") return "";
  if (field.kind === "lines") return Array.isArray(value) ? value.join("\n") : "";
  if (field.kind === "json") return JSON.stringify(value ?? null, null, 2);
  if (field.key === "refusalRetries" && value == null) return "null";
  return value == null ? "" : String(value);
}
export function ObjectForm({
  title,
  fields,
  data,
  operation,
  fixed = {},
  models = [],
  onDone,
}: {
  title: string;
  fields: PreferenceField[];
  data: Row;
  operation: Operation;
  fixed?: Row;
  models?: { value: string; label: string; note: string }[];
  onDone?(): void;
}) {
  const { s } = useUi();
  const mutation = useFeatureMutation();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [validation, setValidation] = useState("");
  const save = async () => {
    try {
      const body: Row = { ...fixed };
      const whole = [
        "gateway.key.limit",
        "provider.keeplogin",
        "agents.arrange",
        "signin.import",
        "settings.search-api",
        "settings.codex-auto-reset",
        "settings.codex-credits",
        "sync.save",
        "backup.export",
        "backup.import",
      ].includes(operation);
      for (const field of fields) {
        if (!(field.key in draft) && fixed.old !== "" && !whole) continue;
        if (!(field.key in draft) && field.kind === "secret") continue;
        const value =
          field.key in draft
            ? draft[field.key]
            : field.kind === "boolean"
            ? Boolean(at(data, field.key))
            : stringifyField(field, at(data, field.key));
        if (field.kind === "secret" && value === "" && operation !== "settings.github-token")
          continue;
        if (field.kind === "boolean") body[field.key] = Boolean(value);
        else if (field.kind === "number") {
          const number = Number(value);
          if (!Number.isFinite(number)) throw new Error(`${field.label}：请输入有效数字`);
          body[field.key] = number;
        } else if (field.kind === "json") body[field.key] = JSON.parse(String(value));
        else if (field.kind === "lines")
          body[field.key] = String(value)
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean);
        else if (field.key === "refusalRetries")
          body[field.key] = value === "null" ? null : Number(value);
        else body[field.key] = String(value);
      }
      setValidation("");
      if (await mutation.execute(operation, body)) {
        setDraft({});
        onDone?.();
      }
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Card>
      <Text style={s.sectionTitle}>{title}</Text>
      {fields.map((field) => {
        const value =
          field.key in draft
            ? draft[field.key]
            : field.kind === "boolean"
            ? Boolean(at(data, field.key))
            : stringifyField(field, at(data, field.key));
        const change = (value: string | boolean) =>
          setDraft((draft) => ({ ...draft, [field.key]: value }));
        return (
          <View key={field.key} style={s.section}>
            {field.kind === "boolean" ? (
              <Toggle
                label={field.label}
                value={Boolean(value)}
                disabled={mutation.busy}
                onChange={change}
              />
            ) : field.kind === "choice" ? (
              <ChoicePicker
                label={field.label}
                value={String(value)}
                options={(field.choices || []).map(([value, label]) => ({
                  value,
                  label,
                  note: "",
                }))}
                onChange={change}
              />
            ) : field.kind === "model" && models.length ? (
              <ChoicePicker
                label={field.label}
                value={String(value)}
                options={[
                  { value: "", label: "默认 / 自动", note: "" },
                  { value: "off", label: "关闭", note: "" },
                  ...models,
                ]}
                onChange={change}
              />
            ) : (
              <Field
                label={field.label}
                value={String(value)}
                onChange={change}
                secure={field.kind === "secret"}
                multiline={
                  field.kind === "lines" || field.kind === "json" || field.kind === "multiline"
                }
              />
            )}
            {field.hint ? <Text style={s.small}>{field.hint}</Text> : null}
          </View>
        );
      })}
      {validation || mutation.error ? <Banner error>{validation || mutation.error}</Banner> : null}
      {mutation.result !== undefined ? (
        <>
          <Banner>已保存。</Banner>
          {[
            "backup.export",
            "backup.import",
            "provider.test",
            "provider.detect",
            "library.skills.probe",
            "library.market.server",
            "library.market.skill",
            "library.projects.add",
            "library.mcp.config",
            "groups.template",
          ].includes(operation) ? (
            <DataView data={mutation.result} />
          ) : null}
        </>
      ) : null}
      {["backup.import", "sessions.provider", "keys.replace"].includes(operation) ? (
        <ConfirmButton
          label={`保存${title}`}
          disabled={!Object.keys(draft).length || mutation.busy}
          detail="此操作会修改主机上现有的数据，请核对目标与选项后确认。"
          onConfirm={() => {
            void save();
          }}
        />
      ) : (
        <Button
          label={`保存${title}`}
          icon="Check"
          primary
          disabled={!Object.keys(draft).length || mutation.busy}
          onPress={() => {
            void save();
          }}
        />
      )}
    </Card>
  );
}

export function DataView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const { s } = useUi();
  const [expanded, setExpanded] = useState(depth < 1);
  const [shown, setShown] = useState(20);
  if (data == null) return <Text style={s.small}>—</Text>;
  if (typeof data !== "object")
    return (
      <Text selectable style={s.text}>
        {String(data)}
      </Text>
    );
  if (depth > 5)
    return (
      <Text selectable style={s.small}>
        {JSON.stringify(data, null, 2)}
      </Text>
    );
  const entries = Array.isArray(data)
    ? data.map((v, i) => [String(i + 1), v] as const)
    : Object.entries(data);
  if (!expanded)
    return (
      <Button
        label={`展开${Array.isArray(data) ? "列表" : "详情"}（${entries.length} 项）`}
        onPress={() => setExpanded(true)}
      />
    );
  return (
    <View style={s.section}>
      {entries.slice(0, shown).map(([key, value]) => (
        <View key={key} style={s.section}>
          <Text style={s.label}>{key}</Text>
          <DataView data={value} depth={depth + 1} />
        </View>
      ))}
      {shown < entries.length ? (
        <Button label="显示更多详情" onPress={() => setShown(shown + 20)} />
      ) : null}
      {depth > 0 ? <Button label="收起详情" onPress={() => setExpanded(false)} /> : null}
    </View>
  );
}
export function FeatureStatus({ query }: { query: ReturnType<typeof useFeature> }) {
  const { s } = useUi();
  return query.isPending ? (
    <Text style={s.muted}>正在读取…</Text>
  ) : query.error ? (
    <Banner error>{query.error.message}</Banner>
  ) : null;
}
export function ActionButton({
  operation,
  label,
  body = {},
  confirm = false,
  detail,
  showResult = false,
}: {
  operation: Operation;
  label: string;
  body?: Row;
  confirm?: boolean;
  detail?: string;
  showResult?: boolean;
}) {
  const mutation = useFeatureMutation();
  return (
    <View>
      {confirm ? (
        <ConfirmButton
          label={label}
          disabled={mutation.busy}
          detail={detail}
          onConfirm={() => {
            void mutation.execute(operation, body);
          }}
        />
      ) : (
        <Button
          label={mutation.busy ? `${label}…` : label}
          disabled={mutation.busy}
          onPress={() => {
            void mutation.execute(operation, body);
          }}
        />
      )}
      {mutation.error ? <Banner error>{mutation.error}</Banner> : null}
      {mutation.result !== undefined ? (
        showResult ? (
          <DataView data={mutation.result} />
        ) : (
          <Banner>操作完成。</Banner>
        )
      ) : null}
    </View>
  );
}
