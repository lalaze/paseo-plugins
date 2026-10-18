import { useState } from "react";
import { Text, View } from "react-native";
import type { PageData } from "../shared/rpc";
import {
  Banner,
  BrandIcon,
  Button,
  Card,
  Chip,
  ChoicePicker,
  ConfirmButton,
  Empty,
  Field,
  IconButton,
  StatusDot,
  Toggle,
  useUi,
} from "./kit";

export function AgentsPage({ data, query }: { data: PageData; query: string }) {
  const { s, run } = useUi();
  const [profile, setProfile] = useState("");
  const [profilesOpen, setProfilesOpen] = useState(false);
  const rows = data.agents.filter((a) =>
    `${a.name} ${a.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <View style={s.between}>
        <Text style={s.muted}>
          {data.agents.length} 个已检测 Agent · {data.agents.filter((a) => a.wired).length} 个已接入
        </Text>
        <Button
          label="重新扫描"
          icon="ScanLine"
          onPress={() => {
            void run({ type: "agents.rescan" });
          }}
        />
      </View>
      {!rows.length ? (
        <Empty
          title="没有找到 Agent"
          hint="在 Magpie 所在主机安装或登录 Agent 后，点击重新扫描。"
          icon="Terminal"
        />
      ) : null}
      {rows.length ? (
        <View style={s.list}>
          {rows.map((a, i) => (
            <AgentRow key={a.id} agent={a} first={i === 0} />
          ))}
        </View>
      ) : null}
      <View style={s.between}>
        <Text style={s.small}>配置方案</Text>
        <Button
          label={profilesOpen ? "收起配置方案" : "保存当前配置"}
          icon="Plus"
          onPress={() => setProfilesOpen(!profilesOpen)}
        />
      </View>
      {profilesOpen ? (
        <>
          <View style={s.section}>
            <Text style={s.sectionTitle}>配置方案</Text>
            <Text style={s.muted}>保存当前 Agent 的模型选择，之后可一键切换。</Text>
            <View style={s.row}>
              <Field
                label="方案名称"
                value={profile}
                onChange={setProfile}
                placeholder="例如：日常开发"
              />
              <Button
                label="保存当前方案"
                icon="BookmarkPlus"
                disabled={!profile.trim()}
                onPress={() => {
                  void run({ type: "profile", operation: "save", name: profile.trim() }).then(
                    (ok) => {
                      if (ok) setProfile("");
                    },
                  );
                }}
              />
            </View>
            {data.profiles.map((p) => (
              <Card key={p.name}>
                <View style={s.between}>
                  <View style={s.grow}>
                    <Text style={s.cardTitle}>{p.name}</Text>
                    <Text style={s.muted}>{p.summary}</Text>
                  </View>
                  {p.inUse ? (
                    <Chip label="使用中" good />
                  ) : (
                    <Button
                      label="应用方案"
                      onPress={() => {
                        void run({ type: "profile", operation: "apply", name: p.name });
                      }}
                    />
                  )}
                </View>
                <ConfirmButton
                  label="删除方案"
                  onConfirm={() => {
                    void run({ type: "profile", operation: "delete", name: p.name });
                  }}
                />
              </Card>
            ))}
          </View>
        </>
      ) : null}
    </>
  );
}

function AgentRow({ agent: a, first }: { agent: PageData["agents"][number]; first: boolean }) {
  const { s, compact, run } = useUi();
  const [expanded, setExpanded] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const fields = a.fields.filter((f) => f.options.length > 0);
  const pickers = (
    <View style={[s.agentFields, !compact && fields.length < 2 && { width: 196 }]}>
      {fields.slice(0, 2).map((f) => (
        <ChoicePicker
          key={f.key}
          inline
          label={f.label}
          value={f.value}
          options={f.options}
          onChange={(value) => {
            void run({ type: "agent.set", id: a.id, field: f.key, value });
          }}
        />
      ))}
      {!fields.length ? <Text style={s.small}>尚无可用模型</Text> : null}
    </View>
  );
  return (
    <View style={[s.listItem, first && { borderTopWidth: 0 }]}>
      <View style={s.listHead}>
        <View style={s.iconTile}>
          <BrandIcon id={a.id} fallback="Terminal" />
        </View>
        <View style={s.grow}>
          <Text style={s.cardTitle}>{a.name}</Text>
          <View style={s.row}>
            <StatusDot good={a.wired} />
            <Text numberOfLines={1} style={[s.small, { flexShrink: 1 }]}>
              {a.wired ? "已接入" : "未接入"} · {a.source || a.id}
            </Text>
          </View>
        </View>
        {!compact ? pickers : null}
        <Toggle
          label={`将 ${a.name} 接入 magpie`}
          hideLabel
          value={a.wired}
          onChange={(on) => {
            if (on) void run({ type: "agent.connect", id: a.id });
            else setDisconnecting(true);
          }}
        />
        <IconButton
          label={`调整 ${a.name}`}
          icon={expanded ? "ChevronUp" : "ChevronDown"}
          onPress={() => setExpanded(!expanded)}
        />
      </View>
      {compact ? <View style={{ paddingLeft: 34 }}>{pickers}</View> : null}
      {a.drift ? <Banner error>Agent 配置已在其他地方更改。可重新应用 Magpie 配置。</Banner> : null}
      {expanded ? (
        <View style={s.editor}>
          {fields.slice(2).map((f) => (
            <ChoicePicker
              key={f.key}
              label={f.label}
              value={f.value}
              options={f.options}
              onChange={(value) => {
                void run({ type: "agent.set", id: a.id, field: f.key, value });
              }}
            />
          ))}
          {!fields.length ? <Text style={s.muted}>请先在供应商页面添加模型。</Text> : null}
          {a.wired ? (
            <ConfirmButton
              label="断开接入"
              detail="恢复此 Agent 接入 Magpie 之前的配置。"
              onConfirm={() => {
                void run({ type: "agent.disconnect", id: a.id });
              }}
            />
          ) : (
            <Button
              label="接入 Magpie"
              onPress={() => {
                void run({ type: "agent.connect", id: a.id });
              }}
            />
          )}
          {a.drift ? (
            <Button
              label="重新应用"
              icon="RotateCcw"
              onPress={() => {
                void run({ type: "agent.reapply", id: a.id });
              }}
            />
          ) : null}
        </View>
      ) : null}
      {disconnecting ? (
        <View style={s.editor}>
          <Text style={s.muted}>断开接入并恢复 {a.name} 原来的配置？</Text>
          <View style={s.row}>
            <Button
              label="确认断开接入"
              danger
              onPress={() => {
                setDisconnecting(false);
                void run({ type: "agent.disconnect", id: a.id });
              }}
            />
            <Button label="取消" onPress={() => setDisconnecting(false)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
