import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { taskTitle } from '../shared/title';

describe('task title', () => {
  it('keeps a title that was typed', () => {
    assert.equal(taskTitle('  Fix login  ', 'anything'), 'Fix login');
  });

  it('falls back to the first non-empty line of the prompt', () => {
    assert.equal(taskTitle('', '删除一下全部多余分支'), '删除一下全部多余分支');
    assert.equal(taskTitle('   ', '\n\n  Add CSV export  \nwith headers'), 'Add CSV export');
  });

  it('shortens a long first line on a character boundary', () => {
    const long = '把'.repeat(100);
    const title = taskTitle('', long);
    assert.equal([...title].length, 60);
    assert.ok(title.endsWith('…'));
    // A surrogate pair at the cut stays whole.
    assert.equal(taskTitle('', `${'a'.repeat(58)}😀tail`), `${'a'.repeat(58)}😀…`);
  });

  it('is empty only when both are empty', () => {
    assert.equal(taskTitle('', '  \n '), '');
  });
});
