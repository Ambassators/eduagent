import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTeXPatch, canonicalTeXShortcut, cleanTeXSettings, defaultTeXSettings, isTeXExtension, TeXHistory } from '../src/glasstex.ts';

test('visual equation patches preserve BOM, CRLF, comments, preamble, and unrelated Unicode', () => {
  const source = '\uFEFF% keep this\r\n\\documentclass{article}\r\n\\begin{document}\r\nHello 🧮\r\n\\[1+2\\]\r\n\\end{document}\r\n';
  const start = source.indexOf('1+2');
  const next = applyTeXPatch(source, 7, { start, end: start + 3, expected: '1+2', replacement: '\\frac{1}{2}', revision: 7 });
  assert.equal(next, source.replace('1+2', '\\frac{1}{2}'));
});

test('stale patches, content mismatches, invalid ranges, and split surrogate pairs are rejected', () => {
  const source = 'A🧮B';
  const patch = { start: 1, end: 3, expected: '🧮', replacement: 'x', revision: 2 };
  assert.equal(applyTeXPatch(source, 2, patch), 'AxB');
  assert.throws(() => applyTeXPatch(source, 3, patch), /document changed/);
  assert.throws(() => applyTeXPatch(source, 2, { ...patch, expected: 'other' }), /no longer agree/);
  assert.throws(() => applyTeXPatch(source, 2, { ...patch, start: 2 }), /Invalid source range/);
  assert.throws(() => applyTeXPatch(source, 2, { ...patch, end: 2 }), /Invalid source range/);
  assert.throws(() => applyTeXPatch(source, 2, { ...patch, end: 100 }), /Invalid source range/);
});

test('all original GlassTeX extensions are recognized case-insensitively', () => {
  for (const extension of ['.tex', '.ltx', '.latex', '.TEX']) assert.equal(isTeXExtension(extension), true);
  for (const extension of ['.txt', '.pdf', '.tex.bak']) assert.equal(isTeXExtension(extension), false);
});

test('custom shortcuts canonicalize modifiers and preserve application shortcuts', () => {
  assert.equal(canonicalTeXShortcut(' Shift + CMD + F '), 'cmd+shift+f');
  assert.equal(canonicalTeXShortcut(''), '');
  for (const shortcut of ['cmd+s', 'ctrl+s', 'cmd+shift+l', 'ctrl+alt+e', 'alt+f', 'cmd+cmd+f', 'cmd+ArrowUp']) assert.throws(() => canonicalTeXShortcut(shortcut));
});

test('stored and export preferences reject invalid types and clamp supported ranges', () => {
  assert.deepEqual(cleanTeXSettings(null), defaultTeXSettings);
  const settings = cleanTeXSettings({ appearance: 'invalid', automatic: 'false', fontSize: 500, customLineSpacing: NaN, customListSpacing: -1, angleMode: 'degrees' });
  assert.equal(settings.appearance, 'system'); assert.equal(settings.automatic, true);
  assert.equal(settings.fontSize, 32); assert.equal(settings.customLineSpacing, 1.25);
  assert.equal(settings.customListSpacing, 0); assert.equal(settings.angleMode, 'degrees');
});

test('undo history restores sources in order, and a new edit clears redo', () => {
  const history = new TeXHistory();
  assert.equal(history.undo('a'), null);
  history.record('a'); history.record('ab');
  assert.equal(history.undo('abc'), 'ab');
  assert.equal(history.undo('ab'), 'a');
  assert.equal(history.undo('a'), null);
  assert.equal(history.redo('a'), 'ab');
  history.record('ab');
  assert.equal(history.redo('abX'), null);
  assert.equal(history.undo('abX'), 'ab');
});

test('undo history is bounded by count and memory but keeps the latest snapshot', () => {
  const counted = new TeXHistory(3);
  for (const text of ['1', '2', '3', '4', '5']) counted.record(text);
  assert.deepEqual([counted.undo('6'), counted.undo('5'), counted.undo('4'), counted.undo('3')], ['5', '4', '3', null]);
  const sized = new TeXHistory(200, 10);
  sized.record('aaaa'); sized.record('bbbbbbbbbb');
  assert.equal(sized.undo('c'), 'bbbbbbbbbb');
  assert.equal(sized.undo('b'), null);
});
