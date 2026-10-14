// Run after npm run build: electron tests/chat-history.electron.mjs
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { defaultSettings } from '../dist/main/shared.js';

async function main() {
  await app.whenReady();
  const entry = (id, role, text, time) => ({ id, role, text, time, final: true });
  const first = { id: '11111111-1111-4111-8111-111111111111', title: 'Study databases', created: 1000, updated: 3000,
    entries: [entry('saved-question', 'user', 'Explain primary keys', 1000), entry('saved-voice', 'assistant', 'A key identifies each row.', 2000)],
    think: [entry('saved-request', 'user', 'Explain primary keys', 1000), entry('saved-answer', 'assistant', 'Each primary key must be unique.', 3000)] };
  const second = { id: '22222222-2222-4222-8222-222222222222', title: 'Another topic', created: 4000, updated: 4000,
    entries: [entry('second-question', 'user', 'Explain indexes', 4000)], think: [] };
  const chats = new Map([first, second].map(chat => [chat.id, chat]));
  const resumed = [], requests = [], synced = [];
  let failResume = false, currentId, answer = 0;
  const win = new BrowserWindow({ width: 1460, height: 920, show: false,
    webPreferences: { preload: path.resolve('dist/main/main/preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true } });
  const emit = (method, params) => win.webContents.send('voice:event', { method, params });
  const handlers = {
    windowActivity: () => true,
    status: () => ({ connected: true, account: { type: 'chatgpt', name: 'Test' }, models: [], voices: [], voiceAvailable: false,
      settings: defaultSettings, platform: process.platform, darkMode: false }),
    workspace: () => ({ files: [], activeId: null, artifacts: [], thinking: { tokens: 0 }, annotations: { overlays: [], highlights: [], pointer: null }, quiz: {} }),
    browserState: () => null, stop: () => {}, interrupt: () => {}, new: () => { currentId = undefined; },
    updateState: () => ({ status: 'disabled', currentVersion: '0.0.4' }),
    syncTranscript: entries => { synced.push(structuredClone(entries)); },
    saveChat: async chat => { await new Promise(resolve => setTimeout(resolve, 20)); chats.set(chat.id, structuredClone(chat)); },
    listChats: () => [...chats.values()].map(chat => ({ ...chat, count: chat.entries.length + chat.think.filter(entry => entry.role === 'assistant').length })),
    deleteChat: id => chats.delete(id),
    resumeChat: async id => {
      resumed.push(id); await new Promise(resolve => setTimeout(resolve, 80));
      if (failResume) { failResume = false; throw Error('Chat could not be opened. Try again.'); }
      if(resumed.length===1)emit('think/message', { item: { id: 'final-outgoing-answer', text: 'Final reply while switching.' } });
      currentId = id; return structuredClone(chats.get(id));
    },
    think: message => {
      requests.push({ message, transcript: synced.at(-1), chatId: currentId });
      emit('think/message', { item: { id: `answer-${++answer}`, text: `Follow-up answer ${answer}` } });
    }
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`voice:${name}`, (_, ...args) => handler(...args));
  const js = source => win.webContents.executeJavaScript(source);
  const wait = async source => { for (let i = 0; i < 150; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error('Timeout: ' + source); };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setMessage = value => js(`(()=>{const input=document.querySelector('#message');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const select = id => js(`[...document.querySelectorAll('.history-open')].find(button=>button.closest('.history-row').textContent.includes(${JSON.stringify(chats.get(id).title)})).click()`);
  try {
    await win.loadFile(path.resolve('dist/renderer/index.html'));
    await wait(`!!document.querySelector('.account.online')`);
    await setMessage('Current question'); await click('.think-button');
    await wait(`document.querySelector('.agent-scroll').textContent.includes('Follow-up answer 1')`);
    await click('[title="Past chats"]');
    await wait(`document.querySelectorAll('.history-open').length===3`);
    const original = [...chats.values()].find(chat => chat.title === 'Current question');
    await select(first.id);
    // A second click while the restore request is pending must be ignored.
    await select(second.id);
    await wait(`!document.querySelector('.history-dialog').open`);
    assert.deepEqual(resumed, [first.id]);
    const text = await js(`document.querySelector('.agent-scroll').textContent`);
    assert.match(text, /Explain primary keys/); assert.match(text, /A key identifies each row/); assert.match(text, /Each primary key must be unique/);
    assert.doesNotMatch(text, /Current question|Follow-up answer 1/);
    await wait(`document.activeElement.id==='message'`);
    assert.equal(await js(`document.querySelector('.think-button').disabled`), false);
    assert.equal(chats.get(original.id).think.at(-1).text, 'Final reply while switching.');
    await setMessage('Can two rows share a key?'); await click('.think-button');
    await wait(`document.querySelector('.agent-scroll').textContent.includes('Follow-up answer 2')`);
    assert.equal(requests.at(-1).chatId, first.id);
    assert.deepEqual(requests.at(-1).transcript.map(entry => entry.text), ['Explain primary keys', 'A key identifies each row.', 'Can two rows share a key?']);
    await click('[title="Past chats"]'); await wait(`document.querySelector('.history-dialog').open && !document.querySelector('.history-open')?.disabled`);
    assert.equal(chats.size, 3); assert.equal(chats.get(first.id).created, first.created);
    assert.equal(chats.get(first.id).think.at(-1).text, 'Follow-up answer 2');
    await select(first.id); await wait(`!document.querySelector('.history-dialog').open`);
    assert.equal(resumed.length, 1, 'Selecting the current chat must preserve its live context');
    await click('[title="Past chats"]'); await wait(`document.querySelector('.history-dialog').open && !document.querySelector('.history-open')?.disabled`);
    failResume = true; await select(second.id);
    await wait(`!!document.querySelector('.history-dialog [role="alert"]') && !document.querySelector('.history-open').disabled`);
    assert.match(await js(`document.querySelector('.history-dialog').textContent`), /Try again/);
    assert.match(await js(`document.querySelector('.agent-scroll').textContent`), /Follow-up answer 2/);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
    await writeFile('/tmp/eduagent-chat-history-error.png', (await win.webContents.capturePage()).toPNG());
    await select(second.id); await wait(`!document.querySelector('.history-dialog').open`);
    assert.equal(await js(`document.querySelector('.agent-scroll').textContent.includes('Explain indexes')`), true);
    await click('[title="Past chats"]'); await wait(`document.querySelector('.history-dialog').open && !document.querySelector('.history-open')?.disabled`);
    await select(first.id); await wait(`!document.querySelector('.history-dialog').open`);
    assert.match(await js(`document.querySelector('.agent-scroll').textContent`), /Follow-up answer 2/);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
    await writeFile('/tmp/eduagent-chat-history-resumed.png', (await win.webContents.capturePage()).toPNG());
    await js(`[...document.querySelectorAll('.rail-action')].find(button=>button.textContent.includes('New conversation')).click()`);
    await wait(`!!document.querySelector('.suggestions')`);
    assert.equal(chats.get(first.id).think.at(-1).text, 'Follow-up answer 2');
    console.log('PASS: reopen, continue, preserve identity and prior chat, prevent overlapping switches, current-chat selection, restore failure and retry, switch back, and new conversation.');
  } finally { win.destroy(); }
}
void main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
