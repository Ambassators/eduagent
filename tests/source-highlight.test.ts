import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSource } from '../src/renderer/source-highlight.ts';

test('SQL highlights keywords, comments, and strings while escaping markup', () => {
  const html = highlightSource("-- Notes\nSELECT '<script>alert(1)</script>' FROM students;", '.SQL');
  assert.match(html!, /hljs-keyword/); assert.match(html!, /hljs-comment/); assert.match(html!, /hljs-string/);
  assert.ok(!html!.includes('<script>')); assert.ok(html!.includes('&lt;script&gt;'));
});
test('source and configuration extensions select their language grammars', () => {
  for (const [extension, text] of [
    ['.kts', 'val name = "Jordan"'], ['.java', 'public class Student {}'],
    ['.tsx', 'const id: number = 1;'], ['.py', 'def study(): return True'],
    ['.yaml', 'name: Jordan'], ['.toml', '[app]\nname = "Study"'],
    ['.ps1', 'Write-Host "Hello"'], ['.gradle', 'plugins { id "java" }']
  ]) assert.match(highlightSource(text, extension)!, /hljs-/, extension);
});
test('unknown formats and large dumps fall back to unchanged plain text', () => {
  assert.equal(highlightSource('plain text', '.unknown'), null);
  assert.equal(highlightSource('SELECT '.repeat(50000), '.sql'), null);
});
