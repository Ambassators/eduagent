// Run after npm run build: electron tests/updates.electron.mjs
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { defaultSettings } from '../dist/main/shared.js';

async function main() {
  await app.whenReady();
  let settings = { ...defaultSettings }, state = { status: 'idle', currentVersion: '0.0.4' };
  let downloads = 0, installs = 0, savedChats = 0, openedDownloads = 0, finishDownload;
  const win = new BrowserWindow({ width: 1460, height: 920, show: false,
    webPreferences: { preload: path.resolve('dist/main/main/preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true } });
  const update = next => { state = { currentVersion: '0.0.4', ...next }; win.webContents.send('voice:event', { method: 'app/update', params: { state } }); return state; };
  const handlers = {
    windowActivity: () => true,
    status: () => ({ connected: true, account: null, models: [], voices: [], voiceAvailable: false, settings, platform: process.platform, darkMode: false }),
    workspace: () => ({ files: [], activeId: null, artifacts: [], thinking: { tokens: 0 }, annotations: { overlays: [], highlights: [], pointer: null }, quiz: {} }),
    browserState: () => null, stop: () => {}, interrupt: () => {}, syncTranscript: () => {},
    saveChat: () => { savedChats++; }, settings: next => { settings = next; return settings; },
    updateState: () => state,
    checkForUpdates: async () => { update({ status: 'checking' }); await new Promise(resolve => setTimeout(resolve, 60)); return update({ status: 'available', version: '0.0.5' }); },
    downloadUpdate: async () => { downloads++; update({ status: 'downloading', version: '0.0.5', percent: 42 }); await new Promise(resolve => { finishDownload = resolve; }); return state; },
    installUpdate: () => { installs++; assert.ok(savedChats > 0, 'chat must be saved before install'); return update({ status: 'installing', version: '0.0.5' }); },
    updateDownloads: () => { openedDownloads++; }
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(`voice:${name}`, (_, ...args) => fn(...args));
  const js = source => win.webContents.executeJavaScript(source);
  const wait = async source => { for (let i = 0; i < 100; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error('Timeout: ' + source); };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async name => { win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150)); await writeFile(`/tmp/eduagent-update-${name}.png`, (await win.webContents.capturePage()).toPNG()); };
  const setMessage = value => js(`(()=>{const input=document.querySelector('#message');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  try {
    await win.loadFile(path.resolve('dist/renderer/index.html'));
    await wait(`!!document.querySelector('.account.signed-out')`);
    await click('[title="Preferences"]');
    await wait(`document.querySelector('.settings-dialog:last-of-type').open`);
    await click('.app-updates button');
    await wait(`document.querySelector('.app-updates').textContent.includes('0.0.5')`);
    await capture('preferences');
    await js(`[...document.querySelectorAll('.settings-dialog:last-of-type .dialog-footer button')].find(button=>button.textContent==='Done').click()`);
    await wait(`!document.querySelector('.settings-dialog:last-of-type').open`);
    await capture('available');
    await click('[aria-label="Remind me later"]');
    assert.equal(await js(`!!document.querySelector('.update-toast')`), false);
    await click('[title="Preferences"]');
    await wait(`document.querySelector('.settings-dialog:last-of-type').open`);
    assert.match(await js(`document.querySelector('.app-updates').textContent`), /Update now/);
    await click('.app-updates button');
    await wait(`document.querySelector('.app-updates progress')?.value===42`);
    await click('.app-updates button'); assert.equal(downloads, 1);
    update({ status: 'error', version: '0.0.5', retry: 'download', message: 'The update could not be downloaded or verified. Try again or open Downloads.' });
    finishDownload();
    await wait(`document.querySelector('.app-updates').textContent.includes('Retry download')`);
    await click('.app-updates button:last-child'); await wait(`true`);
    assert.equal(openedDownloads, 1);
    await click('.app-updates button');
    await wait(`document.querySelector('.app-updates progress')?.value===42`);
    await js(`[...document.querySelectorAll('.settings-dialog:last-of-type .dialog-footer button')].find(button=>button.textContent==='Done').click()`);
    await wait(`!document.querySelector('.settings-dialog:last-of-type').open`);
    win.setSize(1000, 680); await capture('progress');
    update({ status: 'downloaded', version: '0.0.5' }); finishDownload();
    await wait(`document.querySelector('.update-toast button')?.textContent==='Restart to install' && !document.querySelector('.update-toast button').disabled`);
    await setMessage('Unsent draft');
    await click('.update-toast .update-action');
    await wait(`document.querySelector('.update-toast').textContent.includes('Send or clear')`);
    assert.equal(installs, 0);
    await setMessage('');
    win.webContents.send('voice:event', { method: 'think/delta', params: { itemId: 'saved-result', delta: 'Keep this answer.' } });
    await click('.update-toast .update-action');
    await wait(`document.querySelector('.update-toast').textContent.includes('Restarting to install')`);
    assert.equal(installs, 1); assert.equal(downloads, 2);
    console.log('PASS: manual check, update notice, dismissal, preferences recovery, progress, failure, Downloads, retry, unsent draft protection, and save before restart.');
  } finally { win.destroy(); }
}
void main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
