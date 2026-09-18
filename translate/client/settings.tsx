import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { translationSettings, validateTranslationSettings } from '../shared/settings';

export function TranslationSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(translationSettings);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status !== 'ready') return;
    setApiUrl(settings.values.apiUrl);
    setApiKey(settings.values.apiKey);
    setModel(settings.values.model);
  }, [settings.status, settings.status === 'ready' ? settings.revision : '']);

  const fieldStyle = {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 14,
  } as const;
  const labelStyle = { color: theme.colors.foreground, fontSize: 14, fontWeight: '600' as const };

  if (settings.status === 'loading') return <View style={{ padding: 24 }}><Text style={{ color: theme.colors.foregroundMuted }}>正在读取翻译 API 设置…</Text></View>;
  if (settings.status === 'error' || settings.status === 'invalid') return <View style={{ padding: 24, gap: 12 }}>
    <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
    <Pressable onPress={() => { void settings.reload(); }} style={{ alignSelf: 'flex-start', backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 }}>
      <Text style={{ color: theme.colors.accentForeground }}>重新读取</Text>
    </Pressable>
  </View>;

  const save = async () => {
    setError(null); setMessage(null);
    try {
      const values = validateTranslationSettings({ apiUrl, apiKey, model });
      const saved = await settings.save(values, settings.revision);
      if (saved) setMessage('已保存。之后的划词翻译会直接调用此 API。');
      else setError(settings.saveError || '保存失败，请重试');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 14 : 24, gap: 18, maxWidth: 760 }}>
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: '700' }}>翻译 API</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
        使用 OpenAI Chat Completions 兼容接口。插件服务端会直接请求此地址，不会创建 Paseo Agent。
      </Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>API 地址</Text>
      <TextInput value={apiUrl} onChangeText={setApiUrl} style={fieldStyle} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://api.openai.com/v1/chat/completions" placeholderTextColor={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>填写完整的 Chat Completions 请求地址。</Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>API Key</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput value={apiKey} onChangeText={setApiKey} style={[fieldStyle, { flex: 1 }]} autoCapitalize="none" autoCorrect={false} secureTextEntry={!showKey} placeholder="sk-…（免鉴权接口可留空）" placeholderTextColor={theme.colors.foregroundMuted} />
        <Pressable onPress={() => setShowKey(value => !value)} style={{ justifyContent: 'center', borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 }}>
          <Text style={{ color: theme.colors.foreground }}>{showKey ? '隐藏' : '显示'}</Text>
        </Pressable>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>非空时以 Authorization: Bearer 发送；配置保存在当前 Paseo 主机。</Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>模型</Text>
      <TextInput value={model} onChangeText={setModel} style={fieldStyle} autoCapitalize="none" autoCorrect={false} placeholder="例如 gpt-4.1-mini" placeholderTextColor={theme.colors.foregroundMuted} />
    </View>

    {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    {message ? <Text style={{ color: theme.colors.statusSuccess }}>{message}</Text> : null}
    {settings.saveError && !error ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}

    <Pressable disabled={settings.saving} onPress={() => { void save(); }} style={{ alignSelf: 'flex-start', opacity: settings.saving ? 0.6 : 1, backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: theme.colors.accentForeground, fontWeight: '600' }}>{settings.saving ? '保存中…' : '保存设置'}</Text>
    </Pressable>
  </ScrollView>;
}
