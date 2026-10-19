import { useState } from "react";
import { Pressable, Text, View } from "react-native";
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
} from "./features";
import {
  Button,
  Card,
  ChoicePicker,
  CopyButton,
  Field,
  Metric,
  Segments,
  money,
  number,
  useUi,
} from "./kit";

export function UsageAdvanced() {
  const { s } = useUi();
  const [tab, setTab] = useState("requests");
  const [period, setPeriod] = useState("7d");
  const [days, setDays] = useState("7");
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [resultFilter, setResultFilter] = useState("");
  const [startDay, setStartDay] = useState("");
  const [endDay, setEndDay] = useState("");
  const effectivePeriod =
    /^\d{4}-\d{2}-\d{2}$/.test(startDay) && /^\d{4}-\d{2}-\d{2}$/.test(endDay)
      ? `${startDay}..${endDay}`
      : period;
  const requestParams = {
    period: effectivePeriod,
    ...filter,
    ...(resultFilter ? { [resultFilter]: "1" } : {}),
  };
  const query = useFeature(
    tab === "requests" ? "requests" : tab === "sessions" ? "usageSessions" : "context",
    tab === "requests" ? { ...requestParams, offset: String(offset), limit: "50" } : { days },
    tab !== "quotas",
  );
  const settings = useFeature("preferences");
  const data = record(query.data);
  const currencies = record(settings.data);
  const currency = str(currencies.currency) || "usd";
  const rate = Number(record(currencies.fx).rate || 1);
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>详细用量</Text>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { value: "requests", label: "请求" },
            { value: "sessions", label: "会话分析" },
            { value: "context", label: "上下文" },
            { value: "quotas", label: "额度管理" },
          ]}
        />
        {tab === "requests" ? (
          <ChoicePicker
            label="统计范围"
            value={period}
            options={[
              ["today", "今天"],
              ["7d", "7 天"],
              ["30d", "30 天"],
              ["all", "全部"],
            ].map(([value, label]) => ({ value, label, note: "" }))}
            onChange={(p) => {
              setPeriod(p);
              setOffset(0);
            }}
          />
        ) : (
          <ChoicePicker
            label="分析天数"
            value={days}
            options={["1", "7", "30", "90", "365"].map((value) => ({
              value,
              label: `${value} 天`,
              note: "",
            }))}
            onChange={setDays}
          />
        )}
      </Card>
      {tab === "quotas" ? (
        <QuotaManagement />
      ) : (
        <>
          <FeatureStatus query={query} />
          {tab === "requests" ? (
            <>
              <Card>
                <Text style={s.sectionTitle}>请求筛选</Text>
                <Field
                  label="搜索模型、会话、供应商"
                  value={filter.q || ""}
                  onChange={(q) => {
                    setFilter({ ...filter, q });
                    setOffset(0);
                  }}
                />
                <View style={s.row}>
                  <Field
                    label="开始日期（YYYY-MM-DD，可选）"
                    value={startDay}
                    onChange={(value) => {
                      setStartDay(value);
                      setOffset(0);
                    }}
                  />
                  <Field
                    label="结束日期（YYYY-MM-DD，可选）"
                    value={endDay}
                    onChange={(value) => {
                      setEndDay(value);
                      setOffset(0);
                    }}
                  />
                </View>
                {[
                  ["agent", "Agent", data.agents],
                  ["provider", "供应商", data.providers],
                  ["account", "账号", data.accounts],
                  [
                    "callerKey",
                    "网关密钥",
                    rows(data.callerKeys).map((k) => ({
                      ...k,
                      id: k.callerKey || k.callerKeyId || k.id,
                    })),
                  ],
                  ["computer", "机器", data.computers],
                  [
                    "purpose",
                    "用途",
                    (Array.isArray(data.purposes) ? data.purposes : []).map((purpose) => ({
                      id: purpose,
                      name: purpose,
                    })),
                  ],
                ].map(([key, label, items]) => (
                  <ChoicePicker
                    key={String(key)}
                    label={String(label)}
                    value={filter[String(key)] || ""}
                    options={[
                      { value: "", label: "全部", note: "" },
                      ...rows(items).map((i) => ({
                        value: str(i.id),
                        label: str(i.name) || str(i.id),
                        note: "",
                      })),
                    ]}
                    onChange={(value) => {
                      setFilter({ ...filter, [String(key)]: value });
                      setOffset(0);
                    }}
                  />
                ))}
                <ChoicePicker
                  label="请求结果"
                  value={resultFilter}
                  options={[
                    { value: "", label: "全部", note: "" },
                    { value: "failed", label: "失败", note: "" },
                    { value: "retried", label: "经重试回答", note: "" },
                  ]}
                  onChange={(value) => {
                    setResultFilter(value);
                    setOffset(0);
                  }}
                />
                <ChoicePicker
                  label="请求来源"
                  value={filter.via || ""}
                  options={[
                    ["", "全部"],
                    ["through", "经过网关"],
                    ["direct", "本机会话"],
                    ["reported", "客户端上报"],
                  ].map(([value, label]) => ({ value, label, note: "" }))}
                  onChange={(via) => {
                    setFilter({ ...filter, via });
                    setOffset(0);
                  }}
                />
              </Card>
              <View style={s.grid}>
                <Metric label="请求次数" value={number(Number(data.calls || 0))} />
                <Metric label="Token" value={number(tokenTotal(data))} />
                <Metric label="费用" value={money(Number(data.cost || 0), currency, rate)} />
              </View>
              <NativeBars series={rows(data.series)} />
              <UsageHeatmap
                filter={requestParams}
                onDay={(day) => {
                  setFilter({ ...filter, day });
                  setOffset(0);
                }}
              />
              {filter.day ? (
                <Button
                  label={`清除日期筛选 ${filter.day}`}
                  onPress={() => {
                    const { day, ...next } = filter;
                    setFilter(next);
                    setOffset(0);
                  }}
                />
              ) : null}
              <Card>
                <Text style={s.sectionTitle}>按账号、密钥、模型与供应商汇总</Text>
                <DataView data={data.by} />
              </Card>
              {rows(data.rows).map((r, i) => (
                <Card key={`${r.route_id}-${i}`}>
                  <Text style={s.cardTitle}>
                    {str(r.model)} · {str(r.agentName) || str(r.agent)}
                  </Text>
                  <Text style={s.small}>
                    {str(r.t)} · {str(r.providerAccount)} · HTTP {Number(r.status || 0)}
                  </Text>
                  <Text style={s.text}>
                    {number(Number(r.in || 0))} 输入 · {number(Number(r.out || 0))} 输出 ·{" "}
                    {money(Number(r.cost || 0), currency, rate)}
                  </Text>
                  <DataView data={r} />
                  <RequestContent item={r} />
                </Card>
              ))}
              <View style={s.row}>
                <Button
                  label="上一页请求"
                  disabled={!offset}
                  onPress={() => setOffset(Math.max(0, offset - 50))}
                />
                <Button
                  label="下一页请求"
                  disabled={offset + 50 >= Number(data.total || 0)}
                  onPress={() => setOffset(offset + 50)}
                />
                <ActionButton
                  operation="usage.export"
                  label="导出筛选结果全部 CSV 到主机"
                  body={requestParams}
                  showResult
                />
                <CopyButton
                  label="复制当前请求 JSON"
                  value={JSON.stringify(data.rows || [], null, 2)}
                />
              </View>
            </>
          ) : tab === "sessions" ? (
            <SessionAnalytics days={days} data={data} currency={currency} rate={rate} />
          ) : (
            <ContextAnalysis data={data} days={days} />
          )}
        </>
      )}
    </>
  );
}
function tokenTotal(value: Row) {
  return (
    Number(value.input || 0) +
    Number(value.output || 0) +
    Number(value.cache_read || 0) +
    Number(value.cache_write || 0)
  );
}
function NativeBars({ series }: { series: ReturnType<typeof rows> }) {
  const { s, c } = useUi();
  const max = Math.max(1, ...series.map((p) => tokenTotal(p)));
  return (
    <Card>
      <Text style={s.sectionTitle}>Token 趋势</Text>
      <View style={{ flexDirection: "row", height: 110, alignItems: "flex-end", gap: 3 }}>
        {series.slice(-90).map((p, i) => (
          <View
            key={i}
            accessibilityLabel={`${p.label}: ${tokenTotal(p)} Token`}
            style={{
              flex: 1,
              minHeight: 2,
              height: `${Math.max(1, (tokenTotal(p) / max) * 100)}%`,
              backgroundColor: c.accent,
            }}
          />
        ))}
      </View>
    </Card>
  );
}
function SessionStats({ days }: { days: string }) {
  const query = useFeature("sessionStats", { days });
  return (
    <Card>
      <FeatureStatus query={query} />
      <DataView data={query.data} />
    </Card>
  );
}
function QuotaManagement() {
  const { s } = useUi();
  const query = useFeature("quotas");
  const history = useFeature("quotaHistory", { days: "45" });
  const list = Array.isArray(query.data) ? rows(query.data) : rows(record(query.data).quotas);
  return (
    <>
      <FeatureStatus query={query} />
      {list.map((q, i) => (
        <Card key={`${q.provider}-${i}`}>
          <Text style={s.cardTitle}>
            {str(q.name)} · {str(q.user)}
          </Text>
          <DataView data={q} />
          <ActionButton
            operation="quota.refresh"
            label="刷新此账号额度"
            body={{ provider: q.provider || "", account: q.user || "" }}
            showResult
          />
          {q.provider === "codex" ? (
            <ActionButton
              operation="quota.reset"
              label="使用此账号重置次数"
              body={{ user: q.user }}
              confirm
              showResult
            />
          ) : null}
        </Card>
      ))}
      <Card>
        <Text style={s.sectionTitle}>额度历史与趋势</Text>
        <FeatureStatus query={history} />
        <DataView data={history.data} />
      </Card>
    </>
  );
}

