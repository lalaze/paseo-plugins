/** Unified line diffs for the edit cards Paseo shows. Display only: Dot and the journal never use them. */
const CONTEXT = 3;
/** The changed middle is compared line by line; larger rewrites show the path without a diff. */
const MAX_CELLS = 2_000_000;
const MAX_DIFF_BYTES = 64 * 1024;

type Op = { kind: ' ' | '-' | '+'; text: string };

function lines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Hunks with three context lines, or null when the change is too large to show. */
export function unifiedDiff(before: string, after: string): string | null {
  const a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_CELLS) return null;
  // Longest-common-subsequence lengths for the changed middle, filled from the end so the walk goes forward.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, start).map(text => ({ kind: ' ', text }));
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[start + i] === b[start + j]) { ops.push({ kind: ' ', text: a[start + i]! }); i++; j++; }
    else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) { ops.push({ kind: '-', text: a[start + i]! }); i++; }
    else { ops.push({ kind: '+', text: b[start + j]! }); j++; }
  }
  for (const text of a.slice(endA)) ops.push({ kind: ' ', text });
  const oldLine: number[] = [], newLine: number[] = [];
  let oldAt = 1, newAt = 1;
  for (const op of ops) {
    oldLine.push(oldAt); newLine.push(newAt);
    if (op.kind !== '+') oldAt++;
    if (op.kind !== '-') newAt++;
  }
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const out: string[] = [];
  for (let h = 0; h < changed.length; h++) {
    const first = changed[h]!;
    // Changes separated by at most twice the context share one hunk.
    while (h + 1 < changed.length && changed[h + 1]! - changed[h]! <= CONTEXT * 2 + 1) h++;
    const from = Math.max(0, first - CONTEXT), to = Math.min(ops.length, changed[h]! + CONTEXT + 1);
    const hunk = ops.slice(from, to);
    const oldCount = hunk.filter(op => op.kind !== '+').length, newCount = hunk.filter(op => op.kind !== '-').length;
    out.push(`@@ -${oldCount ? oldLine[from] : oldLine[from]! - 1},${oldCount} +${newCount ? newLine[from] : newLine[from]! - 1},${newCount} @@`);
    for (const op of hunk) out.push(op.kind + op.text);
  }
  const text = out.join('\n');
  return Buffer.byteLength(text) > MAX_DIFF_BYTES ? null : text;
}
