import { useEffect, useState } from 'react';
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { dotBridgeSettingsDefinition, type DotBridgeSettings } from '../shared/settings';
import { parseDotBridgeError, ui } from './i18n';
import { Button, outline, Pill, SectionTitle, tint, type Colors } from './kit';

function row(colors: Colors) {
  return { color: colors.foreground, borderWidth: 1, borderColor: outline(colors), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 } as const;
}

/** Host settings: the in-flight cap, the bridge bind address and task defaults. */
export function DotBridgeSettingsScreen(props: PluginSurfaceProps) {
  const { colors } = props.theme;
  const settings = useSettings(dotBridgeSettingsDefinition);
  const toast = useToast();
  const [draft, setDraft] = useState<DotBridgeSettings | null>(null);

  useEffect(() => {
    if (settings.status === 'ready' && draft === null) setDraft(settings.values);
  }, [settings, draft]);

  // An error or an invalid stored value must be shown before the "loading" branch, otherwise a
  // broken settings file would render a permanent spinner with no way to recover.
  if (settings.status === 'error' || settings.status === 'invalid') {
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Text style={{ color: colors.statusDanger }}>
          {settings.status === 'invalid' ? settings.error : ui('Settings could not be loaded.', '无法读取设置。')}
        </Text>
        <Button label={ui('Retry', '重试')} colors={colors} onPress={() => { void settings.reload(); }} />
      </ScrollView>
    );
  }
  if (settings.status === 'loading' || !draft) {
    return <Text style={{ color: colors.foregroundMuted, padding: 16 }}>{ui('Loading settings…', '正在读取设置…')}</Text>;
  }

  const set = <K extends keyof DotBridgeSettings>(key: K, value: DotBridgeSettings[K]) => setDraft({ ...draft, [key]: value });

  async function save() {
    if (!draft || settings.status !== 'ready') return;
    const ok = await settings.save(draft, settings.revision);
    if (ok) toast.show(ui('Settings saved', '设置已保存'), { variant: 'success' });
    else toast.error(settings.saveError ?? ui('Save failed', '保存失败'));
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {ui(
          'The display name and public tunnel base are set in the Dot tasks panel → Connection tab.',
          '显示名称与公网隧道基址在 Dot 任务面板 → 连接标签中设置。',
        )}
      </Text>

      <SectionTitle colors={colors}>{ui('In-flight tasks', '在途任务')}</SectionTitle>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('In-flight tasks (bridge cap)', '在途任务上限（桥接自身）')}</Text>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[1, 2].map(value => (
          <Pill key={value} colors={colors} active={draft.maxInFlightTasks === value} onPress={() => set('maxInFlightTasks', value as 1 | 2)} label={String(value)}>
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{value}</Text>
          </Pill>
        ))}
      </View>

      <SectionTitle colors={colors}>{ui('Task authorization', '任务授权说明')}</SectionTitle>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(
        'When enabled, future prompts authorize relevant workspace reads and sending their contents to the connected Your dot / ChatGPT for this task; edits are authorized only when requested. Secrets, security changes, publishing and unrelated work remain excluded. This does not approve ChatGPT platform checks or retry blocked calls. Existing messages are unchanged.',
        '启用后，未来提示词会附带授权：读取本任务所需的相关工作区文件，并将内容传回当前连接的 Your dot / ChatGPT；只有明确要求修改代码时才授权相关写入。不包含凭据、安全设置、发布或无关操作，不代替平台审批，也不重试被拦截的调用。已有消息保持不变。',
      )}</Text>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[false, true].map(value => <Pill key={String(value)} colors={colors} active={draft.appendTaskAuthorization === value} onPress={() => set('appendTaskAuthorization', value)} label={value ? ui('Enabled', '已启用') : ui('Disabled', '已关闭')}>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>{value ? ui('Enabled', '已启用') : ui('Disabled', '已关闭')}</Text>
        </Pill>)}
      </View>

      <SectionTitle colors={colors}>{ui('Bridge HTTP server', '桥接 HTTP 服务')}</SectionTitle>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Listen host', '监听地址')}</Text>
      <TextInput value={draft.listenHost} onChangeText={value => set('listenHost', value)} autoCapitalize="none" style={row(colors)} placeholderTextColor={tint(colors.foregroundMuted, 0.7)} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Listen port (0 = random)', '监听端口（0 = 随机）')}</Text>
      <TextInput
        value={String(draft.listenPort)}
        onChangeText={value => set('listenPort', Number(value.replace(/[^0-9]/g, '') || '0'))}
        keyboardType="number-pad"
        style={row(colors)}
        placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
      />

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={ui('Save settings', '保存设置')} colors={colors} onPress={save} disabled={settings.saving} />
        <Button label={ui('Reset', '重置')} colors={colors} variant="outline" onPress={() => { void settings.reset(); }} disabled={settings.saving} />
      </View>
      {settings.saveError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{parseDotBridgeError(settings.saveError)}</Text> : null}
    </ScrollView>
  );
}
