import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { translationSettings, validateTranslationSettings } from '../shared/settings';
import { localizeTranslationError, ui } from './i18n';

export function TranslationSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(translationSettings);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [englishLockModels, setEnglishLockModels] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status !== 'ready') return;
    setApiUrl(settings.values.apiUrl);
    setApiKey(settings.values.apiKey);
    setModel(settings.values.model);
    setEnglishLockModels(settings.values.englishLockModels);
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

  if (settings.status === 'loading') return <View style={{ padding: 24 }}><Text style={{ color: theme.colors.foregroundMuted }}>{ui('Loading Translation API settings…', '正在读取翻译 API 设置…')}</Text></View>;
  if (settings.status === 'error' || settings.status === 'invalid') return <View style={{ padding: 24, gap: 12 }}>
    <Text style={{ color: theme.colors.statusDanger }}>{localizeTranslationError(settings.error)}</Text>
    <Pressable onPress={() => { void settings.reload(); }} style={{ alignSelf: 'flex-start', backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 }}>
      <Text style={{ color: theme.colors.accentForeground }}>{ui('Reload', '重新读取')}</Text>
    </Pressable>
  </View>;

  const save = async () => {
    setError(null); setMessage(null);
    try {
      const values = validateTranslationSettings({ apiUrl, apiKey, model, englishLockModels });
      const saved = await settings.save(values, settings.revision);
      if (saved) setMessage(ui('Saved. Future translations will call this API directly.', '已保存。之后的翻译会直接调用此 API。'));
      else setError(settings.saveError ? localizeTranslationError(settings.saveError) : ui('Save failed; try again', '保存失败，请重试'));
    } catch (reason) {
      setError(localizeTranslationError(reason));
    }
  };

  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 14 : 24, gap: 18, maxWidth: 760 }}>
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: '700' }}>{ui('Translation API', '翻译 API')}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
        {ui('Uses an OpenAI Chat Completions-compatible endpoint. The plugin server calls this URL directly and does not create a Paseo agent.', '使用 OpenAI Chat Completions 兼容接口。插件服务端会直接请求此地址，不会创建 Paseo Agent。')}
      </Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>{ui('API URL', 'API 地址')}</Text>
      <TextInput value={apiUrl} onChangeText={setApiUrl} style={fieldStyle} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://api.openai.com/v1/chat/completions" placeholderTextColor={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{ui('Enter the complete Chat Completions request URL.', '填写完整的 Chat Completions 请求地址。')}</Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>API Key</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput value={apiKey} onChangeText={setApiKey} style={[fieldStyle, { flex: 1 }]} autoCapitalize="none" autoCorrect={false} secureTextEntry={!showKey} placeholder={ui('sk-… (leave blank if authentication is not required)', 'sk-…（免鉴权接口可留空）')} placeholderTextColor={theme.colors.foregroundMuted} />
        <Pressable onPress={() => setShowKey(value => !value)} style={{ justifyContent: 'center', borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 }}>
          <Text style={{ color: theme.colors.foreground }}>{showKey ? ui('Hide', '隐藏') : ui('Show', '显示')}</Text>
        </Pressable>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{ui('When set, it is sent as Authorization: Bearer. The configuration is stored on the current Paseo host.', '非空时以 Authorization: Bearer 发送；配置保存在当前 Paseo 主机。')}</Text>
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>{ui('Model', '模型')}</Text>
      <TextInput value={model} onChangeText={setModel} style={fieldStyle} autoCapitalize="none" autoCorrect={false} placeholder={ui('For example, gpt-4.1-mini', '例如 gpt-4.1-mini')} placeholderTextColor={theme.colors.foregroundMuted} />
    </View>

    <View style={{ gap: 7 }}>
      <Text style={labelStyle}>{ui('Automatic EN-lock models', '自动 EN 锁模型')}</Text>
      <TextInput value={englishLockModels} onChangeText={setEnglishLockModels} style={fieldStyle} autoCapitalize="none" autoCorrect={false} multiline placeholder={ui('For example, claude, anthropic', '例如 claude, anthropic')} placeholderTextColor={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        {ui('Separate case-insensitive keywords with commas, semicolons, or line breaks. EN lock turns on automatically and cannot be disabled when the current provider or model matches any keyword. Leave blank to disable automatic locking.', '用逗号、分号或换行分隔关键词，不区分大小写。当前对话的供应商或模型名命中任一关键词时，EN 锁会自动开启且不能手动关闭；留空则禁用自动锁。')}
      </Text>
    </View>

    {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    {message ? <Text style={{ color: theme.colors.statusSuccess }}>{message}</Text> : null}
    {settings.saveError && !error ? <Text style={{ color: theme.colors.statusDanger }}>{localizeTranslationError(settings.saveError)}</Text> : null}

    <Pressable disabled={settings.saving} onPress={() => { void save(); }} style={{ alignSelf: 'flex-start', opacity: settings.saving ? 0.6 : 1, backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: theme.colors.accentForeground, fontWeight: '600' }}>{settings.saving ? ui('Saving…', '保存中…') : ui('Save Settings', '保存设置')}</Text>
    </Pressable>
  </ScrollView>;
}
