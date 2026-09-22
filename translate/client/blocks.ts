import type { TargetLanguage, TranslationResult } from '../shared/rpc';
import { parseConversationRoute } from './route';
import { button, style } from './dom';
import { localizeTranslationError, ui } from './i18n';

type Runtime = { translate(text: string, target: TargetLanguage): Promise<TranslationResult> };
type BlockTranslator = { dispose(): void };

// Paseo's web UI is React Native Web: markdown blocks are <div>s tagged with data-paseo-markdown-tag,
// and list items are flex rows of [marker, content].
const MARKDOWN_BLOCK_SELECTOR = ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => `[data-paseo-markdown-tag="${tag}"]`).join(', ');
const MESSAGE_SELECTOR = '[data-testid="assistant-message"], [data-testid="user-message"]';
const PLUGIN_SELECTOR = '[data-paseo-translate-group], [data-paseo-translate-block], [data-paseo-translate]';
const MAX_BLOCK_CHARS = 5000;

/** Hoverable text block inside an assistant message, excluding the plugin's own nodes. */
function hoveredBlock(element: Element | null): Element | null {
  if (!element || element.closest(PLUGIN_SELECTOR)) return null;
  const message = element.closest(MESSAGE_SELECTOR);
  if (!message?.matches('[data-testid="assistant-message"]') || !message.closest('[data-testid="agent-chat-scroll"]')) return null;
  const block = element.closest(MARKDOWN_BLOCK_SELECTOR);
  return block && !block.closest('[data-paseo-markdown-tag="pre"]') ? block : null;
}

