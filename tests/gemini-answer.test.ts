import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGeminiAnswer, listGeminiModels, geminiThinking, type GeminiAnswerRequest } from '../src/main/gemini-answer.ts';
import { geminiCatalog, geminiLiveModels, geminiVoices } from '../src/gemini.ts';

const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const event = (parts: unknown[], finishReason = 'STOP') => ({ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason }] });
function fixture(patch: Partial<GeminiAnswerRequest & { apiKey: string }> = {}) {
  const text: string[] = [], usages: number[] = [], calls: unknown[] = [], searches: unknown[] = [];
  const controller = new AbortController();
  const options = { apiKey: 'fixture-secret', model: 'gemini-3.8-flash', effort: 'medium' as const, system: 'Use workspace tools', prompt: 'Explain the open file',
    tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'], additionalProperties: false } }],
    signal: controller.signal, execute: async (...args: unknown[]) => { calls.push(args); return { success: true, contentItems: [{ type: 'inputText', text: 'File content' }] }; },
    text: (value: string) => text.push(value), usage: (value: number) => usages.push(value), search: (...args: unknown[]) => searches.push(args), ...patch };
  return { options, text, usages, calls, searches, controller };
}

test('Gemini answers execute tools and preserve exact model parts and thought signatures', async () => {
  const f = fixture(), requests: any[] = [];
  const part = { functionCall: { id: 'api-call', name: 'read_file', args: { fileId: 'file-1' } }, thoughtSignature: 'opaque-signature' };
  const fetcher = (async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /gemini-3.8-flash:streamGenerateContent\?alt=sse$/);
    assert.equal((init.headers as Record<string,string>)['x-goog-api-key'], 'fixture-secret');
    requests.push(JSON.parse(init.body as string));
    return requests.length === 1 ? sse([event([{ text: 'Hidden thought', thought: true }, part])]) : sse([event([{ text: 'The answer ' }], ''), { ...event([{ text: 'is ready.' }]), usageMetadata: { totalTokenCount: 42 } }]);
  }) as typeof fetch;
  assert.equal(await runGeminiAnswer(f.options, fetcher), 'The answer is ready.');
  assert.equal(f.text.join(''), 'The answer is ready.');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(0,2), ['read_file', { fileId: 'file-1' }]);
  assert.deepEqual(requests[1].contents[1].parts[1], part);
  assert.equal(requests[1].contents[2].parts[0].functionResponse.id, 'api-call');
  assert.deepEqual(requests[0].tools[0].functionDeclarations[0].parametersJsonSchema, f.options.tools[0].inputSchema);
  assert.deepEqual(f.usages, [42]);
});

