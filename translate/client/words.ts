import { button, FLOATING_CONTROL_Z_INDEX, style } from './dom';
import { localizeTranslationError, ui } from './i18n';
import { parseConversationRoute } from './route';
import { subscribeWordTranslation, wordTranslationEnabled } from './word-preference';
import type { TargetLanguage, TranslationResult } from '../shared/rpc';

type Runtime = {
  translate(text: string, target: TargetLanguage): Promise<TranslationResult>;
  translateWord?(text: string): Promise<TranslationResult>;
};
const MESSAGE = '[data-testid="assistant-message"], [data-testid="user-message"]';
const EXCLUDED = 'a, button, input, textarea, select, pre, code, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"]), [data-paseo-markdown-tag="a"], [data-paseo-markdown-tag="pre"], [data-paseo-markdown-tag="code"], [data-paseo-translate], [data-paseo-translate-group], [data-paseo-translate-annotation], [data-paseo-translate-block], [hidden], [aria-hidden="true"]';
const BLOCK = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, [data-paseo-markdown-tag="p"], [data-paseo-markdown-tag="li"], [data-paseo-markdown-tag="blockquote"], [data-paseo-markdown-tag^="h"]';
type Word = { text: string; range: Range; rect: DOMRect; message: Element };
const WORD_HIGHLIGHT = 'paseo-translate-word';

/** Paint the lookup word without creating a browser selection or rewriting message nodes. */
function highlightWord(range: Range): () => void {
  const browser = window as unknown as {
    CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  const highlights = browser.CSS?.highlights;
  if (highlights && browser.Highlight) {
    const sheet = document.createElement('style');
    sheet.textContent = `::highlight(${WORD_HIGHLIGHT}) { background-color: rgba(96,165,250,.22); text-decoration: underline; text-decoration-color: rgba(96,165,250,.65); }`;
    document.head.append(sheet);
    highlights.set(WORD_HIGHLIGHT, new browser.Highlight(range));
    return () => { highlights.delete(WORD_HIGHLIGHT); sheet.remove(); };
  }
  const marks = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => {
    const mark = document.createElement('span'); mark.dataset.paseoTranslate = 'word-highlight';
    mark.setAttribute('aria-hidden', 'true');
    style(mark, { position: 'fixed', zIndex: FLOATING_CONTROL_Z_INDEX, pointerEvents: 'none', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: '2px', background: 'rgba(96,165,250,.18)', boxShadow: 'inset 0 -1px rgba(96,165,250,.65)' });
    document.body.append(mark); return mark;
  });
  return () => marks.forEach(mark => mark.remove());
}

