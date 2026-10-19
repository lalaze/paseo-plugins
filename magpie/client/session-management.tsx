import { useState } from "react";
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
  useFeatureMutation,
} from "./features";
import {
  Banner,
  Button,
  Card,
  ChoicePicker,
  ConfirmButton,
  CopyButton,
  Field,
  Segments,
  Toggle,
  useUi,
} from "./kit";

export function SessionManagement() {
  const { s } = useUi();
  const [agent, setAgent] = useState("");
  const [tab, setTab] = useState("sessions");
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const query = useFeature("sessions", agent ? { agent } : {});
  const found = useFeature(
    "sessionSearch",
    { agent: agent || str(record(query.data).agent), q: search },
    Boolean(search.trim()),
  );
  const data = record(query.data);
  const actualAgent = agent || str(data.agent);
  const sessions = rows(data.sessions);
  const visible = sessions.filter(
    (session) =>
      (!folder || session.cwd === folder) &&
      (!search ||
        `${session.title} ${session.id} ${session.cwd}`
          .toLowerCase()
          .includes(search.toLowerCase()) ||
        rows(record(found.data).hits).some((h) => h.id === session.id)),
  );
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>会话管理</Text>
        <Segments
          value={tab}
          onChange={(value) => {
            setTab(value);
            setSelected([]);
          }}
          options={[
            { value: "sessions", label: "按 Agent 和目录" },
            { value: "trash", label: "回收站" },
            { value: "migrate", label: "迁移" },
          ]}
        />
        <ChoicePicker
          label="管理的 Agent"
          value={actualAgent}
          options={rows(data.agents).map((a) => ({
            value: str(a.agent),
            label: `${a.name} · ${a.count}`,
            note: "",
          }))}
          onChange={(value) => {
            setAgent(value);
            setSelected([]);
            setFolder("");
          }}
        />
      </Card>
      <FeatureStatus query={query} />
      {tab === "sessions" ? (
        <>
          <Card>
            <Field label="搜索标题、目录和会话内容" value={search} onChange={setSearch} />
            <ChoicePicker
              label="项目目录"
              value={folder}
              options={[
                { value: "", label: "全部目录", note: "" },
                ...[...new Set(sessions.map((s) => str(s.cwd)))].map((value) => ({
                  value,
                  label: value || "无目录",
                  note: "",
                })),
              ]}
              onChange={setFolder}
            />
            <Toggle
              label="选择当前列表全部可删除会话"
              value={
                visible.length > 0 &&
                visible.filter((s) => s.deletable).every((s) => selected.includes(str(s.id)))
              }
              onChange={(on) =>
                setSelected(on ? visible.filter((s) => s.deletable).map((s) => str(s.id)) : [])
              }
            />
            {selected.length ? (
              <ActionButton
                operation="sessions.delete"
                label={`移入回收站（${selected.length}）`}
                body={{ agent: actualAgent, ids: selected }}
                detail="会话文件会移入 Magpie 回收站；正在写入的会话由 Magpie 拒绝删除。"
                confirm
                showResult
              />
            ) : null}
          </Card>
          {visible.map((session) => (
            <Card key={str(session.id)}>
              <Text style={s.cardTitle}>{str(session.title) || str(session.id)}</Text>
              <Text style={s.small}>{str(session.cwd)}</Text>
              {session.deletable ? (
                <Toggle
                  label={`选择会话 ${session.title || session.id}`}
                  value={selected.includes(str(session.id))}
                  onChange={(on) =>
                    setSelected(
                      on
                        ? [...selected, str(session.id)]
                        : selected.filter((id) => id !== session.id),
                    )
                  }
                />
              ) : null}
              <View style={s.row}>
                {session.resume ? (
                  <CopyButton value={str(session.resume)} label="复制恢复会话命令" />
                ) : null}
                {data.terminal ? (
                  <ActionButton
                    operation="sessions.terminal"
                    label="在主机终端继续"
                    body={{ agent: actualAgent, id: session.id }}
                  />
                ) : null}
                <ActionButton
                  operation="sessions.export"
                  label="导出会话 Markdown 到主机"
                  body={{ agent: actualAgent, id: session.id }}
                  showResult
                />
              </View>
              {Array.isArray(session.subagents) ? (
                <>
                  <Text style={s.label}>子 Agent 会话</Text>
                  <DataView data={session.subagents} />
                </>
              ) : null}
              <Text style={s.small}>{str(session.path)}</Text>
            </Card>
          ))}
          {search ? (
            <Card>
              <Text style={s.sectionTitle}>内容搜索结果</Text>
              <FeatureStatus query={found} />
              <DataView data={found.data} />
            </Card>
          ) : null}
          <ObjectForm
            title="记录网关会话"
            operation="sessions.recording"
            data={{ on: data.recording }}
            fields={[{ key: "on", label: "保存经过网关的会话正文", kind: "boolean" }]}
          />
          <ActionButton
            operation="sessions.recording"
            label="停止记录并清除已记录正文"
            body={{ on: false, clear: true }}
            confirm
          />
        </>
      ) : tab === "trash" ? (
        <>
          <Card>
            <Text style={s.small}>{str(data.trashDir)}</Text>
            <ActionButton
              operation="sessions.purge"
              label="清空回收站"
              detail="永久删除回收站中的所有会话，无法恢复。"
              body={{ all: true }}
              confirm
              showResult
            />
          </Card>
          {rows(data.trash).map((item) => (
            <Card key={str(item.key)}>
              <Text style={s.cardTitle}>{str(item.title) || str(item.id)}</Text>
              <Text style={s.small}>{str(item.cwd)}</Text>
              <ActionButton
                operation="sessions.restore"
                label="恢复会话"
                body={{ key: item.key }}
                showResult
              />
              <ActionButton
                operation="sessions.purge"
                label="永久删除会话"
                body={{ keys: [item.key] }}
                confirm
                showResult
              />
            </Card>
          ))}
        </>
      ) : (
        <>
          <Relocation />
          <ObjectForm
            title="Codex 会话供应商迁移"
            operation="sessions.provider"
            data={{ moves: selected.map((id) => ({ id, to: "" })) }}
            fields={[{ key: "moves", label: "迁移项（会话 id 与目标供应商 to）", kind: "json" }]}
          />
        </>
      )}
    </>
  );
}
function Relocation() {
  const { s } = useUi();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [wsl, setWsl] = useState("");
  const mutation = useFeatureMutation();
  const result = record(mutation.result);
  return (
    <Card>
      <Text style={s.sectionTitle}>迁移 Claude 项目会话</Text>
      <Text style={s.muted}>
        先关闭此项目的 Claude Code 和编辑器会话。预览后再确认迁移，原始文件由 Magpie 保留。
      </Text>
      <Field
        label="原项目绝对路径"
        value={from}
        onChange={(value) => {
          setFrom(value);
          mutation.clear();
        }}
      />
      <Field
        label="新项目绝对路径"
        value={to}
        onChange={(value) => {
          setTo(value);
          mutation.clear();
        }}
      />
      <Field
        label="WSL 发行版（可选）"
        value={wsl}
        onChange={(value) => {
          setWsl(value);
          mutation.clear();
        }}
      />
      <Button
        label="预览会话迁移"
        disabled={!from || !to || mutation.busy}
        onPress={() => {
          void mutation.execute("sessions.relocate", { from, to, wsl, token: "" });
        }}
      />
      {mutation.error ? <Banner error>{mutation.error}</Banner> : null}
      {mutation.result ? <DataView data={mutation.result} /> : null}
      {result.token && !result.backup ? (
        <ConfirmButton
          label="执行会话迁移"
          onConfirm={() => {
            void mutation.execute("sessions.relocate", { from, to, wsl, token: result.token });
          }}
        />
      ) : null}
    </Card>
  );
}
