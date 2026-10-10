import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const script = await readFile(new URL('../extensions/common/background.js',import.meta.url),'utf8');
for (const variant of ['Chromium','Chromium browser alias','Firefox']) test(`${variant} worker gates cookie permission and transfers bounded default-profile batches`,async()=>{
  const firefox = variant === 'Firefox';
  let granted = false, queried = '', socket: any;
  const sent: any[] = [], listeners: any[] = [];
  const event = {addListener:(listener: any)=>listeners.push(listener)};
  const source = Array.from({length:28},(_,i)=>({name:`cookie${i}`,value:'private-value'}));
  const api = {
    storage:{session:{get:async()=>({}),set:async()=>{}},local:{get:async()=>({token:'b'.repeat(64)}),set:async()=>{},remove:async()=>{}}},
    tabs:{onRemoved:event,onUpdated:event,get:async()=>{throw new Error('Cookie import must not access tabs');}},
    runtime:{getURL:()=>firefox?'moz-extension://test/':'chrome-extension://test/',id:'test',onMessage:event,onInstalled:event,onStartup:event},
    alarms:{onAlarm:event,create:async()=>{}},action:{setBadgeText:async()=>{}},
    permissions:{contains:async()=>granted,onAdded:event,onRemoved:event},
    cookies:{getAll:async({storeId}: any)=>{queried=storeId;return source;}},
  };
  class Socket {
    static OPEN=1; static CONNECTING=0;
    readyState=1; onopen?:()=>void; onmessage?: (event:any)=>Promise<void>; onclose?: (event:any)=>void;
    constructor() {socket=this;setImmediate(()=>this.onopen?.());}
    send(raw:string){sent.push(JSON.parse(raw));}
    close(){this.readyState=3;this.onclose?.({code:1008});}
  }
  runInNewContext(script,{[variant === 'Chromium'?'chrome':'browser']:api,WebSocket:Socket,URL,setTimeout,clearTimeout});
  try {
    for(let i=0;i<20&&!sent.length;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(sent[0].type,'hello');
    await socket.onmessage({data:JSON.stringify({type:'ready'})});
    assert.equal(sent.at(-1).cookieImportAvailable,false);
    const command = async (offset:number,action='cookies')=>{
      await socket.onmessage({data:JSON.stringify({type:'command',id:String(offset),command:{action,transferId:'test-transfer',offset}})});
      return sent.findLast(item=>item.type==='result');
    };
    assert.match((await command(0)).error,/Enable cookie import/);assert.equal(queried,'');
    granted=true;
    const first=await command(0);assert.equal(first.result.cookies.length,25);assert.equal(first.result.total,28);
    assert.equal(queried,firefox?'firefox-default':'0');
    const second=await command(25);assert.equal(second.result.cookies.length,3);
    await command(28,'cookies-clear');
    assert.match((await command(25)).error,/expired/);
    assert.equal(sent.filter(item=>item.type==='tabs').some(item=>JSON.stringify(item).includes('private-value')),false);
  } finally {socket?.close();}
});
