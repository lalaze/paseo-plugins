import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  readJob,
  readPage,
  runAction,
  signIn,
  type Action,
  type Page,
  type SignIn,
} from "../shared/rpc";
import { AgentsPage } from "./agents";
import { ProvidersPage } from "./providers";
import { RoutingPage } from "./routing";
import { GatewayPage, UsagePage } from "./insights";
import { LibraryPage, SettingsPage } from "./manage";
import { PluginsPage } from "./plugins";
import { SessionsPage } from "./sessions";
import { SignInPanel } from "./signin";
import { Banner, BrandIcon, IconButton, Segments, UiProvider, useUi } from "./kit";

export const navigation: { id: Page; label: string; icon: string; group: string; hint: string }[] =
  [
    {
      id: "agents",
      label: "Agent",
      icon: "Terminal",
      group: "使用",
      hint: "让每个 Agent 用上你的模型和订阅。",
    },
    {
      id: "sessions",
      label: "会话",
      icon: "MessagesSquare",
      group: "使用",
      hint: "浏览主机上的会话历史，查看消息与继续命令。",
    },
    {
      id: "library",
      label: "资源库",
      icon: "BookOpen",
      group: "使用",
      hint: "集中管理 MCP 服务器与技能，分发给不同 Agent。",
    },
    {
      id: "providers",
      label: "供应商",
      icon: "KeyRound",
      group: "模型",
      hint: "你的 API、订阅与本地模型，集中在这里。",
    },
    {
      id: "routing",
      label: "路由",
      icon: "GitBranch",
      group: "模型",
      hint: "组合多个模型，管理故障切换与请求分配。",
    },
    {
      id: "gateway",
      label: "网关",
      icon: "Server",
      group: "模型",
      hint: "一个 API 入口，连接所有供应商与 Agent。",
    },
    {
      id: "usage",
      label: "用量",
      icon: "ChartNoAxesColumn",
      group: "观测",
      hint: "查看请求、Token、费用与订阅额度。",
    },
    {
      id: "plugins",
      label: "插件",
      icon: "Puzzle",
      group: "扩展",
      hint: "管理 Magpie 的模型来源插件和内置功能。",
    },
    {
      id: "settings",
      label: "设置",
      icon: "Settings",
      group: "扩展",
      hint: "管理此主机上的 Magpie 偏好和连接设置。",
    },
  ];

export function MagpieScreen(props: PluginScreenProps) {
  return <HostScreen key={props.host.id} {...props} />;
}

