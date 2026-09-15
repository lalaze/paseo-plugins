import { Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { HostEntry, HostRegistry } from './hosts';
import { dataAge, hasQuota, isStale } from '../shared/usage';
import { ProviderCard } from './overview';
import { TextAction } from './consumption-ui';

export function HostQuotas({ hosts, registry, theme }: { hosts: readonly HostEntry[]; registry: HostRegistry; theme: PluginHostProps['theme'] }) {
  return <View style={{ gap: 16 }}>
    <Text style={{ fontSize: 11, lineHeight: 17, color: theme.colors.foregroundMuted }}>额度按主机分别显示；同账号可能共享额度，不相加。</Text>
    {hosts.map(host => {
      const providers = host.quota?.providers.filter(hasQuota) ?? [];
      const stale = !host.online || host.quotaError || isStale(host.quota);
      return <View key={host.id} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: '600' }}>{host.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{!host.online ? '未连接 · ' : host.quotaError ? '读取失败 · ' : ''}{dataAge(host.quota?.fetchedAt)}</Text>
          </View>
          <TextAction label={host.quotaLoading ? '更新中' : '刷新'} accessibilityLabel={`刷新 ${host.label} 额度`} onPress={() => { void registry.refreshQuota(host.id); }} disabled={!host.online || host.quotaLoading} theme={theme} />
        </View>
        {stale && providers.length ? <Text style={{ fontSize: 11, lineHeight: 17, color: theme.colors.statusWarning }}>上次读取的额度，等待主机更新</Text> : null}
        {!providers.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 8 }}>{!host.online ? '此主机未连接，暂无缓存额度。' : host.quotaError ? '额度读取失败，请稍后刷新。' : host.quotaLoading ? '正在读取额度…' : '此主机尚未返回额度数据。'}</Text> : null}
        {providers.map(usage => <ProviderCard key={usage.providerId} usage={usage} theme={theme} current={false} pinned={false} />)}
      </View>;
    })}
  </View>;
}
