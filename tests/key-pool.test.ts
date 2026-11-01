import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, classifyResponse, GeminiError, KeyPool, parseKeys } from '../src/main/key-pool.ts';
import { runGeminiAnswer } from '../src/main/gemini-answer.ts';

const limited = (retryDelay?: string) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : [] } });
const clock = () => { let now = 1_000_000; return { now: () => now, advance: (ms: number) => { now += ms; } }; };

test('parses one or many keys from storage, env and pasted text', () => {
  assert.deepEqual(parseKeys('only-key'), ['only-key']);
  assert.deepEqual(parseKeys(' a, b\nc;  a \n'), ['a', 'b', 'c']);
  assert.deepEqual(parseKeys(''), []);
  assert.equal(parseKeys(Array.from({ length: 30 }, (_, i) => `k${i}`).join(',')).length, 20);
});

test('classifies Gemini errors for rotation', () => {
  const rate = classifyResponse(429, limited('12.5s'), 'm');
  assert.equal(rate.kind, 'rate-limited'); assert.equal(rate.retryAfterMs, 12_500);
  assert.equal(classifyResponse(429, { error: { details: [{ '@type': 'QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } }, 'm').kind, 'quota');
  assert.equal(classifyResponse(429, {}, 'm', '7').retryAfterMs, 7000);
  assert.equal(classifyResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'm').kind, 'auth');
  assert.equal(classifyResponse(403, {}, 'm').kind, 'auth');
  assert.equal(classifyResponse(404, { error: { message: 'models/gemini-x is not found for API version v1beta' } }, 'm').kind, 'model');
  assert.equal(classifyResponse(503, { error: { message: 'The model is overloaded.' } }, 'm').kind, 'unavailable');
  assert.equal(classifyResponse(400, { error: { message: 'Invalid JSON payload' } }, 'm').kind, 'bad-request');
  assert.equal(classifyError(new Error('Gemini Live disconnected (1011): You exceeded your current quota.')).kind, 'rate-limited');
  assert.equal(classifyError(new Error('Gemini Live disconnected (1007): API key not valid.')).kind, 'auth');
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).kind, 'aborted');
  assert.equal(classifyError(new TypeError('fetch failed')).kind, 'unavailable');
});

test('round-robins healthy keys and skips a rate-limited key until its retry delay passes', async () => {
  const c = clock(), pool = new KeyPool(['k1', 'k2', 'k3'], c.now), used: string[] = [];
  for (let i = 0; i < 3; i++) await pool.run(async key => { used.push(key); });
  assert.deepEqual(used, ['k1', 'k2', 'k3']);
  pool.recordFailure('k1', new GeminiError('429', 'rate-limited', 429, 5000));
  assert.deepEqual(pool.candidates().map(r => r.key), ['k2', 'k3']);
  c.advance(5001);
  assert.deepEqual(pool.candidates().map(r => r.key).sort(), ['k1', 'k2', 'k3']);
});

test('falls back to the next key on 429, auth and outages, but not on bad requests or cancellation', async () => {
  const pool = new KeyPool(['k1', 'k2', 'k3']);
  const tried: string[] = [];
  assert.equal(await pool.run(async key => {
    tried.push(key);
    if (key === 'k1') throw new GeminiError('limited', 'rate-limited', 429);
    if (key === 'k2') throw new GeminiError('rejected', 'auth', 403);
    return 'ok';
  }), 'ok');
  assert.deepEqual(tried, ['k1', 'k2', 'k3']);
  assert.equal(pool.state('k1').state, 'cooldown');
  assert.equal(pool.state('k2', 'any-model').state, 'open');

  const fresh = new KeyPool(['a', 'b']); let calls = 0;
  await assert.rejects(fresh.run(async () => { calls++; throw new GeminiError('bad body', 'bad-request', 400); }), /bad body/);
  assert.equal(calls, 1);
  assert.equal(fresh.state('a').state, 'ok');
  const controller = new AbortController(); calls = 0;
  await assert.rejects(fresh.run(async () => { calls++; controller.abort(); throw new GeminiError('limited', 'rate-limited', 429); }, controller.signal));
  assert.equal(calls, 1);
});

test('reports every key failing with a redacted error, and still retries a single cooling key', async () => {
  const pool = new KeyPool(['secret-one', 'secret-two']);
  await assert.rejects(pool.run(async key => { throw new GeminiError(`limited secret ${key}`, 'rate-limited', 429); }), (error: GeminiError) => {
    assert.equal(error.kind, 'rate-limited');
    assert.match(error.message, /tried 2 key\/model combinations/);
    assert.doesNotMatch(error.message, /secret-(one|two)/);
    return true;
  });
  // Every key is cooling down: the soonest-recovering one is still tried instead of refusing outright.
  let tried = 0;
  assert.equal(await pool.run(async () => { tried++; return 'recovered'; }), 'recovered');
  assert.equal(tried, 1);
});

test('trips the breaker after consecutive failures and resets on success', () => {
  const c = clock(), pool = new KeyPool(['k'], c.now);
  for (let i = 0; i < 2; i++) pool.recordFailure('k', new GeminiError('503', 'unavailable', 503), 'm');
  assert.equal(pool.state('k', 'm').state, 'ok');
  pool.recordFailure('k', new GeminiError('503', 'unavailable', 503), 'm');
  assert.equal(pool.state('k', 'm').state, 'open');
  c.advance(30_001);
  assert.equal(pool.state('k', 'm').state, 'ok');
  // Past the rolling window, one success resets the streak, so a single new failure does not reopen it.
  c.advance(30_000);
  pool.recordSuccess('k', 'm');
  pool.recordFailure('k', new GeminiError('503', 'unavailable', 503), 'm');
  assert.equal(pool.state('k', 'm').state, 'ok');
});

test('routes over key × model pairs: primary model on every key first, then fallbacks', async () => {
  const pool = new KeyPool(['k1', 'k2']), tried: string[] = [];
  const value = await pool.run(async (key, model) => {
    tried.push(`${key}/${model}`);
    if (model === 'primary') throw new GeminiError('limited', 'rate-limited', 429);
    return model;
  }, { models: ['primary', 'backup'] });
  assert.equal(value, 'backup');
  assert.deepEqual(tried, ['k1/primary', 'k2/primary', 'k1/backup']);
  // Rate limits are per model: both keys remain usable for the backup model.
  assert.deepEqual(pool.candidates(['primary', 'backup']).map(r => `${r.key}/${r.model}`), ['k2/backup', 'k1/backup']);
  assert.deepEqual(pool.snapshot().map(s => [s.state, s.models]), [['cooldown', ['primary']], ['cooldown', ['primary']]]);
});

test('a missing model skips its remaining keys and goes to the next model', async () => {
  const pool = new KeyPool(['k1', 'k2']), tried: string[] = [];
  await pool.run(async (key, model) => {
    tried.push(`${key}/${model}`);
    if (model === 'gone') throw new GeminiError('not found', 'model', 404);
    return model;
  }, { models: ['gone', 'backup'] });
  assert.deepEqual(tried, ['k1/gone', 'k1/backup']);
});

test('keys that remain keep their health when the key list changes', () => {
  const pool = new KeyPool(['a', 'b']);
  pool.recordFailure('a', new GeminiError('rejected', 'auth', 403));
  pool.setKeys(['a', 'c']);
  assert.equal(pool.state('a').state, 'open');
  assert.deepEqual(pool.snapshot().map(s => s.label), ['…a', '…c']);
});

const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const answer = (parts: unknown[]) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }] });
function request(apiKey: KeyPool, patch: Record<string, unknown> = {}) {
  return { apiKey, model: 'gemini-3.8-flash', effort: 'medium' as const, system: 's', prompt: 'p', tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal, execute: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'content' }] }),
    text: () => {}, usage: () => {}, search: () => {}, ...patch };
}

