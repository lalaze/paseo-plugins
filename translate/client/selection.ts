import type { PluginClientContext } from '@getpaseo/plugin/client';
import { settingsRpc } from '@getpaseo/plugin';
import { parseConversationRoute } from './route';
import { translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { translationSettings, validateTranslationSettings } from '../shared/settings';

type Runtime = { translate(text: string, target: TargetLanguage): Promise<TranslationResult> };
type SelectionSnapshot = { text: string; rect: DOMRect; route: { serverId: string }; message?: Element; anchor?: Element; range?: Range; selectionKey?: string };
type OverlayController = { refresh(): void; dispose(): void };
type Registry = { readonly closed: boolean; register(serverId: string, runtime: Runtime): () => void };
type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): boolean };
type HighlightConstructor = new (...ranges: Range[]) => unknown;
type DraftUndo = { editor: HTMLElement; before: string; after: string };

const REGISTRY_KEY = Symbol.for('lalaze.paseo-translate.registry.v1');
const HIGHLIGHT_NAME = 'paseo-translate-selection';

function elementFor(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function selectedMessage(selection: Selection): Element | null {
  const start = elementFor(selection.anchorNode), end = elementFor(selection.focusNode);
  if (start?.closest('[data-paseo-translate-annotation]') || end?.closest('[data-paseo-translate-annotation]')) return null;
  const messageSelector = '[data-testid="assistant-message"], [data-testid="user-message"]';
  const message = start?.closest(messageSelector) ?? null;
  const chat = message?.closest('[data-testid="agent-chat-scroll"]') ?? null;
  return chat && end?.closest('[data-testid="agent-chat-scroll"]') === chat && end.closest(messageSelector) === message ? message : null;
}

function selectionRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0);
  return rects.at(-1) ?? range.getBoundingClientRect();
}

function readSelection(): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const message = selectedMessage(selection);
  if (!message) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const route = parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
  if (!route) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const selectedElement = elementFor(range.startContainer);
  const block = selectedElement?.closest('p, li, pre, blockquote');
  const anchor = block && message.contains(block) ? block : message;
  const before = document.createRange(); before.selectNodeContents(message); before.setEnd(range.startContainer, range.startOffset);
  return { text, route, message, anchor, range, selectionKey: `${before.toString().length}:${range.toString().length}`, rect: selectionRect(range) };
}

function style(element: HTMLElement, values: Partial<CSSStyleDeclaration>) { Object.assign(element.style, values); }
function button(label: string, title = label) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.title = title;
  style(element, { border: '1px solid #3f3f46', borderRadius: '7px', background: '#27272a', color: '#fafafa', padding: '6px 9px', cursor: 'pointer', font: '12px system-ui, sans-serif' });
  return element;
}

function place(element: HTMLElement, rect: DOMRect, width = 0) {
  const margin = 8, measured = width || element.offsetWidth || 80;
  const left = Math.min(Math.max(margin, rect.right - measured), window.innerWidth - measured - margin);
  const below = rect.bottom + margin;
  const top = below + element.offsetHeight < window.innerHeight ? below : Math.max(margin, rect.top - element.offsetHeight - margin);
  style(element, { left: `${left}px`, top: `${top}px` });
}

function visibleEditor(element: HTMLElement) {
  if (element.closest('[data-paseo-translate]')) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    if (element.disabled || element.readOnly) return false;
  } else if (!element.isContentEditable) return false;
  const rect = element.getBoundingClientRect(), computed = window.getComputedStyle(element);
  return rect.width >= 160 && rect.height >= 24 && rect.bottom > window.innerHeight * .45 && computed.display !== 'none' && computed.visibility !== 'hidden';
}

function findComposer(): HTMLElement | null {
  const preferred = '[data-testid*="composer"] textarea, [data-testid*="composer"] [contenteditable="true"], textarea[placeholder*="@files"], textarea[placeholder*="/commands"], [data-testid="agent-chat-input"], [data-testid="agent-composer-input"]';
  const fallback = 'textarea, input[type="text"], [contenteditable="true"][role="textbox"]';
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(preferred)).filter(visibleEditor);
  const pool = candidates.length ? candidates : Array.from(document.querySelectorAll<HTMLElement>(fallback)).filter(visibleEditor);
  return pool.sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom || right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0] ?? null;
}

function editorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return editor.value;
  return editor.innerText.replace(/\u00a0/g, ' ');
}

function replaceEditorText(editor: HTMLElement, text: string) {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(editor, text); else editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    editor.setSelectionRange(text.length, text.length);
    return;
  }
  const selection = window.getSelection(), range = document.createRange();
  range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!inserted) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
  }
  range.selectNodeContents(editor); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
}

