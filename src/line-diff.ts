/** Unified diff of before → after with two lines of context, or null when it would not be much smaller than resending after. */
export function lineDiff(before: string, after: string): string | null {
  const a = before.split('\n'), b = after.split('\n');
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  if (x.length * y.length > 4_000_000) return null;
  // Longest common subsequence over the changed middle, walked into keep/remove/add operations.
  const w = y.length + 1, table = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
  const ops: Op[] = a.slice(0, head).map((text, i) => ({ kind: ' ', text, ai: i, bi: i }));
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push({ kind: ' ', text: x[i], ai: head + i, bi: head + j }); i++; j++; }
    else if (j < y.length && (i === x.length || table[i * w + j + 1] >= table[(i + 1) * w + j])) { ops.push({ kind: '+', text: y[j], ai: head + i, bi: head + j }); j++; }
    else { ops.push({ kind: '-', text: x[i], ai: head + i, bi: head + j }); i++; }
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: ' ', text: a[a.length - tail + k], ai: a.length - tail + k, bi: b.length - tail + k });
  const changed = ops.flatMap((op, k) => op.kind === ' ' ? [] : [k]);
  if (!changed.length) return '';
  const out: string[] = [];
  for (let k = 0; k < changed.length;) {
    const from = Math.max(0, changed[k] - 2);
    let to = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - to <= 5) to = changed[++k];
    k++;
    const hunk = ops.slice(from, Math.min(ops.length, to + 3));
    out.push(`@@ -${hunk[0].ai + 1},${hunk.filter(op => op.kind !== '+').length} +${hunk[0].bi + 1},${hunk.filter(op => op.kind !== '-').length} @@`, ...hunk.map(op => op.kind + op.text));
  }
  const diff = out.join('\n');
  return diff.length < after.length / 2 ? diff : null;
}