test('Gemini answers rotate keys on 429 and fall back to another model, then stay on it for later rounds', async () => {
  const pool = new KeyPool(['key-a', 'key-b']), seen: string[] = [], routed: string[] = [];
  const fetcher = (async (url: unknown, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)['x-goog-api-key'], model = /models\/([^:]+):/.exec(String(url))![1];
    seen.push(`${key}/${model}`);
    if (model === 'gemini-3.8-flash') return Response.json(limited('30s'), { status: 429 });
    return seen.filter(item => item.endsWith('gemini-3.6-flash')).length === 1 ? sse([answer([{ functionCall: { name: 'read_file', args: {} } }])]) : sse([answer([{ text: 'Done.' }])]);
  }) as typeof fetch;
  const output = await runGeminiAnswer(request(pool, { fallbackModels: ['gemini-3.6-flash'], route: (model: string) => routed.push(model) }), fetcher);
  assert.equal(output, 'Done.');
  assert.deepEqual(seen.slice(0, 3), ['key-a/gemini-3.8-flash', 'key-b/gemini-3.8-flash', 'key-a/gemini-3.6-flash']);
  // The second round (after the tool call) stays on the model that produced the call, on the next key.
  assert.deepEqual(seen.slice(3), ['key-b/gemini-3.6-flash']);
  assert.deepEqual(routed, ['gemini-3.6-flash']);
  // The next answer skips the cooling primary model entirely.
  seen.length = 0;
  await runGeminiAnswer(request(pool, { tools: [], fallbackModels: ['gemini-3.6-flash'] }), (async (url: unknown, init: RequestInit) => {
    seen.push(`${(init.headers as Record<string, string>)['x-goog-api-key']}/${/models\/([^:]+):/.exec(String(url))![1]}`);
    return sse([answer([{ text: 'Again.' }])]);
  }) as typeof fetch);
  assert.deepEqual(seen, ['key-a/gemini-3.6-flash']);
});

test('Gemini answers do not retry on another key once streaming has started', async () => {
  const pool = new KeyPool(['key-a', 'key-b']); let calls = 0;
  await assert.rejects(runGeminiAnswer(request(pool, { tools: [] }), (async () => { calls++; return sse([{ error: { message: 'Quota exceeded mid-stream' } }]); }) as typeof fetch), /mid-stream/);
  assert.equal(calls, 1);
});