function HostScreen(props: PluginScreenProps) {
  const [width, setWidth] = useState<number | null>(null);
  const load = useRpc(readPage);
  const action = useRpc(runAction);
  const login = useRpc(signIn);
  const job = useRpc(readJob);
  const cache = useQueryClient();
  const [page, setPage] = useState<Page>("agents");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [period, setPeriod] = useState<"today" | "7d" | "30d" | "all">("today");
  const [quotas, setQuotas] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [signin, setSignin] = useState<SignIn | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: [
      "magpie",
      props.host.id,
      page,
      period,
      page === "sessions" ? debouncedSearch : "",
      limit,
      quotas,
    ],
    queryFn: () =>
      load({ page, period, query: page === "sessions" ? debouncedSearch : "", limit, quotas }),
    staleTime: 10_000,
    retry: false,
    refetchInterval: page === "sessions" || page === "library" ? 60_000 : 20_000,
  });
  const refresh = useCallback(async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["magpie", props.host.id] }),
      cache.invalidateQueries({ queryKey: ["magpie-feature", props.host.id] }),
    ]);
  }, [cache, props.host.id]);
  const run = useCallback(
    async (input: Action) => {
      if (pending.current) return false;
      pending.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await action(input);
        if (!alive.current) return false;
        if (result.jobId) {
          setNotice(result.notice);
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (!alive.current) return false;
            const progress = await job({ id: result.jobId });
            if (progress.state === "failed") throw new Error(progress.error);
            if (progress.state === "done") {
              result.notice = progress.notice;
              break;
            }
          }
        }
        if (alive.current) {
          setNotice(result.notice);
          await refresh();
        }
        return true;
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [action, refresh, job],
  );
  const startSignIn = useCallback(
    (agent: string) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      void login({ operation: "start", agent })
        .then(
          (state) => {
            if (alive.current) setSignin(state);
          },
          (cause: unknown) => {
            if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          pending.current = false;
          if (alive.current) setBusy(false);
        });
    },
    [login],
  );
  const doneSignIn = useCallback(() => {
    setSignin(null);
    setNotice("账户登录完成。");
    void refresh();
  }, [refresh]);
  const navigate = (next: Page) => {
    setPage(next);
    setSearch("");
    setDebouncedSearch("");
    setLimit(100);
    setError("");
    setNotice("");
  };
  return (
    <View
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <UiProvider
        hostId={props.host.id}
        colors={props.theme.colors}
        compact={props.layout.compact || (width !== null && width < 820)}
        busy={busy}
        run={run}
        error={error || query.error?.message || ""}
        notice={notice}
      >
        <ScreenLayout
          page={page}
          host={props.host.label}
          onNavigate={navigate}
          fetching={query.isFetching}
          refresh={() => {
            void query.refetch();
            if (page === "plugins")
              void cache.invalidateQueries({ queryKey: ["magpie-catalog", props.host.id] });
          }}
        >
          <ScreenContent page={page} search={search} setSearch={setSearch}>
            {error || query.error ? <Banner error>{error || query.error?.message}</Banner> : null}
            {notice ? <Banner>{notice}</Banner> : null}
            {signin ? (
              <SignInPanel
                hostId={props.host.id}
                initial={signin}
                onClose={() => setSignin(null)}
                onDone={doneSignIn}
              />
            ) : null}
            {query.data?.notices.map((message, index) => (
              <Banner key={index}>{message}</Banner>
            ))}
            {query.isPending ? <Loading /> : null}
            {query.data ? (
              <>
                {page === "agents" ? <AgentsPage data={query.data} query={search} /> : null}
                {page === "providers" ? (
                  <ProvidersPage data={query.data} query={search} startSignIn={startSignIn} />
                ) : null}
                {page === "routing" ? <RoutingPage data={query.data} query={search} /> : null}
                {page === "gateway" ? <GatewayPage data={query.data} query={search} /> : null}
                {page === "usage" ? (
                  <>
                    <PeriodPicker period={period} onChange={setPeriod} />
                    <UsagePage data={query.data} quotas={quotas} onQuotas={setQuotas} />
                  </>
                ) : null}
                {page === "sessions" ? (
                  <SessionsPage
                    hostId={props.host.id}
                    data={query.data}
                    onMore={() => setLimit((value) => Math.min(2000, value + 100))}
                  />
                ) : null}
                {page === "library" ? <LibraryPage data={query.data} query={search} /> : null}
                {page === "plugins" ? (
                  <PluginsPage hostId={props.host.id} data={query.data} query={search} />
                ) : null}
                {page === "settings" ? <SettingsPage settings={query.data.settings} /> : null}
              </>
            ) : null}
          </ScreenContent>
        </ScreenLayout>
      </UiProvider>
    </View>
  );
}

