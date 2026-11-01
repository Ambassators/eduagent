// Production renderer/preload smoke test using silent, synthetic microphone input.
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultSettings } from '../dist/main/shared.js';

async function main() {
const watchdog=setTimeout(()=>{console.error('Gemini smoke test timed out.');process.exit(1);},30000);
await app.whenReady();
let starts = 0, stops = 0, subscriptionStarts = 0;
const activity = [];
const settings = { ...defaultSettings, voiceProvider: 'gemini', standbyAfterSeconds: 2 };
const handlers = {
  windowActivity: () => true,
  status: () => ({ connected: true, account: { type: 'chatgpt', name: 'Test' }, models: [], voices: [], voiceAvailable: true, geminiKeyConfigured: true, settings, platform: process.platform, darkMode: false }),
  workspace: () => ({ files: [], folders: [], activeId: null, artifacts: [], thinking: { tokens: 0 }, annotations: { overlays: [], highlights: [], pointer: null }, quiz: {} }),
  browserState: () => null,
  microphone: () => true,
  startGemini: () => ({ sessionId: `fixture-${++starts}` }),
  start: () => { subscriptionStarts++; throw Error('Unexpected subscription connection'); },
  stop: () => { stops++; }, interrupt: () => {}, log: () => {}, saveChat: () => {}, syncTranscript: () => {}, pointer: () => {},
  geminiActivity: (id, active) => activity.push({ id, active }),
  appendAudio: () => {},
  updateState: () => ({ status: 'disabled', currentVersion: 'test' })
};
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`voice:${name}`, (_event, ...args) => handler(...args));
const win = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { preload: path.resolve('dist/main/main/preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
const js = source => win.webContents.executeJavaScript(source);
async function wait(source) {
  for (let i = 0; i < 300; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error(`Timeout: ${source}; ${await js("document.querySelector('.error')?.textContent")}`);
}
const send = (sessionId, event) => win.webContents.send('voice:event', { method: 'gemini/event', params: { sessionId, event } });
try {
  console.log('Gemini smoke: loading renderer');
  await win.loadFile(path.resolve('dist/renderer/index.html'));
  await wait(`!document.querySelector('.mic-button').disabled`);
  console.log('Gemini smoke: preparing microphone');
  await js(`window.fixtureContext=new AudioContext();window.fixtureDestination=window.fixtureContext.createMediaStreamDestination();window.fixtureSource=window.fixtureContext.createConstantSource();window.fixtureSource.offset.value=0;window.fixtureSource.connect(window.fixtureDestination);window.fixtureSource.start();navigator.mediaDevices.getUserMedia=async()=>window.fixtureDestination.stream.clone();void 0;`);
  console.log('Gemini smoke: toggling session');
  await js(`document.querySelector('.mic-button').click()`);
  await wait(`document.querySelector('.voice-stage').classList.contains('listening')`);
  assert.equal(starts, 1); assert.equal(subscriptionStarts, 0);
  assert.deepEqual(activity[0], { id: 'fixture-1', active: false });
  send('stale-session', { type: 'output_transcript.added', item: { id: 'old', text: 'STALE CAPTION' } });
  send('fixture-1', { type: 'output_transcript.added', item: { id: 'first', text: 'Gemini fixture response' } });
  await wait(`document.body.textContent.includes('Gemini fixture response')`);
  assert.equal(await js(`document.body.textContent.includes('STALE CAPTION')`), false);
  send('fixture-1', { type: 'audio.delta', data: Buffer.alloc(4800).toString('base64'), sampleRate: 24000 });
  send('fixture-1', { type: 'audio.interrupted' });
  await wait(`document.querySelector('.voice-stage').classList.contains('standby')`);
  assert.ok(stops >= 1);
  console.log('Gemini smoke: toggling session');
  await js(`document.querySelector('.mic-button').click()`);
  await wait(`document.querySelector('.mic-button').getAttribute('aria-pressed')==='false'`);
  console.log('Gemini smoke: toggling session');
  await js(`document.querySelector('.mic-button').click()`);
  await wait(`document.querySelector('.voice-stage').classList.contains('listening')`);
  assert.equal(starts, 2);
  send('fixture-1', { type: 'error', message: 'STALE ERROR' });
  send('fixture-2', { type: 'error', message: 'Gemini fixture disconnect' });
  await wait(`document.querySelector('.mic-button').getAttribute('aria-pressed')==='false' && document.body.textContent.includes('Gemini fixture disconnect')`);
  assert.equal(await js(`document.body.textContent.includes('STALE ERROR')`), false);
  assert.equal(subscriptionStarts, 0);
  console.log('PASS: Gemini renderer startup, captions, stale event rejection, PCM playback, interruption, standby, reconnect, and disconnect cleanup.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { clearTimeout(watchdog); win.destroy(); app.quit(); }

}
main().catch(error=>{console.error(error);app.exit(1);});
