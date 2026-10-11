import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PluginClientContext, PluginHostProps } from '@getpaseo/plugin/client';
import { copyText, Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { Text, TextInput, View } from 'react-native';
import { connectionConfigure, connectionTest, connectionTokenReveal } from '../shared/rpc';
import { isExplicitRejection, parseDotBridgeError, ui } from './i18n';
import { Button, outline, Pill, SectionTitle, tint, type Colors } from './kit';
import { usePendingOperation } from './operation';
import type { BridgeQuery } from './query';

interface FactRowProps {
  label: string;
  value: string;
  ok: boolean;
  colors: Colors;
}

function FactRow(props: FactRowProps) {
  const { colors } = props;
  const color = props.ok ? colors.statusSuccess ?? colors.foreground : colors.foregroundMuted;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
      <Icon name={props.ok ? 'Check' : 'X'} size={14} color={color} />
      <Text style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>{props.label}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{props.value}</Text>
    </View>
  );
}

export interface ConnectionCardProps extends PluginHostProps {
  rpc: PluginClientContext['rpc'];
  query: BridgeQuery;
}

/** Connection facts, the two-way test, the token reveal and the copyable dot instructions. */
export function ConnectionCard(props: ConnectionCardProps) {
  const { colors } = props.theme;
  const toast = useToast();
  const status = useQuery(props.query.connectionOptions, props.query.client);
  const [name, setName] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'token' | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const saveOp = usePendingOperation<{ revision: number; name: string; publicBaseUrl: string }>();
  const testOp = usePendingOperation<Record<string, never>>();

  const data = status.data;
  const facts = data?.facts;
  const connection = data?.connection;

  async function save() {
    if (!connection) return;
    // A display name is required, so an empty one keeps the current value; the tunnel base may be
    // cleared explicitly with an empty string.
    const nextName = (name ?? connection.name).trim() || connection.name;
    const nextBaseUrl = (baseUrl ?? connection.callbackBaseUrl).trim();
    setBusy('save');
    try {
      // The pending operation freezes the revision seen now, so a retry after a lost response reuses
      // the same id and revision even if a background poll has since bumped the connection revision.
      const pending = saveOp.begin(JSON.stringify({ nextName, nextBaseUrl }), { revision: connection.revision, name: nextName, publicBaseUrl: nextBaseUrl });
      await props.rpc(connectionConfigure, { operationId: pending.operationId, ...pending.payload });
      saveOp.settle();
      toast.show(ui('Connection saved', '连接已保存'), { variant: 'success' });
      await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'connection'] });
    } catch (error) {
      // An explicit decision (e.g. a revision conflict) releases the frozen save so a retry uses the
      // latest revision; an uncertain failure keeps it, so a lost response cannot save twice.
      if (isExplicitRejection(error)) {
        saveOp.settle();
        await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'connection'] });
      }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    try {
      // Reuse the same operationId across retries so the dot sees one test, not a new one per click.
      const pending = testOp.begin('connection-test', {});
      const result = await props.rpc(connectionTest, { operationId: pending.operationId });
      if (result.delivered || result.expiresAt <= Date.now()) testOp.settle();
      toast.show(
        result.delivered
          ? ui('Connection test delivered', '连接测试已送达')
          : ui('Connection test event sent — waiting for the dot', '已发出连接测试事件 —— 等待 dot 确认'),
        { variant: result.delivered ? 'success' : 'info' },
      );
      await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'connection'] });
    } catch (error) {
      if (isExplicitRejection(error)) {
        testOp.settle();
        await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'connection'] });
      }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    setBusy('token');
    try {
      const result = await props.rpc(connectionTokenReveal, {});
      setToken(result.token);
    } catch (error) {
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await copyText(text);
      toast.show(ui(`${label} copied`, `${label} 已复制`), { variant: 'success' });
    } catch {
      toast.error(ui('Copy failed', '复制失败'));
    }
  }

  if (status.isPending) {
    return <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{ui('Loading connection…', '正在读取连接…')}</Text>;
  }
  if (status.isError || !data) {
    return <Text style={{ color: colors.statusDanger, fontSize: 13 }}>{parseDotBridgeError(status.error)}</Text>;
  }

  const ready = facts?.ready ?? false;
  const missing: string[] = [];
  if (facts && !facts.localBridge) missing.push(ui('start the local bridge', '启动本地桥接'));
  if (facts && !facts.taskRoute) missing.push(ui('subscribe a verified task_changed route', '订阅并通过 task_changed 回调验证'));
  if (facts && !facts.dotVerified) missing.push(ui('have the dot call confirm_dot_connection', '让 dot 调用 confirm_dot_connection'));

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SectionTitle colors={colors}>{ui('Connection', '连接')}</SectionTitle>
        <Pill colors={colors} active={ready}>
          <Text style={{ color: ready ? colors.foreground : colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>
            {ready ? ui('Ready', '已就绪') : ui('Not ready', '未就绪')}
          </Text>
        </Pill>
      </View>
      <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 10, padding: 12, gap: 2 }}>
        <FactRow colors={colors} label={ui('Local bridge', '本地桥接')} value={data.bridge.listening ? `${data.bridge.host}:${data.bridge.port}` : ui('off', '未启动')} ok={facts?.localBridge ?? false} />
        <FactRow colors={colors} label={ui('Subscription', '订阅')} value={facts?.subscribed ? ui('active', '有效') : ui('none', '无')} ok={facts?.subscribed ?? false} />
        <FactRow colors={colors} label={ui('Callback verified', '回调验证')} value={facts?.callbackVerified ? ui('yes', '通过') : ui('no', '未通过')} ok={facts?.callbackVerified ?? false} />
        <FactRow colors={colors} label={ui('Dot confirmed', 'dot 回传验证')} value={facts?.dotVerified ? ui('yes', '通过') : ui('no', '未通过')} ok={facts?.dotVerified ?? false} />
        <FactRow colors={colors} label={ui('Task route', '任务通道')} value={facts?.taskRoute ? ui('verified', '已验证') : ui('missing', '缺失')} ok={facts?.taskRoute ?? false} />
        {connection && connection.subscriptions.length > 0 ? (
          <View style={{ marginTop: 4, gap: 2 }}>
            {connection.subscriptions.map(sub => (
              <Text key={sub.id} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {sub.name} · {sub.verifiedAt ? ui('verified', '已验证') : ui('unverified', '未验证')}
                {sub.expiresAt ? ` · ${ui('expires', '到期')} ${new Date(sub.expiresAt).toLocaleString()}` : ''}
              </Text>
            ))}
          </View>
        ) : null}
        {facts?.lastCallbackAt ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginTop: 4 }}>
            {ui('Last callback', '最后回传')}: {new Date(facts.lastCallbackAt).toLocaleString()}
          </Text>
        ) : null}
        {data.bridge.endpoint ? (
          <Text style={{ color: tint(colors.foregroundMuted, 0.9), fontSize: 11, marginTop: 2 }}>{data.bridge.endpoint}</Text>
        ) : null}
        {data.bridge.error ? <Text style={{ color: colors.statusDanger, fontSize: 11 }}>{data.bridge.error}</Text> : null}
      </View>

      {!ready && missing.length > 0 ? (
        <Text style={{ color: colors.statusWarning, fontSize: 12 }}>
          {ui('To dispatch work, ', '要派发任务，需要')}
          {missing.join(ui('; ', '；'))}
          {ui('.', '。')}
        </Text>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Display name', '显示名称')}</Text>
        <TextInput
          value={name ?? connection?.name ?? ''}
          onChangeText={setName}
          placeholder={ui('My dot', '我的 dot')}
          placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
          style={{ color: colors.foreground, borderWidth: 1, borderColor: outline(colors), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 }}
        />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Public HTTPS base (tunnel)', '公网 HTTPS 基址（隧道）')}</Text>
        <TextInput
          value={baseUrl ?? connection?.callbackBaseUrl ?? ''}
          onChangeText={setBaseUrl}
          placeholder="https://…"
          autoCapitalize="none"
          placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
          style={{ color: colors.foreground, borderWidth: 1, borderColor: outline(colors), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 }}
        />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label={ui('Save', '保存')} colors={colors} onPress={save} disabled={busy !== null} />
          <Button label={ui('Test connection', '测试连接')} colors={colors} variant="outline" onPress={test} disabled={busy !== null} />
          <Button label={ui('Reveal token', '显示令牌')} colors={colors} variant="outline" onPress={reveal} disabled={busy !== null} />
        </View>
      </View>

      {token ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('MCP bearer token (secret)', 'MCP 访问令牌（密钥）')}</Text>
          <Text selectable style={{ color: colors.foreground, fontSize: 12, fontFamily: 'monospace' }}>{token}</Text>
          <Button label={ui('Copy token', '复制令牌')} colors={colors} variant="outline" size="sm" onPress={() => copy(token, ui('Token', '令牌'))} />
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Instructions for your dot', '复制给 dot 的说明')}</Text>
        <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{data.instructions}</Text>
        <Button label={ui('Copy instructions', '复制说明')} colors={colors} variant="outline" size="sm" onPress={() => copy(data.instructions, ui('Instructions', '说明'))} />
      </View>

      <View style={{ gap: 4 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('ChatGPT Activity', 'ChatGPT 活动记录')}</Text>
        <Text style={{ color: tint(colors.foregroundMuted, 0.95), fontSize: 11, lineHeight: 16 }}>
          {ui(
            'This panel shows only the bridge’s own status, never the dot’s chat. In ChatGPT, open the conversation’s Activity (or the connected plugin’s task list) to see what the dot actually ran, its tool calls and any errors.',
            '本面板只显示桥接自身的状态，不显示 dot 的对话。请在 ChatGPT 对话的「Activity / 活动」（或已连接插件的任务列表）中查看 dot 实际执行的内容、工具调用与错误。',
          )}
        </Text>
      </View>
    </View>
  );
}
