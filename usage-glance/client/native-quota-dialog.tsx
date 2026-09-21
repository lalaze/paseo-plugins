import { useMemo, useRef, type ReactNode } from 'react';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Animated, Modal, PanResponder, Platform, Pressable, SafeAreaView, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { ui } from './i18n';

/** A separate native window keeps this single scroller outside Paseo 0.8's
 * menu-sheet pan recognizer and its content-driven height measurement. */
export function NativeQuotaDialog({ theme, onClose, children }: {
  theme: PluginHostProps['theme'];
  onClose(): void;
  children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const offset = useRef(new Animated.Value(0)).current;
  const close = useRef(onClose);
  close.current = onClose;
  const drag = useMemo(() => PanResponder.create({
    // Only the fixed header owns this gesture; the quota list scrolls normally.
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && gesture.dy > Math.abs(gesture.dx),
    onPanResponderMove: (_, gesture) => { offset.setValue(Math.max(0, gesture.dy)); },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 64 || (gesture.dy > 12 && gesture.vy > 0.7)) close.current();
      else Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => { Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start(); },
  }), [offset]);
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={ui('Dismiss quota details', '收起额度明细')} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <Animated.View accessibilityViewIsModal style={{
        height: Math.min(600, Math.round(height * 0.65)), maxHeight: '90%',
        width: '100%', maxWidth: 560, transform: [{ translateY: offset }],
        borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', backgroundColor: theme.colors.surface0,
      }}>
        <SafeAreaView style={{ flex: 1 }}>
          <View {...drag.panHandlers}>
            <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 2 }}>
              <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: theme.colors.foregroundMuted, opacity: 0.35 }} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 10, paddingTop: 0, paddingBottom: 0 }}>
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
          </View>
          {/* RN SafeAreaView handles iOS. Android 0.8 draws edge to edge, so reserve
              space for its three-button navigation bar as well as gesture mode. */}
          <ScrollView style={{ flex: 1, marginBottom: Platform.OS === 'android' ? 48 : 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 16 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
            {children}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </View>
  </Modal>;
}
