import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { readPluginCatalog, type PageData, type PluginCatalogItem } from "../shared/rpc";
import {
  Banner,
  BrandIcon,
  Button,
  Card,
  Chip,
  ConfirmButton,
  Empty,
  Field,
  Segments,
  Toggle,
  number,
  useUi,
} from "./kit";
import { Builtins } from "./manage";

const kinds = [
  { value: "provider", label: "订阅" },
  { value: "middleware", label: "网关中间件" },
  { value: "agent", label: "Agent" },
  { value: "tools", label: "Agent 工具" },
  { value: "page", label: "页面" },
];
function packageName(spec: string) {
  if (/^(?:@[^/]+\/)?[\w.-]+(?:@[^/]+)?$/.test(spec)) {
    const i = spec.lastIndexOf("@");
    return i > 0 ? spec.slice(0, i) : spec;
  }
  return spec;
}

export function PluginsPage({
  data,
  query,
  hostId,
}: {
  data: PageData;
  query: string;
  hostId: string;
}) {
  const { s, run } = useUi();
  const [tab, setTab] = useState("discover");
  const [spec, setSpec] = useState("");
  const [debounced, setDebounced] = useState(query.trim());
  const readCatalog = useRpc(readPluginCatalog);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const suggested = useQuery({
    queryKey: ["magpie-catalog", hostId, "suggested"],
    queryFn: () => readCatalog({ source: "suggested", query: "" }),
    enabled: tab === "discover",
    staleTime: 300_000,
    retry: false,
  });
  const github = useQuery({
    queryKey: ["magpie-catalog", hostId, "github"],
    queryFn: () => readCatalog({ source: "github", query: "" }),
    enabled: tab === "discover",
    staleTime: 300_000,
    retry: false,
  });
  const npm = useQuery({
    queryKey: ["magpie-catalog", hostId, "npm", debounced],
    queryFn: () => readCatalog({ source: "npm", query: debounced }),
    enabled: tab === "discover" && debounced.length >= 2,
    staleTime: 60_000,
    retry: false,
  });
  const q = query.trim().toLowerCase();
  const matches = (p: PluginCatalogItem) =>
    `${p.name} ${p.spec} ${p.description} ${p.publisher} ${p.providers.join(" ")}`
      .toLowerCase()
      .includes(q);
  const recommendations = (suggested.data?.items || []).filter(matches);
  const recommendedNames = new Set((suggested.data?.items || []).map((p) => packageName(p.spec)));
  const repositories = (github.data?.items || []).filter(
    (p) => !recommendedNames.has(packageName(p.spec)) && matches(p),
  );
  const known = new Set([
    ...recommendedNames,
    ...(github.data?.items || []).map((p) => packageName(p.spec)),
  ]);
  const hits = (npm.data?.items || []).filter((p) => !known.has(packageName(p.spec)));
  const installed = data.plugins.filter((p) =>
    `${p.name} ${p.spec} ${p.providers.join(" ")}`.toLowerCase().includes(q),
  );
  return (
    <>
      <Segments
        value={tab}
        onChange={setTab}
        options={[
          { value: "builtin", label: "内置" },
          { value: "discover", label: "发现" },
          { value: "installed", label: `已安装 · ${data.plugins.length}` },
        ]}
      />
      {tab === "discover" ? (
        <>
          {!q ? (
            <Card>
              <Text style={s.sectionTitle}>插件扩展 magpie</Text>
              <Text style={s.muted}>
                插件可以接入更多订阅、扩展网关和 Agent，安装后由 Magpie 在主机上运行。
              </Text>
            </Card>
          ) : null}
          <CatalogSection
            title={q ? "推荐插件" : "Magpie 社区"}
            loading={suggested.isPending}
            error={suggested.error?.message}
            retry={() => {
              void suggested.refetch();
            }}
          >
            {q ? (
              <CatalogGrid items={recommendations} installed={data.plugins} />
            ) : (
              kinds.map((kind) => {
                const items = recommendations.filter((p) => (p.kind || "provider") === kind.value);
                return items.length ? (
                  <View key={kind.value} style={s.section}>
                    <Text style={s.small}>
                      {kind.label} · {items.length}
                    </Text>
                    <CatalogGrid items={items} installed={data.plugins} />
                  </View>
                ) : null;
              })
            )}
            {!suggested.isPending && !suggested.error && !recommendations.length ? (
              <Text style={s.muted}>没有匹配的推荐插件</Text>
            ) : null}
          </CatalogSection>
          <CatalogSection
            title="GitHub 社区"
            loading={github.isPending}
            error={github.error?.message}
            retry={() => {
              void github.refetch();
            }}
          >
            <CatalogGrid items={repositories} installed={data.plugins} />
            {!github.isPending && !github.error && !repositories.length ? (
              <Text style={s.muted}>没有匹配的 GitHub 插件</Text>
            ) : null}
          </CatalogSection>
          {q ? (
            <CatalogSection
              title="npm 搜索"
              loading={q.length >= 2 && (debounced !== query.trim() || npm.isPending)}
              error={npm.error?.message}
              retry={() => {
                void npm.refetch();
              }}
            >
              {q.length < 2 ? (
                <Text style={s.muted}>输入至少两个字符以搜索 npm</Text>
              ) : debounced === query.trim() ? (
                <>
                  <CatalogGrid items={hits} installed={data.plugins} />
                  {!npm.isPending && !npm.error && !hits.length ? (
                    <Text style={s.muted}>npm 上没有更多匹配的插件</Text>
                  ) : null}
                </>
              ) : null}
            </CatalogSection>
          ) : null}
        </>
      ) : null}
      {tab === "installed" ? (
        <>
          <Text style={s.sectionTitle}>已安装插件</Text>
          {!installed.length ? (
            <Empty
              title={q ? "暂无匹配的已安装插件" : "尚未安装插件"}
              hint="在「发现」中搜索并安装插件。"
              icon="Puzzle"
            />
          ) : null}
          {installed.map((p) => (
            <Card key={p.spec}>
              <View style={s.between}>
                <View style={s.grow}>
                  <Text style={s.cardTitle}>{p.name || p.spec}</Text>
                  <Text style={s.small}>{p.spec}</Text>
                </View>
                <Chip label={p.version || "本地插件"} />
                <Toggle
                  label="启用插件"
                  value={!p.off}
                  onChange={(on) => {
                    void run({ type: "plugin.toggle", spec: p.spec, on });
                  }}
                />
              </View>
              {p.error ? <Banner error>{p.error}</Banner> : null}
              <View style={s.row}>
                {p.providers.map((name) => (
                  <Chip key={name} label={name} />
                ))}
              </View>
              <View style={s.row}>
                <Button
                  label="更新插件"
                  icon="RefreshCw"
                  onPress={() => {
                    void run({ type: "plugin.upgrade", spec: p.spec });
                  }}
                />
                <ConfirmButton
                  label="卸载插件"
                  onConfirm={() => {
                    void run({ type: "plugin.remove", spec: p.spec });
                  }}
                />
              </View>
            </Card>
          ))}
        </>
      ) : null}
      {tab === "builtin" ? (
        <>
          <Text style={s.sectionTitle}>Magpie 内置功能</Text>
          <Builtins
            data={{
              ...data,
              builtins: data.builtins.filter((b) =>
                `${b.name} ${b.id} ${b.sub}`.toLowerCase().includes(q),
              ),
            }}
          />
        </>
      ) : (
        <Card>
          <Text style={s.sectionTitle}>手动安装</Text>
          <Text style={s.muted}>填写 npm 包名、Git 仓库地址或主机上的插件目录。</Text>
          <View style={[s.row, { alignItems: "flex-end" }]}>
            <Field
              label="插件来源"
              value={spec}
              onChange={setSpec}
              placeholder="@scope/package 或 Git 地址"
            />
            <Button
              label="安装插件"
              icon="Download"
              primary
              disabled={!spec.trim()}
              onPress={() => {
                void run({ type: "plugin.add", spec: spec.trim() }).then((ok) => {
                  if (ok) setSpec("");
                });
              }}
            />
          </View>
        </Card>
      )}
    </>
  );
}

