import { useState } from "react";
import { Text, View } from "react-native";
import type { GroupDraft, PageData } from "../shared/rpc";
import {
  Button,
  Card,
  Chip,
  ChoicePicker,
  ConfirmButton,
  Empty,
  Field,
  Toggle,
  useUi,
} from "./kit";

const strategies = [
  { value: "smart", label: "智能选择", note: "由 Magpie 选择可用成员" },
  { value: "order", label: "按顺序", note: "按成员顺序尝试，失败后切换" },
  { value: "rotate", label: "轮换", note: "轮流使用各成员" },
  { value: "usage", label: "最低使用量", note: "优先剩余额度较多的账户" },
  { value: "pace", label: "按消耗速度", note: "平衡额度消耗" },
  { value: "weight", label: "按权重", note: "使用模型与账户的权重" },
  { value: "manual", label: "手动", note: "使用选定的成员" },
];

export function RoutingPage({ data, query }: { data: PageData; query: string }) {
  const { s, run } = useUi();
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [member, setMember] = useState("");
  const groups = data.groups.filter((g) =>
    `${g.name} ${g.id} ${g.members.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <View style={s.between}>
        <Text style={s.muted}>将多个模型组成一个入口，统一故障切换与请求分配。</Text>
        <Button
          label="新建路由组"
          icon="Plus"
          primary
          onPress={() => {
            setAdding(true);
            setMember("");
            setDraft({ id: "", name: "", members: [], routing: "order" });
          }}
        />
      </View>
      {draft ? (
        <Card>
          <Text style={s.sectionTitle}>{adding ? "新建路由组" : "编辑路由组"}</Text>
          <View style={s.row}>
            <Field
              label="组名称"
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            {adding ? (
              <Field
                label="组 ID"
                value={draft.id}
                onChange={(id) => setDraft({ ...draft, id })}
                placeholder="小写字母、数字、点或短横线"
              />
            ) : (
              <Chip label={`group/${draft.id}`} />
            )}
          </View>
          <ChoicePicker
            label="分配策略"
            value={draft.routing}
            options={
              strategies.some((s) => s.value === draft.routing)
                ? strategies
                : [
                    { value: draft.routing, label: draft.routing, note: "当前的自定义策略" },
                    ...strategies,
                  ]
            }
            onChange={(routing) =>
              setDraft({ ...draft, routing: routing as GroupDraft["routing"] })
            }
          />
          <View style={s.row}>
            <ChoicePicker
              label="添加模型成员"
              value={member}
              options={data.models.filter((m) => !draft.members.includes(m.value))}
              onChange={setMember}
            />
            <Button
              label="添加成员"
              icon="Plus"
              disabled={!member}
              onPress={() => {
                setDraft({ ...draft, members: [...draft.members, member] });
                setMember("");
              }}
            />
          </View>
          {draft.members.map((id, index) => (
            <View key={id} style={s.tableRow}>
              <Text style={[s.text, s.grow]}>
                {index + 1}. {data.models.find((m) => m.value === id)?.label || id}
              </Text>
              <Button
                label="上移"
                icon="ArrowUp"
                disabled={index === 0}
                onPress={() => {
                  const members = [...draft.members];
                  [members[index - 1], members[index]] = [members[index], members[index - 1]];
                  setDraft({ ...draft, members });
                }}
              />
              <Button
                label="移除成员"
                icon="X"
                onPress={() =>
                  setDraft({ ...draft, members: draft.members.filter((m) => m !== id) })
                }
              />
            </View>
          ))}
          <View style={s.row}>
            <Button
              label="保存路由组"
              icon="Check"
              primary
              disabled={
                !draft.name.trim() ||
                !/^[a-z0-9][a-z0-9.-]*$/.test(draft.id) ||
                draft.members.length === 0
              }
              onPress={() => {
                void run({ type: "group.save", draft }).then((ok) => {
                  if (ok) setDraft(null);
                });
              }}
            />
            <Button label="取消" onPress={() => setDraft(null)} />
          </View>
        </Card>
      ) : null}
      {!groups.length ? (
        <Empty
          title="还没有路由组"
          hint="将不同供应商的模型放进一个组，Agent 只需选择这个组。"
          icon="GitBranch"
        />
      ) : null}
      {groups.map((g) => (
        <Card key={g.id}>
          <View style={s.between}>
            <View style={s.grow}>
              <Text style={s.cardTitle}>{g.name}</Text>
              <Text style={s.small}>group/{g.id}</Text>
            </View>
            <Chip
              label={
                g.auto
                  ? "自动发现"
                  : strategies.find((s) => s.value === g.routing)?.label || g.routing || "智能选择"
              }
            />
            <Chip
              label={g.ready && !g.disabled ? "可用" : "不可用"}
              good={g.ready && !g.disabled}
            />
          </View>
          {g.members.map((member, i) => (
            <View key={member} style={s.row}>
              <Text style={s.small}>{i + 1}</Text>
              <Text style={[s.text, s.grow]}>
                {data.models.find((m) => m.value === member)?.label || member}
              </Text>
              {g.off.includes(member) ? <Chip label="已停用" /> : null}
            </View>
          ))}
          {!g.auto ? (
            <View style={s.row}>
              <Toggle
                label="启用路由组"
                value={!g.disabled}
                onChange={(on) => {
                  void run({ type: "group.toggle", id: g.id, on });
                }}
              />
              <Button
                label="编辑路由组"
                icon="Pencil"
                onPress={() => {
                  setAdding(false);
                  setDraft({
                    id: g.id,
                    name: g.name,
                    members: g.members,
                    routing: g.routing || "smart",
                  });
                }}
              />
              <ConfirmButton
                label="删除路由组"
                onConfirm={() => {
                  void run({ type: "group.delete", id: g.id });
                }}
              />
            </View>
          ) : null}
        </Card>
      ))}
    </>
  );
}
