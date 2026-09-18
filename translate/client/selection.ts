import type { PluginClientContext } from '@getpaseo/plugin/client';
import { settingsRpc } from '@getpaseo/plugin';
import { parseConversationRoute } from './route';
import { translateSelectionRpc, type TargetLanguage, type TranslationResult } from '../shared/rpc';
import { translationSettings, validateTranslationSettings } from '../shared/settings';

type Runtime = { translate(text: string, target: TargetLanguage): Promise<TranslationResult>; configure(): void };
type SelectionSnapshot = { text: string; rect: DOMRect; route: { serverId: string } };
type OverlayController = { refresh(): void; dispose(): void };
type Registry = { readonly closed: boolean; register(serverId: string, runtime: Runtime): () => void };

const REGISTRY_KEY = Symbol.for('lalaze.paseo-translate.registry.v1');
const AUTO_TRANSLATE_DELAY_MS = 600;
const languageOptions: { value: TargetLanguage; label: string }[] = [
  { value: 'auto', label: '自动' }, { value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' }, { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' }, { value: 'es', label: 'Español' }, { value: 'ru', label: 'Русский' },
];

function elementFor(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function selectedMessage(selection: Selection): Element | null {
  const start = elementFor(selection.anchorNode), end = elementFor(selection.focusNode);
  const messageSelector = '[data-testid="assistant-message"], [data-testid="user-message"]';
  const message = start?.closest(messageSelector) ?? null;
  const chat = message?.closest('[data-testid="agent-chat-scroll"]') ?? null;
  return chat && end?.closest('[data-testid="agent-chat-scroll"]') === chat && end.closest(messageSelector) ? message : null;
}

function selectionRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0);
  return rects.at(-1) ?? range.getBoundingClientRect();
}

function readSelection(): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selectedMessage(selection)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const route = parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
  if (!route) return null;
  return { text, route, rect: selectionRect(selection.getRangeAt(0)) };
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

