import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkEngine } from '../dist/main/main/think.js';
import { defaultSettings } from '../dist/main/shared.js';

async function until(check) {
  for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw Error('Think fixture timed out.');
}
function fixture(run) {
  let settings={...defaultSettings,answerProvider:'gemini',geminiAnswerModel:'gemini-answer-test',quizModel:'codex-quiz'};
  const events=[],relayed=[],rpc=[];
  const files={activeId:'guide',context:()=> 'Study file: database concepts',content:()=>({info:{kind:'pdf',name:'Guide.pdf'},text:'Exact document text'})};
  const client={running:true,request:async(method,args)=>{
    rpc.push({method,args});
    if(method==='thread/start')return {thread:{id:'think'},model:'codex-answer'};
    if(method==='turn/start')return {turn:{id:'codex-turn',status:'inProgress'}};
    return {};
  }};
  const engine=new ThinkEngine(client,files,()=>settings,process.cwd(),event=>events.push(event),async text=>relayed.push(text),()=>{},async()=>{},undefined,undefined,run);
  return {engine,events,relayed,rpc,setSettings:patch=>{settings={...settings,...patch};}};
}

test('Gemini answers use the shared transcript, tools, live result relay and independent quiz provider', async()=>{
  let request;
  const f=fixture(async options=>{
    request=options;
    assert.match(options.prompt,/Study file: database concepts/);
    assert.match(options.prompt,/Earlier user question/);
    const result=await options.execute('read_file',{fileId:'guide'},'call-1');
    assert.match(result.contentItems[0].text,/Exact document text/);
    options.text('A Gemini answer.');return 'A Gemini answer.';
  });
  try {
    f.engine.syncTranscript([{id:'prior',role:'user',text:'Earlier user question',time:1,final:true}]);
    await f.engine.requestThink('Explain database concepts');
    await until(()=>f.events.some(e=>e.method==='think/completed'));
    assert.equal(request.model,'gemini-answer-test');
    assert.ok(f.events.some(e=>e.method==='think/delta'));
    assert.match(f.relayed[0],/A Gemini answer/);
    assert.equal(f.rpc.filter(r=>r.method==='turn/start').length,0);
    await until(()=>!f.engine.state.busy);
    await f.engine.requestThink('Make a quiz from this file');
    await until(()=>f.rpc.some(r=>r.method==='turn/start'));
    assert.equal(f.rpc.find(r=>r.method==='turn/start').args.model,'codex-quiz');
    f.engine.notification({method:'turn/completed',params:{threadId:'think',turn:{status:'completed'}}});
    await until(()=>!f.engine.state.busy);
    f.setSettings({answerProvider:'codex',model:'codex-selected'});
    await f.engine.requestThink('Explain another detail');
    await until(()=>f.rpc.filter(r=>r.method==='turn/start').length===2);
    assert.equal(f.rpc.filter(r=>r.method==='turn/start')[1].args.model,'codex-selected');
    assert.ok(f.rpc.some(r=>r.method==='thread/inject_items'&&JSON.stringify(r.args).includes('Previous completed Gemini answer')));
    f.engine.notification({method:'turn/completed',params:{threadId:'think',turn:{status:'completed'}}});
  } finally {f.engine.shutdown();}
});

test('cancelling a Gemini answer aborts the request, clears queued work, and never relays a success', async()=>{
  let started=false,aborted=false;
  const f=fixture(async options=>new Promise((resolve,reject)=>{
    started=true;options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason);},{once:true});
  }));
  try {
    await f.engine.requestThink('Explain a detail');await until(()=>started);
    await f.engine.requestThink('Explain another detail');
    await f.engine.cancel();await until(()=>!f.engine.state.busy);
    assert.equal(aborted,true);assert.equal(f.engine.state.queued,0);assert.equal(f.relayed.length,0);
    assert.ok(f.events.some(e=>e.method==='think/completed'&&e.params.status==='interrupted'));
    assert.equal(f.rpc.some(r=>r.method==='turn/interrupt'),false);
  } finally {f.engine.shutdown();}
});

test('Gemini failures appear in the answer and do not get relayed as verified work', async()=>{
  const f=fixture(async()=>{throw Error('Add your Gemini API key in Preferences → Gemini API.');});
  try {
    await f.engine.requestThink('Explain this');await until(()=>f.events.some(e=>e.method==='think/error'));
    assert.ok(f.events.some(e=>e.method==='think/message'&&e.params.item.text.includes('Add your Gemini API key')));
    assert.equal(f.relayed.length,0);assert.equal(f.engine.state.busy,false);
  }finally{f.engine.shutdown();}
});
