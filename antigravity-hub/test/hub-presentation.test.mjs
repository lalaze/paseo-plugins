import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownSnapshot, questionPresentation, toolPresentation, isPlanFile, isPlanConfirmation, planEntries, toolKind } from '../src/hub/presentation.mjs';
import { resolveUiLocale } from '../src/hub/i18n.mjs';

const body = 'diff --git a/README.md b/README.md\n@@ -1,2 +1,3 @@\n ```\n context\n+new\n';
const raw = '结果：\n\n```diff\n' + body + '```\n完成。';
const expected = '结果：\n\n````diff\n' + body + '````\n完成。';

test('diff fences preserve hunk contents and remain safe across every stream split', () => {
  assert.equal(markdownSnapshot(raw, true), expected);
  let emitted = '';
  for (let i = 1; i <= raw.length; i++) {
    const next = markdownSnapshot(raw.slice(0, i));
    assert.ok(next.startsWith(emitted), `non-append update at ${i}`);
    emitted = next;
  }
  assert.equal(emitted, expected);
  assert.equal(markdownSnapshot('结果：'), '结果：');
  assert.equal(markdownSnapshot('结果：\n```diff\n' + body), '结果：\n');
});

test('ordinary fences stay literal; CRLF, long markers, multiple blocks and unfinished diffs work', () => {
  const ordinary = '```markdown\n```diff\n+example\n```\n';
  assert.equal(markdownSnapshot(ordinary, true), ordinary);
  assert.equal(markdownSnapshot(raw.replaceAll('\n', '\r\n'), true), expected.replaceAll('\n', '\r\n'));
  assert.equal(markdownSnapshot(raw + '\n' + raw, true), expected + '\n' + expected);
  const longBody = '@@ -1 +1 @@\n ``````\n';
  assert.equal(markdownSnapshot('```patch\n' + longBody + '```', true), '```````patch\n' + longBody + '```````');
  assert.equal(markdownSnapshot('```diff\n' + body, true), '````diff\n' + body + '````');
  const indented = ' ```diff\n@@ -1 +1 @@\n x\n ```\n';
  assert.equal(markdownSnapshot(indented, true), indented);
});

test('shell cards expose the real command and output while retaining structured results', () => {
  const step = { runCommand: { commandLine: 'git diff', cwd: '/workspace', exitCode: 0, combinedOutput: { full: body }, shellName: 'bash' } };
  const view = toolPresentation(step, { name: 'run_command' }, { toolSummary: 'Git diff execution', CommandLine: 'git diff' });
  assert.equal(view.title, 'git diff');
  assert.equal(view.rawInput.command, 'git diff');
  assert.equal(view.rawInput.CommandLine, 'git diff');
  assert.equal(view.rawInput.cwd, '/workspace');
  assert.equal(view.content[0].content.text, body);
  assert.equal(view.rawOutput.exitCode, 0);
  assert.deepEqual(view.rawOutput.combinedOutput, step.runCommand.combinedOutput);
  assert.equal(toolPresentation({ runCommand: { commandLine: 'true' } }, null, {}).content[0].content.text, '');
  assert.equal(toolPresentation({}, { name: 'run_command' }, { CommandLine: 'pwd', Cwd: '/tmp' }).rawInput.cwd, '/tmp');
});

test('generic and MCP result strings display directly; structured data remains available', () => {
  const result = { result: 'hello\nworld', stepRenderInfo: { label: 'fixture' } };
  const generic = toolPresentation({ generic: { result } }, { name: 'tool' }, {});
  assert.equal(generic.content[0].content.text, result.result);
  assert.deepEqual(generic.rawOutput, result);
  assert.equal(toolPresentation({ mcpTool: { resultString: 'MCP result' } }, {}, {}).content[0].content.text, 'MCP result');
});

test('tool kinds distinguish commands from reads, searches and plan artifacts', () => {
  assert.equal(toolKind('view_file'), 'read');
  assert.equal(toolKind('grep_search'), 'search');
  assert.equal(toolKind('write_to_file'), 'edit');
  assert.equal(toolPresentation({}, { name: 'view_file' }, { AbsolutePath: '/tmp/a.ts' }).kind, 'read');
  assert.equal(toolPresentation({}, { name: 'grep_search' }, { Query: 'foo' }).kind, 'search');
  const planPath = '/tmp/.gemini/antigravity-cli/brain/abc/implementation_plan.md';
  const plan = toolPresentation({}, { name: 'write_to_file' }, {
    TargetFile: planPath, CodeContent: '# Plan\n\n- One\n- Two\n', ArtifactMetadata: { RequestFeedback: true, UserFacing: true },
  });
  assert.equal(plan.kind, 'think');
  assert.equal(plan.title, 'implementation_plan.md');
  assert.equal(plan.content[0].content.text, '# Plan\n\n- One\n- Two\n');
  assert.equal(plan.locations[0].path, planPath);
  assert.equal(isPlanFile(planPath), true);
  assert.equal(isPlanFile('/workspace/src.ts'), false);
  assert.equal(isPlanConfirmation('Proceed'), true);
  assert.equal(isPlanConfirmation('确认'), true);
  assert.equal(isPlanConfirmation('please change the plan to use postgres'), false);
  assert.deepEqual(planEntries('# Plan\n\n- Inspect the renderer\n- Apply the patch\n').map(e => e.content), ['Plan', 'Inspect the renderer', 'Apply the patch']);
});

test('control copy follows the client or desktop locale', () => {
  assert.equal(resolveUiLocale('zh-Hans', {}), 'zh-CN');
  assert.equal(resolveUiLocale(undefined, { LANG: 'en_US.UTF-8' }), 'en');
  const question = [{ question: 'Choose scope', options: [{ id: 'one', text: '(Recommended) One' }] }];
  assert.equal(questionPresentation(question, { locale: 'en' }).title, 'Your input is needed');
  assert.equal(questionPresentation(question, { locale: 'zh-CN' }).title, '需要你确认');
});
