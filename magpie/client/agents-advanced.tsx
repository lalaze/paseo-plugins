import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
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
import { Button, Card, ChoicePicker, CopyButton, Dialog, useUi } from "./kit";

export function AgentsAdvanced() {
  const { s } = useUi();
  const query = useFeature("agents");
  const clis = useFeature("agentCli");
  const installs = useFeature("agentInstalls");
  const [selected, setSelected] = useState("");
  const data = record(query.data);
  const settings = record(data.settings);
  return (
    <>
      <ActionButton
        operation="codex.restart"
        label="重启 Codex 后台服务以更新账号与模型列表"
        detail="请先结束正在运行的轮次；较旧 Codex 的后台会话可能会结束。"
        confirm
        showResult
      />
      <ObjectForm
        title="Agent 排序和显示"
        operation="agents.arrange"
        data={{
          order: settings.agentOrder || [],
          hidden: settings.agentsHidden || [],
          shown: settings.agentsShown || [],
        }}
        fields={[
          { key: "order", label: "Agent 顺序（一行一个 ID）", kind: "lines" },
          { key: "hidden", label: "隐藏的 Agent（一行一个 ID）", kind: "lines" },
          { key: "shown", label: "显式显示的 Agent（一行一个 ID）", kind: "lines" },
        ]}
      />
      <Card>
        <Text style={s.sectionTitle}>Agent 模型管理与配置预览</Text>
        {rows(data.agents).map((a) => (
          <Button
            key={str(a.id)}
            label={`管理 ${a.name} 的模型列表`}
            onPress={() => setSelected(str(a.id))}
          />
        ))}
      </Card>
      <FeatureStatus query={clis} />
      <Card>
        <Text style={s.sectionTitle}>已安装 CLI 及版本</Text>
        {Object.entries(record(record(clis.data).agents)).map(([id, value]) => (
          <Card key={id}>
            <Text style={s.cardTitle}>{str(record(value).name) || id}</Text>
            <DataView data={value} />
            <ActionButton
              operation="agents.upgrade"
              label={`更新 ${str(record(value).name) || id}`}
              body={{ id }}
              showResult
            />
          </Card>
        ))}
      </Card>
      <Card>
        <Text style={s.sectionTitle}>可安装的 Agent</Text>
        <FeatureStatus query={installs} />
        {rows(installs.data).map((item) => (
          <Card key={str(item.id)}>
            <Text style={s.cardTitle}>{str(item.name) || str(item.id)}</Text>
            <DataView data={item} />
            {item.command ? (
              <CopyButton
                label={`复制 ${item.name || item.id} 安装命令`}
                value={str(item.command)}
              />
            ) : null}
            {item.url ? <ExternalLink href={str(item.url)}>打开安装说明</ExternalLink> : null}
          </Card>
        ))}
      </Card>
      {selected ? (
        <Dialog title={`${selected} · 模型与配置`} onClose={() => setSelected("")}>
          <AgentModels id={selected} />
        </Dialog>
      ) : null}
    </>
  );
}
function AgentModels({ id }: { id: string }) {
  const { s } = useUi();
  const query = useFeature("agentModels", { id });
  const [preview, setPreview] = useState(false);
  const plan = useFeature("agentPreview", { id }, preview);
  const data = record(query.data);
  return (
    <>
      <FeatureStatus query={query} />
      <ObjectForm
        title="模型可见性"
        operation="agents.models"
        fixed={{ id }}
        data={{
          hidden: rows(data.models)
            .filter((m) => m.hidden)
            .map((m) => m.id),
        }}
        fields={[{ key: "hidden", label: "隐藏模型 ID（一行一个）", kind: "lines" }]}
      />
      <ObjectForm
        title="新模型可见性"
        operation="agents.models"
        fixed={{ id }}
        data={data}
        fields={[{ key: "only", label: "只显示手动选择的模型", kind: "boolean" }]}
      />
      <ObjectForm
        title="Agent 自有模型"
        operation="agents.models"
        fixed={{ id }}
        data={data}
        fields={[{ key: "ownHidden", label: "隐藏 Agent 自有模型", kind: "boolean" }]}
      />
      <ObjectForm
        title="模型排列顺序"
        operation="agents.models"
        fixed={{ id }}
        data={{ order: rows(data.models).map((m) => m.id) }}
        fields={[{ key: "order", label: "模型 ID（一行一个）", kind: "lines" }]}
      />
      <Card>
        <Text style={s.sectionTitle}>模型列表</Text>
        <DataView data={data.models} />
        <CopyButton
          value={rows(data.models)
            .map((m) => m.id)
            .join("\n")}
          label="复制模型 ID 列表"
        />
      </Card>
      <Button label="查看断开接入的配置变更预览" onPress={() => setPreview(true)} />
      {preview ? (
        <>
          <FeatureStatus query={plan} />
          <DataView data={plan.data} />
        </>
      ) : null}
    </>
  );
}
