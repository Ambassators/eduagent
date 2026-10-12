/* npm run build && electron tests/rendering.electron.cjs; no account or microphone. */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const { readFile, writeFile, rm } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'codex-glasstex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }, { scheme: 'codex-presentation', privileges: { standard: true, secure: true } }]);
let win;
const temporary = mkdtempSync(path.join(os.tmpdir(), 'eduagent-rendering-'));
app.setPath('userData', temporary);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Rendering smoke test timed out'); app.exit(1); }, 45000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error('Timed out: ' + description);
}
app.whenReady().then(async () => {
  const { DocumentStore } = await import(path.join(root, 'dist/main/main/documents.js'));
  const { glassTeXResponse } = await import(path.join(root, 'dist/main/main/glasstex.js'));
  const { watchWindowActivity, windowIsActive } = await import(path.join(root, 'dist/main/main/window-activity.js'));
  const { defaultSettings } = await import(path.join(root, 'dist/main/shared.js'));
  const { demoDocument } = await import(path.join(root, 'dist/main/presentation.js'));
  let busy = false;
  const state = () => ({ files: store.list(), activeId: store.activeId, artifacts: [{ id: 'render-test', title: 'Animation test', kind: 'demo', placement: 'side', content: '' }], annotations: { overlays: [], highlights: [], pointer: null }, thinking: { threadId: null, busy, delegating: false, compacting: false, queued: 0, tokens: 0, contextWindow: null, contextVersion: 0 }, quiz: { banks: [], quiz: null } });
  const store = new DocumentStore(path.join(temporary, 'files'), () => {});
  await store.initialize();
  const file = path.join(temporary, 'sample.tex');
  await writeFile(file, '\\documentclass{article}\n\\begin{document}\nTest $x+1$.\n\\end{document}\n');
  await store.open([file]);
  const handlers = {
    windowActivity: () => windowIsActive(win),
    status: async () => ({ connected: false, account: null, models: [], voices: [], voiceAvailable: false, settings: { ...defaultSettings, transparency: 'opaque', ...await readFile(path.join(temporary, 'settings.json'), 'utf8').then(JSON.parse).catch(() => ({})) }, executable: '', platform: process.platform, darkMode: false }),
    settings: async settings => { await writeFile(path.join(temporary, 'settings.json'), JSON.stringify(settings)); return settings; },
    stop: () => {}, interrupt: () => {},
    workspace: state, document: id => store.content(id), documentBytes: id => store.bytes(id),
    syncTranscript: () => {}, present: () => {}, browserState: () => ({ tabs: [], activeId: null, clients: [] })
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle('voice:' + name, (_event, ...args) => fn(...args));
  protocol.handle('codex-glasstex', glassTeXResponse(path.join(root, 'dist/renderer/glasstex')));
  protocol.handle('codex-presentation', () => new Response(demoDocument(`<style>@keyframes pulse{to{opacity:.2}}.pulse{animation:pulse 1s infinite alternate}</style><div class="pulse">Demo</div><script>window.framesRendered=0;function tick(){framesRendered++;requestAnimationFrame(tick)}requestAnimationFrame(tick);</script>`), { headers: { 'Content-Type': 'text/html' } }));
  win = new BrowserWindow({ show: false, paintWhenInitiallyHidden: false, width: 1460, height: 920, webPreferences: { preload: path.join(root, 'dist/main/main/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: true } });
  watchWindowActivity(win);
  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  const ui = code => win.webContents.executeJavaScript(code);
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'false' && !!document.querySelector('.tex-frame') && !document.querySelector('.tex-loading')`), 'initially hidden window pauses rendering');
  const child = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('codex-glasstex:'));
  assert.ok(child);
  const editor = code => child.executeJavaScript(code);
  await waitFor(() => editor(`document.documentElement.dataset.renderActive === 'false'`), 'hidden editor receives activity');
  win.show(); app.focus({ steal: true }); win.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'true'`), 'native focus resumes rendering');
  await waitFor(() => editor(`document.documentElement.dataset.renderActive === 'true'`), 'editor resumes');
  assert.equal(await ui(`document.querySelector('.orb').getAnimations({subtree:true}).length`), 0, 'idle orb has no animations');
  assert.equal(await ui(`(async () => {
    const image = new Image();
    image.src = getComputedStyle(document.querySelector('.orb')).getPropertyValue('--orb-texture').trim().slice(5, -2);
    await image.decode();
    return image.naturalWidth;
  })()`), 192, 'bundled gradient fallback texture loads in the built app');
  assert.equal(await ui(`document.querySelectorAll('.orb .mist').length`), 0, 'no SVG noise textures');
  assert.equal(await ui(`getComputedStyle(document.querySelector('.orb-glow'),'::before').filter`), 'none', 'halo has no blur filter');
  await ui(`document.querySelector('.artifact-list button').click()`);
  await waitFor(() => win.webContents.mainFrame.frames.some(frame => frame.url.startsWith('codex-presentation:')), 'demo loaded');
  const demoFrame = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('codex-presentation:'));
  const demo = code => demoFrame.executeJavaScript(code);
  await waitFor(() => demo(`framesRendered > 1`), 'embedded demo frames run while focused');
  // Exercise the smooth fluid surface without a paid session, then the native focus/visibility boundary.
  const videoFrameStep = () => ui(`new Promise(resolve => {
    const video = document.querySelector('.think-orb video'), times = [];
    const frame = (_now, info) => {
      times.push(info.mediaTime);
      if (times.length < 8) video.requestVideoFrameCallback(frame);
      else { const steps = times.slice(1).map((time, i) => time - times[i]).sort((a,b) => a-b); resolve(steps[3]); }
    };
    video.requestVideoFrameCallback(frame);
  })`);
  busy = true; win.webContents.send('voice:event', { method: 'workspace/changed', params: { workspace: state() } });
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.readyState >= 2 && !document.querySelector('.think-orb video').paused`), 'smooth fluid video plays while focused');
  assert.ok(await videoFrameStep() <= 1 / 50 + .001, 'normal mode delivers a smooth 60fps loop');
  assert.ok(await ui(`document.querySelector('.think-orb video').src.endsWith('-smooth.mp4')`));
  await ui(`window.testVideo=document.querySelector('.think-orb video');`);
  assert.equal(await ui(`document.querySelector('.think-orb .orb').getAnimations({subtree:true}).length`), 0, 'fluid surface has no rotating CSS layers');
  await editor(`document.querySelector('math-field').focus()`);
  await delay(100);
  assert.equal(await ui(`document.documentElement.dataset.renderActive`), 'true', 'focus inside editor keeps native window active');
  const other = new BrowserWindow({ width: 200, height: 120 });
  await other.loadURL('about:blank'); other.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'false'`), 'visible unfocused window pauses');
  await waitFor(() => editor(`document.documentElement.dataset.renderActive === 'false'`), 'unfocused editor pauses');
  await waitFor(() => demo(`document.documentElement.dataset.renderActive === 'false'`), 'demo receives pause');
  await delay(100);
  const before = await ui(`testVideo.currentTime`);
  const demoBefore = await demo(`framesRendered`);
  await delay(200);
  assert.equal(await ui(`testVideo.currentTime`), before, 'fluid playback stops while unfocused');
  assert.equal(await demo(`framesRendered`), demoBefore, 'demo animation frame callbacks stop while unfocused');
  assert.equal(await demo(`getComputedStyle(document.querySelector('.pulse')).animationPlayState`), 'paused', 'demo CSS pauses');
  assert.equal(await editor(`getComputedStyle(document.querySelector('math-field').shadowRoot.querySelector('.ML__caret')).animationPlayState`), 'paused', 'MathLive shadow caret pauses');
  win.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'true'`), 'focus resumes');
  await delay(150);
  assert.ok(await ui(`testVideo.currentTime`) > before, 'fluid playback resumes from paused time');
  assert.ok(await demo(`framesRendered`) > demoBefore, 'demo frame callbacks resume');
  other.destroy();
  win.minimize();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'false'`), 'minimized window pauses');
  win.restore(); win.show(); win.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'true'`), 'restore resumes');
  win.hide();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'false'`), 'hide pauses');
  win.show(); win.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'true'`), 'show resumes');
  // Save the video option through Preferences, and verify actual decoded playback.
  busy = true; win.webContents.send('voice:event', { method: 'workspace/changed', params: { workspace: state() } });
  await waitFor(() => ui(`!!document.querySelector('.think-orb video[src$="-smooth.mp4"]')`), 'normal mode uses the smooth 60fps loop');
  async function setLowPower(enabled) {
    await ui(`document.querySelector('button[title="Preferences"]').click()`);
    await waitFor(() => ui(`document.querySelector('.settings-dialog:not(.history-dialog)').open`), 'preferences open');
    await ui(`if(document.querySelector('input[name="lowPowerMode"]').checked !== ${enabled}) document.querySelector('input[name="lowPowerMode"]').click(); document.querySelector('.settings-dialog:not(.history-dialog) .dialog-footer .button-primary').click();`);
    await waitFor(() => ui(`!document.querySelector('.settings-dialog:not(.history-dialog)').open`), 'preferences saved');
    assert.equal(JSON.parse(await readFile(path.join(temporary, 'settings.json'), 'utf8')).lowPowerMode, enabled, 'video preference persists');
  }
  await setLowPower(true);
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.readyState >= 2 && !document.querySelector('.think-orb video').paused`), 'low power mode plays video');
  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.readyState >= 2 && !document.querySelector('.think-orb video').paused`), 'saved video mode survives renderer restart');
  const frameStep = await videoFrameStep();
  assert.ok(frameStep > 0 && frameStep <= 1 / 24 + .001, 'video delivers at least 24 unique frames per second: ' + frameStep);
  assert.equal(await ui(`document.querySelector('.think-orb .orb').getAnimations({subtree:true}).length`), 0, 'video face has no CSS animations');
  assert.equal(await ui(`document.querySelector('.mic-button > .face video') === null`), true, 'idle voice does not load or decode video');
  const videoOther = new BrowserWindow({ width: 200, height: 120 });
  await videoOther.loadURL('about:blank'); videoOther.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'false' && document.querySelector('.think-orb video')?.paused`), 'visible unfocused video pauses');
  win.focus();
  await waitFor(() => ui(`document.documentElement.dataset.renderActive === 'true' && !document.querySelector('.think-orb video')?.paused`), 'video resumes after native focus');
  videoOther.destroy();
  win.hide();
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.paused`), 'hidden video pauses');
  const videoTime = await ui(`document.querySelector('.think-orb video').currentTime`);
  await delay(200);
  assert.equal(await ui(`document.querySelector('.think-orb video').currentTime`), videoTime, 'paused video clock does not advance');
  win.show(); win.focus();
  await waitFor(() => ui(`!document.querySelector('.think-orb video')?.paused`), 'video resumes on focus');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await ui(`document.querySelector('.face').insertAdjacentHTML('beforeend','<span class="orb-spinner"></span>')`);
  assert.equal(await ui(`document.querySelector('.face').getAnimations({subtree:true}).length`), 0, 'reduced motion disables face and connecting spinner');
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.paused`), 'reduced motion pauses video');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  win.webContents.debugger.detach();
  await ui(`document.querySelector('.think-orb video').dispatchEvent(new Event('error'))`);
  await waitFor(() => ui(`!document.querySelector('.think-orb video') && !!document.querySelector('.think-orb .swirl')`), 'video error falls back to the still gradient');
  await setLowPower(false);
  await waitFor(() => ui(`!!document.querySelector('.think-orb video[src$="-smooth.mp4"]')`), 'normal mode restores smooth fluid playback');
  await waitFor(() => ui(`document.querySelector('.think-orb video')?.readyState >= 2 && !document.querySelector('.think-orb video').paused`), 'normal fluid video is playing');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(100);
  const quietPhase = await ui(`document.querySelector('.think-orb video').currentTime`);
  await delay(200);
  assert.equal(await ui(`document.querySelector('.think-orb video').currentTime`), quietPhase, 'reduced motion stops normal fluid playback');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  win.webContents.debugger.detach();
  console.log('Rendering smoke passed: light fluid orb, saved video mode, actual decoding, pause/resume, reduced motion, native focus/visibility, editor caret, demos');
  clearTimeout(timeout); win.destroy(); await rm(temporary, { recursive: true, force: true }); app.exit(0);
}).catch(async error => { console.error(error); clearTimeout(timeout); win?.destroy(); if (temporary) await rm(temporary, { recursive: true, force: true }); app.exit(1); });
