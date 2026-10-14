// Run after npm run build: node --test tests/chat-context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkEngine } from '../dist/main/main/think.js';
import { defaultSettings } from '../dist/main/shared.js';

const entry = (id, role, text, time) => ({ id, role, text, time, final: true });
const files = { activeId: null, context: () => '' };
const wait = async condition => { for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Timed out'); };

test('restored context contains saved answers and later messages, without another chat or replayed requests', async () => {
  const calls = [];
  let thread = 0;
  const client = { running: true, request: async (method, args) => {
    calls.push({ method, args });
    if (method === 'thread/start') return { thread: { id: `thread-${++thread}` } };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
    return {};
  } };
  const engine = new ThinkEngine(client, files, () => ({ ...defaultSettings, model: 'test', autoCompact: false }), process.cwd(), () => {}, async () => {}, () => {}, async () => {});
  try {
    engine.syncTranscript([entry('other', 'user', 'Unrelated old conversation', 1)]);
    await engine.sync();
    await engine.reset(); calls.length = 0;
    const restored = [entry('question', 'user', 'Make an interactive quiz about keys', 2), entry('answer', 'assistant', 'A primary key uniquely identifies a row.', 3)];
    engine.syncTranscript(restored);
    await engine.sync();
    assert.equal(calls.some(call => call.method === 'turn/start'), false, 'Historical quiz requests must not be executed');
    assert.match(engine.voiceHistory()[0].text, /primary key uniquely identifies/);
    assert.doesNotMatch(engine.voiceHistory()[0].text, /Unrelated/);
    const context = calls.filter(call => call.method === 'thread/inject_items').map(call => call.args.items[0].content[0].text).join('\n');
    assert.match(context, /Make an interactive quiz/); assert.match(context, /primary key uniquely identifies/); assert.doesNotMatch(context, /Unrelated/);
    engine.syncTranscript([...restored, entry('follow-up', 'user', 'Explain composite keys', 4)]);
    await engine.requestThink('Explain composite keys');
    await wait(() => calls.some(call => call.method === 'turn/start'));
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.match(calls.find(call => call.method === 'turn/start').args.input[0].text, /Explain composite keys/);
    engine.notification({ method: 'turn/completed', params: { threadId: engine.state.threadId, turn: { status: 'completed' } } });
    await wait(() => !engine.state.busy);
  } finally { engine.shutdown(); }
});

test('switching waits for interrupted work before restoring the next chat', async () => {
  const calls = [];
  let engine, finishInterrupt;
  const client = { running: true, request: async (method, args) => {
    calls.push({ method, args });
    if (method === 'thread/start') return { thread: { id: 'old-thread' } };
    if (method === 'turn/start') return { turn: { id: 'old-turn', status: 'inProgress' } };
    if (method === 'turn/interrupt') finishInterrupt = () => engine.notification({ method: 'turn/completed', params: { threadId: 'old-thread', turn: { status: 'interrupted' } } });
    return {};
  } };
  engine = new ThinkEngine(client, files, () => ({ ...defaultSettings, model: 'test', autoCompact: false }), process.cwd(), () => {}, async () => {}, () => {}, async () => {});
  try {
    await engine.requestThink('Old work');
    await wait(() => calls.some(call => call.method === 'turn/start'));
    await wait(() => engine.turnId === 'old-turn');
    let resetDone = false;
    const reset = engine.reset().then(() => { resetDone = true; });
    await wait(() => !!finishInterrupt);
    assert.equal(resetDone, false);
    finishInterrupt(); await reset;
    assert.equal(engine.state.busy, false); assert.equal(engine.state.threadId, null);
    engine.syncTranscript([entry('next', 'user', 'Next conversation', 10)]);
    assert.match(engine.voiceHistory()[0].text, /Next conversation/);
    assert.doesNotMatch(engine.voiceHistory()[0].text, /Old work/);
  } finally { engine.shutdown(); }
});
