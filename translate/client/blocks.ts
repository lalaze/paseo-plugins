import type { TargetLanguage, TranslationResult } from '../shared/rpc';
import { parseConversationRoute } from './route';
import { button, style } from './dom';

type Runtime = { translate(text: string, target: TargetLanguage): Promise<TranslationResult> };
type BlockTranslator = { dispose(): void };

const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6';
const MESSAGE_SELECTOR = '[data-testid="assistant-message"], [data-testid="user-message"]';
const PLUGIN_SELECTOR = '[data-paseo-translate-group], [data-paseo-translate-block], [data-paseo-translate]';
const MAX_BLOCK_CHARS = 5000;

/** Hoverable markdown block inside a chat message, excluding the plugin's own nodes. */
function hoveredBlock(target: EventTarget | null): Element | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element || element.closest(PLUGIN_SELECTOR)) return null;
  const block = element.closest(BLOCK_SELECTOR);
  if (!block || block.closest('pre') || !block.closest(MESSAGE_SELECTOR)?.closest('[data-testid="agent-chat-scroll"]')) return null;
  return block;
}

/** Own text of the block: nested lists and earlier translations are left out. */
export function blockText(block: Element): string {
  const clone = block.cloneNode(true) as Element;
  clone.querySelectorAll('ul, ol, [data-paseo-translate-group], [data-paseo-translate-block]').forEach(node => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function existingTranslation(block: Element): HTMLElement | null {
  const inside = block.querySelector<HTMLElement>(':scope > [data-paseo-translate-block]');
  const after = block.nextElementSibling;
  return inside ?? (after instanceof HTMLElement && after.matches('[data-paseo-translate-block]') ? after : null);
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
      const remove = button('×', '移除这段译文');
      style(remove, { flex: '0 0 auto', padding: '0 5px', border: '0', background: 'transparent', color: '#a1a1aa', fontSize: '15px', lineHeight: '1.3' });
      remove.addEventListener('click', () => { panel?.remove(); if (hovered === block) syncTrigger(block); });
      panel.append(body, remove);
      if (block.matches('li')) block.append(panel); else block.insertAdjacentElement('afterend', panel);
    }
    const body = panel.querySelector<HTMLElement>('[data-paseo-translate-block-text]');
    if (body) { body.textContent = text; body.style.color = error ? '#fca5a5' : '#e4e4e7'; }
    return panel;
  }

  async function translateBlock(block: Element, runtime: Runtime) {
    const text = blockText(block).slice(0, MAX_BLOCK_CHARS);
    if (!text) return;
    const sequence = String(++request);
    const panel = renderTranslation(block, '正在翻译…');
    panel.dataset.paseoTranslateRequest = sequence;
    try {
      const result = await runtime.translate(text, 'auto');
      if (!panel.isConnected || panel.dataset.paseoTranslateRequest !== sequence) return;
      renderTranslation(block, result.translation);
    } catch (error) {
      if (!panel.isConnected || panel.dataset.paseoTranslateRequest !== sequence) return;
      renderTranslation(block, error instanceof Error ? error.message : String(error), true);
    }
  }

  function syncTrigger(block: Element) {
    if (!trigger) return;
    const translated = Boolean(existingTranslation(block));
    trigger.textContent = translated ? '收起' : '译';
    trigger.title = translated ? '移除这段译文' : '翻译这一段';
  }

  function position(block: Element) {
    if (!trigger) return;
    const rect = block.getBoundingClientRect(), margin = 6, width = trigger.offsetWidth || 28, height = trigger.offsetHeight || 22;
    const outsideRight = rect.right + margin, outsideLeft = rect.left - width - margin;
    const left = outsideRight + width <= window.innerWidth - margin ? outsideRight : outsideLeft >= margin ? outsideLeft : rect.right - width - margin;
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
      trigger = button('译', '翻译这一段');
      trigger.dataset.paseoTranslate = 'block-trigger';
      style(trigger, { position: 'fixed', zIndex: '2147483000', padding: '2px 7px', boxShadow: '0 4px 14px rgba(0,0,0,.28)' });
      trigger.addEventListener('pointerdown', event => event.preventDefault());
      trigger.addEventListener('click', () => {
        const runtime = currentRuntime();
        if (!hovered || !runtime) return;
        const existing = existingTranslation(hovered);
        if (existing) existing.remove(); else void translateBlock(hovered, runtime);
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
    const block = hoveredBlock(event.target);
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
