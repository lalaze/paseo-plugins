import { RoutingRules } from "./routing-rules";
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
import { Button, Card, Chip, Dialog, Field, Segments, useUi } from "./kit";

const groupFields: PreferenceField[] = [
  { key: "pick", label: "手动使用的成员模型 ID", kind: "text" },
  { key: "weights", label: "成员权重（模型 ID → 权重）", kind: "json" },
  {
    key: "affinity",
    label: "会话保持",
    kind: "choice",
    choices: [
      ["", "自动"],
      ["session", "会话"],
      ["turn", "单轮"],
      ["off", "关闭"],
      ["strict", "严格"],
    ],
  },
  { key: "sink", label: "被短期限流的成员排到队尾", kind: "boolean" },
  { key: "unlists", label: "目录只显示路由组，隐藏成员", kind: "boolean" },
  { key: "firstToken", label: "首 Token 等待上限（秒，0 一直等待）", kind: "number" },
  { key: "patience", label: "成员全部忙时排队（秒，-1 关闭）", kind: "number" },
  { key: "match", label: "自动匹配模型的模式（一行一个）", kind: "lines" },
  { key: "off", label: "组内停用的成员（一行一个）", kind: "lines" },
  { key: "fast", label: "使用快速模式的成员（一行一个）", kind: "lines" },
  { key: "context", label: "向 Agent 提供的上下文窗口", kind: "number" },
  {
    key: "effort",
    label: "组的思考级别",
    kind: "choice",
    choices: [
      ["", "跟随请求"],
      ["auto", "自动分类"],
      ["low", "低"],
      ["medium", "中"],
      ["high", "高"],
      ["xhigh", "更高"],
      ["max", "最高"],
    ],
  },
  { key: "classifier", label: "意图分类模型 ID", kind: "text" },
  { key: "levels", label: "开放的思考级别（一行一个）", kind: "lines" },
];
export function RoutingAdvanced() {
  const { s } = useUi();
  const [tab, setTab] = useState("live");
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useFeature("groups");
  const [day, setDay] = useState("");
  const history = useFeature("gatewayHistory", day ? { day } : {}, tab === "history");
  const trace = useFeature("routing", { after: "0" }, tab === "live", true);
  const data = record(groups.data);
  const routes = rows(record(tab === "history" ? history.data : trace.data).routes);
  const group = rows(data.groups).find((g) => g.id === selected);
  return (
    <>
      <Card>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { value: "live", label: "实时决策" },
            { value: "history", label: "历史路由" },
            { value: "pools", label: "账号池" },
            { value: "advanced", label: "规则与高级配置" },
            { value: "templates", label: "模板与共享" },
          ]}
        />
      </Card>
      {tab === "live" || tab === "history" ? (
        <>
          {tab === "history" ? (
            <Card>
              <Field label="历史日期（YYYY-MM-DD）" value={day} onChange={setDay} />
              <FeatureStatus query={history} />
              <DataView data={record(history.data).days} />
            </Card>
          ) : (
            <FeatureStatus query={trace} />
          )}
          <Card>
            <Text style={s.sectionTitle}>网关路由决策</Text>
            <DataView data={record(trace.data).totals} />
            <Button
              label="刷新路由记录"
              onPress={() => {
                void trace.refetch();
              }}
            />
          </Card>
          {routes
            .slice()
            .reverse()
            .map((r) => (
              <Card key={String(r.id)}>
                <View style={s.between}>
                  <Text style={s.cardTitle}>
                    {str(r.agent)} → {str(r.model)}
                  </Text>
                  <Chip label={String(r.status || "进行中")} />
                </View>
                <Text style={s.small}>
                  {str(r.time)} · {Number(r.ms || 0)} ms
                </Text>
                <Text style={s.label}>候选账号与顺序</Text>
                <DataView data={r.order} />
                <Text style={s.label}>实际尝试与结果</Text>
                <DataView data={r.tries} />
                <Text style={s.label}>会话保持原因</Text>
                <DataView data={r.affinity} />
                <Text style={s.label}>完整决策、规则与请求信息</Text>
                <DataView data={r} />
                {[...rows(r.order), ...rows(r.left)]
                  .filter((candidate) => candidate.rest)
                  .map((candidate) => (
                    <ActionButton
                      key={str(candidate.id)}
                      operation="gateway.unrest"
                      label={`解除 ${candidate.who || candidate.name || candidate.id} 的休息状态`}
                      body={{ key: candidate.id }}
                      confirm
                      showResult
                    />
                  ))}
              </Card>
            ))}
        </>
      ) : tab === "pools" ? (
        <>
          {rows(data.pools).map((p, i) => (
            <Card key={`${p.provider}-${i}`}>
              <Text style={s.cardTitle}>{str(p.name)}</Text>
              <DataView data={p.who} />
              <ObjectForm
                title="账号池路由"
                operation="provider.routing"
                fixed={{ id: p.provider }}
                data={p}
                fields={[
                  {
                    key: "routing",
                    label: "路由策略",
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
                ]}
              />
              <ObjectForm
                title="账号池会话保持"
                operation="provider.affinity"
                fixed={{ id: p.provider }}
                data={p}
                fields={groupFields.filter((f) => f.key === "affinity")}
              />
            </Card>
          ))}
        </>
      ) : tab === "advanced" ? (
        <>
          <FeatureStatus query={groups} />
          {rows(data.groups)
            .filter((g) => !g.auto)
            .map((g) => (
              <Card key={str(g.id)}>
                <Text style={s.cardTitle}>{str(g.name)}</Text>
                <ActionButton
                  operation="groups.share"
                  label={`导出 ${g.name} 的共享配置`}
                  body={{ id: g.id }}
                  showResult
                />
                <Button
                  label={`编辑 ${g.name} 的高级配置`}
                  onPress={() => setSelected(str(g.id))}
                />
              </Card>
            ))}
        </>
      ) : (
        <>
          <ObjectForm
            title="导入共享路由组"
            operation="groups.import"
            data={{}}
            fields={[{ key: "text", label: "共享的路由组配置", kind: "text" }]}
          />
          <Card>
            <Text style={s.sectionTitle}>路由模板</Text>
            <DataView data={data.templates} />
            <ObjectForm
              title="应用路由模板"
              operation="groups.template"
              data={{}}
              fields={[
                {
                  key: "kind",
                  label: "模板",
                  kind: "choice",
                  choices: [
                    ["smart", "智能选择"],
                    ["thrifty", "优先节省"],
                    ["steady", "多供应商保障"],
                  ],
                },
                { key: "name", label: "路由组名称", kind: "text" },
              ]}
            />
          </Card>
          <ObjectForm
            title="路由组显示顺序"
            operation="groups.arrange"
            data={{}}
            fields={[{ key: "order", label: "路由组 ID（一行一个）", kind: "lines" }]}
          />
          <ObjectForm
            title="自动发现同名模型"
            operation="groups.found"
            data={{ on: data.found }}
            fields={[{ key: "on", label: "发现并组合多个来源的同名模型", kind: "boolean" }]}
          />
        </>
      )}
      {group ? (
        <Dialog title={`${group.name} · 高级路由`} onClose={() => setSelected(null)}>
          <ObjectForm
            title="高级路由"
            fields={groupFields}
            data={group}
            operation="groups.save"
            fixed={{ id: group.id }}
          />
          <RoutingRules key={str(group.id)} group={group} />
        </Dialog>
      ) : null}
    </>
  );
}
