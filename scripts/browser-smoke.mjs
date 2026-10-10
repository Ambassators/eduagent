// Real Chromium smoke test: run after npm run build.
import { app, BrowserWindow, session } from 'electron';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserWorkspace } from '../dist/main/main/browser.js';
app.on('window-all-closed', () => {});
async function main() {
console.log('Starting Chromium smoke test');
const profile = await mkdtemp(path.join(os.tmpdir(), 'codex-browser-smoke-'));
app.setPath('userData',profile);
await app.whenReady();
console.log('Electron ready');
const server = createServer((req,res) => {
  res.setHeader('Content-Type','text/html');
  if(req.url==='/next') res.end('<h1>Next page</h1>');
  else res.end('<h1>Study app</h1><p>Test content</p><input id="name" aria-label="Name"><input id="secret" type="password" value="private"><select id="choice"><option value="one">One</option><option value="two">Two</option></select><button id="apply" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Apply</button><p id="result"></p><a href="/next">Next</a>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const win = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
const workspace = new BrowserWorkspace(profile,path.resolve('dist/extensions'),()=>{});
try {
  await workspace.initialize(0); console.log('Browser initialized'); workspace.attach(win);
  const peer = new WebSocket(workspace.pairing().endpoint,{origin:`chrome-extension://${'a'.repeat(32)}`});
  await once(peer,'open'); const greeted = once(peer,'message');
  peer.send(JSON.stringify({type:'hello',token:workspace.pairing().token,name:'Chromium'}));
  const [hello] = await greeted, clientId = JSON.parse(hello.toString()).clientId;
  const source = Array.from({length:27},(_,i)=>({name:`test${i}`,value:`value${i}`,domain:'127.0.0.1',path:'/',secure:false,httpOnly:true,hostOnly:true,session:i%2===0,sameSite:'lax',expirationDate:Date.now()/1000+86400,storeId:'0'}));
  source.push({...source[0],name:'private',storeId:'1'},{...source[0],name:'partitioned',partitionKey:{topLevelSite:'https://example.com'}});
  peer.on('message', raw=>{
    const message = JSON.parse(raw.toString());
    if(message.type!=='command') return;
    const result = message.command.action==='cookies-clear' ? {cleared:true} : {cookies:source.slice(message.command.offset,message.command.offset+25),total:source.length,omitted:0};
    peer.send(JSON.stringify({type:'result',id:message.id,result}));
  });
  peer.send(JSON.stringify({type:'tabs',tabs:[],cookieImportAvailable:true}));
  await new Promise(resolve=>setTimeout(resolve,50));
  const imported = await workspace.importCookies(clientId);
  assert.deepEqual(imported,{imported:27,skipped:2,failed:0});
  const savedCookies = await session.fromPartition('persist:workspace-browser').cookies.get({domain:'127.0.0.1'});
  assert.equal(savedCookies.length,27); assert.equal(savedCookies[0].httpOnly,true);
  assert.equal(savedCookies.find(item=>item.name==='test0').session,true);
  assert.equal(savedCookies.find(item=>item.name==='test1').session,false);
  assert.equal((await session.defaultSession.cookies.get({domain:'127.0.0.1'})).length,0);
  assert.equal(JSON.stringify(workspace.state()).includes('value0'),false); peer.close();
  const opened = workspace.open(); const tabId = opened.activeId;
  workspace.setBounds({x:0,y:0,width:600,height:400,visible:true});
  await workspace.navigate(tabId,url); 
  const read = () => workspace.execute('browser_read',{tabId});
  const snapshot = await read();
  assert.match(snapshot.text,/Study app/);
  assert.equal(snapshot.elements.find(el=>el.selector==='#secret').value,'[redacted]');
  const act = args => workspace.execute('browser_act',{tabId,...args});
  await act({action:'fill',selector:'#name',value:'Alex'});
  await act({action:'select',selector:'#choice',value:'two'});
  await act({action:'click',selector:'#apply'});
  assert.match((await read()).text,/Alex/);
  await assert.rejects(act({action:'fill',selector:'#secret',value:'oops'}),/passwords/);
  await assert.rejects(act({action:'click',selector:'input'}),/matched 2/);
  await assert.rejects(workspace.navigate(tabId,'javascript:alert(1)'),/HTTP/);
  await workspace.navigate(tabId,`${url}/next`); assert.match((await read()).text,/Next page/);
  assert.equal(workspace.state().tabs[0].canGoBack,true);
  assert.equal(win.contentView.children.length,1);
  workspace.setBounds({x:0,y:0,width:600,height:400,visible:false});
  assert.equal(win.contentView.children[0].getVisible(),false);
  workspace.select(tabId); workspace.closeTab(tabId); assert.equal(workspace.state().tabs.length,0);
  console.log('PASS: paired batched cookie import with scope isolation, real Chromium navigation, snapshots, fill/select/click, password protection, history, view visibility, tab lifecycle.');
} catch(error) { console.error(error); process.exitCode=1; }
finally { workspace.shutdown(); win.destroy(); await new Promise(resolve=>server.close(resolve)); await rm(profile,{recursive:true,force:true}); app.exit(process.exitCode || 0); }

}
void main().catch(error => { console.error(error); app.exit(1); });
