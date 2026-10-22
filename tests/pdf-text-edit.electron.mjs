/* Focused PDF text editing smoke test. Run after `npm run build` with:
   electron tests/pdf-text-edit.electron.mjs
   Uses a synthetic local PDF; no account, network, or microphone. */
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { defaultSettings } from '../dist/main/shared.js';

app.on('window-all-closed', () => {});
let window;
let profile;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const keepScreenshots = process.env.PDF_TEXT_EDIT_KEEP_SCREENSHOTS === '1';
const cleanupScreenshots = () => keepScreenshots ? Promise.resolve() : Promise.all([
  '/tmp/eduagent-pdf-text-edit-before.png', '/tmp/eduagent-pdf-text-edit-draft.png'
].map(file => unlink(file).catch(() => {})));
async function until(check, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([600, 800]);
  const font = await pdf.embedFont('Helvetica');
  first.drawText('Original title', { x: 60, y: 710, size: 24, font, color: rgb(0.08, 0.12, 0.16) });
  first.drawText('Keep this text', { x: 60, y: 650, size: 16, font, color: rgb(0.08, 0.12, 0.16) });
  // A vector drawing beside the text makes the fixture exercise retained page content.
  first.drawRectangle({ x: 340, y: 510, width: 120, height: 80, borderColor: rgb(0.15, 0.3, 0.55), borderWidth: 2, color: rgb(0.9, 0.94, 1) });
  first.drawLine({ start: { x: 340, y: 510 }, end: { x: 460, y: 590 }, thickness: 2, color: rgb(0.15, 0.3, 0.55) });
  const second = pdf.addPage([720, 540]);
  second.setCropBox(20, 15, 650, 500);
  second.setRotation(degrees(90));
  second.drawText('Rotated page', { x: 50, y: 420, size: 20, font, color: rgb(0.08, 0.12, 0.16) });
  return Buffer.from(await pdf.save());
}