function RequestContent({ item }: { item: Row }) {
  const { s } = useUi();
  const [open, setOpen] = useState(false);
  const time = Date.parse(str(item.t));
  const valid = Number.isFinite(time);
  const ms = Number(item.ms || 0);
  const from = valid ? new Date(time - (item.source === "log" ? 1 : 5000)).toISOString() : "";
  const to = valid ? new Date(time + (item.source === "log" ? 1 : ms + 30000)).toISOString() : "";
  const at = valid ? new Date(time + (item.source === "log" ? 0 : ms)).toISOString() : "";
  const query = useFeature(
    "usageRequest",
    {
      agent: str(item.agent),
      session: str(item.native_session) || str(item.session),
      from,
      to,
      at,
    },
    open && valid,
  );
  return (
    <View style={s.section}>
      <Button
        label={open ? "收起请求内容" : "查看请求内容"}
        disabled={!valid}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <FeatureStatus query={query} />
          <DataView data={query.data} />
        </>
      ) : null}
    </View>
  );
}
function UsageHeatmap({
  filter,
  onDay,
}: {
  filter: Record<string, string>;
  onDay(day: string): void;
}) {
  const { s, c } = useUi();
  const [open, setOpen] = useState(false);
  const query = useFeature("usageHeatmap", filter, open);
  const days = rows(record(query.data).days);
  const max = Math.max(1, ...days.map((d) => Number(d.tokens || 0)));
  return (
    <Card>
      <Button label={open ? "收起年度活动图" : "查看年度活动图"} onPress={() => setOpen(!open)} />
      {open ? (
        <>
          <FeatureStatus query={query} />
          <Text style={s.small}>
            点击日期筛选请求 · {str(record(query.data).from)} 至 {str(record(query.data).to)}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 3 }}>
            {days.map((day) => (
              <Pressable
                key={str(day.date)}
                accessibilityRole="button"
                accessibilityLabel={`${day.date} · ${day.calls} 次 · ${day.tokens} Token`}
                onPress={() => onDay(str(day.date))}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  backgroundColor: c.accent,
                  opacity: Number(day.tokens || 0)
                    ? Math.max(0.25, Number(day.tokens) / max)
                    : 0.08,
                }}
              />
            ))}
          </View>
        </>
      ) : null}
    </Card>
  );
}

