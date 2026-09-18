import assert from 'node:assert/strict';
import test from 'node:test';
import { latestAssistantText } from '../client/reply';

test('picks the newest non-empty assistant message and skips other items', () => {
  const items = [
    { type: 'assistant_message', text: 'first' },
    { type: 'user_message', text: 'question' },
    { type: 'assistant_message', text: ' second ' },
    { type: 'tool_call', name: 'read' },
    { type: 'assistant_message', text: '   ' },
    { type: 'reasoning', text: 'thinking' },
  ];
  assert.deepEqual(latestAssistantText(items), { text: 'second', truncated: false });
  assert.equal(latestAssistantText([{ type: 'user_message', text: 'hi' }]), null);
  assert.equal(latestAssistantText([]), null);
});

test('clips long replies at a nearby line break, otherwise at the limit', () => {
  const paragraph = 'a'.repeat(60);
  const clipped = latestAssistantText([{ type: 'assistant_message', text: `${paragraph}\n${paragraph}\n${paragraph}` }], 150);
  assert.deepEqual(clipped, { text: `${paragraph}\n${paragraph}`, truncated: true });
  const solid = latestAssistantText([{ type: 'assistant_message', text: 'b'.repeat(200) }], 150);
  assert.deepEqual(solid, { text: 'b'.repeat(150), truncated: true });
  const earlyBreak = latestAssistantText([{ type: 'assistant_message', text: `ab\n${'c'.repeat(200)}` }], 150);
  assert.deepEqual(earlyBreak, { text: `ab\n${'c'.repeat(147)}`, truncated: true });
});