function CatalogSection({
  title,
  loading,
  error,
  retry,
  children,
}: {
  title: string;
  loading: boolean;
  error?: string;
  retry(): void;
  children: React.ReactNode;
}) {
  const { s, c } = useUi();
  return (
    <View style={s.section}>
      <View style={s.row}>
        <Text style={s.sectionTitle}>{title}</Text>
        {loading ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
      </View>
      {error ? (
        <>
          <Banner error>{error}</Banner>
          <View style={s.row}>
            <Button label={`重试${title}`} onPress={retry} />
          </View>
        </>
      ) : null}
      {children}
    </View>
  );
}
function CatalogGrid({
  items,
  installed,
}: {
  items: PluginCatalogItem[];
  installed: PageData["plugins"];
}) {
  const { s, compact, run } = useUi();
  return items.length ? (
    <View style={s.grid}>
      {items.map((p) => {
        const existing = installed.find((i) => packageName(i.spec) === packageName(p.spec));
        return (
          <Card
            key={p.spec}
            column
            style={{
              flexBasis: compact ? "100%" : 280,
              minWidth: compact ? 0 : 240,
              maxWidth: compact ? "100%" : 420,
            }}
          >
            <View style={s.between}>
              <View style={[s.row, s.grow]}>
                <BrandIcon id={p.name} fallback="Puzzle" size={26} />
                <View style={s.grow}>
                  <Text style={s.cardTitle}>{p.name}</Text>
                  <Text numberOfLines={1} style={s.small}>
                    {p.publisher || p.spec}
                  </Text>
                </View>
              </View>
              <Button
                label={existing ? (existing.off ? "启用" : "已安装") : "安装"}
                accessibilityLabel={`${existing ? (existing.off ? "启用" : "已安装") : "安装"} ${p.name}`}
                disabled={!!existing && !existing.off}
                primary={!existing}
                onPress={() => {
                  void run(
                    existing
                      ? { type: "plugin.toggle", spec: existing.spec, on: true }
                      : { type: "plugin.add", spec: p.spec },
                  );
                }}
              />
            </View>
            {p.description ? (
              <Text numberOfLines={3} style={s.muted}>
                {p.description}
              </Text>
            ) : null}
            <Text numberOfLines={1} style={s.small}>
              {p.spec}
            </Text>
            <View style={s.row}>
              {p.community ? <Chip label="Magpie 社区" /> : null}
              {p.version ? <Text style={s.small}>v{p.version}</Text> : null}
              {p.weekly > 0 ? <Text style={s.small}>{number(p.weekly)}/周</Text> : null}
              {p.repository ? <ExternalLink href={p.repository}>源码 ↗</ExternalLink> : null}
            </View>
          </Card>
        );
      })}
    </View>
  ) : null;
}
