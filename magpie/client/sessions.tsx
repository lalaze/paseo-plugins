import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { readTranscript, type PageData } from "../shared/rpc";
import { Banner, Button, Chip, CopyButton, Empty, date, money, number, useUi } from "./kit";

export function SessionsPage({
  data,
  onMore,
  hostId,
}: {
  data: PageData;
  onMore(): void;
  hostId: string;
}) {
  const { s } = useUi();
  const [selected, setSelected] = useState<PageData["sessions"][number] | null>(null);
  if (selected)
    return <Conversation hostId={hostId} session={selected} onBack={() => setSelected(null)} />;
  return (
    <>
      <Text style={s.muted}>
        找到 {data.total} 个会话，已显示 {data.sessions.length} 个。按标题、目录或 Agent 搜索。
      </Text>
      {!data.sessions.length ? (
        <Empty
          title="暂无匹配的会话"
          hint="这里读取 Magpie 主机上的历史会话。"
          icon="MessagesSquare"
        />
      ) : null}
      {data.sessions.length ? (
        <View style={s.list}>
          {data.sessions.map((session, index) => (
            <View
              key={`${session.agent}:${session.id}`}
              style={[s.listItem, index === 0 && { borderTopWidth: 0 }]}
            >
              <View style={s.between}>
                <View style={s.grow}>
                  <Text numberOfLines={2} style={s.cardTitle}>
                    {session.title}
                  </Text>
                  <Text numberOfLines={1} style={s.small}>
                    {session.cwd || session.id}
                  </Text>
                </View>
                <Chip label={session.name || session.agent} />
              </View>
              <View style={s.between}>
                <View style={s.row}>
                  <Text style={s.small}>{date(session.last)}</Text>
                  <Text style={s.small}>{number(session.input + session.output)} Token</Text>
                  <Text style={s.small}>{money(session.cost)}</Text>
                </View>
                <View style={s.row}>
                  {session.resume ? (
                    <CopyButton label="复制继续命令" value={session.resume} />
                  ) : null}
                  <Button
                    label="查看会话"
                    icon="MessageSquare"
                    disabled={!session.transcript}
                    onPress={() => setSelected(session)}
                  />
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {data.sessions.length < data.total && data.sessions.length < 2000 ? (
        <Button label="加载更多会话" icon="ChevronDown" onPress={onMore} />
      ) : null}
      {data.sessions.length >= 2000 && data.sessions.length < data.total ? (
        <Banner>匹配结果超过 2000 条，请使用搜索缩小范围。</Banner>
      ) : null}
    </>
  );
}

function Conversation({
  session,
  onBack,
  hostId,
}: {
  session: PageData["sessions"][number];
  onBack(): void;
  hostId: string;
}) {
  const { s, c } = useUi();
  const read = useRpc(readTranscript);
  const [shown, setShown] = useState(80);
  const query = useQuery({
    queryKey: ["magpie-transcript", hostId, session.agent, session.id],
    queryFn: () => read({ agent: session.agent, id: session.id }),
    staleTime: 30_000,
    retry: false,
  });
  return (
    <>
      <View style={s.row}>
        <Button label="返回会话列表" icon="ArrowLeft" onPress={onBack} />
        <Text style={s.cardTitle}>{session.title}</Text>
      </View>
      {query.isPending ? <ActivityIndicator color={c.accent} /> : null}
      {query.error ? <Banner error>{query.error.message}</Banner> : null}
      {query.data?.cut ? <Banner>Magpie 只返回了此会话的一部分内容。</Banner> : null}
      {query.data?.parts.slice(0, shown).map((part, index) => (
        <View key={index} style={s.transcript}>
          <View style={s.row}>
            <Chip
              label={part.role === "user" ? "你" : part.role === "assistant" ? "助手" : "工具"}
              good={part.role === "user"}
            />
            {part.kind !== "text" ? (
              <Text style={s.small}>
                {part.kind === "thinking"
                  ? "思考"
                  : part.kind === "tool_use"
                    ? "工具调用"
                    : part.kind === "tool_result"
                      ? "工具结果"
                      : part.kind}
                {part.name ? ` · ${part.name}` : ""}
              </Text>
            ) : null}
            {part.model ? <Text style={s.small}>{part.model}</Text> : null}
          </View>
          <Text selectable style={s.text}>
            {part.text || (part.kind === "image" ? "[图片]" : "")}
          </Text>
        </View>
      ))}
      {query.data && shown < query.data.parts.length ? (
        <Button label="继续读取内容" onPress={() => setShown(shown + 80)} />
      ) : null}
      {query.data && !query.data.parts.length ? <Empty title="此会话没有可显示的文本" /> : null}
    </>
  );
}
