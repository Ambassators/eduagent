import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserURL, browserCommand } from '../src/browser.ts';

test('browser navigation permits only web URLs and rejects executable/local schemes', () => {
  assert.equal(browserURL('localhost:3000', true), 'http://localhost:3000/');
  assert.equal(browserURL('example.com'), 'https://example.com/');
  assert.equal(browserURL('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/');
  assert.equal(browserURL('learning about cells', true), 'https://www.google.com/search?q=learning%20about%20cells');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://name:secret@example.com', 'chrome://settings']) assert.throws(() => browserURL(url));
});
test('page actions validate selectors, values, and scroll ranges', () => {
  assert.deepEqual(browserCommand({ action:'scroll' }), { action:'scroll', x:0, y:600 });
  assert.deepEqual(browserCommand({ action:'fill', selector:'#email', value:'hello' }), { action:'fill', selector:'#email', value:'hello' });
  for (const input of [{action:'eval',value:'process.exit()'}, {action:'click'}, {action:'fill',selector:'#field'}, {action:'scroll',y:NaN}, {action:'scroll',x:Infinity}, {action:'scroll',y:10001}]) assert.throws(() => browserCommand(input));
});
