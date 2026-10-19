import { useState } from "react";
import { Text, View } from "react-native";
import type { Row } from "../shared/features";
import { record, rows, str, useFeatureMutation } from "./features";
import { Banner, Button, Card, ChoicePicker, ConfirmButton, Field, Toggle, useUi } from "./kit";

const lines = (text: string) =>
  text
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
const listText = (value: unknown) => (Array.isArray(value) ? value.join("\n") : "");
const effortOptions = [
  ["", "跟随请求"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "更高"],
  ["max", "最高"],
].map(([value, label]) => ({ value, label, note: "" }));

export function RoutingRules({ group }: { group: Row }) {
  const { s } = useUi();
  const mutation = useFeatureMutation();
  const [draft, setDraft] = useState<Row[] | null>(null);
  const rules = draft ?? rows(group.rules);
  const update = (index: number, patch: Row) =>
    setDraft(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const time = (index: number, key: string, value: Row[string]) =>
    update(index, { time: { ...record(rules[index].time), [key]: value } });
  const members = (Array.isArray(group.members) ? group.members : []).map((member) => ({
    value: String(member),
    label: String(member),
    note: "",
  }));
  return (
    <Card>
      <Text style={s.sectionTitle}>路由规则</Text>
      <Text style={s.muted}>
        按顺序匹配；同一条规则中的条件需要同时满足。暂停成员支持 Agent、目录和时间条件。
      </Text>
      {rules.map((rule, index) => (
        <Card key={index}>
          <Text style={s.cardTitle}>规则 {index + 1}</Text>
          <ChoicePicker
            label={`规则 ${index + 1} 目标成员`}
            value={str(rule.use)}
            options={members}
            onChange={(use) => update(index, { use })}
          />
          <Toggle
            label={`规则 ${index + 1} 暂停此成员`}
            value={Boolean(rule.pause)}
            onChange={(pause) =>
              update(
                index,
                pause
                  ? {
                      pause,
                      intent: "",
                      tokens: 0,
                      images: false,
                      compact: false,
                      effort: "",
                      useEffort: "",
                    }
                  : { pause },
              )
            }
          />
          {!rule.pause ? (
            <>
              <Field
                label={`规则 ${index + 1} 意图描述`}
                value={str(rule.intent)}
                onChange={(intent) => update(index, { intent })}
              />
              <Field
                label={`规则 ${index + 1} 最低 Token 数`}
                value={String(rule.tokens || 0)}
                onChange={(value) => update(index, { tokens: value })}
              />
              <ChoicePicker
                label={`规则 ${index + 1} 最低请求思考级别`}
                value={str(rule.effort)}
                options={[
                  { value: "", label: "不限制", note: "" },
                  { value: "on", label: "任意思考级别", note: "" },
                  ...effortOptions.slice(1),
                ]}
                onChange={(effort) => update(index, { effort })}
              />
              <ChoicePicker
                label={`规则 ${index + 1} 目标思考级别`}
                value={str(rule.useEffort)}
                options={effortOptions}
                onChange={(useEffort) => update(index, { useEffort })}
              />
              <Toggle
                label={`规则 ${index + 1} 请求包含图片`}
                value={Boolean(rule.images)}
                onChange={(images) => update(index, { images })}
              />
              <Toggle
                label={`规则 ${index + 1} 正在压缩上下文`}
                value={Boolean(rule.compact)}
                onChange={(compact) => update(index, { compact })}
              />
            </>
          ) : null}
          <Field
            label={`规则 ${index + 1} Agent ID（一行一个）`}
            value={listText(rule.agents)}
            multiline
            onChange={(value) => update(index, { agents: lines(value) })}
          />
          <Field
            label={`规则 ${index + 1} 项目目录（一行一个）`}
            value={listText(rule.folders)}
            multiline
            onChange={(value) => update(index, { folders: lines(value) })}
          />
          <Field
            label={`规则 ${index + 1} 排除目录（一行一个）`}
            value={listText(rule.exceptFolders)}
            multiline
            onChange={(value) => update(index, { exceptFolders: lines(value) })}
          />
          <Toggle
            label={`规则 ${index + 1} 限定生效时间`}
            value={Boolean(rule.time)}
            onChange={(on) =>
              update(index, { time: on ? { from: "00:00", to: "00:00", days: [] } : null })
            }
          />
          {rule.time ? (
            <>
              <Field
                label={`规则 ${index + 1} 开始时间（HH:MM）`}
                value={str(record(rule.time).from)}
                onChange={(from) => time(index, "from", from)}
              />
              <Field
                label={`规则 ${index + 1} 结束时间（HH:MM）`}
                value={str(record(rule.time).to)}
                onChange={(to) => time(index, "to", to)}
              />
              <View style={s.row}>
                {[
                  ["mon", "周一"],
                  ["tue", "周二"],
                  ["wed", "周三"],
                  ["thu", "周四"],
                  ["fri", "周五"],
                  ["sat", "周六"],
                  ["sun", "周日"],
                ].map(([day, label]) => {
                  const days = Array.isArray(record(rule.time).days)
                    ? (record(rule.time).days as string[])
                    : [];
                  return (
                    <Toggle
                      key={day}
                      label={`规则 ${index + 1} ${label}`}
                      value={days.includes(day)}
                      onChange={(on) =>
                        time(
                          index,
                          "days",
                          on ? [...days, day] : days.filter((value) => value !== day),
                        )
                      }
                    />
                  );
                })}
              </View>
              <Text style={s.small}>不选择星期表示每天；结束早于开始表示跨午夜。</Text>
            </>
          ) : null}
          <View style={s.row}>
            <Button
              label={`上移规则 ${index + 1}`}
              disabled={index === 0}
              onPress={() => {
                const next = [...rules];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                setDraft(next);
              }}
            />
            <Button
              label={`下移规则 ${index + 1}`}
              disabled={index === rules.length - 1}
              onPress={() => {
                const next = [...rules];
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                setDraft(next);
              }}
            />
            <ConfirmButton
              label={`删除规则 ${index + 1}`}
              onConfirm={() => setDraft(rules.filter((_, i) => i !== index))}
            />
          </View>
        </Card>
      ))}
      <Button
        label="添加路由规则"
        onPress={() =>
          setDraft([
            ...rules,
            { use: members[0]?.value || "", agents: [], folders: [], exceptFolders: [] },
          ])
        }
      />
      {mutation.error ? <Banner error>{mutation.error}</Banner> : null}
      {mutation.result !== undefined ? <Banner>路由规则已保存。</Banner> : null}
      <Button
        label="保存路由规则"
        primary
        disabled={draft === null || mutation.busy}
        onPress={() => {
          const changed = rules.map((rule) => ({ ...rule, tokens: Number(rule.tokens || 0) }));
          void mutation.execute("groups.save", { id: group.id, rules: changed }).then((ok) => {
            if (ok) setDraft(null);
          });
        }}
      />
    </Card>
  );
}
