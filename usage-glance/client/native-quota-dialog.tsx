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
    <SafeAreaView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={ui('Dismiss quota details', '收起额度明细')} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <View accessibilityViewIsModal style={{
        height: Math.min(600, Math.round(height * 0.65)), maxHeight: '90%',
        width: '94%', maxWidth: 560, marginVertical: 12,
        borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface0,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, paddingVertical: 4,
          borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: theme.colors.foreground, fontSize: 16, fontWeight: '600' }}>
            {ui('Quota details', '额度明细')}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={ui('Close quota details', '关闭额度明细')} onPress={onClose}
            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 26 }}>×</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
          {children}
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}