/** Own text of the block: list markers, nested lists and earlier translations are left out. */
export function blockText(block: Element): string {
  const clone = block.cloneNode(true) as Element;
  clone.querySelectorAll('[data-paseo-markdown-tag="ul"], [data-paseo-markdown-tag="ol"], [data-paseo-markdown-list-marker], [data-paseo-translate-group], [data-paseo-translate-block]').forEach(node => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** List items lay out marker and content side by side, so their panel lives inside the content wrapper. */
function panelParent(block: Element): Element | null {
  if (!block.matches('[data-paseo-markdown-tag="li"]')) return null;
  return Array.from(block.children).reverse().find(child => !child.matches('[data-paseo-markdown-list-marker]')) ?? block;
}

/** Inline display: flex on the panel would defeat the hidden attribute, so collapse toggles the display itself. */
function setCollapsed(panel: HTMLElement, collapsed: boolean) {
  panel.style.display = collapsed ? 'none' : 'flex';
  if (collapsed) panel.dataset.paseoTranslateCollapsed = ''; else delete panel.dataset.paseoTranslateCollapsed;
}

function isCollapsed(panel: HTMLElement) { return 'paseoTranslateCollapsed' in panel.dataset; }

function existingTranslation(block: Element): HTMLElement | null {
  const parent = panelParent(block);
  if (parent) return parent.querySelector<HTMLElement>(':scope > [data-paseo-translate-block]');
  const after = block.nextElementSibling;
  return after instanceof HTMLElement && after.matches('[data-paseo-translate-block]') ? after : null;
}

export function createBlockTranslator(runtimes: Map<string, Runtime>): BlockTranslator {
  let trigger: HTMLButtonElement | null = null, hovered: Element | null = null, request = 0;

  function hide() { trigger?.remove(); trigger = null; hovered = null; }

  function renderTranslation(block: Element, text: string, error = false): HTMLElement {
    let panel = existingTranslation(block);
    if (!panel) {
      panel = document.createElement('div'); panel.dataset.paseoTranslateBlock = '';
      // A full paragraph rendered under the original, unlike the compact source → translation tag used for selections.
      style(panel, { display: 'flex', alignItems: 'flex-start', gap: '6px', margin: '6px 0', padding: '6px 10px', borderLeft: '3px solid rgba(96,165,250,.55)', borderRadius: '0 6px 6px 0', background: 'rgba(59,130,246,.08)', color: '#e4e4e7', fontSize: '.95em', lineHeight: '1.6' });
      const body = document.createElement('div'); body.dataset.paseoTranslateBlockText = '';
      style(body, { flex: '1 1 auto', minWidth: '0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
      const remove = button('×', ui('Remove this translation', '移除这段译文'));
      style(remove, { flex: '0 0 auto', padding: '0 5px', border: '0', background: 'transparent', color: '#a1a1aa', fontSize: '15px', lineHeight: '1.3' });
      remove.addEventListener('click', () => { panel?.remove(); if (hovered === block) syncTrigger(block); });
      panel.append(body, remove);
      const parent = panelParent(block);
      if (parent) parent.append(panel); else block.insertAdjacentElement('afterend', panel);
    }
    const body = panel.querySelector<HTMLElement>('[data-paseo-translate-block-text]');
    if (body) { body.textContent = text; body.style.color = error ? '#fca5a5' : '#e4e4e7'; }
    setCollapsed(panel, false);
    if (error) panel.dataset.paseoTranslateError = ''; else delete panel.dataset.paseoTranslateError;
    return panel;
  }

  async function translateBlock(block: Element, runtime: Runtime) {
    const text = blockText(block).slice(0, MAX_BLOCK_CHARS);
    if (!text) return;
    const sequence = String(++request);
    const panel = renderTranslation(block, ui('Translating…', '正在翻译…'));
    panel.dataset.paseoTranslateRequest = sequence;
    try {
      const result = await runtime.translate(text, 'auto');
      if (!panel.isConnected || panel.dataset.paseoTranslateRequest !== sequence) return;
      renderTranslation(block, result.translation);
    } catch (error) {
      if (!panel.isConnected || panel.dataset.paseoTranslateRequest !== sequence) return;
      renderTranslation(block, localizeTranslationError(error), true);
    }
  }

  function syncTrigger(block: Element) {
    if (!trigger) return;
    const panel = existingTranslation(block);
    const state = !panel || 'paseoTranslateError' in panel.dataset ? 'translate' : isCollapsed(panel) ? 'expand' : 'collapse';
    trigger.textContent = state === 'translate' ? ui('Translate', '译') : state === 'expand' ? ui('Expand', '展开') : ui('Collapse', '收起');
    trigger.title = state === 'translate' ? ui('Translate this block', '翻译这一段') : state === 'expand' ? ui('Expand translation', '展开译文') : ui('Collapse translation', '收起译文');
  }

  function position(block: Element) {
    if (!trigger) return;
    const rect = block.getBoundingClientRect(), margin = 6, width = trigger.offsetWidth || 28, height = trigger.offsetHeight || 22;
    // Sit just before the block's first line; spill to the right edge only when there is no gutter on the left.
    const outsideLeft = rect.left - width - margin, outsideRight = rect.right + margin;
    const left = outsideLeft >= margin ? outsideLeft : outsideRight + width <= window.innerWidth - margin ? outsideRight : rect.left + margin;
    const top = Math.max(margin, Math.min(rect.top + Math.max(0, (Math.min(rect.height, height * 1.5) - height) / 2), window.innerHeight - height - margin));
    style(trigger, { left: `${left}px`, top: `${top}px` });
  }

  function currentRuntime() {
    const route = parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
    return route ? runtimes.get(route.serverId) : undefined;
  }

  function show(block: Element) {
    if (!currentRuntime()) { hide(); return; }
    if (!trigger) {
      trigger = button(ui('Translate', '译'), ui('Translate this block', '翻译这一段'));
      trigger.dataset.paseoTranslate = 'block-trigger';
      style(trigger, { position: 'fixed', zIndex: '2147483000', padding: '2px 7px', boxShadow: '0 4px 14px rgba(0,0,0,.28)' });
      trigger.addEventListener('pointerdown', event => event.preventDefault());
      trigger.addEventListener('click', () => {
        const runtime = currentRuntime();
        if (!hovered || !runtime) return;
        // Collapsing keeps the translation so expanding again does not repeat the request; × discards it.
        const existing = existingTranslation(hovered);
        if (existing && !('paseoTranslateError' in existing.dataset)) setCollapsed(existing, !isCollapsed(existing)); else void translateBlock(hovered, runtime);
        syncTrigger(hovered);
      });
      document.body.append(trigger);
    }
    hovered = block;
    syncTrigger(block);
    position(block);
  }

  /** Keep the trigger while the pointer crosses the gap between the block and the button. */
  function nearHovered(x: number, y: number) {
    if (!hovered || !trigger) return false;
    const slack = 12, block = hovered.getBoundingClientRect(), own = trigger.getBoundingClientRect();
    const reach = own.width + slack * 2;
    return (x >= block.left - reach && x <= block.right + reach && y >= block.top - slack && y <= block.bottom + slack)
      || (x >= own.left - slack && x <= own.right + slack && y >= own.top - slack && y <= own.bottom + slack);
  }

  const pointerMove = (event: PointerEvent) => {
    if (trigger?.contains(event.target as Node | null)) return;
    const element = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    // User messages must dismiss the button even inside the gap tolerance around an AI reply.
    if (element?.closest('[data-testid="user-message"]')) { hide(); return; }
    const block = hoveredBlock(element);
    if (!block) { if (!nearHovered(event.clientX, event.clientY)) hide(); return; }
    if (block !== hovered) show(block);
  };
  const pointerLeave = () => hide();
  document.addEventListener('pointermove', pointerMove, { passive: true });
  document.addEventListener('pointerleave', pointerLeave);
  document.addEventListener('scroll', pointerLeave, true);
  window.addEventListener('resize', pointerLeave);

  return {
    dispose() {
      request++;
      hide();
      document.removeEventListener('pointermove', pointerMove);
      document.removeEventListener('pointerleave', pointerLeave);
      document.removeEventListener('scroll', pointerLeave, true);
      window.removeEventListener('resize', pointerLeave);
      document.querySelectorAll('[data-paseo-translate-block]').forEach(panel => panel.remove());
    },
  };
}
