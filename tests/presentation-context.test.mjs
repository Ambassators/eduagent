import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentationContext } from '../dist/main/main/presentation-context.js';
import { ThinkEngine } from '../dist/main/main/think.js';
import { defaultSettings } from '../dist/main/shared.js';

const html='<html><head><style>'+'.card{color:red}'.repeat(2000)+'</style></head><body><h1>Orbit model</h1><button>Increase gravity</button><canvas></canvas><script>const gravity=9.8; drawOrbit(gravity);</script></body></html>';

test('embed context prioritizes readable text, retains behavior, and bounds large sources', () => {
  const context=presentationContext([{id:'orbit',title:'Orbit',kind:'demo',content:html}]);
  assert.match(context,/Orbit model/);assert.match(context,/Increase gravity/);
  assert.match(context,/gravity=9.8/);assert.doesNotMatch(context,/color:red/);
  assert.match(context,/untrusted content/);assert.match(context,/current interactive state/);
  assert.equal(presentationContext([]),'');
  const large=presentationContext(Array.from({length:100},(_,i)=>({id:String(i),title:'x'.repeat(500),kind:'embed',content:'x'.repeat(300000)})));
  assert.ok(large.length<34000);assert.match(large,/"excerpt":true/);
  assert.doesNotMatch(large,/"id":"0"/);
});

test('created demos and PDF embeds reach voice results, bridge context, and source reading', async () => {
  const calls=[],relayed=[];
  let overlays=[{id:'overlay',fileId:'pdf',page:2,title:'Energy chart',kind:'embed',content:'<h2>Potential energy</h2>'}];
  const files={activeId:null,context:()=>'',contextIdentity:()=>'',fileSetIdentity:()=>'',livePageContext:()=>'',liveContext:()=>''};
  const client={running:true,request:async(method,args)=>{
    calls.push({method,args});
    if(method==='thread/start')return {thread:{id:'think'},model:'test'};
    if(method==='turn/start')return {turn:{id:'turn',status:'inProgress'}};
    return {};
  }};
  const engine=new ThinkEngine(client,files,()=>defaultSettings,process.cwd(),()=>{},async text=>{relayed.push(text);},()=>{},async()=>{},()=>overlays);
  try {
    await engine.requestThink('Show an orbit simulation');
    for(let i=0;i<100&&!calls.some(call=>call.method==='turn/start');i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(calls.some(call=>call.method==='turn/start'));
    const shown=await engine.executeTool({threadId:'think',callId:'demo',tool:'show_demo',arguments:{title:'Orbit',html}});
    const {id}=JSON.parse(shown.contentItems[0].text);
    engine.notification({method:'turn/completed',params:{threadId:'think',turn:{id:'turn',status:'completed'}}});
    assert.equal(relayed.length,1);assert.match(relayed[0],/gravity=9.8/);assert.match(relayed[0],/Potential energy/);
    // The same snapshot is used by main's realtime initialItems at startup/reconnect.
    assert.match(engine.voicePresentationContext(),/Increase gravity/);
    engine.voiceThreadId='bridge';
    await engine.flushVoiceContext();
    const notes=()=>calls.filter(call=>call.method==='thread/inject_items'&&call.args.threadId==='bridge').map(call=>call.args.items[0].content[0].text);
    assert.ok(notes().some(text=>text.includes('gravity=9.8')&&text.includes('Potential energy')));
    const count=notes().length;
    await engine.flushVoiceContext();assert.equal(notes().length,count,'Unchanged embeds are not resent');
    const read=await engine.executeTool({threadId:'bridge',callId:'read',tool:'read_presentation',arguments:{id,start:html.indexOf('<script>'),length:60}});
    assert.match(JSON.parse(read.contentItems[0].text).text,/gravity=9.8/);
    overlays=[];engine.artifacts=[];await engine.flushVoiceContext();
    assert.match(notes().at(-1),/No screen presentations/);
    await engine.reset();assert.equal(engine.voicePresentationContext(),'');
  } finally {engine.shutdown();}
});
