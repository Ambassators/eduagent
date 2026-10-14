import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkEngine } from '../dist/main/main/think.js';
import { defaultSettings } from '../dist/main/shared.js';

const files={activeId:'guide',context:()=> 'Guide PDF: beginner database concepts',content:()=>({info:{kind:'pdf',name:'Guide.pdf'},text:'Database concepts'})};
const entry=(id,text,final=true)=>({id,text,role:'user',final,time:Date.now()});

for (const answerModel of ['answer-model','']) test(`queued quiz and answer jobs use independent models and efforts (${answerModel||'service default'})`, async () => {
  const turns=[],logs=[];
  const settings={...defaultSettings,model:answerModel,reasoningEffort:'low',quizModel:'quiz-model',quizReasoningEffort:'high'};
  const client={running:true,request:async(method,args)=>{
    if(method==='thread/start'){
      assert.equal(args.ephemeral,true,'Internal Think sessions must not create saved desktop chats');
      return {thread:{id:'think'},model:'initial'};
    }
    if(method==='model/list')return {data:[{model:'service-default',isDefault:true}]};
    if(method==='turn/start'){turns.push(args);return {turn:{id:`turn-${turns.length}`,status:'inProgress'}};}
    return {};
  }};
  const engine=new ThinkEngine(client,files,()=>settings,process.cwd(),event=>logs.push(event),async()=>{},()=>{},async()=>({quizId:'created-quiz'}));
  const waitFor=async count=>{for(let i=0;i<100;i++){if(turns.length>=count)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generator did not start');};
  const complete=()=>engine.notification({method:'turn/completed',params:{threadId:'think',turn:{status:'completed'}}});
  try {
    await engine.requestThink('Make a quiz based on this PDF');
    await engine.requestThink('Explain the current question');
    engine.syncTranscript([entry('later','Explain the current question')]);
    await waitFor(1);
    assert.equal(turns[0].model,'quiz-model');assert.equal(turns[0].effort,'high');
    await engine.executeTool({threadId:'think',callId:'start',tool:'start_quiz',arguments:{bankId:'bank'}});
    complete();await waitFor(2);
    assert.equal(turns[1].model,answerModel||'service-default');assert.equal(turns[1].effort,'low');
    assert.match(engine.modelOf('think'),new RegExp(`${answerModel||'service-default'}.*low`));
    complete();
    engine.syncTranscript([entry('add','Please add three more questions')]);
    await engine.requestThink('Author more exercises from the source material','bridge');
    await waitFor(3);
    assert.equal(turns[2].model,'quiz-model');assert.equal(turns[2].effort,'high');
    complete();
    assert.equal(logs.some(event=>event.method==='think/error'),false);
  } finally {engine.shutdown();}
});

test('fresh voice quiz requests route to Think once without optional tools; history and discussion do not', async()=>{
  let started;const began=new Promise(resolve=>{started=resolve;});
  const turns=[];
  const client={running:true,request:async(method,args)=>{
    if(method==='thread/start')return {thread:{id:'think'},model:'test'};
    if(method==='turn/start'){turns.push(args);started();return {turn:{id:'turn',status:'inProgress'}};}
    return {};
  }};
  const engine=new ThinkEngine(client,files,()=>({...defaultSettings,agentTools:false}),process.cwd(),()=>{},async()=>{},()=>{},async()=>{});
  try {
    const history=entry('old','Make a quiz based on this PDF');
    engine.syncTranscript([history]);
    engine.syncTranscript([history],true);
    assert.equal(engine.state.busy,false,'Replaying loaded history must not create a quiz');
    const spoken=entry('new','Can you use the quiz tool to start doing the quiz from this?');
    engine.syncTranscript([history,spoken],true);
    await began;
    assert.equal(turns.length,1);assert.match(turns[0].input[0].text,/create_question_bank/);assert.match(turns[0].input[0].text,/start_quiz/);
    engine.syncTranscript([history,spoken],true);
    const job=await engine.requestThink('Create the quiz using the quiz tool','bridge');
    assert.equal(typeof job,'string');assert.equal(engine.state.queued,0,'Normal delegation must reuse the fallback job');
    const correction=entry('correction','Use the quiz tool');
    engine.syncTranscript([history,spoken,correction],true);
    await Promise.resolve();
    assert.equal(engine.state.queued,0,'Repeating the request while it runs must not queue a duplicate');
    const discussion=entry('discussion','What is semi-structured data?');
    engine.syncTranscript([history,spoken,correction,discussion],true);
    assert.equal(engine.state.queued,0);
    assert.equal(turns.length,1);
  }finally{engine.shutdown();}
});

for(const verified of [false,true])test(`quiz completion ${verified?'relays confirmed tool success':'rejects a claimed success without quiz tools'}`,async()=>{
  let started;const began=new Promise(resolve=>{started=resolve;});const relayed=[];
  const client={running:true,request:async method=>{
    if(method==='thread/start')return {thread:{id:'think'},model:'test'};
    if(method==='turn/start'){started();return {turn:{id:'turn',status:'inProgress'}};}
    return {};
  }};
  const engine=new ThinkEngine(client,files,()=>defaultSettings,process.cwd(),()=>{},async text=>{relayed.push(text);},()=>{},async()=>({quizId:'created-quiz'}));
  try {
    engine.syncTranscript([entry('new','Use the quiz tool')],true);await began;
    if(verified)await engine.executeTool({threadId:'think',turnId:'turn',callId:'start',tool:'start_quiz',arguments:{bankId:'bank'}});
    engine.notification({method:'item/completed',params:{threadId:'think',item:{type:'agentMessage',id:'message',text:'Your quiz is ready.'}}});
    engine.notification({method:'turn/completed',params:{threadId:'think',turn:{id:'turn',status:'completed'}}});
    assert.equal(relayed.length,1);
    if(verified)assert.match(relayed[0],/Verified Think result/);
    else {assert.match(relayed[0],/did not create or verify/);assert.doesNotMatch(relayed[0],/Your quiz is ready/);}
  } finally {engine.shutdown();}
});

test('Think sends the active document once, then only edits or a post-compaction snapshot',async()=>{
  let context=Array.from({length:40},(_,i)=>`Document line ${i}`).join('\n'),start;
  const documents={...files,context:()=>context};const turns=[];
  const client={running:true,request:async(method,args)=>{
    if(method==='thread/start')return {thread:{id:'think'},model:'test-model'};
    if(method==='turn/start'){turns.push(args);start();return {turn:{id:'turn',status:'inProgress'}};}
    return {};
  }};
  const engine=new ThinkEngine(client,documents,()=>({...defaultSettings,model:'test-model'}),process.cwd(),()=>{},async()=>{},()=>{},async()=>{});
  const ask=async()=>{
    const began=new Promise(resolve=>{start=resolve;});await engine.requestThink('Explain this concept');await began;
    engine.notification({method:'turn/completed',params:{threadId:'think',turn:{id:'turn',status:'completed'}}});
    await new Promise(resolve=>setImmediate(resolve));return turns.at(-1);
  };
  try {
    assert.equal((await ask()).additionalContext.active_document.value,context);
    assert.equal((await ask()).additionalContext,undefined);
    context=context.replace('Document line 20','Edited line 20');
    const update=(await ask()).additionalContext.active_document.value;
    assert.match(update,/Apply these changes/);assert.match(update,/Edited line 20/);assert.ok(update.length<context.length);
    engine.notification({method:'item/completed',params:{threadId:'think',item:{type:'contextCompaction'}}});
    assert.equal((await ask()).additionalContext.active_document.value,context);
  }finally{engine.shutdown();}
});
