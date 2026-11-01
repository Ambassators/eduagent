import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { GeminiLive } from '../src/main/gemini-live.ts';

async function until(check: () => unknown) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  throw new Error('Timed out waiting for Gemini fixture.');
}
async function fixture(t: any, options: { delegate?: (message: string) => Promise<unknown>; setup?: boolean } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const messages: any[] = [], events: any[] = [];
  let peer: WebSocket, endpoint: URL;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      if (message.setup && options.setup !== false) socket.send(JSON.stringify({ setupComplete: {} }));
    });
  });
  const address = server.address() as { port: number };
  const session = new GeminiLive({ apiKey: 'fixture-secret', model: 'gemini-test', voice: 'Kore', prompt: 'Test prompt', context: 'File context', event: event => events.push(event), delegate: options.delegate ?? (async message => ({ queued: true, message })) }, url => { endpoint = url; return new WebSocket(`ws://127.0.0.1:${address.port}`); });
  t.after(async () => { session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { session, messages, events, send: (value: unknown) => peer.send(JSON.stringify(value)), close: (code: number, message: string) => peer.close(code, message), endpoint: () => endpoint };
}

test('Gemini setup waits for acknowledgement and sends quiet context without starting a response', async t => {
  const f = await fixture(t, { setup: false });
  const started = f.session.start();
  await until(() => f.messages.length);
  assert.throws(() => f.session.audio('AAAA', 16000), /not connected/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].setup.model, 'models/gemini-test');
  assert.deepEqual(f.messages[0].setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(f.messages[0].setup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  assert.equal(f.endpoint().searchParams.get('key'), 'fixture-secret');
  f.send({ setupComplete: {} }); await started;
  await until(() => f.messages.length === 2);
  assert.equal(f.messages[1].clientContent.turnComplete, false);
  assert.match(f.messages[1].clientContent.turns[0].parts[0].text, /File context/);
  assert.equal(JSON.stringify(f.events).includes('fixture-secret'), false);
});

test('Gemini sends PCM and explicit speech boundaries and handles every audio part plus captions', async t => {
  const f = await fixture(t); await f.session.start();
  f.session.activity(true); f.session.activity(true);
  f.session.audio('AAABAA==', 16000); f.session.activity(false);
  f.session.text('Read the result'); f.session.context('Changed page');
  await until(() => f.messages.length === 7);
  assert.deepEqual(f.messages[2], { realtimeInput: { activityStart: {} } });
  assert.deepEqual(f.messages[3], { realtimeInput: { audio: { data: 'AAABAA==', mimeType: 'audio/pcm;rate=16000' } } });
  assert.deepEqual(f.messages[4], { realtimeInput: { activityEnd: {} } });
  assert.equal(f.messages[5].clientContent.turnComplete, true);
  assert.equal(f.messages[6].clientContent.turnComplete, false);
  f.send({ serverContent: { inputTranscription: { text: 'What ' }, outputTranscription: { text: 'Let ' }, modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }, { text: 'ignored reasoning', thought: true }, { inlineData: { data: 'AQAB', mimeType: 'audio/pcm;rate=24000' } }] } } });
  f.send({ serverContent: { inputTranscription: { text: 'now?' }, outputTranscription: { text: 'me check.' }, turnComplete: true } });
  await until(() => f.events.some(e => e.item?.text === 'What now?'));
  assert.equal(f.events.filter(e => e.type === 'audio.delta').length, 2);
  const captions = f.events.filter(e => e.type === 'input_transcript.added');
  assert.equal(captions[0].item.id, captions[1].item.id);
  f.send({ serverContent: { inputTranscription: { text: 'Next question' }, interrupted: true, modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] } } });
  await until(() => f.events.some(e => e.item?.text === 'Next question'));
  assert.notEqual(f.events.filter(e => e.type === 'input_transcript.added').at(-1).item.id, captions[0].item.id);
  assert.ok(f.events.some(e => e.type === 'audio.interrupted'));
  assert.equal(f.events.filter(e => e.type === 'audio.delta').length, 2);
});

test('Gemini hands workspace actions to Think, matches tool IDs, and reports invalid calls', async t => {
  const requests: string[] = [];
  const f = await fixture(t, { delegate: async message => { requests.push(message); return { queued: true, jobId: 'job-1' }; } });
  await f.session.start();
  f.send({ toolCall: { functionCalls: [{ id: 'call-1', name: 'delegate', args: { message: 'Highlight this paragraph' } }, { id: 'call-2', name: 'shell', args: {} }] } });
  await until(() => f.messages.filter(m => m.toolResponse).length === 2);
  assert.deepEqual(requests, ['Highlight this paragraph']);
  const responses = f.messages.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses);
  assert.deepEqual(responses.find(r => r.id === 'call-1').response, { queued: true, jobId: 'job-1' });
  assert.match(responses.find(r => r.id === 'call-2').response.error, /Invalid workspace/);
});

test('cancelled and closed Gemini sessions discard late tool results', async t => {
  let finish: (value: unknown) => void;
  const f = await fixture(t, { delegate: () => new Promise(resolve => { finish = resolve; }) });
  await f.session.start();
  f.send({ toolCall: { functionCalls: [{ id: 'slow', name: 'delegate', args: { message: 'Research' } }] } });
  await until(() => finish);
  f.send({ toolCallCancellation: { ids: ['slow'] } });
  // The ordered websocket frame proves cancellation was consumed before resolving the tool.
  f.send({ serverContent: { interrupted: true } }); await until(() => f.events.length);
  finish!({ queued: true }); await delay(20);
  assert.equal(f.messages.some(m => m.toolResponse), false);
  f.session.close(); f.session.close();
  assert.throws(() => f.session.audio('AAAA', 16000), /not connected/);
});

test('Gemini rejects startup failures and redacts credentials in service errors', async t => {
  const f = await fixture(t, { setup: false });
  const started = f.session.start();
  const rejected = assert.rejects(started, error => {
    assert.match((error as Error).message, /bad key \[redacted\]/); return true;
  });
  await until(() => f.messages.length);
  f.send({ error: { message: 'bad key fixture-secret' } }); await rejected;
});

test('Gemini closes during setup promptly and reports later disconnections', async t => {
  const pending = await fixture(t, { setup: false });
  const start = pending.session.start();
  const rejected = assert.rejects(start, /cancelled/);
  await until(() => pending.messages.length); pending.session.close(); await rejected;
  const f = await fixture(t); await f.session.start();
  f.close(1008, 'rejected fixture-secret');
  await until(() => f.events.some(e => e.type === 'error'));
  assert.equal(JSON.stringify(f.events).includes('fixture-secret'), false);
  assert.match(f.events[0].message, /disconnected/);
});