export function ScreenLayout({
  page,
  host,
  onNavigate,
  children,
  fetching,
  refresh,
}: {
  page: Page;
  host: string;
  onNavigate(page: Page): void;
  children: ReactNode;
  fetching: boolean;
  refresh(): void;
}) {
  const { c, s, compact } = useUi();
  const [sidebar, setSidebar] = useState(true);
  const current = navigation.find((n) => n.id === page)!;
  const navItem = (item: typeof current) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: page === item.id }}
      onPress={() => onNavigate(item.id)}
      style={[s.navItem, page === item.id && s.navActive]}
    >
      {!compact ? (
        <Icon
          name={item.icon}
          size={15}
          color={page === item.id ? c.foreground : c.foregroundMuted}
        />
      ) : null}
      <Text style={[s.navLabel, page === item.id && s.navLabelActive]}>{item.label}</Text>
    </Pressable>
  );
  const brand = (
    <View style={s.brand}>
      <BrandIcon id="magpie" size={18} />
      <Text style={s.brandText}>magpie</Text>
    </View>
  );
  const refreshControl = fetching ? (
    <ActivityIndicator size="small" color={c.foregroundMuted} />
  ) : (
    <IconButton label="刷新" icon="RefreshCw" onPress={refresh} />
  );
  return (
    <View style={s.root}>
      {compact ? (
        <View style={s.topbar}>
          {brand}
          <View style={s.grow} />
          {refreshControl}
        </View>
      ) : null}
      <View style={s.frame}>
        {compact || sidebar ? (
          <View style={s.nav}>
            {!compact ? brand : null}
            <ScrollView
              horizontal={compact}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={
                compact
                  ? { flexDirection: "row", gap: 2, paddingHorizontal: 16, paddingBottom: 10 }
                  : undefined
              }
            >
              {navigation
                .filter((item) => compact || item.id !== "settings")
                .map((item, i) => (
                  <View key={item.id}>
                    {!compact && (i === 0 || navigation[i - 1].group !== item.group) ? (
                      <Text style={s.navGroup}>{item.group}</Text>
                    ) : null}
                    {navItem(item)}
                  </View>
                ))}
            </ScrollView>
            {!compact ? (
              <View style={s.navFoot}>
                {navItem(navigation[navigation.length - 1])}
                <Text
                  numberOfLines={1}
                  style={[s.small, { paddingHorizontal: 8, paddingBottom: 6 }]}
                >
                  {host}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <View style={s.body}>
          {!compact ? (
            <View style={s.topbar}>
              <IconButton
                label={sidebar ? "隐藏侧边栏" : "显示侧边栏"}
                icon="PanelLeft"
                onPress={() => setSidebar(!sidebar)}
              />
              <Text style={s.muted}>{current.group}</Text>
              <Text style={s.muted}>/</Text>
              <Text style={s.title}>{current.label}</Text>
              <View style={s.grow} />
              {refreshControl}
            </View>
          ) : null}
          {children}
        </View>
      </View>
    </View>
  );
}

function ScreenContent({
  page,
  search,
  setSearch,
  children,
}: {
  page: Page;
  search: string;
  setSearch(value: string): void;
  children: ReactNode;
}) {
  const { s, c } = useUi();
  const current = navigation.find((n) => n.id === page)!;
  return (
    <ScrollView contentContainerStyle={s.content}>
      {page !== "usage" && page !== "settings" ? (
        <View style={s.toolbar}>
          <TextInput
            accessibilityLabel={`搜索${current.label}`}
            value={search}
            onChangeText={setSearch}
            placeholder={`查找${current.label}`}
            placeholderTextColor={c.foregroundMuted}
            style={[s.input, s.search]}
          />
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}
function Loading() {
  const { c, s } = useUi();
  return (
    <View style={s.empty}>
      <ActivityIndicator color={c.accent} />
      <Text style={s.muted}>正在连接 Magpie…</Text>
    </View>
  );
}
function PeriodPicker({
  period,
  onChange,
}: {
  period: "today" | "7d" | "30d" | "all";
  onChange(value: "today" | "7d" | "30d" | "all"): void;
}) {
  const periods = [
    { id: "today", label: "今天" },
    { id: "7d", label: "近 7 天" },
    { id: "30d", label: "近 30 天" },
    { id: "all", label: "全部" },
  ] as const;
  return (
    <Segments
      options={periods.map((p) => ({ value: p.id, label: p.label }))}
      value={period}
      onChange={(value) => onChange(value as typeof period)}
    />
  );
}
