import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '../src/line-diff.ts';
const doc = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
/** Applies a lineDiff result to before, checking each hunk's context and removals. */
function apply(before: string, diff: string) {
  const lines = before.split('\n'), out: string[] = [];
  let at = 0;
  for (const hunk of diff.split(/^(?=@@)/m)) {
    const [header, ...body] = hunk.replace(/\n$/, '').split('\n');
    const start = Number(/^@@ -(\d+)/.exec(header)![1]) - 1;
    out.push(...lines.slice(at, start)); at = start;
    for (const line of body) {
      if (line[0] === '+') out.push(line.slice(1));
      else { assert.equal(lines[at], line.slice(1)); if (line[0] === ' ') out.push(line.slice(1)); at++; }
    }
  }
  return [...out, ...lines.slice(at)].join('\n');
}
test('scattered edits become small hunks that rebuild the new text', () => {
  const after = doc.replace('line 3\n', 'line 3 edited\n').replace('line 40\n', '').replace('line 55', 'line 55\nnew line');
  const diff = lineDiff(doc, after)!;
  assert.equal(diff.match(/^@@/gm)?.length, 3);
  assert.ok(diff.length < 300);
  assert.equal(apply(doc, diff), after);
});
test('edits at the very start and end apply cleanly', () => {
  const after = `new first\n${doc.replace('line 1\n', '')}\nnew last`;
  assert.equal(apply(doc, lineDiff(doc, after)!), after);
});
test('rewrites fall back to a full copy and identical text gives an empty diff', () => {
  assert.equal(lineDiff(doc, doc.replaceAll('line', 'row')), null);
  assert.equal(lineDiff(doc, doc), '');
});