test('Gemini handles SSE split inside Unicode and event boundaries, without publishing internal thoughts', async () => {
  const f = fixture();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event([{ text: 'Hi 🌍' }]))}\r\n\r\n`);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await runGeminiAnswer(f.options, (async () => new Response(stream)) as typeof fetch), 'Hi 🌍');
});

test('Gemini reads images and returns failed tools to the model for recovery', async () => {
  const image = 'data:image/png;base64,AQID';
  const f = fixture({ image, execute: async name => {
    if (name === 'read_file') return { success: true, contentItems: [{ type: 'inputText', text: 'Page' }, { type: 'inputImage', imageUrl: image }] };
    throw Error('Invalid tool');
  } });
  let count = 0; const requests: any[] = [];
  await runGeminiAnswer(f.options, (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return ++count===1 ? sse([event([{ functionCall: { name: 'read_file', args: {} } }, { functionCall: { name: 'shell', args: {} } }])]) : sse([event([{ text: 'Read the page.' }])]);
  }) as typeof fetch);
  assert.deepEqual(requests[0].contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AQID' } });
  assert.deepEqual(requests[1].contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: 'AQID' } });
  assert.match(requests[1].contents[2].parts[2].functionResponse.response.error, /not available/);
});

test('Gemini uses grounded Google Search separately from workspace function declarations and retains source URLs', async () => {
  const f=fixture(), requests: any[]=[];
  const output=await runGeminiAnswer(f.options, (async (_url: unknown, init: RequestInit) => {
    const body=JSON.parse(init.body as string); requests.push(body);
    if(requests.length===1)return sse([event([{functionCall:{name:'web_search',args:{query:'Current example'}}}])]);
    if(requests.length===2)return Response.json({candidates:[{content:{parts:[{text:'Researched answer'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.com/source',title:'Source'}}]}}]});
    return sse([event([{text:'Answer with [source](https://example.com/source).'}])]);
  }) as typeof fetch);
  assert.deepEqual(requests[1].tools,[{googleSearch:{}}]);
  assert.equal(requests[2].contents.at(-1).parts[0].functionResponse.response.sources[0].url,'https://example.com/source');
  assert.match(output,/source/);assert.equal(f.searches.length,2);
});

test('cancelling Gemini prevents later tools in a batch and further generation', async () => {
  const f=fixture();let calls=0,requests=0;
  f.options.execute=async()=>{calls++;f.controller.abort();return {success:true,contentItems:[]};};
  await assert.rejects(runGeminiAnswer(f.options,(async()=>{requests++;return sse([event([{functionCall:{name:'read_file',args:{}}},{functionCall:{name:'read_file',args:{}}}])]);}) as typeof fetch),{name:'AbortError'});
  assert.equal(calls,1);assert.equal(requests,1);
});

test('Gemini reports missing keys, redacts service errors, and rejects truncated, blocked and empty answers', async () => {
  const f=fixture();
  await assert.rejects(runGeminiAnswer({...f.options,apiKey:''},fetch),/Add your Gemini API key/);
  await assert.rejects(runGeminiAnswer(f.options,(async()=>Response.json({error:{message:'bad fixture-secret'}},{status:403})) as typeof fetch),error=>{assert.match((error as Error).message,/bad \[redacted\]/);return true;});
  await assert.rejects(runGeminiAnswer(f.options,(async()=>sse([event([{text:'partial'}],'')])) as typeof fetch),/disconnected before completing/);
  await assert.rejects(runGeminiAnswer(f.options,(async()=>sse([{promptFeedback:{blockReason:'SAFETY'}}])) as typeof fetch),/SAFETY/);
  await assert.rejects(runGeminiAnswer(f.options,(async()=>sse([event([])])) as typeof fetch),/no answer/);
});

test('model discovery paginates and filters by capability, with all conversational Live defaults and 30 voices', async () => {
  const requests: URL[]=[];
  const models=await listGeminiModels('fixture-secret',(async(url: URL)=>{
    requests.push(url);return requests.length===1 ? Response.json({models:[{name:'models/gemini-future-live',supportedGenerationMethods:['bidiGenerateContent']}],nextPageToken:'page-2'}) : Response.json({models:[{name:'models/gemini-future-pro',displayName:'Future Pro',supportedGenerationMethods:['generateContent']},{name:'models/gemini-future-tts',supportedGenerationMethods:['generateContent']},{name:'models/gemini-live-translate',supportedGenerationMethods:['bidiGenerateContent']}]});
  }) as typeof fetch);
  assert.equal(requests[1].searchParams.get('pageToken'),'page-2');
  const catalog=geminiCatalog(models);
  assert.ok(catalog.live.some(item=>item.model==='gemini-future-live'));
  assert.ok(catalog.answer.some(item=>item.model==='gemini-future-pro'));
  assert.equal(catalog.answer.some(item=>item.model.includes('tts')),false);
  assert.equal(catalog.live.some(item=>item.model.includes('translate')),false);
  for(const model of geminiLiveModels)assert.ok(catalog.live.some(item=>item.model===model.model));
  assert.equal(new Set(geminiVoices).size,30);
  assert.deepEqual(geminiThinking('gemini-2.5-pro','xhigh'),{thinkingBudget:16384});
  assert.deepEqual(geminiThinking('gemini-3.8-flash','xhigh'),{thinkingLevel:'high'});
});