function ContextAnalysis({ data, days }: { data: Row; days: string }) {
  const { s, c } = useUi();
  const tune = useFeature("tune", { days });
  return (
    <>
      {rows(data.agents).map((agent) => (
        <Card key={str(agent.agent)}>
          <Text style={s.sectionTitle}>{str(agent.agent)} · 上下文分析</Text>
          <View style={s.grid}>
            <Metric label="上下文中位数" value={number(Number(agent.median || 0))} />
            <Metric label="上下文窗口" value={number(Number(agent.window || 0))} />
            <Metric label="缓存命中" value={`${Math.round(Number(agent.cache || 0) * 100)}%`} />
            <Metric label="压缩次数" value={number(Number(agent.compacts || 0))} />
          </View>
          <DataView
            data={{
              baseline: agent.baseline,
              growth: agent.growth,
              shares: agent.shares,
              scores: agent.scores,
              tags: agent.tags,
            }}
          />
        </Card>
      ))}
      {rows(data.sessions).map((session) => {
        const points = rows(session.points);
        const max = Math.max(
          1,
          Number(session.window || 0),
          ...points.map((point) => Number(point.tokens || 0)),
        );
        return (
          <Card key={`${session.agent}-${session.key}`}>
            <Text style={s.cardTitle}>{str(session.title) || str(session.key)}</Text>
            <Text style={s.small}>
              {str(session.agent)} · {str(session.model)} · {Number(session.requests || 0)} 次请求 ·
              峰值 {number(Number(session.peak || 0))}
            </Text>
            <View style={{ flexDirection: "row", height: 100, alignItems: "flex-end", gap: 2 }}>
              {points.slice(-120).map((point, i) => (
                <View
                  key={i}
                  accessibilityLabel={`${point.time} · ${point.tokens} Token`}
                  style={{
                    flex: 1,
                    minHeight: 2,
                    backgroundColor: c.accent,
                    height: `${Math.min(100, (Number(point.tokens || 0) / max) * 100)}%`,
                  }}
                />
              ))}
            </View>
            <DataView data={session.latest} />
          </Card>
        );
      })}
      <Card>
        <Text style={s.sectionTitle}>压缩与缓存优化建议</Text>
        <FeatureStatus query={tune} />
        <Text style={s.muted}>根据此主机的请求历史计算，应用前请核对 Agent 与模型。</Text>
      </Card>
      {rows(record(tune.data).agents).flatMap((agent) =>
        rows(agent.advice).map((advice, index) => {
          const setting = record(advice.setting);
          const suggested = record(advice.compact).best ?? record(advice.ttl).best;
          const fixed = { agent: agent.agent, knob: advice.knob, model: advice.model || "" };
          return (
            <Card key={`${agent.agent}-${index}`}>
              <Text style={s.cardTitle}>
                {str(agent.agent)} · {str(advice.model) || str(advice.knob)}
              </Text>
              <Text style={s.small}>
                当前值：{str(setting.value) || "默认"} · 推荐值：{String(suggested ?? "—")}
              </Text>
              <DataView data={advice} />
              {setting.locked ? (
                <Text style={s.muted}>{str(setting.locked)}</Text>
              ) : (
                <>
                  <ObjectForm
                    title="应用优化值"
                    operation="tune.apply"
                    fixed={fixed}
                    data={{ value: String(suggested ?? "") }}
                    fields={[{ key: "value", label: "压缩阈值或缓存时长", kind: "text" }]}
                  />
                  {suggested != null ? (
                    <ActionButton
                      operation="tune.apply"
                      label="应用推荐值"
                      body={{ ...fixed, value: String(suggested) }}
                      confirm
                    />
                  ) : null}
                  {setting.ours ? (
                    <ActionButton operation="tune.undo" label="撤销此优化" body={fixed} confirm />
                  ) : null}
                </>
              )}
            </Card>
          );
        }),
      )}
    </>
  );
}