export function createOverlayController(runtimes: Map<string, Runtime>): OverlayController {
  let trigger: HTMLButtonElement | null = null, launcher: HTMLButtonElement | null = null, card: HTMLDivElement | null = null, translateTimer: number | undefined, request = 0;
  const removeTrigger = () => { trigger?.remove(); trigger = null; };
  const removeLauncher = () => { launcher?.remove(); launcher = null; };
  const cancelScheduledTranslation = () => { if (translateTimer !== undefined) { window.clearTimeout(translateTimer); translateTimer = undefined; } };
  const closeCard = () => { request++; cancelScheduledTranslation(); card?.remove(); card = null; };

  function currentRoute() {
    return parseConversationRoute(window.location.pathname, window.location.search, window.location.hash);
  }

  function refreshLauncher() {
    const route = currentRoute();
    if (!route || !runtimes.has(route.serverId)) { removeLauncher(); return; }
    if (launcher) return;
    launcher = button('翻译输入', '输入或粘贴文字进行翻译'); launcher.dataset.paseoTranslate = 'launcher';
    style(launcher, { position: 'fixed', zIndex: '2147482999', right: '18px', bottom: '82px', boxShadow: '0 6px 20px rgba(0,0,0,.28)' });
    launcher.addEventListener('pointerdown', event => event.preventDefault());
    launcher.addEventListener('click', () => {
      const activeRoute = currentRoute(), activeLauncher = launcher;
      const runtime = activeRoute ? runtimes.get(activeRoute.serverId) : undefined;
      if (!activeRoute || !activeLauncher || !runtime) { refreshLauncher(); return; }
      const rect = activeLauncher.getBoundingClientRect();
      showCard({ text: '', rect, route: activeRoute }, runtime);
    });
    document.body.append(launcher);
  }

  function showTrigger(snapshot: SelectionSnapshot) {
    removeTrigger();
    const runtime = runtimes.get(snapshot.route.serverId);
    if (!runtime) return;
    trigger = button('翻译', '翻译选中的文字');
    trigger.dataset.paseoTranslate = 'trigger';
    style(trigger, { position: 'fixed', zIndex: '2147483000', boxShadow: '0 6px 20px rgba(0,0,0,.28)' });
    trigger.addEventListener('pointerdown', event => event.preventDefault());
    trigger.addEventListener('click', () => { removeTrigger(); showCard(snapshot, runtime); });
    document.body.append(trigger); place(trigger, snapshot.rect);
  }

  function showCard(snapshot: SelectionSnapshot, runtime: Runtime) {
    closeCard();
    card = document.createElement('div'); card.dataset.paseoTranslate = 'card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '划词翻译');
    style(card, { position: 'fixed', zIndex: '2147483000', width: 'min(400px, calc(100vw - 16px))', maxHeight: 'min(520px, calc(100vh - 16px))', overflow: 'auto', boxSizing: 'border-box', padding: '12px', border: '1px solid #3f3f46', borderRadius: '12px', background: '#18181b', color: '#fafafa', boxShadow: '0 16px 48px rgba(0,0,0,.38)', font: '13px/1.55 system-ui, sans-serif' });
    const header = document.createElement('div'); style(header, { display: 'flex', alignItems: 'center', gap: '8px' });
    const title = document.createElement('strong'); title.textContent = '划词翻译'; style(title, { flex: '1', fontSize: '13px' });
    const select = document.createElement('select'); select.setAttribute('aria-label', '目标语言');
    style(select, { background: '#27272a', color: '#fafafa', border: '1px solid #3f3f46', borderRadius: '7px', padding: '5px 7px', font: '12px system-ui, sans-serif' });
    for (const option of languageOptions) { const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; select.append(node); }
    const configure = button('设置', '配置翻译 API'); configure.addEventListener('click', () => { closeCard(); runtime.configure(); });
    const close = button('×', '关闭'); style(close, { padding: '4px 8px', fontSize: '16px', lineHeight: '1' }); close.addEventListener('click', closeCard);
    header.append(title, select, configure, close);
    const source = document.createElement('textarea'); source.value = snapshot.text; source.rows = 3; source.spellcheck = true;
    source.setAttribute('aria-label', '待翻译文本'); source.placeholder = '输入或粘贴要翻译的文字';
    style(source, { display: 'block', width: '100%', minHeight: '64px', maxHeight: '160px', boxSizing: 'border-box', marginTop: '10px', padding: '8px', resize: 'vertical', border: '1px solid #3f3f46', borderRadius: '7px', outline: 'none', background: '#27272a', color: '#f4f4f5', font: '12px/1.55 system-ui, sans-serif' });
    const status = document.createElement('div'); status.setAttribute('role', 'status'); style(status, { marginTop: '10px', color: '#a1a1aa' });
    const output = document.createElement('div'); style(output, { marginTop: '8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px' });
    const note = document.createElement('div'); style(note, { marginTop: '8px', color: '#a1a1aa', fontSize: '12px' });
    const footer = document.createElement('div'); style(footer, { display: 'none', marginTop: '10px', alignItems: 'center', gap: '8px', borderTop: '1px solid #3f3f46', paddingTop: '9px' });
    const model = document.createElement('span'); style(model, { flex: '1', minWidth: '0', color: '#a1a1aa', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    const copy = button('复制'); copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(output.textContent || ''); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败'; }
      setTimeout(() => { copy.textContent = '复制'; }, 1200);
    });
    footer.append(model, copy); card.append(header, source, status, output, note, footer); document.body.append(card); place(card, snapshot.rect, Math.min(400, window.innerWidth - 16));
    source.focus();

    async function run() {
      cancelScheduledTranslation();
      const sequence = ++request, text = source.value.trim(); status.textContent = '正在翻译…';
      status.style.color = '#a1a1aa';
      output.textContent = ''; note.textContent = ''; style(footer, { display: 'none' });
      if (!text) { status.textContent = '请输入要翻译的文字。'; status.style.color = '#fbbf24'; return; }
      if (text.length > 5000) { status.textContent = '输入内容超过 5000 字符，请缩短后重试。'; status.style.color = '#fbbf24'; return; }
      try {
        const result = await runtime.translate(text, select.value as TargetLanguage);
        if (sequence !== request || !card) return;
        status.textContent = `${result.detectedLanguage ? `${result.detectedLanguage} → ` : ''}${languageOptions.find(option => option.value === result.target)?.label ?? result.target}`;
        status.style.color = '#a1a1aa'; output.textContent = result.translation; note.textContent = result.note || ''; model.textContent = result.model; model.title = result.model; style(footer, { display: 'flex' });
      } catch (error) {
        if (sequence !== request || !card) return;
        status.textContent = error instanceof Error ? error.message : String(error); status.style.color = '#f87171';
      }
    }
    let composing = false;
    function scheduleTranslation() {
      cancelScheduledTranslation(); request++;
      const text = source.value.trim(); status.textContent = text ? '输入中…' : '请输入要翻译的文字。'; status.style.color = '#a1a1aa';
      output.textContent = ''; note.textContent = ''; style(footer, { display: 'none' });
      if (!text || composing) return;
      translateTimer = window.setTimeout(() => { translateTimer = undefined; void run(); }, AUTO_TRANSLATE_DELAY_MS);
    }
    source.addEventListener('input', scheduleTranslation);
    source.addEventListener('compositionstart', () => { composing = true; request++; cancelScheduledTranslation(); });
    source.addEventListener('compositionend', () => { composing = false; scheduleTranslation(); });
    source.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void run(); }
    });
    select.addEventListener('change', () => { void run(); });
    void run();
  }

  function refresh() {
    refreshLauncher();
    if (card) return;
    const snapshot = readSelection();
    if (snapshot) showTrigger(snapshot); else removeTrigger();
  }
  const delayedRefresh = () => { window.setTimeout(refresh, 0); };
  const outside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (card?.contains(target) || trigger?.contains(target) || launcher?.contains(target)) return;
    if (card) closeCard(); else removeTrigger();
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { closeCard(); removeTrigger(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') removeTrigger(); };
  const dismiss = () => { removeTrigger(); closeCard(); };
  const routeChanged = () => { closeCard(); removeTrigger(); refreshLauncher(); };
  document.addEventListener('pointerup', delayedRefresh); document.addEventListener('keyup', delayedRefresh); document.addEventListener('touchend', delayedRefresh);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown); window.addEventListener('resize', dismiss); window.addEventListener('popstate', routeChanged); window.addEventListener('hashchange', routeChanged); document.addEventListener('scroll', removeTrigger, true);
  return { refresh, dispose() { dismiss(); removeLauncher(); document.removeEventListener('pointerup', delayedRefresh); document.removeEventListener('keyup', delayedRefresh); document.removeEventListener('touchend', delayedRefresh); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown); window.removeEventListener('resize', dismiss); window.removeEventListener('popstate', routeChanged); window.removeEventListener('hashchange', routeChanged); document.removeEventListener('scroll', removeTrigger, true); } };
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
    configure: () => client.openSettings('translate-settings'),
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
