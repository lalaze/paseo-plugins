import { Text, View } from "react-native";
import type { PageData } from "../shared/rpc";
import {
  Banner,
  Card,
  Chip,
  CopyButton,
  Empty,
  Metric,
  Toggle,
  date,
  money,
  number,
  useUi,
} from "./kit";

export function GatewayPage({ data, query }: { data: PageData; query: string }) {
  const { s, compact } = useUi();
  const gateway = data.gateway;
  if (!gateway) return <Empty title="无法读取网关状态" icon="Server" />;
  const rows = gateway.calls.filter((c) =>
    `${c.agent} ${c.model} ${c.provider}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <View style={s.grid}>
        <Metric label="网关状态" value={gateway.running ? "运行中" : "已停止"} />
        <Metric label="可用模型" value={number(gateway.models)} />
        <Metric label="最近请求" value={number(gateway.calls.length)} />
      </View>
      <Card>
        <Text style={s.sectionTitle}>本机 API 入口</Text>
        <View style={s.between}>
          <Text selectable style={s.text}>
            {gateway.url}
          </Text>
          <CopyButton value={gateway.url} />
        </View>
        <Text style={s.muted}>
          这是 Magpie 主机上的地址。远程设备访问插件管理界面无需直连此地址。
        </Text>
        <View style={s.row}>
          <Chip label="Chat Completions" />
          <Chip label="Responses" />
          <Chip label="Anthropic Messages" />
          <Chip label="Gemini" />
        </View>
      </Card>
      <Card>
        <Text style={s.sectionTitle}>最近请求</Text>
        <Text style={s.muted}>Magpie 的实时请求记录，最多显示最近 40 条。</Text>
        {!rows.length ? (
          <Empty title="暂无匹配的请求" />
        ) : (
          rows.map((call) => (
            <View key={`${call.id}-${call.time}`} style={s.tableRow}>
              <View style={s.grow}>
                <View style={s.row}>
                  <Text style={s.text}>{call.agent || "未知客户端"}</Text>
                  <Chip
                    label={call.status ? String(call.status) : "进行中"}
                    good={call.status >= 200 && call.status < 300}
                    danger={call.status >= 400}
                  />
                </View>
                <Text style={s.small}>
                  {call.provider} / {call.model}
                </Text>
                {call.error ? <Text style={s.muted}>{call.error}</Text> : null}
              </View>
              {!compact ? (
                <Text style={s.small}>
                  {number(call.input)} 输入 · {number(call.output)} 输出
                </Text>
              ) : null}
              <View>
                <Text style={s.muted}>{call.ms ? `${(call.ms / 1000).toFixed(1)}s` : "—"}</Text>
                <Text style={s.small}>{date(call.time)}</Text>
              </View>
            </View>
          ))
        )}
      </Card>
    </>
  );
}

export function UsagePage({
  data,
  quotas,
  onQuotas,
}: {
  data: PageData;
  quotas: boolean;
  onQuotas(value: boolean): void;
}) {
  const { s, c } = useUi();
  const usage = data.usage;
  if (!usage) return <Empty title="暂无用量数据" icon="ChartNoAxesColumn" />;
  const max = Math.max(
    1,
    ...usage.series.map((p) => p.input + p.output + p.cache_read + p.cache_write),
  );
  return (
    <>
      <View style={[s.list, { flexDirection: "row", flexWrap: "wrap" }]}>
        <Metric grouped label="输入 Token" value={number(usage.input)} />
        <Metric grouped label="输出 Token" value={number(usage.output)} />
        <Metric grouped label="请求次数" value={number(usage.calls)} />
        <Metric grouped label="估算费用（USD）" value={money(usage.cost)} />
      </View>
      <Card>
        <View style={s.between}>
          <Text style={s.sectionTitle}>Token 用量</Text>
          <Text style={s.small}>
            缓存读取 {number(usage.cache_read)} · 缓存写入 {number(usage.cache_write)}
          </Text>
        </View>
        {usage.series.length ? (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 135 }}>
            {usage.series.map((p, i) => (
              <View
                key={`${p.label}-${i}`}
                accessibilityLabel={`${p.label}：${number(p.input + p.output + p.cache_read + p.cache_write)} Token`}
                style={{
                  flex: 1,
                  alignItems: "center",
                  height: "100%",
                  justifyContent: "flex-end",
                  gap: 7,
                }}
              >
                <View
                  style={{
                    width: "100%",
                    minHeight: 2,
                    maxWidth: 38,
                    height: `${Math.max(1, ((p.input + p.output + p.cache_read + p.cache_write) / max) * 85)}%`,
                    borderRadius: 3,
                    backgroundColor: c.accent,
                  }}
                />
                {i % Math.max(1, Math.floor(usage.series.length / 6)) === 0 ? (
                  <Text style={s.small}>{p.label.slice(-5)}</Text>
                ) : (
                  <Text style={s.small}> </Text>
                )}
              </View>
            ))}
          </View>
        ) : (
          <Empty title="此时间段没有请求" />
        )}
      </Card>
      <View style={s.section}>
        {[
          { title: "按 Agent", rows: usage.agents },
          { title: "按模型", rows: usage.models },
        ].map((section) => (
          <Card key={section.title}>
            <Text style={s.sectionTitle}>{section.title}</Text>
            {!section.rows.length ? (
              <Text style={s.muted}>此时间段暂无记录</Text>
            ) : (
              section.rows.slice(0, 30).map((row, i) => (
                <View key={`${row.id}-${i}`} style={s.tableRow}>
                  <View style={s.grow}>
                    <Text style={s.text}>{row.name || row.label || row.id}</Text>
                    <Text style={s.small}>
                      {number(row.calls)} 次 · {number(row.input + row.output)} Token
                    </Text>
                  </View>
                  <Text style={s.muted}>{money(row.cost)}</Text>
                </View>
              ))
            )}
          </Card>
        ))}
      </View>
      <View style={s.between}>
        <Text style={s.sectionTitle}>账户额度</Text>
        <Toggle label="读取订阅额度" value={quotas} onChange={onQuotas} />
      </View>
      {!quotas ? <Banner>开启后从 Magpie 读取订阅额度和余额，可能需要几秒钟。</Banner> : null}
      {quotas && !data.quotas.length ? (
        <Empty title="没有可显示的额度" hint="请先在供应商页面添加订阅账户或 API 密钥。" />
      ) : null}
      <View style={s.grid}>
        {data.quotas.map((q, index) => (
          <Card key={`${q.provider}-${q.user}-${index}`} column>
            <View style={s.between}>
              <Text style={s.cardTitle}>{q.name}</Text>
              {q.plan ? <Chip label={q.plan} /> : null}
            </View>
            {q.user ? <Text style={s.small}>{q.user}</Text> : null}
            {q.balance ? <Text style={s.metricValue}>{q.balance}</Text> : null}
            {q.error ? <Banner error>{q.error}</Banner> : null}
            {q.windows.map((w, i) => (
              <View key={`${w.name}-${i}`} style={s.section}>
                <View style={s.between}>
                  <Text style={s.muted}>{w.name}</Text>
                  <Text style={s.muted}>
                    {w.unlimited ? "不限额" : w.display || `已用 ${w.used.toFixed(0)}%`}
                  </Text>
                </View>
                <View style={s.barTrack}>
                  <View
                    style={{
                      width: `${Math.min(100, Math.max(0, w.used))}%`,
                      height: "100%",
                      backgroundColor: w.used >= 90 ? c.statusDanger : c.accent,
                    }}
                  />
                </View>
                {w.resetsAt ? <Text style={s.small}>{date(w.resetsAt)} 重置</Text> : null}
              </View>
            ))}
          </Card>
        ))}
      </View>
    </>
  );
}