function SessionAnalytics({
  days,
  data,
  currency,
  rate,
}: {
  days: string;
  data: Row;
  currency: string;
  rate: number;
}) {
  const { s, c } = useUi();
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState("");
  const stats = useFeature("sessionStats", { days });
  const filtered = useFeature(
    "usageSessions",
    { days, agent, model, cwd: folder },
    Boolean(agent || model || folder),
  );
  const detail = useFeature("sessionDetail", { key: selected }, Boolean(selected));
  const summary = agent || model || folder ? record(filtered.data) : data;
  const daysValues = (Array.isArray(summary.days) ? summary.days : []).map(Number);
  const max = Math.max(1, ...daysValues);
  const daysRows = rows(record(stats.data).days);
  const usage = daysRows.flatMap((day) => rows(day.usage));
  const agents = record(record(stats.data).agents);
  return (
    <>
      <Card>
        <Text style={s.sectionTitle}>会话分析筛选</Text>
        <ChoicePicker
          label="分析的 Agent"
          value={agent}
          options={[
            { value: "", label: "全部 Agent", note: "" },
            ...Object.entries(agents).map(([value, name]) => ({
              value,
              label: str(name) || value,
              note: "",
            })),
          ]}
          onChange={setAgent}
        />
        <ChoicePicker
          label="分析的模型"
          value={model}
          options={[
            { value: "", label: "全部模型", note: "" },
            ...[...new Set(usage.map((row) => str(row.model)).filter(Boolean))].map((value) => ({
              value,
              label: value,
              note: "",
            })),
          ]}
          onChange={setModel}
        />
        <ChoicePicker
          label="分析的项目目录"
          value={folder}
          options={[
            { value: "", label: "全部目录", note: "" },
            ...[...new Set(usage.map((row) => str(row.cwd)).filter(Boolean))].map((value) => ({
              value,
              label: value,
              note: "",
            })),
          ]}
          onChange={setFolder}
        />
        {filtered.isEnabled ? <FeatureStatus query={filtered} /> : null}
        <View style={s.grid}>
          <Metric label="会话数" value={number(Number(summary.count || 0))} />
          <Metric label="会话 Token 中位数" value={number(Number(summary.median || 0))} />
          <Metric label="会话 Token P90" value={number(Number(summary.p90 || 0))} />
        </View>
        <Text style={s.label}>每日活跃会话数</Text>
        <View style={{ flexDirection: "row", height: 100, alignItems: "flex-end", gap: 3 }}>
          {daysValues.map((value, i) => (
            <View
              key={i}
              accessibilityLabel={`第 ${i + 1} 天 · ${value} 个会话`}
              style={{
                flex: 1,
                minHeight: 2,
                backgroundColor: c.accent,
                height: `${(value / max) * 100}%`,
              }}
            />
          ))}
        </View>
      </Card>
      {Object.entries(record(summary.top)).map(([kind, value]) => (
        <Card key={kind}>
          <Text style={s.sectionTitle}>
            会话排行 ·{" "}
            {({ tokens: "Token", cost: "费用", active: "活跃时间" } as Record<string, string>)[
              kind
            ] || kind}
          </Text>
          {rows(value).map((session) => (
            <View key={str(session.key)} style={s.section}>
              <Text style={s.cardTitle}>{str(session.title) || str(session.id)}</Text>
              <Text style={s.small}>
                {str(session.agent)} · {str(session.cwd)} ·{" "}
                {money(Number(session.cost || 0), currency, rate)}
              </Text>
              <Button
                label={`查看会话分析 ${session.key}`}
                onPress={() => setSelected(str(session.key))}
              />
            </View>
          ))}
        </Card>
      ))}
      {selected ? (
        <Card>
          <Button label="关闭会话分析详情" onPress={() => setSelected("")} />
          <FeatureStatus query={detail} />
          <DataView data={detail.data} />
        </Card>
      ) : null}
      <Card>
        <Text style={s.sectionTitle}>工具、技能与会话分布</Text>
        <DataView
          data={{
            tools: summary.tools,
            skills: summary.skills,
            shape: summary.shape,
            messages: summary.messages,
            output: summary.output,
          }}
        />
      </Card>
      <SessionStats days={days} />
    </>
  );
}
