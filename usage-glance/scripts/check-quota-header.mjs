import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Exercise the compiled contribution through Paseo's require boundary. Native
// primitives are stand-ins; this verifies button integration, not device gestures.
const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = await readFile(process.argv[2] ?? new URL('../dist/client.js', import.meta.url), 'utf8');
const noop = () => {};

for (const platform of ['android', 'ios', 'web']) {
  let windowHeight = 800;
  const Modal = Object.assign(({ open, children, onOpenChange }) =>
    open ? React.createElement('modal', { onOpenChange }, children) : null,
  { Content: 'modal-content' });
  const runtimeRequire = name => {
    if (name === 'react-native') return {
      Platform: { OS: platform }, View: 'view', Text: 'text', Pressable: 'pressable', ScrollView: 'scroll-view',
      Modal: 'native-modal', SafeAreaView: 'safe-area',
      useWindowDimensions: () => ({ width: 400, height: windowHeight }),
    };
    if (name === '@getpaseo/plugin/client/react-native') return { Modal };
    return require(name);
  };
  const contribute = (0, eval)(source)(runtimeRequire).default;
  let button, tree, removed = false;
  const client = {
    paseo: {
      providers: { listUsage: async () => ({
        providers: Array.from({ length: 12 }, (_, index) => ({
          providerId: `provider-${index}`, displayName: `Provider ${index}`, status: 'available', planLabel: null,
          windows: [{ id: 'weekly', label: 'Weekly', remainingPct: 80 }],
        })), fetchedAt: new Date().toISOString(),
      }), subscribe: () => noop },
      workspaces: { subscribe: () => noop, list: async () => ({ entries: [{ id: 'workspace' }], pageInfo: { hasMore: false } }) },
    },
    rpc: async (_contract, input) => input.range ? { range: input.range, sources: [], scanning: false } : {},
    addHeaderButton: contribution => {
      button = contribution.button;
      return { update: patch => Object.assign(button, patch), remove: () => { removed = true; } };
    },
    addSurface: () => noop, addSidebarItem: () => noop, addCommandCenterItem: () => noop,
  };
  const cleanup = contribute(client);
  const props = {
    theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#444', accent: '#acf' } },
    host: { id: platform, label: 'Test host' }, layout: { compact: platform !== 'web', platform },
    context: 'workspace', workspaceId: 'workspace', size: 16, color: '#aaa',
  };
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(button, `${platform}: workspace registers its quota button`);
    assert.equal(button.behavior.kind, 'action', 'quota must not nest its scroller inside a host menu sheet');
    await act(async () => { tree = create(React.createElement(button.icon, props)); });
    for (let attempt = 0; attempt < 3; attempt++) {
      // The host temporarily replaces action icons with a pending spinner.
      await act(async () => { tree.update(null); button.behavior.onPress(); });
      await act(async () => { tree.update(React.createElement(button.icon, props)); });
      if (platform === 'web') {
        assert.equal(tree.root.findAllByType('modal').length, 1);
        await act(async () => { tree.root.findByType('modal').props.onOpenChange(false); });
        assert.equal(tree.root.findAllByType('modal').length, 0);
      } else {
        const modal = tree.root.findByType('native-modal');
        assert.equal(modal.props.visible, true);
        assert.equal(tree.root.findAllByType('modal').length, 0, 'no host bottom sheet competes for gestures');
        assert.equal(modal.findAllByType('scroll-view').length, 1, 'one native scroll container owns the list');
        const scroll = modal.findByType('scroll-view');
        assert.ok(scroll.findAllByType('text').some(node => node.props.children === 'Provider 11'), 'last provider stays inside the scroll content');
        const card = modal.findByProps({ accessibilityViewIsModal: true });
        assert.ok(card.props.style.height < 800 * 0.8, 'dialog stays below full-screen height');
        assert.ok(modal.findAllByType('text').some(node => /Quota on this host|本机额度/.test(node.props.children)));
        if (attempt === 0) {
          windowHeight = 360;
          await act(async () => { tree.update(React.createElement(button.icon, { ...props })); });
          assert.ok(modal.findByProps({ accessibilityViewIsModal: true }).props.style.height < 360 * 0.8, 'landscape retains a bounded dialog');
          await act(async () => { modal.props.onRequestClose(); });
          windowHeight = 800;
        }
        else {
          const control = modal.findAllByType('pressable').find(node =>
            new RegExp(attempt === 1 ? 'Close quota|关闭额度' : 'Dismiss quota|收起额度').test(node.props.accessibilityLabel));
          assert.ok(control, 'close button and backdrop are available');
          await act(async () => { control.props.onPress(); });
        }
        assert.equal(tree.root.findAllByType('native-modal').length, 0);
      }
    }
  } finally {
    await act(async () => { tree?.unmount(); cleanup(); });
  }
  assert.ok(removed, 'unloading removes the header');
  console.log(`PASS ${platform}: quota content opens, closes and reopens`);
}