/** Keep Latin-script neighbours in the token so café never becomes caf. CJK is a boundary. */
export function englishWordAt(text: string, offset: number): { text: string; start: number; end: number } | null {
  const tokens = /[\p{Script=Latin}\p{M}\p{N}_]+(?:['’\-‐‑][\p{Script=Latin}\p{M}\p{N}_]+)*/gu;
  for (const match of text.matchAll(tokens)) {
    const start = match.index!, end = start + match[0].length;
    if (offset < start || offset > end) continue;
    if (!/^[a-z]+(?:['’\-‐‑][a-z]+)*$/i.test(match[0])) return null;
    // Do not extract Latin fragments from identifiers written in another alphabet.
    if (/[\p{L}\p{M}]/u.test(text[start - 1] ?? '') && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text[start - 1])) return null;
    if (/[\p{L}\p{M}]/u.test(text[end] ?? '') && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text[end])) return null;
    return { text: match[0], start, end };
  }
  return null;
}

export function wordAtPoint(target: Element, x: number, y: number): Word | null {
  if (target.closest(EXCLUDED)) return null;
  const message = target.closest(MESSAGE);
  if (!message?.closest('[data-testid="agent-chat-scroll"]')) return null;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y);
  const fallback = !caret ? doc.caretRangeFromPoint?.(x, y) : null;
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE || offset === undefined || !message.contains(node) || node.parentElement?.closest(EXCLUDED)) return null;
  const candidate = node.parentElement?.closest(BLOCK);
  const block = candidate && message.contains(candidate) ? candidate : message;
  const parts: { node: Text; start: number; end: number }[] = [];
  let text = '', position = -1;
  // Read across inline Markdown (e.g. un<strong>believ</strong>able) without rewriting React's DOM.
  function collect(current: Node) {
    if (current.nodeType === Node.TEXT_NODE) {
      const start = text.length;
      text += current.textContent ?? '';
      parts.push({ node: current as Text, start, end: text.length });
      if (current === node) position = start + offset!;
    } else if (current instanceof Element) {
      if (current.matches(EXCLUDED) || current.matches('br')) { text += ' '; return; }
      const boundary = current !== block && current.matches(BLOCK);
      if (boundary) text += ' ';
      current.childNodes.forEach(collect);
      if (boundary) text += ' ';
    }
  }
  collect(block);
  const word = position >= 0 ? englishWordAt(text, position) : null;
  if (!word) return null;
  const start = parts.find(part => part.start <= word.start && part.end > word.start);
  const end = parts.find(part => part.start < word.end && part.end >= word.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, word.start - start.start);
  range.setEnd(end.node, word.end - end.start);
  // Caret APIs may return the nearest text when clicking a margin or inter-word space.
  const rect = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  return rect ? { text: word.text, range, rect, message } : null;
}

/** Per-host, bounded cache; settings changes invalidate both results and pending request reuse. */
export function createWordCache() {
  let configuration = '';
  const entries = new Map<string, Promise<TranslationResult>>();
  return (settings: string, word: string, request: () => Promise<TranslationResult>) => {
    if (configuration !== settings) { entries.clear(); configuration = settings; }
    const cached = entries.get(word);
    if (cached) return cached;
    const pending = Promise.resolve().then(request).catch(error => {
      if (entries.get(word) === pending) entries.delete(word);
      throw error;
    });
    entries.set(word, pending);
    if (entries.size > 100) entries.delete(entries.keys().next().value!);
    return pending;
  };
}

export function createWordTranslator(runtimes: Map<string, Runtime>) {
  let bubble: HTMLElement | null = null, timer: number | undefined, sequence = 0;
  let enabled = wordTranslationEnabled(), clearHighlight = () => {};
  let down: { x: number; y: number; target: EventTarget | null } | null = null;
  let active: { word: Word; url: string; runtime: Runtime; serverId: string } | null = null;
  const selectionActive = () => { const selection = window.getSelection(); return Boolean(selection && !selection.isCollapsed); };
  function dismiss() {
    sequence++;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined; bubble?.remove(); bubble = null; active = null;
    clearHighlight(); clearHighlight = () => {};
  }
  function valid() {
    return Boolean(enabled && active && active.url === window.location.href && active.word.message.isConnected && active.word.range.startContainer.isConnected && active.word.range.toString() === active.word.text && runtimes.get(active.serverId) === active.runtime);
  }
  function place(rect: DOMRect) {
    if (!bubble) return;
    const width = bubble.offsetWidth, height = bubble.offsetHeight;
    style(bubble, {
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
      top: `${rect.bottom + 8 + height <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)}px`,
    });
  }
  const pointerdown = (event: PointerEvent) => {
    if (bubble?.contains(event.target as Node)) return;
    dismiss();
    // Capture this before the browser collapses an existing selection on mousedown.
    down = enabled && !selectionActive() && event.button === 0 && (!event.pointerType || event.pointerType === 'mouse')
      ? { x: event.clientX, y: event.clientY, target: event.target } : null;
  };
  const pointermove = (event: PointerEvent) => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down = null;
  };
  const click = (event: MouseEvent) => {
    if (bubble?.contains(event.target as Node)) return;
    const origin = down; down = null;
    if (!enabled || !origin || event.defaultPrevented || event.button !== 0 || event.detail !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || selectionActive()) return;
    if (origin.target !== event.target || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4 || !(event.target instanceof Element)) return;
    if (document.querySelector('[aria-modal="true"]:not([data-state="closed"])')) return;
    const route = parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
    const runtime = route && runtimes.get(route.serverId);
    if (!route || !runtime) return;
    const word = wordAtPoint(event.target, event.clientX, event.clientY);
    if (!word) return;
    dismiss();
    active = { word, runtime, serverId: route.serverId, url: window.location.href };
    const request = sequence;
    clearHighlight = highlightWord(word.range);
    // Only the unobtrusive highlight appears immediately. A second click cancels
    // the bubble itself as well as the API request, so double-click copying never flashes a popup.
    timer = window.setTimeout(async () => {
      timer = undefined;
      if (!valid() || selectionActive()) { dismiss(); return; }
      bubble = document.createElement('div'); bubble.dataset.paseoTranslate = 'word';
      bubble.setAttribute('role', 'dialog'); bubble.setAttribute('aria-label', ui(`Translate ${word.text}`, `翻译 ${word.text}`));
      style(bubble, { position: 'fixed', zIndex: FLOATING_CONTROL_Z_INDEX, width: '260px', maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(320px, calc(100vh - 16px))', overflowY: 'auto', boxSizing: 'border-box', padding: '12px 32px 12px 12px', border: '1px solid #3f3f46', borderRadius: '10px', background: '#18181b', color: '#fafafa', boxShadow: '0 6px 24px rgba(0,0,0,.3)', font: '14px/1.5 system-ui, sans-serif', overflowWrap: 'anywhere' });
      const source = document.createElement('strong'); source.textContent = word.text; style(source, { color: '#93c5fd' });
      const output = document.createElement('div'); output.setAttribute('role', 'status'); output.textContent = ui('Translating…', '正在翻译…'); style(output, { marginTop: '6px', whiteSpace: 'pre-wrap' });
      const close = button('×', ui('Close translation', '关闭翻译')); close.setAttribute('aria-label', close.title); style(close, { position: 'absolute', right: '6px', top: '6px', padding: '0 5px', border: '0', background: 'transparent' }); close.addEventListener('click', dismiss);
      bubble.append(source, output, close); document.body.append(bubble); place(word.rect);
      try {
        const result = await (runtime.translateWord?.(word.text) ?? runtime.translate(word.text, 'zh-CN'));
        if (request !== sequence) return;
        if (!valid()) { dismiss(); return; }
        output.textContent = result.translation;
      } catch (error) {
        if (request !== sequence) return;
        if (!valid()) { dismiss(); return; }
        output.textContent = localizeTranslationError(error); output.style.color = '#fca5a5';
      }
      place(word.rect);
    }, 300);
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
  const selectionchange = () => { if (selectionActive() && !bubble?.contains(window.getSelection()?.anchorNode ?? null)) dismiss(); };
  const scroll = (event: Event) => { if (!(event.target instanceof Node) || !bubble?.contains(event.target)) { down = null; dismiss(); } };
  const cancel = () => { down = null; dismiss(); };
  const unsubscribePreference = subscribeWordTranslation(value => { enabled = value; cancel(); });
  const observer = new MutationObserver(() => { if (active && !valid()) dismiss(); });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  document.addEventListener('pointerdown', pointerdown, true);
  document.addEventListener('pointermove', pointermove, { passive: true, capture: true });
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('click', click);
  document.addEventListener('keydown', keydown);
  document.addEventListener('selectionchange', selectionchange);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', cancel);
  window.addEventListener('popstate', cancel);
  window.addEventListener('hashchange', cancel);
  return { dismiss, dispose() {
    dismiss(); observer.disconnect(); unsubscribePreference();
    document.removeEventListener('pointerdown', pointerdown, true);
    document.removeEventListener('pointermove', pointermove, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('click', click);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('selectionchange', selectionchange);
    document.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', cancel);
    window.removeEventListener('popstate', cancel);
    window.removeEventListener('hashchange', cancel);
  } };
}
