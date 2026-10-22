/* Focused renderer smoke test for a real exam document. Run after building:
 *   electron tests/glasstex-exam.electron.cjs /path/to/exam.tex
 * The fixture is read-only; its sibling graphics are resolved through DocumentStore.texAssets.
 */
const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const { readFile, writeFile, rm } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
if (!process.argv[2]) {
  console.error('Usage: electron tests/glasstex-exam.electron.cjs /path/to/exam.tex');
  process.exit(2);
}
const fixture = path.resolve(process.argv[2]);
const temporary = mkdtempSync(path.join(os.tmpdir(), 'glasstex-exam-'));
app.setPath('userData', temporary);
protocol.registerSchemesAsPrivileged([{ scheme: 'codex-glasstex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const timeout = setTimeout(() => { console.error('GlassTeX exam smoke test timed out'); app.exit(1); }, 45_000);
let win;

async function waitFor(check, description, duration = 12_000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

app.whenReady().then(async () => {
  const source = await readFile(fixture, 'utf8');
  const { DocumentStore } = await import(path.join(root, 'dist/main/main/documents.js'));
  const { glassTeXResponse } = await import(path.join(root, 'dist/main/main/glasstex.js'));
  const store = new DocumentStore(path.join(temporary, 'files'), () => {});
  await store.initialize();
  await store.open([fixture]);
  const file = store.list().find(item => item.kind === 'tex');
  assert.ok(file, `expected TeX fixture: ${fixture}`);
  const original = store.content(file.id).text;
  assert.equal(original, source, 'opening the fixture preserves its source exactly');
  const assets = await store.texAssets(file.id);
  assert.ok(Object.keys(assets).length >= 2, 'both sibling PDF graphics are available to the renderer');

  protocol.handle('codex-glasstex', glassTeXResponse(path.join(root, 'dist/renderer/glasstex')));
  win = new BrowserWindow({ show: false, width: 1200, height: 950, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); });
  await win.loadURL('codex-glasstex://editor/index.html');
  const evaluate = script => win.webContents.executeJavaScript(script);
  await waitFor(() => evaluate(`Boolean(window.GlassTeX && window.MathfieldElement && document.querySelector('#page'))`), 'GlassTeX renderer');
  const payload = JSON.stringify({ source: original, assets });
  await evaluate(`(() => { const p=${payload}; GlassTeX.receive({action:'assets',assets:p.assets}); GlassTeX.setDocument({source:p.source,revision:0,initial:true,force:true}); })()`);
  await waitFor(() => evaluate(`GlassTeX.snapshot().source === ${JSON.stringify(original)} && document.querySelectorAll('#page > *').length > 0`), 'exam layout');
  await waitFor(() => evaluate(`[...document.images].filter(image=>image.complete&&image.naturalWidth>0).length >= 2`), 'both exam graphics', 8_000);

  const rendered = await evaluate(`(() => {
    const tokens=GlassTeX.snapshot().tokens;
    const raw=[...document.querySelectorAll('.source-fragment')].map(el=>el.textContent).join('\\n');
    return {
      source: GlassTeX.snapshot().source,
      questionCount: tokens.filter(token=>token.kind==='examItem'&&token.level==='question').length,
      visibleQuestions: document.querySelectorAll('.exam-marker').length,
      raw,
      editable: document.querySelectorAll('#page [contenteditable="true"]').length,
      math: document.querySelectorAll('#page math-field').length,
      images: [...document.images].filter(image=>image.complete&&image.naturalWidth>0).length
    };
  })()`);
  assert.equal(rendered.source, original, 'renderer retains the complete original source');
  assert.ok(rendered.questionCount >= 6, `expected at least six parsed question markers, got ${rendered.questionCount}`);
  assert.ok(rendered.visibleQuestions >= 6, `expected visible exam markers, got ${rendered.visibleQuestions}`);
  assert.equal(rendered.raw.trim(), '', `exam markup has no raw source fragments: ${rendered.raw}`);
  assert.ok(rendered.editable > 10, `expected editable prose and answer areas, got ${rendered.editable}`);
  assert.ok(rendered.math > 5, `expected editable math fields, got ${rendered.math}`);
  assert.ok(rendered.images >= 2, `expected both loaded exam graphics, got ${rendered.images}`);

  const edit = await evaluate(`(() => {
    const el=[...document.querySelectorAll('#page .text-run')].find(node=>node.textContent.trim().length>8 && !node.closest('.exam-marker'));
    if(!el) throw new Error('No editable prose token found');
    el.focus();
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    let text=walker.nextNode();
    while(text && !text.data.length) text=walker.nextNode();
    if(!text) throw new Error('Could not locate a source-backed prose token');
    const offset=Math.min(3,text.data.length);
    const range=document.createRange();range.setStart(text,offset);range.collapse(true);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    const inserted=document.createTextNode('Z');
    range.insertNode(inserted);
    range.setStartAfter(inserted);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
    const before=GlassTeX.snapshot().source;
    el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Z'}));
    return {before, renderedText:el.textContent};
  })()`);
  await waitFor(() => evaluate(`GlassTeX.snapshot().source.length === ${edit.before.length + 1}`), 'single prose insertion');
  const after = await evaluate('GlassTeX.snapshot().source');
  const firstDifference = [...edit.before].findIndex((character, index) => character !== after[index]);
  assert.ok(firstDifference >= edit.before.indexOf('\\begin{document}'), 'editing prose leaves the exam preamble untouched');
  assert.equal(after, edit.before.slice(0, firstDifference) + 'Z' + edit.before.slice(firstDifference), 'the edit patches only the selected prose character position');
  assert.ok(await evaluate(`document.querySelectorAll('#page [contenteditable="true"]').length > 10 && document.querySelectorAll('#page math-field').length > 5`), 'the edited exam remains visually editable');

  await evaluate('window.scrollTo(0,0)');
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(path.join(os.tmpdir(), 'glasstex-exam.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate(`(() => { const sections=document.querySelectorAll('.document-minipage'); const target=sections[sections.length-1]; target?.scrollIntoView({block:'center'}); return Boolean(target); })()`);
  await new Promise(resolve => setTimeout(resolve, 250));
  await writeFile(path.join(os.tmpdir(), 'glasstex-exam-formula.png'), (await win.webContents.capturePage()).toPNG());
  console.log(`GlassTeX exam smoke passed: ${path.basename(fixture)}, ${rendered.questionCount} parsed questions, ${rendered.images} loaded graphics, ${rendered.editable} editable regions.`);
}).then(async () => {
  clearTimeout(timeout); win?.destroy(); await rm(temporary, { recursive: true, force: true }); app.exit(0);
}).catch(async error => {
  console.error(error); clearTimeout(timeout); win?.destroy(); await rm(temporary, { recursive: true, force: true }); app.exit(1);
});
