/* Run after building: electron tests/glasstex.electron.cjs. Uses isolated temporary files and no account. */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const { writeFile, readFile, rm } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'codex-glasstex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win;
const temporary = mkdtempSync(path.join(os.tmpdir(), 'glasstex-test-'));
app.setPath('userData', temporary);
const timeout = setTimeout(() => { console.error('GlassTeX smoke test timed out'); app.exit(1); }, 45000);
async function waitFor(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('Timed out: ' + description);
}
app.whenReady().then(async () => {
  const { DocumentStore } = await import(path.join(root, 'dist/main/main/documents.js'));
  const { glassTeXResponse, renderTeXPDF, cleanTeXSettings } = await import(path.join(root, 'dist/main/main/glasstex.js'));
  const { defaultSettings } = await import(path.join(root, 'dist/main/shared.js'));
  const original = '\uFEFF% retained comment\r\n\\documentclass{article}\r\n\\usepackage{amsmath}\r\n\\begin{document}\r\n\\section{GlassTeX integration}\r\nHello 🧮\r\n\\[1+2\\]\r\n\\end{document}\r\n';
  const filePath = path.join(temporary, 'sample.tex'), plainPath = path.join(temporary, 'notes.txt');
  await writeFile(filePath, original); await writeFile(plainPath, 'A regular text file.');
  const workspaceState = () => ({ files: store.list(), activeId: store.activeId, artifacts: [], annotations: { overlays: [], highlights: [], pointer: null }, thinking: { threadId: null, busy: false, delegating: false, compacting: false, queued: 0, tokens: 0, contextWindow: null, contextVersion: 0 }, quiz: { banks: [], quiz: null } });
  const store = new DocumentStore(path.join(temporary, 'files'), () => { if (win && !win.isDestroyed()) win.webContents.send('voice:event', { method: 'workspace/changed', params: { workspace: workspaceState() } }); });
  await store.initialize(); await store.open([plainPath, filePath]);
  const tex = store.list().find(file => file.kind === 'tex'), plain = store.list().find(file => file.kind === 'text');
  assert.equal(store.content(tex.id).text, original);
  const invalidPath = path.join(temporary, 'invalid.tex'); await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(store.open([invalidPath]), /UTF-8/);
  await assert.rejects(store.updateText(tex.id, 'stale', 0), /document changed/);
  protocol.handle('codex-glasstex', glassTeXResponse(path.join(root, 'dist/renderer/glasstex')));
  const handlers = {
    status: () => ({ connected: false, account: null, models: [], voices: [], voiceAvailable: false, settings: { ...defaultSettings, transparency: 'opaque' }, executable: '', platform: process.platform, darkMode: false }),
    workspace: workspaceState, document: id => store.content(id), documentBytes: id => store.bytes(id),
    updateTeXDocument: (id, source, revision) => store.updateText(id, source, revision),
    selectFile: async id => { await store.select(id); return workspaceState(); }, closeFile: async id => { await store.close(id); return workspaceState(); },
    saveDocument: async id => { await store.save(id, path.join(temporary, 'saved.tex'), false); return true; },
    syncTranscript: () => {}, browserState: () => ({ tabs: [], activeId: null, clients: [] })
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle('voice:' + name, (_event, ...args) => fn(...args));
  win = new BrowserWindow({ show: false, width: 1460, height: 920, webPreferences: { preload: path.join(root, 'dist/main/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Renderer:', event.message, event.sourceId, event.lineNumber); } });
  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  const ui = code => win.webContents.executeJavaScript(code);
  await waitFor(() => ui(`Boolean(document.querySelector('.tex-command-rail button:not(:disabled)')) && !document.querySelector('.tex-loading')`), 'GlassTeX ready');
  const child = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('codex-glasstex:'));
  assert.ok(child, 'editor frame exists');
  const editor = code => child.executeJavaScript(code);
  assert.equal(await editor('GlassTeX.snapshot().source'), original);
  assert.equal(await editor('typeof window.desktop'), 'undefined', 'frame has no desktop bridge');
  const heights = await ui(`(() => { const a=document.querySelector('.rail-library-stack .library').getBoundingClientRect(), b=document.querySelector('.rail-tex-slot').getBoundingClientRect(); return [a.height,b.height,a.bottom,b.top]; })()`);
  assert.ok(Math.abs(heights[0] - heights[1]) <= 1, '50/50 rail split ' + JSON.stringify(heights)); assert.ok(Math.abs(heights[2] - heights[3]) <= 1, 'commands below file list');
  assert.equal(await ui(`document.querySelectorAll('.tex-feature').length`), 443);
  win.setSize(1080, 760);
  await ui(`document.querySelector('.workspace').classList.add('with-presentation')`);
  assert.equal(await ui(`getComputedStyle(document.querySelector('.rail-left')).display`), 'flex', 'TeX sidebar survives narrow presentations');
  assert.equal(await ui(`getComputedStyle(document.querySelector('.rail-right')).display`), 'none');
  await ui(`document.querySelector('.workspace').classList.remove('with-presentation')`); win.setSize(1460, 920);
  await ui(`Array.from(document.querySelectorAll('.tex-rail-footer button')).find(b=>b.textContent==='Settings…').click()`);
  await waitFor(() => ui(`document.querySelector('.tex-dialog').open`), 'settings dialog');
  await ui(`(() => { const select=document.querySelector('.tex-settings select'); select.value='light'; select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[aria-label="Close dialog"]').click(); })()`);
  assert.equal(await ui(`JSON.parse(localStorage.getItem('glasstex.settings')).appearance`), 'light');
  await ui(`Array.from(document.querySelectorAll('.tex-rail-footer button')).find(b=>b.textContent==='Custom command').click()`);
  await waitFor(() => ui(`document.querySelector('.tex-dialog').open`), 'custom command dialog');
  await ui(`(() => { const form=document.querySelector('.tex-dialog form'), input=form.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Test function');input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await ui(`document.querySelector('.tex-dialog form').requestSubmit()`);
  await waitFor(() => ui(`document.querySelectorAll('.tex-feature').length===444`), 'custom command saved');
  await ui(`Array.from(document.querySelectorAll('.tex-rail-footer button')).find(b=>b.textContent==='Custom command').click()`);
  await waitFor(() => ui(`document.querySelector('.tex-dialog').open`), 'custom command management');
  await ui(`document.querySelector('[aria-label="Delete Test function"]').click();document.querySelector('[aria-label="Close dialog"]').click()`);
  assert.equal(await ui(`document.querySelectorAll('.tex-feature').length`), 443);
  await editor(`window.testMessages=[];const originalPost=window.webkit.messageHandlers.editor.postMessage;window.webkit.messageHandlers.editor.postMessage=(m)=>{testMessages.push(m);originalPost(m)};const mf=document.querySelector('math-field'); mf.focus(); mf.dispatchEvent(new FocusEvent('focus'));`);
  try { await waitFor(() => ui(`Boolean(document.querySelector('.tex-assistant button'))`), 'local calculation'); }
  catch(error) { console.error(await editor(`JSON.stringify({fields:[...document.querySelectorAll('math-field')].map(m=>m.value),messages:testMessages,worker:typeof SOLVER_WORKER_SOURCE})`)); throw error; }
  await ui(`document.querySelector('.tex-assistant button').click()`);
  await waitFor(() => store.content(tex.id).text.includes('1+2=3'), 'accepted result persisted');
  const edited = store.content(tex.id).text;
  assert.equal(edited, original.replace('1+2', '1+2=3'), 'source fidelity');
  await editor(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await waitFor(() => store.content(tex.id).text === original, 'undo persisted');
  await editor(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`);
  await waitFor(() => store.content(tex.id).text === edited, 'redo persisted');
  await ui(`document.querySelector('[aria-label="Insert Table"]').click()`);
  await waitFor(() => store.content(tex.id).text.includes('\\begin{tabular}'), 'table insertion persisted');
  assert.equal(await editor(`document.querySelectorAll('.document-table td').length`), 4);
  await ui(`document.querySelector('.tex-rail-footer button').click()`);
  await waitFor(() => ui(`Boolean(document.querySelector('.tex-source'))`), 'source mode');
  const beforeSourceEdit = store.content(tex.id).text;
  await ui(`(() => { const t=document.querySelector('.tex-source'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(t,t.value.replace('Hello','Edited Hello')); t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => store.content(tex.id).text.includes('Edited Hello'), 'source edit persisted');
  await ui(`document.querySelector('.tex-rail-footer button').click()`);
  await waitFor(() => editor(`GlassTeX.snapshot().source.includes('Edited Hello')`), 'visual mode synchronized');
  // External agent edits must replace the visual/source state rather than being overwritten.
  await store.updateText(tex.id, store.content(tex.id).text.replace('Edited Hello', 'Agent Hello'));
  await waitFor(() => editor(`GlassTeX.snapshot().source.includes('Agent Hello')`), 'external edit synchronized');
  await ui(`document.querySelector('.file-row:not(.active) .file-select').click()`);
  await waitFor(() => ui(`!document.querySelector('.tex-command-rail') && Boolean(document.querySelector('.plain-document'))`), 'non-TeX layout restored');
  await ui(`document.querySelector('.file-row:not(.active) .file-select').click()`);
  await waitFor(() => ui(`Boolean(document.querySelector('.tex-command-rail')) && !document.querySelector('.tex-loading')`), 'TeX reopening');
  assert.equal(store.activeId, tex.id);
  await ui(`Array.from(document.querySelectorAll('.doc-actions button')).find(b=>b.textContent==='Save copy').click()`);
  await waitFor(async () => { try { return (await readFile(path.join(temporary, 'saved.tex'), 'utf8')).includes('Agent Hello'); } catch { return false; } }, 'save copy');
  const reopened = new DocumentStore(path.join(temporary, 'files'), () => {}); await reopened.initialize();
  assert.equal(reopened.content(tex.id).text, store.content(tex.id).text, 'working copy survives restart');
  const pdf = await renderTeXPDF(store.content(tex.id).text, cleanTeXSettings({ appearance: 'dark' }));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const { PDFDocument } = await import('pdf-lib'); const parsed = await PDFDocument.load(pdf); assert.ok(parsed.getPageCount() >= 1);
  await writeFile(path.join(temporary, 'rendered.pdf'), pdf);
  await writeFile(path.join(os.tmpdir(), 'glasstex-integration.png'), (await win.webContents.capturePage()).toPNG());
  assert.ok(!errors.some(error => /Refused to|Uncaught|not allowed|ERR_/i.test(error)), errors.join('\n'));
  assert.ok(beforeSourceEdit.includes('Hello')); assert.equal(plain.kind, 'text');
  console.log('GlassTeX Electron smoke passed: visual editing, solver, source preservation, undo/redo, tables, source mode, external edits, file switching, 50/50 rail, saving, restart, and PDF export.');
}).then(async () => { clearTimeout(timeout); win?.destroy(); await rm(temporary, { recursive: true, force: true }); app.exit(0); }).catch(async error => { console.error(error); clearTimeout(timeout); win?.destroy(); if (temporary) await rm(temporary, { recursive: true, force: true }); app.exit(1); });
