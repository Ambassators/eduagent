/* npm run build && electron tests/text-files.electron.cjs; no account or microphone. */
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { writeFile, readFile, rm } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
let win;
const temporary = mkdtempSync(path.join(os.tmpdir(), 'eduagent-text-files-'));
app.setPath('userData', temporary);
const timeout = setTimeout(() => { console.error('Text file smoke test timed out'); app.exit(1); }, 30000);
app.on('window-all-closed', () => {});
async function waitFor(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + description);
}
app.whenReady().then(async () => {
  const { DocumentStore } = await import(path.join(root, 'dist/main/main/documents.js'));
  const { defaultSettings } = await import(path.join(root, 'dist/main/shared.js'));
  const { documentFileFilters, textFileExtensions } = await import(path.join(root, 'dist/main/document-formats.js'));
  for (const extension of ['sql', 'kt', 'java', 'py', 'ts', 'yaml', 'toml']) assert.ok(documentFileFilters[0].extensions.includes(extension));
  const sql = '-- Study query\r\nSELECT\r\n\tname, \'<script>window.sqlExecuted = true</script>\'\r\nFROM students;\r\n' + '-- ' + 'long_column_'.repeat(150) + '\r\n';
  const filePath = path.join(temporary, 'QUERY.SQL'); await writeFile(filePath, sql);
  const store = new DocumentStore(path.join(temporary, 'files'), () => {
    if (win && !win.isDestroyed()) win.webContents.send('voice:event', { method: 'workspace/changed', params: { workspace: state() } });
  });
  const state = () => ({ files: store.list(), activeId: store.activeId, artifacts: [], annotations: { overlays: [], highlights: [], pointer: null }, thinking: { threadId: null, busy: false, delegating: false, compacting: false, queued: 0, tokens: 0, contextWindow: 0 }, quiz: { banks: [], quiz: null } });
  await store.initialize(); await store.open([filePath]);
  const sqlFile = store.list()[0]; assert.equal(sqlFile.kind, 'text'); assert.equal(store.content(sqlFile.id).text, sql);
  assert.ok(store.context().includes('FROM students;'));
  // Every advertised text format reaches the text reader, including empty files.
  for (const extension of textFileExtensions) {
    const fixture = path.join(temporary, 'fixture.' + extension); await writeFile(fixture, ''); await store.open([fixture]);
    assert.equal(store.get(store.activeId).info.kind, 'text', extension); await store.close(store.activeId);
  }
  const bePath = path.join(temporary, 'utf16.unknown');
  await writeFile(bePath, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('SELECT café;', 'utf16le').swap16()]));
  await store.open([bePath]); assert.equal(store.content(store.activeId).text, 'SELECT café;');
  const binary = path.join(temporary, 'data.bin'); await writeFile(binary, Buffer.from([0, 1, 2, 3]));
  await store.open([binary]); assert.equal(store.get(store.activeId).info.kind, 'binary');
  await store.select(sqlFile.id);
  const handlers = {
    windowActivity: () => true,
    updateState: () => ({ status: 'disabled', currentVersion: '0.0.6' }),
    status: () => ({ connected: false, account: null, models: [], voices: [], voiceAvailable: false, settings: defaultSettings, executable: '', platform: process.platform, darkMode: false }),
    workspace: state, document: id => store.content(id), documentBytes: id => store.bytes(id),
    updateDocument: (id, text) => store.updateText(id, text), syncTranscript: () => {},
    browserState: () => ({ tabs: [], activeId: null, clients: [] })
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle('voice:' + name, (_event, ...args) => handler(...args));
  win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload: path.join(root, 'dist/main/main/preload.cjs'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  const ui = code => win.webContents.executeJavaScript(code);
  await waitFor(() => ui(`!!document.querySelector('.source-paper .plain-document')`), 'SQL source preview');
  assert.equal(await ui(`document.querySelector('.plain-document').textContent`), sql.replaceAll('\r\n', '\n'));
  assert.equal(await ui(`window.sqlExecuted`), undefined);
  assert.equal(await ui(`document.querySelector('.source-paper .hljs-keyword')?.textContent`), 'SELECT');
  assert.equal(await ui(`document.querySelector('.source-paper .hljs-comment')?.textContent`), '-- Study query');
  assert.equal(await ui(`getComputedStyle(document.querySelector('.hljs-keyword')).color !== getComputedStyle(document.querySelector('.plain-document')).color`), true);
  assert.equal(await ui(`getComputedStyle(document.querySelector('.plain-document')).whiteSpace`), 'pre');
  assert.equal(await ui(`(() => { const host = document.querySelector('.source-scroll'); return host.scrollWidth > host.clientWidth && document.documentElement.scrollWidth <= window.innerWidth; })()`), true, 'long queries scroll inside the source preview');
  await ui(`document.querySelector('[aria-label="Wrap lines"]').click()`);
  await waitFor(() => ui(`getComputedStyle(document.querySelector('.plain-document')).whiteSpace === 'pre-wrap'`), 'line wrapping');
  await ui(`document.querySelector('button[title="Edit"]').click()`);
  await waitFor(() => ui(`!!document.querySelector('textarea[aria-label="Edit document text"]')`), 'SQL editor');
  const edited = 'SELECT id FROM students;\n';
  await ui(`(() => { const input = document.querySelector('textarea[aria-label="Edit document text"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(edited)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await ui(`document.querySelector('.text-editor .button-primary').click()`);
  await waitFor(() => store.content(sqlFile.id).text === edited, 'applying SQL edits');
  assert.equal(await readFile(filePath, 'utf8'), sql, 'editing preserves the original until explicitly saved');
  await store.save(sqlFile.id, path.join(temporary, 'saved.sql'), false);
  assert.equal(await readFile(path.join(temporary, 'saved.sql'), 'utf8'), edited);
  const restored = new DocumentStore(path.join(temporary, 'files'), () => {}); await restored.initialize();
  assert.equal(restored.content(sqlFile.id).text, edited);
  console.log('Text file smoke passed: source formats, SQL preview/edit/save, wrapping, UTF-16, binary fallback, and restored working copies.');
}).then(async () => { clearTimeout(timeout); win?.destroy(); if (temporary) await rm(temporary, { recursive: true, force: true }); app.exit(0); }).catch(async error => { console.error(error); clearTimeout(timeout); win?.destroy(); if (temporary) await rm(temporary, { recursive: true, force: true }); app.exit(1); });
