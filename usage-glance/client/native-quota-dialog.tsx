import type { ReactNode } from 'react';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Modal, Pressable, SafeAreaView, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { ui } from './i18n';

/** A separate native window keeps this single scroller outside Paseo 0.8's
 * menu-sheet pan recognizer and its content-driven height measurement. */
export function NativeQuotaDialog({ theme, onClose, children }: {
  theme: PluginHostProps['theme'];
  onClose(): void;
  children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={ui('Dismiss quota details', '收起额度明细')} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <View accessibilityViewIsModal style={{
        height: Math.min(600, Math.round(height * 0.65)), maxHeight: '90%',
        width: '92%', maxWidth: 440, marginVertical: 12,
        borderRadius: 24, overflow: 'hidden', backgroundColor: theme.colors.surface0,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 10, paddingTop: 12, paddingBottom: 0 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: theme.colors.foreground, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 }}>
            {ui('Remaining quota', '可用额度')}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={ui('Close quota details', '关闭额度明细')} onPress={onClose}
            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.surface2, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 21, lineHeight: 24 }}>×</Text>
            </View>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 16 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
          {children}
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}
