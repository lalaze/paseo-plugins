#!/usr/bin/env node
// Synthetic local Hub for protocol tests. No Google login, model calls or shell execution.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const port = Number(process.argv.find(a => a.startsWith('--hub-port=')).split('=')[1]);
const streams = new Map(), actions = new Map(), started = new Set();
const record = value => appendFileSync(process.env.HUB_FIXTURE_LOG, JSON.stringify(value) + '\n');
function frame(id, update) {
  const res = streams.get(id); if (!res) return;
  const data = Buffer.from(JSON.stringify({ update: { conversationId: id, trajectoryId: id, ...update } }));
  const head = Buffer.alloc(5); head.writeUInt32BE(data.length, 1);
  // Deliberately split both the envelope header and payload across writes.
  const bytes = Buffer.concat([head, data]);
  res.write(bytes.subarray(0, 2)); res.write(bytes.subarray(2, 8)); res.write(bytes.subarray(8));
}
function steps(id, values, fullyIdle = false) {
  frame(id, { status: fullyIdle ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_RUNNING', fullyIdle, mainTrajectoryUpdate: { stepsUpdate: { indices: values.map((_, i) => i), steps: values } } });
}
const text = value => ({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { modifiedResponse: value } });
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.end('<script>window.__APP_CONFIG__ = {"csrfToken":"fixture-only"};</script>'); return; }
  if (req.headers['x-codeium-csrf-token'] !== 'fixture-only') { res.writeHead(401); res.end('{"message":"missing csrf"}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  let data = Buffer.concat(chunks);
  if (req.headers['content-type'] === 'application/connect+json') data = data.subarray(5);
  const body = JSON.parse(data), method = req.url.split('/').pop(); record({ method, body });
  res.setHeader('Content-Type', 'application/json');
  if (method === 'StreamAgentStateUpdates') {
    res.setHeader('Content-Type', 'application/connect+json'); streams.set(body.conversationId, res);
    if (!started.has(body.conversationId)) {
      frame(body.conversationId, { fullyIdle: false });
      steps(body.conversationId, [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'prior user' } },
        text('prior assistant'),
      ], true);
      started.add(body.conversationId);
    } else {
      frame(body.conversationId, { fullyIdle: true });
    }
    res.on('close', () => { if (streams.get(body.conversationId) === res) streams.delete(body.conversationId); }); return;
  }
  if (method === 'GetCascadeModelConfigData') { res.end(JSON.stringify({ clientModelConfigs: [{ modelId: 'test-model', label: 'Fixture model', modelOrAlias: { model: 'MODEL_FIXTURE' } }] })); return; }
  if (method === 'StartCascade') { started.add(body.cascadeId); res.end(JSON.stringify({ cascadeId: body.cascadeId })); return; }
  if (method === 'SendUserCascadeMessage') {
    res.end('{}'); const id = body.cascadeId; const prompt = body.items.map(i => i.text).join('');
    setTimeout(() => {
      if (prompt === 'rendering') {
        const output = '@@ -1 +1,2 @@\n ```\n+added\n';
        const reply = 'Result:\n```diff\n' + output + '```';
        for (let i = 1; i <= reply.length; i++) steps(id, [{ ...text(reply.slice(0, i)), status: 'CORTEX_STEP_STATUS_RUNNING' }]);
        // Completion can arrive without another plannerResponse snapshot.
        frame(id, { fullyIdle: true, mainTrajectoryUpdate: { stepsUpdate: { indices: [1], steps: [{
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: { toolCall: { id: 'render-tool', name: 'run_command', argumentsJson: '{"CommandLine":"git diff","toolSummary":"Git diff execution"}' } },
          runCommand: { commandLine: 'git diff', cwd: '/fixture', exitCode: 0, combinedOutput: { full: output } },
        }] } } }); return;
      }
      if (prompt === 'error') steps(id, [{ type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE', errorMessage: { error: { shortError: 'fixture execution failed' } } }]);
      else if (prompt.startsWith('question')) {
        const questions = [{ question: '请选择前端改动范围', options: [{ id: 'scope-agent', text: '仅更新充值代理管理' }, { id: 'scope-both', text: '同时更新用户管理' }, { id: 'scope-user', text: '仅更新用户管理' }] }];
        if (prompt === 'question-multiple') questions.push({ question: '选择需要的功能', isMultiSelect: true, options: [{ id: 'toggle', text: '开关' }, { id: 'filter', text: '搜索筛选' }, { id: 'column', text: '列表字段' }] }, { question: '补充说明', options: [] });
        const waiting = { type: 'CORTEX_STEP_TYPE_ASK_QUESTION', status: 'CORTEX_STEP_STATUS_WAITING', metadata: { sourceTrajectoryStepInfo: { trajectoryId: id, stepIndex: 7 } }, requestedInteraction: { askQuestion: { questions } } };
        // Include a generic tool as in the reported screenshot, except in the
        // native-step case, which has no tool metadata at all.
        if (prompt !== 'question-native') waiting.metadata.toolCall = { id: 'question-tool', name: 'ask_user', argumentsJson: JSON.stringify({ questions: questions.map(q => ({ ...q, options: q.options.map(o => o.text) })), toolSummary: 'Ask user to clarify scope' }) };
        steps(id, [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: prompt } }, waiting, waiting], true); return;
      }
      else if (prompt === 'permission') {
        actions.set(id, true);
        steps(id, [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'permission' } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_WAITING', metadata: { sourceTrajectoryStepInfo: { trajectoryId: id, stepIndex: 1 }, toolCall: { id: 'fixture-tool', name: 'run_command', argumentsJson: '{"CommandLine":"printf fixture"}' } }, requestedInteraction: { permission: { resource: { action: 'command', target: 'printf fixture' } } } },
        ], true); return;
      } else if (prompt.includes('plan-turn')) {
        const plan = '# Implementation Plan\n\n- Inspect the renderer\n- Apply the patch\n';
        steps(id, [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'plan-turn' } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', metadata: { toolCall: { id: 'view-tool', name: 'view_file', argumentsJson: '{"AbsolutePath":"/fixture/src.ts","toolSummary":"File view"}' } } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', metadata: { toolCall: { id: 'grep-tool', name: 'grep_search', argumentsJson: '{"Query":"render","toolSummary":"Search"}' } } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', runCommand: { commandLine: 'ls', cwd: '/fixture', exitCode: 0, combinedOutput: { full: 'src.ts\n' } }, metadata: { toolCall: { id: 'ls-tool', name: 'run_command', argumentsJson: '{"CommandLine":"ls"}' } } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', metadata: { toolCall: { id: 'plan-file', name: 'write_to_file', argumentsJson: JSON.stringify({ TargetFile: '/tmp/.gemini/antigravity-cli/brain/abc/implementation_plan.md', CodeContent: plan, ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: 'Implementation plan' }, toolSummary: 'Implementation Plan' }) } } },
          text('请查阅实现计划，如确认无误请点击 Proceed 或回复确认开始执行。'),
        ]);
        frame(id, { fullyIdle: true, status: 'CASCADE_RUN_STATUS_IDLE' }); return;
      } else if (/approved the implementation plan/i.test(prompt)) {
        steps(id, [text('implementing')]);
      } else if (prompt === 'approval' || prompt.includes('approval-turn')) {
        steps(id, [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'approval' } },
          { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_WAITING', metadata: { sourceTrajectoryStepInfo: { trajectoryId: id, stepIndex: 1 }, toolCall: { id: 'plan-file', name: 'write_to_file', argumentsJson: JSON.stringify({ TargetFile: '/tmp/.gemini/antigravity-cli/brain/abc/implementation_plan.md', CodeContent: '# Plan\n\n- Do the work\n', ArtifactMetadata: { RequestFeedback: true, UserFacing: true } }) } }, requestedInteraction: { approvalInteraction: { resource: { target: 'implementation_plan.md' } } } },
        ], true); return;
      } else steps(id, [text('fixture reply')]);
      frame(id, { fullyIdle: true, status: 'CASCADE_RUN_STATUS_IDLE' });
    }, 10); return;
  }
  if (method === 'HandleCascadeUserInteraction') {
    const interaction = body.interaction;
    if (interaction.askQuestion) {
      const { responses, cancelled } = interaction.askQuestion;
      // Match Hub's protobuf message shape; the old ["Allow once"] payload
      // must fail here instead of being silently accepted by the fixture.
      if (typeof cancelled !== 'boolean' || !Array.isArray(responses) || responses.some(r => !r || typeof r !== 'object' || !Array.isArray(r.selectedOptionIds) || r.selectedOptionIds.some(id => !r.options.some(o => o.id === id)))) {
        res.writeHead(400); res.end('{"message":"invalid AskQuestionEntry responses"}'); return;
      }
      record({ interaction }); res.end('{}');
      setTimeout(() => steps(body.cascadeId, [text(cancelled ? 'question cancelled' : 'question answered')], true), 10); return;
    }
    const allow = interaction.permission?.allow ?? interaction.approvalInteraction?.confirm ?? interaction.runCommand?.confirm;
    record({ decision: interaction.permission, interaction }); res.end('{}');
    setTimeout(() => { steps(body.cascadeId, [text(allow ? 'approved' : 'denied')]); frame(body.cascadeId, { fullyIdle: true }); }, 10); return;
  }
  if (method === 'CancelCascadeInvocation') { record({ cancelled: body.cascadeId }); res.end('{}'); return; }
  res.writeHead(501); res.end('{"message":"unsupported fixture method"}');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
