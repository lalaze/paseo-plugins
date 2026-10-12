import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unifiedDiff } from '../server/diff';

const lines = (text: string) => { const parts = text.split('\n'); if (parts.at(-1) === '') parts.pop(); return parts.map(line => line.replace(/\r$/, '')); };

/** Applies the hunks to the old text, so every diff can be checked against the new text. */
function patch(before: string, diff: string): string[] {
  const source = lines(before), out: string[] = [];
  let next = 0;
  for (const line of diff ? diff.split('\n') : []) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      while (next < start) out.push(source[next++]!);
      continue;
    }
    const text = line.slice(1);
    if (line[0] === ' ') { assert.equal(source[next], text, 'context must match the old text'); out.push(text); next++; }
    else if (line[0] === '-') { assert.equal(source[next], text, 'removals must match the old text'); next++; }
    else if (line[0] === '+') out.push(text);
    else assert.fail(`unexpected diff line: ${line}`);
  }
  while (next < source.length) out.push(source[next++]!);
  return out;
}

test('a one-line change shows three lines of context around it', () => {
  const before = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 5\n', 'line five\n');
  assert.equal(unifiedDiff(before, after), ['@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8'].join('\n'));
});

test('created and deleted files diff against nothing', () => {
  assert.equal(unifiedDiff('', 'a\nb\n'), '@@ -0,0 +1,2 @@\n+a\n+b');
  assert.equal(unifiedDiff('a\nb\n', ''), '@@ -1,2 +0,0 @@\n-a\n-b');
  assert.equal(unifiedDiff('same\n', 'same\n'), '');
});

test('distant changes get separate hunks, nearby ones share a hunk', () => {
  const before = Array.from({ length: 30 }, (_, i) => `${i + 1}`).join('\n');
  const distant = unifiedDiff(before, before.replace(/^2$/m, 'two').replace(/^25$/m, 'twenty-five'))!;
  assert.equal(distant.split('\n').filter(line => line.startsWith('@@')).length, 2);
  const nearby = unifiedDiff(before, before.replace(/^10$/m, 'ten').replace(/^16$/m, 'sixteen'))!;
  assert.equal(nearby.split('\n').filter(line => line.startsWith('@@')).length, 1);
});

test('CRLF files diff by line and oversized rewrites fall back to no diff', () => {
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n'), '@@ -1,2 +1,2 @@\n a\n-b\n+c');
  const big = (tag: string) => Array.from({ length: 2000 }, (_, i) => `${tag}${i}`).join('\n');
  assert.equal(unifiedDiff(big('old'), big('new')), null);
});

test('applying any diff to the old text reproduces the new text', () => {
  let seed = 7;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const text = () => Array.from({ length: random(40) }, () => `l${random(6)}`).join('\n') + (random(2) ? '\n' : '');
  for (let round = 0; round < 500; round++) {
    const before = text(), after = text();
    const diff = unifiedDiff(before, after);
    assert.ok(diff !== null);
    assert.deepEqual(patch(before, diff), lines(after), `round ${round}`);
  }
});
