// Optional integration test: install Playwright + its Chromium runtime, or set
// PLAYWRIGHT_MODULE to an existing Playwright index.mjs. Never uses your profile.
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../dist/main/main/browser-bridge.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(),'codex-extension-'));
const extension = path.join(temporary,'extension');
const bridge = new BrowserBridge('b'.repeat(64),()=>{});
const server = createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>External study app</h1><input id="name"><button id="apply" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Apply</button><p id="result"></p>');});
let context;
try {
  await cp(path.resolve('dist/extensions/chromium'),extension,{recursive:true});
  // Browser permission prompts need an interactive popup. For this isolated API
  // integration test only, grant the optional permissions at installation time.
  const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  manifest.permissions.push(...manifest.optional_permissions);manifest.host_permissions.push(...manifest.optional_host_permissions);
  delete manifest.optional_permissions;delete manifest.optional_host_permissions;
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  await bridge.start(0); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context = await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(), url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await context.addCookies(Array.from({length:28},(_,i)=>({name:`import${i}`,value:`local-cookie-${i}`,url,httpOnly:true,sameSite:'Lax'})));
  await worker.evaluate(async ({endpoint,token})=>{await api.storage.local.set({endpoint,token});await connect();},{endpoint:`ws://127.0.0.1:${bridge.port}/bridge`,token:'b'.repeat(64)});
  const wait = async check=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error('Extension state timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
  await wait(()=>bridge.clients()[0]?.cookieImportAvailable);
  const clientId=bridge.clients()[0].id;
  assert.equal(bridge.clients()[0].tabs.length,0);
  const first=await bridge.requestCookies(clientId,'smoke-import',0);
  assert.equal(first.cookies.length,25);assert.equal(first.total,28);assert.equal(first.cookies[0].httpOnly,true);
  const second=await bridge.requestCookies(clientId,'smoke-import',25);
  assert.equal(second.cookies.length,3);await bridge.requestCookies(clientId,'smoke-import',28,true);
  const tabId = await worker.evaluate(async url=>{const tabs=await api.tabs.query({});const tab=tabs.find(tab=>tab.url===`${url}/`);grants.set(tab.id,new URL(tab.url).origin);await saveGrants();await publish();return tab.id;},url);
  await wait(()=>bridge.clients()[0]?.tabs.some(tab=>tab.id===tabId));
  const read=()=>bridge.request(clientId,String(tabId),{action:'snapshot'});
  assert.match((await read()).text,/External study app/);
  await bridge.request(clientId,String(tabId),{action:'fill',selector:'#name',value:'External action'});
  await bridge.request(clientId,String(tabId),{action:'click',selector:'#apply'});
  assert.match((await read()).text,/External action/);
  await worker.evaluate(async id=>{grants.delete(id);await saveGrants();await publish();},tabId);
  await wait(()=>bridge.clients()[0]?.tabs.length===0);
  assert.throws(()=>read(),/not shared/);
  bridge.revoke(clientId);assert.equal(bridge.clients().length,0);
  console.log('PASS: real Chromium extension pairing, default-profile cookie batches, shared-page snapshots/actions, unshare, and disconnect.');
} finally {
  await context?.close();bridge.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}