export function createOverlayController(runtimes: Map<string, Runtime>): OverlayController {
  let trigger: HTMLButtonElement | null = null, launcher: HTMLButtonElement | null = null, launcherTimer: number | undefined, draftUndo: DraftUndo | null = null, composerRequest = 0, composerBusy = false, writingComposer = false, inlineRequest = 0;
  const highlightedRanges = new Map<HTMLElement, Range>();
  const annotationGroups = new WeakMap<Element, HTMLElement>();
  const removeTrigger = () => { trigger?.remove(); trigger = null; };
  const clearLauncherTimer = () => { if (launcherTimer !== undefined) { window.clearTimeout(launcherTimer); launcherTimer = undefined; } };
  const removeLauncher = () => { clearLauncherTimer(); launcher?.remove(); launcher = null; };

  function syncHighlights() {
    const css = globalThis.CSS as typeof CSS & { highlights?: HighlightRegistry };
    const HighlightClass = (globalThis as typeof globalThis & { Highlight?: HighlightConstructor }).Highlight;
    if (!css?.highlights || !HighlightClass) return;
    for (const [annotation, range] of highlightedRanges) if (!annotation.isConnected) highlightedRanges.delete(annotation);
    if (!highlightedRanges.size) { css.highlights.delete(HIGHLIGHT_NAME); return; }
    if (!document.querySelector('[data-paseo-translate-highlight-style]')) {
      const highlightStyle = document.createElement('style'); highlightStyle.dataset.paseoTranslateHighlightStyle = '';
      highlightStyle.textContent = `::highlight(${HIGHLIGHT_NAME}) { background: rgba(59, 130, 246, .38); color: inherit; }`;
      document.head.append(highlightStyle);
    }
    css.highlights.set(HIGHLIGHT_NAME, new HighlightClass(...highlightedRanges.values()));
  }

  function persistAnnotation(snapshot: SelectionSnapshot, text: string, error = false): HTMLElement | null {
    const { message, anchor, range, selectionKey } = snapshot;
    if (!message?.isConnected || !range || !selectionKey) return null;
    const existing = Array.from(message.querySelectorAll<HTMLElement>('[data-paseo-translate-annotation]')).find(node => node.dataset.paseoTranslateKey === selectionKey);
    const annotation = existing ?? document.createElement('div');
    if (!existing) {
      annotation.dataset.paseoTranslateAnnotation = ''; annotation.dataset.paseoTranslateKey = selectionKey;
      style(annotation, { display: 'inline-flex', alignItems: 'center', gap: '5px', maxWidth: '100%', padding: '3px 6px', border: '1px solid rgba(96,165,250,.24)', borderRadius: '6px', background: 'rgba(59,130,246,.10)', color: '#e4e4e7', font: '12px/1.45 system-ui, sans-serif' });
      const source = document.createElement('span'); source.dataset.paseoTranslateSource = '';
      style(source, { flex: '0 1 auto', padding: '0 5px', borderRadius: '4px', background: 'rgba(59,130,246,.32)', color: '#dbeafe', overflowWrap: 'anywhere' });
      const arrow = document.createElement('span'); arrow.textContent = '→'; arrow.setAttribute('aria-hidden', 'true'); style(arrow, { color: '#93c5fd' });
      const output = document.createElement('span'); output.dataset.paseoTranslateOutput = ''; style(output, { flex: '1', minWidth: '0', overflowWrap: 'anywhere' });
      const remove = button('×', '移除这条翻译'); style(remove, { flex: '0 0 auto', padding: '0 5px', border: '0', background: 'transparent', color: '#a1a1aa', fontSize: '15px', lineHeight: '1.3' });
      remove.addEventListener('click', () => {
        const group = annotation.parentElement; highlightedRanges.delete(annotation); annotation.remove();
        if (group?.matches('[data-paseo-translate-group]') && !group.childElementCount) group.remove();
        syncHighlights();
      });
      annotation.append(source, arrow, output, remove);
      const groupAnchor = anchor ?? message;
      let group = annotationGroups.get(groupAnchor);
      if (!group?.isConnected) {
        group = document.createElement('div'); group.dataset.paseoTranslateGroup = '';
        style(group, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px', marginTop: '6px' });
        annotationGroups.set(groupAnchor, group);
        if (groupAnchor !== message && !groupAnchor.matches('li')) groupAnchor.insertAdjacentElement('afterend', group);
        else groupAnchor.append(group);
      }
      group.append(annotation);
    }
    const source = annotation.querySelector<HTMLElement>('[data-paseo-translate-source]');
    const output = annotation.querySelector<HTMLElement>('[data-paseo-translate-output]');
    if (source) source.textContent = snapshot.text;
    if (output) { output.textContent = text; output.style.color = error ? '#fca5a5' : '#e4e4e7'; }
    highlightedRanges.set(annotation, range); syncHighlights();
    return annotation;
  }

  async function translateInline(snapshot: SelectionSnapshot, runtime: Runtime) {
    const sequence = String(++inlineRequest);
    const annotation = persistAnnotation(snapshot, '正在翻译…');
    if (!annotation) return;
    annotation.dataset.paseoTranslateRequest = sequence;
    try {
      const result = await runtime.translate(snapshot.text, 'auto');
      if (!annotation.isConnected || annotation.dataset.paseoTranslateRequest !== sequence) return;
      persistAnnotation(snapshot, result.translation);
    } catch (error) {
      if (!annotation.isConnected || annotation.dataset.paseoTranslateRequest !== sequence) return;
      persistAnnotation(snapshot, error instanceof Error ? error.message : String(error), true);
    }
  }

  function currentRoute() {
    return parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
  }

  function setLauncherState(label: string, title: string, busy = false) {
    if (!launcher) return;
    launcher.textContent = label; launcher.title = title; launcher.disabled = busy; launcher.setAttribute('aria-busy', String(busy));
    style(launcher, { cursor: busy ? 'wait' : 'pointer', opacity: busy ? '.65' : '1' });
  }

  function resetLauncher() {
    clearLauncherTimer(); setLauncherState('译', '翻译当前聊天输入并替换原文（Alt/Option + T）');
  }

  function temporaryLauncherState(label: string, title: string) {
    clearLauncherTimer(); setLauncherState(label, title);
    launcherTimer = window.setTimeout(() => { launcherTimer = undefined; if (!draftUndo && !composerBusy) resetLauncher(); }, 1800);
  }

  function positionLauncher() {
    if (!launcher) return;
    const editor = findComposer(), rect = editor?.getBoundingClientRect();
    if (!rect) { style(launcher, { right: '18px', bottom: '82px', left: 'auto', top: 'auto' }); return; }
    style(launcher, { right: `${Math.max(8, window.innerWidth - rect.right + 8)}px`, bottom: `${Math.max(8, window.innerHeight - rect.top + 6)}px`, left: 'auto', top: 'auto' });
  }

  async function translateComposer() {
    if (composerBusy) return;
    const editor = findComposer();
    if (!editor) { temporaryLauncherState('未找到', '没有找到当前聊天输入框'); return; }
    if (draftUndo?.editor === editor && editorText(editor) === draftUndo.after) {
      writingComposer = true;
      try { replaceEditorText(editor, draftUndo.before); }
      finally { writingComposer = false; draftUndo = null; }
      temporaryLauncherState('已撤销', '已恢复翻译前的草稿');
      return;
    }
    draftUndo = null;
    const route = currentRoute(), runtime = route ? runtimes.get(route.serverId) : undefined;
    if (!runtime) { temporaryLauncherState('不可用', '当前对话没有可用的翻译服务'); return; }
    const original = editorText(editor), source = original.trim();
    if (!source) { temporaryLauncherState('空', '请先在聊天输入框中输入文字'); return; }
    if (source.length > 5000) { temporaryLauncherState('过长', '输入内容超过 5000 字符'); return; }
    const sequence = ++composerRequest; composerBusy = true; clearLauncherTimer(); setLauncherState('翻译中…', '正在翻译当前草稿', true);
    try {
      const result = await runtime.translate(source, 'auto');
      if (sequence !== composerRequest || !editor.isConnected) return;
      if (editorText(editor) !== original) { temporaryLauncherState('已取消', '翻译期间草稿发生变化，未覆盖新内容'); return; }
      writingComposer = true;
      try { replaceEditorText(editor, result.translation); }
      finally { writingComposer = false; }
      draftUndo = { editor, before: original, after: result.translation };
      setLauncherState('撤销', '恢复翻译前的草稿');
    } catch (error) {
      if (sequence === composerRequest) temporaryLauncherState('失败', error instanceof Error ? error.message : String(error));
    } finally {
      if (sequence === composerRequest) composerBusy = false;
    }
  }

  function refreshLauncher() {
    const route = currentRoute();
    if (!route || !runtimes.has(route.serverId)) { removeLauncher(); return; }
    if (launcher) { positionLauncher(); return; }
    launcher = button('译', '翻译当前聊天输入并替换原文（Alt/Option + T）'); launcher.dataset.paseoTranslate = 'launcher';
    style(launcher, { position: 'fixed', zIndex: '2147482999', minWidth: '34px', boxShadow: '0 6px 20px rgba(0,0,0,.28)' });
    launcher.addEventListener('pointerdown', event => event.preventDefault());
    launcher.addEventListener('click', () => { void translateComposer(); });
    document.body.append(launcher); positionLauncher();
  }

  function showTrigger(snapshot: SelectionSnapshot) {
    removeTrigger();
    const runtime = runtimes.get(snapshot.route.serverId);
    if (!runtime) return;
    trigger = button('翻译', '翻译选中的文字');
    trigger.dataset.paseoTranslate = 'trigger';
    style(trigger, { position: 'fixed', zIndex: '2147483000', boxShadow: '0 6px 20px rgba(0,0,0,.28)' });
    trigger.addEventListener('pointerdown', event => event.preventDefault());
    trigger.addEventListener('click', () => { removeTrigger(); void translateInline(snapshot, runtime); });
    document.body.append(trigger); place(trigger, snapshot.rect);
  }

  function refresh() {
    refreshLauncher();
    const snapshot = readSelection();
    if (snapshot) showTrigger(snapshot); else removeTrigger();
  }
  const delayedRefresh = () => { window.setTimeout(refresh, 0); };
  const outside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (trigger?.contains(target) || launcher?.contains(target)) return;
    removeTrigger();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 't' && !event.isComposing) { event.preventDefault(); void translateComposer(); }
    else if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) removeTrigger();
  };
  const inputChanged = (event: Event) => {
    if (writingComposer || !draftUndo) return;
    const target = event.target as Node | null;
    if (target === draftUndo.editor || (target && draftUndo.editor.contains(target))) { draftUndo = null; resetLauncher(); }
  };
  const dismiss = () => { removeTrigger(); positionLauncher(); };
  const routeChanged = () => { composerRequest++; composerBusy = false; draftUndo = null; removeTrigger(); refreshLauncher(); resetLauncher(); };
  document.addEventListener('pointerup', delayedRefresh); document.addEventListener('keyup', delayedRefresh); document.addEventListener('touchend', delayedRefresh);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown); document.addEventListener('input', inputChanged, true); window.addEventListener('resize', dismiss); window.addEventListener('popstate', routeChanged); window.addEventListener('hashchange', routeChanged); document.addEventListener('scroll', removeTrigger, true);
  return { refresh, dispose() { composerRequest++; dismiss(); removeLauncher(); for (const annotation of highlightedRanges.keys()) annotation.remove(); document.querySelectorAll('[data-paseo-translate-group]').forEach(group => group.remove()); highlightedRanges.clear(); syncHighlights(); document.querySelector('[data-paseo-translate-highlight-style]')?.remove(); document.removeEventListener('pointerup', delayedRefresh); document.removeEventListener('keyup', delayedRefresh); document.removeEventListener('touchend', delayedRefresh); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown); document.removeEventListener('input', inputChanged, true); window.removeEventListener('resize', dismiss); window.removeEventListener('popstate', routeChanged); window.removeEventListener('hashchange', routeChanged); document.removeEventListener('scroll', removeTrigger, true); } };
}

