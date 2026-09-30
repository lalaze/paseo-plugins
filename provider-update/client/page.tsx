import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ui } from '../shared/i18n';
import { listProviderUpdates, updateProvider, type ProviderUpdate } from '../shared/rpc';

type Colors = PluginSurfaceProps['theme']['colors'];
type Rpc = PluginClientContext['rpc'];

const POLL_MS = 2000;

const installLabels: Record<ProviderUpdate['install'], string> = {
  'claude-native': ui('Native installer', '原生安装'),
  'codex-standalone': ui('Standalone', '独立安装'),
  'grok-standalone': ui('Standalone', '独立安装'),
  'kimi-standalone': ui('Standalone', '独立安装'),
  npm: 'npm',
  homebrew: 'Homebrew',
  'homebrew-cask': 'Homebrew Cask',
  script: ui('Local script', '本地脚本'),
  unknown: ui('Unrecognised install', '未识别的安装方式'),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderUpdatesPage(props: PluginSurfaceProps & { rpc: Rpc }) {
  const { colors } = props.theme;
  const [rows, setRows] = useState<ProviderUpdate[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setChecking(true);
    try {
      const result = await props.rpc(listProviderUpdates, { refresh });
      if (!alive.current) return;
      setRows(result.providers);
      setCheckedAt(result.checkedAt);
      setError(null);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current && refresh) setChecking(false);
    }
  }, [props.rpc]);

  useEffect(() => { void load(false); }, [load]);

  const updating = rows?.some(row => row.state === 'updating') ?? false;
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => { void load(false); }, POLL_MS);
    return () => clearInterval(timer);
  }, [updating, load]);

  const start = async (provider: string) => {
    try {
      const row = await props.rpc(updateProvider, { provider });
      if (alive.current) setRows(current => current?.map(existing => existing.provider === provider ? row : existing) ?? [row]);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    }
  };

  return <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '700' }}>{ui('Provider updates', 'Provider 更新')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {ui(
            `Enabled providers on ${props.host.label}. Updates replace the CLI the daemon launches; new sessions use it right away, running agents after they restart.`,
            `${props.host.label} 上已启用的 Provider。更新会替换 daemon 实际启动的 CLI；新会话立即生效，运行中的 Agent 重启后生效。`,
          )}
        </Text>
      </View>
      <Button colors={colors} icon="RefreshCw" label={checking ? ui('Checking…', '检查中…') : ui('Check again', '重新检查')} disabled={checking || updating} onPress={() => void load(true)} variant="outline" />
    </View>
    {error ? <Text style={{ color: colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
    {rows === null
      ? <ActivityIndicator color={colors.foregroundMuted} />
      : rows.length === 0
        ? <Text style={{ color: colors.foregroundMuted }}>{ui('No providers are enabled on this host.', '本机没有启用的 Provider。')}</Text>
        : rows.map(row => <ProviderRow key={row.provider} row={row} colors={colors} busy={updating} onUpdate={() => void start(row.provider)} />)}
    {checkedAt ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
      {ui('Last checked', '上次检查')} {new Date(checkedAt).toLocaleString()}
    </Text> : null}
  </ScrollView>;
}

function ProviderRow(props: { row: ProviderUpdate; colors: Colors; busy: boolean; onUpdate(): void }) {
  const { row, colors } = props;
  const version = row.current
    ? row.latest && row.updateAvailable ? `${row.current} → ${row.latest}` : row.current
    : ui('Version unknown', '版本未知');
  const upToDate = Boolean(row.current && row.latest && !row.updateAvailable);
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: '600' }}>{row.label}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: colors.surface2 }}>{installLabels[row.install]}</Text>
        </View>
        <Text style={{ color: row.updateAvailable ? colors.statusWarning : colors.foregroundMuted, fontSize: 13 }}>{version}</Text>
      </View>
      {row.state === 'updating'
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{ui('Updating…', '更新中…')}</Text>
        </View>
        : !row.canUpdate ? null
          : upToDate
            ? <Text style={{ color: colors.statusSuccess, fontSize: 13 }}>{ui('Up to date', '已是最新')}</Text>
            // Without a version feed (Homebrew, failed lookup) the updater itself decides.
            : <Button colors={colors} icon="CircleArrowUp" label={ui('Update', '更新')} disabled={props.busy} onPress={props.onUpdate} variant={row.updateAvailable ? 'primary' : 'outline'} />}
    </View>
    {row.binary ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{row.binary}</Text> : null}
    {!row.canUpdate && row.binary
      ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.install === 'script'
        ? ui('A script run by an interpreter; update it where it came from.', '由解释器运行的脚本，请在其来源处更新。')
        : ui('Installed in a way this plugin does not recognise; update it manually.', '安装方式无法识别，请手动更新。')}</Text>
      : null}
    {row.state === 'updated'
      ? <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>{ui('Update finished. Restart running agents to switch to the new version.', '更新完成。运行中的 Agent 重启后切换到新版本。')}</Text>
      : null}
    {row.state === 'failed' ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{ui('Update failed.', '更新失败。')}</Text> : null}
    {row.message
      ? <Text selectable style={{ color: row.state === 'failed' || !row.binary ? colors.statusDanger : colors.foregroundMuted, fontSize: 11, fontFamily: 'monospace' }}>{row.message}</Text>
      : null}
  </View>;
}

function Button(props: { label: string; icon: string; onPress(): void; colors: Colors; variant: 'primary' | 'outline'; disabled?: boolean }) {
  const { colors } = props;
  const fg = props.variant === 'primary' ? colors.accentForeground : colors.foreground;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={props.label}
    disabled={props.disabled}
    onPress={props.onPress}
    style={({ pressed }) => ({
      flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 14, borderRadius: 999,
      backgroundColor: props.variant === 'primary' ? colors.accent : pressed ? colors.surface2 : 'transparent',
      borderWidth: props.variant === 'outline' ? 1 : 0, borderColor: colors.border,
      opacity: props.disabled ? 0.45 : pressed ? 0.85 : 1,
    })}
  >
    <Icon name={props.icon} size={14} color={fg} />
    <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>{props.label}</Text>
  </Pressable>;
}