async function main() {
  profile = await mkdtemp(path.join(os.tmpdir(), 'eduagent-pdf-text-'));
  app.setPath('userData', profile);
  console.log('PDF text smoke: waiting for Electron');
  await app.whenReady();

  console.log('PDF text smoke: loading DocumentStore');
  const { DocumentStore } = await import('../dist/main/main/documents.js');
  const sourcePath = path.join(profile, 'source.pdf');
  const originalBytes = await fixture();
  await writeFile(sourcePath, originalBytes);
  let store;
  const state = () => ({
    files: store.list(), activeId: store.activeId, artifacts: [],
    annotations: { overlays: [], highlights: [], pointer: null },
    thinking: { threadId: null, busy: false, delegating: false, compacting: false, queued: 0, tokens: 0, contextWindow: null, contextVersion: 0 },
    quiz: { banks: [], quiz: null }
  });
  store = new DocumentStore(path.join(profile, 'workspace'), () => {
    if (window && !window.isDestroyed()) window.webContents.send('voice:event', { method: 'workspace/changed', params: { workspace: state() } });
  });
  await store.initialize();
  await store.open([sourcePath]);
  console.log('PDF text smoke: fixture opened');
  const file = store.list()[0];
  assert.equal(file.kind, 'pdf');

  const settingsPath = path.join(profile, 'settings.json');
  const savedCopyPath = path.join(profile, 'edited-copy.pdf');
  const handlers = {
    windowActivity: () => true,
    updateState: async () => ({ status: 'idle', currentVersion: '0.0.0' }),
    status: async () => ({ connected: false, account: null, models: [], voices: [], voiceAvailable: false,
      settings: { ...defaultSettings, transparency: 'opaque', lowPowerMode: true }, executable: '', platform: process.platform, darkMode: false }),
    settings: async settings => { await writeFile(settingsPath, JSON.stringify(settings)); return settings; },
    stop: () => {}, interrupt: () => {}, workspace: state,
    document: id => store.content(id), documentBytes: id => store.bytes(id),
    page: (id, page) => store.setPage(id, page),
    editPDFText: (id, revision, change) => store.editPDFText(id, revision, change),
    undoPDFText: (id, revision) => store.undoPDFText(id, revision),
    saveDocument: async (id, original) => { await store.save(id, original ? sourcePath : savedCopyPath, original); return true; },
    updateDocument: (id, body) => store.updateText(id, body),
    syncTranscript: () => {}, browserState: () => ({ tabs: [], activeId: null, clients: [] }),
    dismissPDFAnnotation: () => {}, openURL: () => {}
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`voice:${name}`, (_event, ...args) => handler(...args));

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  window = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: {
    preload: path.join(root, 'dist/main/main/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false
  } });
  window.webContents.on('did-fail-load', (_event, code, description) => console.error('PDF text smoke load failed:', code, description));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('PDF renderer:', message); });
  await window.loadFile(path.join(root, 'dist/renderer/index.html'));
  console.log('PDF text smoke: App loaded');
  const ui = code => window.webContents.executeJavaScript(code);
  await until(() => ui(`!!document.querySelector('.pdf-sheet[data-page="1"][data-text-ready="true"]')`), 'the synthetic PDF page and text layer to render');
  console.log('PDF text smoke: initial PDF rendered');
  const initialScreenshot = await window.webContents.capturePage();
  await writeFile('/tmp/eduagent-pdf-text-edit-before.png', initialScreenshot.toPNG());

  // Replace the page-one title through the visible PDF controls and preserve the neighboring text/vector drawing.
  await ui(`document.querySelector('button[title="Edit PDF"]').click()`);
  await until(() => ui(`!!document.querySelector('button[title="Change text"]')`), 'PDF text editing controls');
  await ui(`document.querySelector('button[title="Change text"]').click()`);
  await until(() => ui(`!!document.querySelector('.pdf-edit-target[aria-label="Replace text: Original title"]')`), 'the detected title target');
  await ui(`document.querySelector('.pdf-edit-target[aria-label="Replace text: Original title"]').click()`);
  await until(() => ui(`!!document.querySelector('.pdf-edit-card textarea')`), 'the replacement editor');
  await ui(`(()=>{for(const [label,value] of [['Replacement width in pixels','300'],['Replacement height in pixels','70']]){const e=document.querySelector('input[aria-label="'+label+'"]');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ui(`(()=>{const e=document.querySelector('.pdf-edit-card textarea');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,'Revised heading');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(150);
  await writeFile('/tmp/eduagent-pdf-text-edit-draft.png', (await window.webContents.capturePage()).toPNG());
  await ui(`document.querySelector('.pdf-edit-card button.primary').click()`);
  console.log('PDF text smoke: replacement submitted');
  await until(() => ui(`document.querySelector('.pdf-scroll')?.dataset.revision === '${file.revision + 1}'`), 'the revised PDF to reload');
  await until(() => ui(`!!document.querySelector('.pdf-sheet[data-page="1"][data-text-ready="true"]')`), 'the revised page to render');
  let extracted = store.content(file.id).text;
  assert.match(extracted, /Revised heading/, 'replacement is searchable in extracted PDF text');
  assert.doesNotMatch(extracted, /Original title/, 'old printed title is removed from PDF text content');
  assert.match(extracted, /Keep this text/, 'unselected text remains');
  assert.deepEqual(await readFile(sourcePath), originalBytes, 'editing never changes the source PDF on disk');

  // Place an added note on the blank second page (rotated and cropped in the fixture).
  await ui(`document.querySelector('button[title="Add text"]').click()`);
  await until(() => ui(`!!document.querySelector('.pdf-edit-layer.is-add')`), 'add-text mode');
  await ui(`document.querySelector('.pdf-sheet[data-page="2"]').scrollIntoView({block:'center'})`);
  await until(() => ui(`!!document.querySelector('.pdf-sheet[data-page="2"] .pdf-edit-layer.is-add')`), 'the second cropped and rotated page in add mode');
  await ui(`(()=>{const e=document.querySelector('.pdf-sheet[data-page="2"] .pdf-edit-layer.is-add'),r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width*.25,clientY:r.top+r.height*.25}));})()`);
  await until(() => ui(`!!document.querySelector('.pdf-edit-card textarea')`), 'the add-text editor');
  await ui(`(()=>{const e=document.querySelector('.pdf-edit-card textarea');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,'Margin note');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await ui(`document.querySelector('.pdf-edit-card button.primary').click()`);
  console.log('PDF text smoke: note submitted');
  await until(() => ui(`document.querySelector('.pdf-scroll')?.dataset.revision === '${file.revision + 2}'`), 'the added note to commit');
  extracted = store.content(file.id).text;
  assert.match(extracted, /Margin note/, 'added note is searchable on the cropped, rotated page');

  // Save a separate copy and verify that opening it retains the changes.
  await ui(`document.querySelector('button[title="Save copy"]').click()`);
  await until(async () => { try { await readFile(savedCopyPath); return true; } catch { return false; } }, 'the Save copy action');
  assert.notDeepEqual(await readFile(savedCopyPath), originalBytes, 'the saved copy contains the edits');
  const reopened = new DocumentStore(path.join(profile, 'reopened'), () => {});
  await reopened.initialize(); await reopened.open([savedCopyPath]);
  assert.match(reopened.content(reopened.list()[0].id).text, /Revised heading/);
  assert.match(reopened.content(reopened.list()[0].id).text, /Margin note/);
  assert.match(reopened.content(reopened.list()[0].id).text, /Keep this text/);

  // Undo is revision-checked; stale requests cannot overwrite newer content.
  await assert.rejects(store.editPDFText(file.id, file.revision, { action: 'add_text', page: 1, x: .2, y: .2, width: .4, height: .06, text: 'stale', fontSize: 14, color: '#202522' }), /changed|revision/i);
  await ui(`Array.from(document.querySelectorAll('.pdf-edit-toolbar button')).find(button=>button.textContent.trim()==='Undo').click()`);
  await until(() => !/Margin note/.test(store.content(file.id).text), 'the toolbar Undo to remove the last added note');
  assert.match(store.content(file.id).text, /Revised heading/, 'toolbar undo preserves the preceding replacement');
  let revision = store.content(file.id).info.revision;
  await store.undoPDFText(file.id, revision);
  assert.doesNotMatch(store.content(file.id).text, /Revised heading/);
  assert.match(store.content(file.id).text, /Original title/);
  assert.match(store.content(file.id).text, /Keep this text/);
  assert.deepEqual(await readFile(sourcePath), originalBytes, 'undo also leaves the source PDF untouched');

  console.log('PASS: PDF text replacement and addition render, preserve nearby content, save/reopen, reject stale edits, and undo without changing the source.');
}

const timeout = setTimeout(() => { console.error('PDF text-edit smoke test timed out'); app.exit(1); }, 60000);
void main().then(async () => {
  clearTimeout(timeout);
  window?.destroy();
  await cleanupScreenshots();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(0);
}).catch(async error => {
  console.error(error);
  clearTimeout(timeout);
  window?.destroy();
  await cleanupScreenshots();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(1);
});