function createRegistry(): Registry {
  const runtimes = new Map<string, Runtime>();
  const overlay = typeof document === 'undefined' ? null : createOverlayController(runtimes);
  let closed = false;
  return {
    get closed() { return closed; },
    register(serverId, runtime) {
      if (closed) throw new Error('Translation client registry is closed');
      runtimes.set(serverId, runtime); overlay?.refresh();
      return () => {
        if (runtimes.get(serverId) === runtime) runtimes.delete(serverId);
        if (!runtimes.size && !closed) { closed = true; overlay?.dispose(); }
      };
    },
  };
}

export function registerTranslationClient(serverId: string, client: PluginClientContext) {
  const shared = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  const registry = !shared[REGISTRY_KEY] || shared[REGISTRY_KEY].closed ? shared[REGISTRY_KEY] = createRegistry() : shared[REGISTRY_KEY];
  const contracts = settingsRpc(translationSettings.id);
  return registry.register(serverId, {
    translate: async (text, target) => {
      const saved = await client.rpc(contracts.read, {});
      if (saved.status !== 'ready') throw new Error(`翻译 API 设置无法读取：${saved.error}`);
      let settings;
      try { settings = validateTranslationSettings(translationSettings.schema.parse(saved.values)); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}；请点击“设置”完成配置`); }
      return client.rpc(translateSelectionRpc, { text, target, settings });
    },
  });
}
