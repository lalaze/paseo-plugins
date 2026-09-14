import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rpc, updates, stopHub } from './runtime.mjs';
import { mcpSpec, promptContent } from './content.mjs';
import { markdownSnapshot, toolPresentation, questionPresentation, questionOptionText, PLAN_MODE_INJECTION, isPlanConfirmation, isPlanFile, planEntries } from './presentation.mjs';

if (process.argv.includes('--version')) { console.log('agy-hub-acp 0.3.0'); process.exit(0); }

const sessions = new Map(), pending = new Map();
const stateDir = process.env.AGY_HUB_STATE_DIR || join(homedir(), '.local/state/agy-hub-acp');
let nextId = 0, closing = false;
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
const notify = (sid, update) => send({ method: 'session/update', params: { sessionId: sid, update } });
function requestClient(method, params, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Cancelled'));
    const id = `hub-${++nextId}`;
    const abort = () => { pending.delete(id); reject(new Error('Cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    pending.set(id, {
      resolve: value => { signal.removeEventListener('abort', abort); resolve(value); },
      reject: error => { signal.removeEventListener('abort', abort); reject(error); },
    });
    send({ id, method, params });
  });
}
async function models() {
  const data = await rpc('GetCascadeModelConfigData', {});
  return (data.clientModelConfigs || []).filter(m => m.modelId && m.modelOrAlias?.model);
}
const AVAILABLE_MODES = [
  { id: 'default', name: 'Ask when required', description: 'Forward Hub approval requests to Paseo; no permission bypass.' },
  { id: 'plan', name: 'Plan', description: 'Explore and write an implementation plan. Click Proceed or reply to confirm before making changes.' },
];
const INTERACTION_TYPES = ['permission', 'runCommand', 'filePermission', 'mcp', 'readUrlContent', 'openBrowserUrl', 'captureBrowserScreenshot', 'executeBrowserJavascript', 'approvalInteraction', 'askQuestion', 'elicitation'];
function sessionInfo(s) {
  return { sessionId: s.id, modes: { currentModeId: s.mode, availableModes: AVAILABLE_MODES },
    models: { currentModelId: s.model, availableModels: s.catalog.map(m => ({ modelId: m.modelId, name: m.label })) },
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: s.catalog.map(m => ({ value: m.modelId, name: m.label })) },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: AVAILABLE_MODES.map(m => ({ value: m.id, name: m.name, description: m.description })) },
    ] };
}
async function save(s) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, `${s.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ id: s.id, cwd: s.cwd, model: s.model, mode: s.mode }), { mode: 0o600 });
  await rename(temporary, path);
}
async function makeSession(params, load = false) {
  const customAgentSpec = mcpSpec(params.mcpServers, params.cwd);
  if (load && sessions.get(params.sessionId)?.controller) throw new Error('Session already running');
  let saved;
  if (load) {
    if (!/^[0-9a-f-]{36}$/i.test(params.sessionId)) throw new Error('Invalid session ID');
    try { saved = JSON.parse(await readFile(join(stateDir, `${params.sessionId}.json`), 'utf8')); }
    catch { throw new Error('This prototype can resume only sessions it created; start a new Hub session.'); }
    if (saved.cwd !== params.cwd) throw new Error('Session workspace mismatch');
  }
  const catalog = await models();
  const chosen = (catalog.some(m => m.modelId === saved?.model) ? saved.model : null) || catalog.find(m => m.modelId === 'gemini-3.8-flash-high')?.modelId || catalog[0]?.modelId;
  if (!chosen) throw new Error('Hub returned no models; sign in through the Antigravity extension first.');
  customAgentSpec.builtinAgent.model = catalog.find(m => m.modelId === chosen).modelOrAlias.model;
  const s = { id: saved?.id || randomUUID(), cwd: params.cwd, model: chosen, mode: saved?.mode === 'plan' ? 'plan' : 'default', catalog, customAgentSpec, texts: new Map(), assistantTexts: new Map(), tools: new Map(), permissions: new Set(), pendingPermissions: new Set(), controller: null, planText: '', proceedAsked: false };
  if (!load) await rpc('StartCascade', { cascadeId: s.id, source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', requestedModel: customAgentSpec.builtinAgent.model, workspaceUris: [pathToFileURL(s.cwd).href], customAgentSpec });
  sessions.set(s.id, s); await save(s);
  if (load) await replay(s);
  return sessionInfo(s);
}
async function applyMode(s, mode) {
  if (!AVAILABLE_MODES.some(m => m.id === mode)) throw new Error(`Unknown session mode: ${mode}`);
  if (s.mode === mode) return;
  s.mode = mode;
  await save(s);
  notify(s.id, { sessionUpdate: 'current_mode_update', currentModeId: mode });
  notify(s.id, { sessionUpdate: 'config_option_update', configOptions: sessionInfo(s).configOptions });
}
function textUpdate(s, key, text, kind = 'agent_message_chunk') {
  if (!text) return;
  const old = s.texts.get(key) || '';
  if (text === old) return;
  s.texts.set(key, text);
  if (kind === 'agent_message_chunk') s.lastAssistant = text;
  notify(s.id, { sessionUpdate: kind, content: { type: 'text', text: text.startsWith(old) ? text.slice(old.length) : '\n' + text } });
}
function emitPlan(s, text) {
  if (!text || s.planText === text) return;
  s.planText = text;
  const entries = planEntries(text);
  if (entries.length) notify(s.id, { sessionUpdate: 'plan', entries });
}
function toolUpdate(s, step, index, u) {
  const call = step.metadata?.toolCall || step.mcpTool?.toolCall;
  if (!call && !step.runCommand && !step.generic?.args && !step.writeFile && !step.askQuestion && !step.requestedInteraction?.askQuestion) return null;
  const id = call?.id || `${u.trajectoryId}:${index}`;
  let input = step.generic?.args || {};
  try { if (call?.argumentsJson) input = { ...input, ...JSON.parse(call.argumentsJson) }; } catch {}
  const status = step.status?.endsWith('_DONE') ? 'completed' : step.status?.endsWith('_ERROR') ? 'failed' : step.status?.endsWith('_WAITING') ? 'pending' : 'in_progress';
  const payload = { toolCallId: id, status, ...toolPresentation(step, call, input) };
  const serialized = JSON.stringify(payload), previous = s.tools.get(id);
  if (previous !== serialized) { notify(s.id, { sessionUpdate: previous ? 'tool_call_update' : 'tool_call', ...payload }); s.tools.set(id, serialized); }
  const planPath = input.TargetFile || input.targetFile || input.path || payload.locations?.[0]?.path;
  const body = payload.content?.[0]?.content?.text;
  if ((payload.kind === 'think' || isPlanFile(planPath) || payload.title === 'Implementation Plan') && typeof body === 'string' && body && status === 'completed') emitPlan(s, body);
  return payload;
}
function permissionOptions(switchMode) {
  return switchMode
    ? [{ optionId: 'default', name: 'Proceed', kind: 'allow_once' }, { optionId: 'plan', name: 'Stay in plan', kind: 'reject_once' }]
    : [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }];
}
function selectedAllow(result, options) {
  if (result?.outcome?.outcome !== 'selected') return { allow: false, optionId: null };
  const optionId = result.outcome.optionId;
  const chosen = options.find(o => o.optionId === optionId);
  return { allow: Boolean(chosen?.kind?.startsWith('allow')), optionId };
}
async function answerQuestions(s, request, tool, key, signal) {
  const questions = request.questions || [];
  if (!questions.length) throw new Error('Hub question interaction has no questions');
  const responses = [];
  for (const [index, question] of questions.entries()) {
    const choices = question.options || [];
    const selected = new Set();
    let skipped = false;
    while (true) {
      // ACP permission responses contain one option ID. For multiple selection,
      // offer toggles until the user explicitly submits the selected set.
      const options = choices.map((choice, i) => ({ optionId: `answer:${i}`, name: `${question.isMultiSelect ? (selected.has(choice.id) ? '☑ ' : '☐ ') : '选择 '}${i + 1}${questionOptionText(choice).recommended ? ' · 推荐' : ''}`, kind: 'allow_once' }));
      if (question.isMultiSelect && selected.size) options.push({ optionId: 'submit', name: '提交所选答案', kind: 'allow_once' });
      options.push({ optionId: 'skip', name: '跳过此题', kind: 'reject_once' }, { optionId: 'cancel', name: '取消回答', kind: 'reject_once' });
      const toolCall = { toolCallId: tool?.toolCallId || key, status: 'pending',
        ...questionPresentation([question], { index, total: questions.length, selected }) };
      // Paseo can use its cached tool snapshot for permission details. Refresh
      // it before every question/toggle so that clients show the current choice.
      notify(s.id, { sessionUpdate: s.tools.has(toolCall.toolCallId) ? 'tool_call_update' : 'tool_call', ...toolCall });
      s.tools.set(toolCall.toolCallId, JSON.stringify(toolCall));
      const result = await requestClient('session/request_permission', {
        sessionId: s.id,
        toolCall,
        options,
      }, signal);
      const optionId = result?.outcome?.outcome === 'selected' ? result.outcome.optionId : null;
      if (!options.some(o => o.optionId === optionId) || optionId === 'cancel') return { responses: [], cancelled: true };
      if (optionId === 'skip') { selected.clear(); skipped = true; break; }
      if (optionId === 'submit') break;
      const choice = choices[Number(optionId.slice('answer:'.length))];
      if (selected.has(choice.id)) selected.delete(choice.id); else selected.add(choice.id);
      if (!question.isMultiSelect) break;
    }
    // Hub responses are AskQuestionEntry messages, not strings or button labels.
    responses.push({ question: question.question, options: choices, isMultiSelect: Boolean(question.isMultiSelect), selectedOptionIds: [...selected], writeInResponse: '', skipped });
  }
  return { responses, cancelled: false };
}
async function handlePermission(s, step, tool, signal) {
  const info = step.metadata?.sourceTrajectoryStepInfo;
  const request = step.requestedInteraction;
  if (!info || !request) throw new Error('Missing Hub interaction location');
  const key = `${info.trajectoryId}:${info.stepIndex || 0}:${JSON.stringify(request)}`;
  if (s.permissions.has(key) || s.pendingPermissions.has(key)) return false;
  const type = Object.keys(request).find(k => INTERACTION_TYPES.includes(k));
  if (!type) throw new Error('Unsupported Hub interaction; cancelled to avoid hanging.');
  if (type === 'askQuestion') {
    s.pendingPermissions.add(key);
    try {
      const askQuestion = await answerQuestions(s, request.askQuestion, tool, key, signal);
      await rpc('HandleCascadeUserInteraction', { cascadeId: s.id, interaction: { trajectoryId: info.trajectoryId, stepIndex: info.stepIndex || 0, askQuestion } }, signal);
      s.permissions.add(key);
      return true;
    } finally { s.pendingPermissions.delete(key); }
  }
  const path = tool?.locations?.[0]?.path || tool?.rawInput?.TargetFile || tool?.rawInput?.targetFile;
  const switchMode = type === 'approvalInteraction' || s.mode === 'plan' && (tool?.kind === 'think' || isPlanFile(path));
  const options = permissionOptions(switchMode);
  const planText = s.planText || tool?.content?.[0]?.content?.text || '';
  const toolCall = switchMode
    ? { ...(tool || { toolCallId: key, status: 'pending', rawInput: request }), kind: 'switch_mode', title: tool?.title && isPlanFile(path) ? tool.title : '请查阅实现计划', ...(planText ? { content: [{ type: 'content', content: { type: 'text', text: planText } }] } : {}) }
    : (tool || { toolCallId: key, title: request.permission?.actionDescription || request.askQuestion?.questions?.[0]?.question || 'Hub approval', kind: 'other', status: 'pending', rawInput: request });
  s.pendingPermissions.add(key);
  try {
    const result = await requestClient('session/request_permission', { sessionId: s.id, toolCall, options }, signal);
    const { allow } = selectedAllow(result, options);
    const value = type === 'permission' || type === 'filePermission' ? { allow, scope: 'PERMISSION_SCOPE_ONCE' }
      : { confirm: allow };
    if (type === 'runCommand') { value.proposedCommandLine = step.runCommand?.commandLine || ''; value.submittedCommandLine = value.proposedCommandLine; }
    if (type === 'filePermission') value.absolutePathUri = request.filePermission?.absolutePathUri;
    await rpc('HandleCascadeUserInteraction', { cascadeId: s.id, interaction: { trajectoryId: info.trajectoryId, stepIndex: info.stepIndex || 0, [type]: value } }, signal);
    s.permissions.add(key);
    if (switchMode) s.proceedAsked = true;
    if (switchMode && allow && s.mode === 'plan') await applyMode(s, 'default');
    return true;
  } finally {
    s.pendingPermissions.delete(key);
  }
}
async function requestPlanProceed(s, signal) {
  if (s.proceedAsked || s.mode !== 'plan') return false;
  s.proceedAsked = true;
  const planText = s.planText || s.lastAssistant || '';
  const options = permissionOptions(true);
  const result = await requestClient('session/request_permission', {
    sessionId: s.id,
    toolCall: { toolCallId: `plan-proceed:${s.id}`, title: '请查阅实现计划', kind: 'switch_mode', status: 'pending', rawInput: { mode: 'plan' }, ...(planText ? { content: [{ type: 'content', content: { type: 'text', text: planText } }] } : {}) },
    options,
  }, signal);
  const { allow } = selectedAllow(result, options);
  if (!allow) return false;
  await applyMode(s, 'default');
  const selected = s.catalog.find(m => m.modelId === s.model);
  await rpc('SendUserCascadeMessage', { cascadeId: s.id, items: [{ text: 'The user approved the implementation plan. Proceed with execution.' }], customAgentSpec: { builtinAgent: { ...s.customAgentSpec.builtinAgent, model: selected.modelOrAlias.model } } }, signal);
  return true;
}
async function handleUpdate(s, u, signal, replaying = false) {
  const changes = u.mainTrajectoryUpdate?.stepsUpdate;
  let asked = false;
  for (const [offset, step] of (changes?.steps || []).entries()) {
    const index = changes.indices?.[offset] ?? offset;
    const key = `${u.trajectoryId}:${index}`;
    if (step.userInput) {
      const text = step.userInput.userResponse || (step.userInput.items || []).map(i => i.text || '').join('');
      if (replaying) textUpdate(s, key, text, 'user_message_chunk');
      else { s.texts.set(key, text); s.texts.set(`${key}:media`, 'sent'); }
    }
    if (replaying && step.userInput && !s.texts.has(`${key}:media`)) {
      s.texts.set(`${key}:media`, 'sent');
      for (const m of [...(step.userInput.media || []), ...(step.userInput.images || [])]) {
        const data = m.inlineData || m.base64Data;
        if (data && m.mimeType?.startsWith('image/')) notify(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'image', data, mimeType: m.mimeType } });
      }
    }
    if (step.plannerResponse) {
      const raw = step.plannerResponse.modifiedResponse || step.plannerResponse.response || '';
      const final = replaying || step.status?.endsWith('_DONE') || step.status?.endsWith('_ERROR');
      if (final) s.assistantTexts.delete(key); else s.assistantTexts.set(key, raw);
      textUpdate(s, key, markdownSnapshot(raw, final));
    }
    const tool = toolUpdate(s, step, index, u);
    if (step.errorMessage?.error) {
      const error = step.errorMessage.error;
      if (!replaying) s.turnError = error.shortError || error.userErrorMessage || 'Hub execution failed';
      textUpdate(s, key, error.shortError || error.userErrorMessage || 'Hub execution failed');
    }
    if (step.requestedInteraction && step.status?.endsWith('_WAITING') && !replaying) {
      asked = await handlePermission(s, step, tool, signal) || asked;
    }
  }
  if (u.fullyIdle) {
    for (const [key, raw] of s.assistantTexts) textUpdate(s, key, markdownSnapshot(raw, true));
    s.assistantTexts.clear();
    if (!asked && !replaying && s.mode === 'plan' && !s.proceedAsked && (s.planText || s.lastAssistant)) asked = await requestPlanProceed(s, signal);
  }
  return asked;
}
async function replay(s) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let lastCount = -1;
    for await (const u of updates(s, controller.signal)) {
      await handleUpdate(s, u, controller.signal, true);
      const count = u.mainTrajectoryUpdate?.stepsUpdate?.steps?.length ?? 0;
      if (u.fullyIdle || count <= lastCount) break;
      lastCount = count;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
async function prompt(params) {
  const s = sessions.get(params.sessionId);
  if (!s) throw new Error('Unknown session');
  if (s.controller) throw new Error('Session already running');
  const content = promptContent(params.prompt);
  const userText = (params.prompt || []).filter(b => b?.type === 'text').map(b => b.text).join('');
  if (s.mode === 'plan' && isPlanConfirmation(userText)) {
    await applyMode(s, 'default');
    content.items = [{ text: 'The user approved the implementation plan. Proceed with execution.' }, ...content.items];
  } else if (s.mode === 'plan') content.items = [{ text: PLAN_MODE_INJECTION }, ...content.items];
  const selected = s.catalog.find(m => m.modelId === s.model);
  if (!selected) throw new Error('Selected model unavailable');
  const controller = new AbortController(); s.controller = controller; s.cancelled = false; s.turnError = null;
  s.permissions = new Set(); s.pendingPermissions = new Set(); s.proceedAsked = false;
  const timer = setTimeout(() => controller.abort(new Error('Hub turn timed out')), 30 * 60 * 1000);
  try {
    // Seed texts from the pre-prompt snapshot; replaying skips permissions and turn errors.
    const iterator = updates(s, controller.signal)[Symbol.asyncIterator]();
    const initial = await iterator.next();
    if (initial.done) throw new Error('Hub stream closed before prompt');
    await handleUpdate(s, initial.value, controller.signal, true);
    await rpc('SendUserCascadeMessage', { cascadeId: s.id, ...content, customAgentSpec: { builtinAgent: { ...s.customAgentSpec.builtinAgent, model: selected.modelOrAlias.model } } }, controller.signal);
    let active = false;
    while (true) {
      const { value: u, done } = await iterator.next();
      if (done) throw new Error('Hub stream ended before completion');
      if (u.status?.endsWith('_RUNNING') || u.mainTrajectoryUpdate?.stepsUpdate?.steps?.some(x => x.type === 'CORTEX_STEP_TYPE_USER_INPUT')) active = true;
      const asked = await handleUpdate(s, u, controller.signal);
      if (active && u.fullyIdle && !asked) break;
    }
    if (s.turnError) throw new Error(s.turnError);
    return { stopReason: 'end_turn' };
  } catch (error) {
    await rpc('CancelCascadeInvocation', { cascadeId: s.id }).catch(() => {});
    if (s.cancelled) return { stopReason: 'cancelled' };
    throw error;
  } finally {
    clearTimeout(timer); controller.abort(); s.controller = null;
    s.pendingPermissions = new Set();
  }
}
async function dispatch(method, params = {}) {
  switch (method) {
    case 'initialize': return { protocolVersion: 1, agentInfo: { name: 'agy-hub-acp', version: '0.3.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: true } }, authMethods: [] };
    case 'session/new': return makeSession(params);
    case 'session/load': return makeSession(params, true);
    case 'session/prompt': return prompt(params);
    case 'session/cancel': { const s = sessions.get(params.sessionId); if (s?.controller) { s.cancelled = true; s.pendingPermissions = new Set(); s.controller.abort(); } return {}; }
    case 'session/set_mode': {
      const s = sessions.get(params.sessionId); if (!s) throw new Error('Unknown session');
      if (!AVAILABLE_MODES.some(m => m.id === params.modeId)) throw new Error('Unknown session mode');
      s.mode = params.modeId; await save(s); return {};
    }
    case 'session/set_model':
    case 'session/set_config_option': {
      const s = sessions.get(params.sessionId); if (!s) throw new Error('Unknown session');
      if (method === 'session/set_config_option' && params.configId === 'mode') {
        if (!AVAILABLE_MODES.some(m => m.id === params.value)) throw new Error('Unknown session mode');
        s.mode = params.value; await save(s); return { configOptions: sessionInfo(s).configOptions };
      }
      if (method === 'session/set_config_option' && params.configId !== 'model') throw new Error('Unsupported config option');
      const model = params.modelId || params.value; if (!s.catalog.some(m => m.modelId === model)) throw new Error('Unknown model');
      s.model = model; await save(s); return method === 'session/set_config_option' ? { configOptions: sessionInfo(s).configOptions } : {};
    }
    default: throw new Error(`Unsupported method: ${method}`);
  }
}
async function shutdown() {
  if (closing) return; closing = true;
  for (const s of sessions.values()) { if (s.controller) { s.cancelled = true; s.controller.abort(); } }
  await stopHub();
  process.exit(0);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (!msg.method && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
  if (!msg.method) return;
  dispatch(msg.method, msg.params).then(result => { if (msg.id !== undefined) send({ id: msg.id, result }); }, error => { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: error.message } }); });
});
lines.on('close', shutdown);
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
