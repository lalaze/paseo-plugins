// ACP text chunks are append-only. Hold diff blocks until their closing fence is
// known so an embedded README fence cannot close the block already on screen.
export function markdownSnapshot(text, final = false) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let output = '', fence = null, block = null, oldLeft = 0, newLeft = 0;
  const renderBlock = closing => {
    const body = block.body.join('');
    const runs = body.match(fence.char === '`' ? /`+/g : /~+/g) || [];
    const size = Math.max(fence.size, ...runs.map(run => run.length + 1));
    const marker = fence.char.repeat(size);
    return block.open.replace(fence.marker, marker) + body +
      (closing ? closing.replace(/[`~]+/, marker) :
        (body.endsWith('\n') || !body ? '' : '\n') + marker);
  };
  for (const line of lines) {
    const complete = line.endsWith('\n') || final;
    const plain = line.replace(/\r?\n$/, '');
    if (!fence) {
      // A split opening marker/language must not leak before we know its type.
      if (!complete && /^ {0,3}(?:`|~)/.test(plain)) break;
      const open = plain.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open) {
        fence = { marker: open[1], char: open[1][0], size: open[1].length };
        if (/^(diff|patch)(?:\s|$)/i.test(open[2].trim())) {
          block = { open: line, body: [] }; oldLeft = newLeft = 0;
          continue;
        }
      }
      output += line;
      continue;
    }
    const close = plain.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
    const closes = close && close[1][0] === fence.char && close[1].length >= fence.size;
    if (!block) {
      output += line;
      if (closes && complete) fence = null;
      continue;
    }
    // In a unified hunk, a leading space is a context marker, even when the
    // following text looks exactly like a Markdown closing fence.
    const context = plain.startsWith(' ') && oldLeft > 0 && newLeft > 0;
    if (closes && !context) {
      if (!complete) break;
      output += renderBlock(line); block = fence = null;
      continue;
    }
    block.body.push(line);
    const hunk = plain.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1); newLeft = Number(hunk[2] ?? 1);
    } else if (context) { oldLeft--; newLeft--; }
    else if (plain.startsWith('-') && oldLeft > 0) oldLeft--;
    else if (plain.startsWith('+') && newLeft > 0) newLeft--;
  }
  if (block && final) output += renderBlock(null);
  return output;
}

export const PLAN_MODE_INJECTION = '[PLANNING MODE] Do not write, edit, create, move, or delete project files, and do not start implementing. You may read, search, and run investigative commands. Write a step-by-step implementation plan describing how to accomplish the task. After the plan is ready, stop and wait for the user to click Proceed or reply to confirm before making changes.';

export function isPlanConfirmation(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return false;
  return /^(proceed|go\s*ahead|lgtm|ok(ay)?|yes|y|确认|继续|开始执行|执行吧?|可以|好的?|同意)([.。!！]*)?$/i.test(t)
    || /点击\s*proceed|开始执行/.test(t);
}

export function isPlanFile(path = '') {
  const p = String(path).replace(/\\/g, '/');
  if (/(^|\/)(implementation_plan|plan)\.md$/i.test(p)) return true;
  return p.includes('/.gemini/') && p.includes('/brain/') && /\.md$/i.test(p);
}

export function planEntries(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (!match) continue;
    const content = match[1].replace(/[*_`]+/g, '').trim();
    if (content.length < 2 || content.length > 200) continue;
    entries.push({ content, priority: entries.length < 3 ? 'high' : 'medium', status: 'pending' });
    if (entries.length >= 20) break;
  }
  return entries;
}

export function toolKind(name = '') {
  const l = String(name).toLowerCase();
  if (l === 'run_command' || l.includes('command') || l.includes('execute') || l.includes('terminal')) return 'execute';
  if (l.includes('write') || l.includes('edit') || l.includes('patch') || l.includes('replace')) return 'edit';
  if (l.includes('delete') || l.includes('remove')) return 'delete';
  if (l.includes('move') || l.includes('rename')) return 'move';
  if (l.includes('read') || l.includes('view') || l.includes('list')) return 'read';
  if (l.includes('grep') || l.includes('search') || l.includes('find')) return 'search';
  if (l.includes('url') || l.includes('fetch')) return 'fetch';
  return 'other';
}

function planBody(input) {
  const meta = input.ArtifactMetadata || input.artifactMetadata || {};
  const path = input.TargetFile || input.targetFile || input.path || input.AbsolutePath || input.absolutePath;
  const userFacing = meta.UserFacing ?? meta.userFacing;
  const feedback = meta.RequestFeedback ?? meta.requestFeedback;
  const plan = isPlanFile(path) || userFacing || feedback;
  const body = input.CodeContent || input.codeContent;
  return plan && typeof body === 'string' ? { path, body } : plan && path ? { path, body: '' } : null;
}

export function toolPresentation(step, call, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const name = call?.name || '';
  const execute = Boolean(step.runCommand || name === 'run_command');
  if (execute) {
    const command = step.runCommand?.commandLine ?? input.CommandLine ?? input.commandLine ?? input.command;
    const cwd = step.runCommand?.cwd ?? input.Cwd ?? input.cwd;
    if (typeof command === 'string') input.command = command;
    if (typeof cwd === 'string') input.cwd = cwd;
  }
  const plan = planBody(input);
  const out = step.runCommand ?? step.generic?.result ?? step.mcpTool;
  let visible;
  if (plan) visible = plan.body;
  else if (step.runCommand) {
    const combined = step.runCommand.combinedOutput;
    visible = typeof combined === 'string' ? combined : combined?.full;
    // No terminal output yet: do not display the command metadata as output.
    if (typeof visible !== 'string') visible = '';
  } else if (out !== undefined) {
    visible = typeof out === 'string' ? out :
      [out?.result, out?.resultString, out?.text].find(value => typeof value === 'string') ?? JSON.stringify(out);
  }
  const path = plan?.path || input.TargetFile || input.targetFile || input.AbsolutePath || input.absolutePath || input.path;
  const title = plan
    ? (typeof plan.path === 'string' && plan.path.split(/[\\/]/).pop()) || 'Implementation Plan'
    : input.command || input.toolSummary || input.CommandLine || name || step.type;
  const kind = execute ? 'execute' : plan ? 'think' : toolKind(name);
  const locations = typeof path === 'string' && path && !execute ? [{ path }] : undefined;
  return {
    title, kind, rawInput: input,
    ...(locations ? { locations } : {}),
    ...(visible !== undefined || out !== undefined ? {
      rawOutput: step.runCommand ? { ...out, output: visible } : out,
      content: [{ type: 'content', content: { type: 'text', text: visible ?? '' } }],
    } : {}),
  };
}
