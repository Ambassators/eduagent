// Exercise the production React/preload integration with a local browser fixture.
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserWorkspace } from '../dist/main/main/browser.js';
import { defaultSettings } from '../dist/main/shared.js';
app.on('window-all-closed',()=>{});
process.on('uncaughtException',error=>{console.error(error);app.exit(1);});
async function main() {
  const profile = await mkdtemp(path.join(os.tmpdir(),'codex-browser-ui-'));
  app.setPath('userData',profile); await app.whenReady();
  const win = new BrowserWindow({width:1460,height:920,show:false,webPreferences:{preload:path.resolve('dist/main/main/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  const browser = new BrowserWorkspace(profile,path.resolve('dist/extensions'),state=>{if(!win.isDestroyed())win.webContents.send('voice:event',{method:'browser/state',params:{state}});});
  let peer;
  try {
    await browser.initialize(0); browser.attach(win);
    const handlers = {
      status:()=>({connected:false,account:null,models:[],voices:[],voiceAvailable:false,settings:defaultSettings,executable:'',platform:process.platform,darkMode:false}),
      workspace:()=>({files:[],activeId:null,artifacts:[],thinking:{threadId:null,busy:false,delegating:false,compacting:false,queued:0,tokens:0,contextWindow:null,contextVersion:0},annotations:{overlays:[],highlights:[],pointer:null},quiz:{banks:[],quiz:null}}),
      browserImportCookies:id=>browser.importCookies(id),browserState:()=>browser.state(),browserOpen:url=>browser.open(url),browserSelect:id=>browser.select(id),browserClose:id=>browser.closeTab(id),browserNavigate:(id,url)=>browser.navigate(id,url),browserControl:(id,action)=>browser.control(id,action),browserBounds:bounds=>browser.setBounds(bounds),browserPairing:()=>browser.pairing(),browserRotatePairing:()=>browser.rotatePairing(),browserRevoke:id=>browser.bridge.revoke(id),
      syncTranscript:()=>{},
    };
    for(const [name,fn] of Object.entries(handlers)) ipcMain.handle(`voice:${name}`,(_event,...args)=>fn(...args));
    const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message);});
    await win.loadFile(path.resolve('dist/renderer/index.html'));
    const wait = async predicate => { for(let i=0;i<50;i++){if(await win.webContents.executeJavaScript(predicate))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`UI timed out: ${predicate}`); };
    await wait(`!![...document.querySelectorAll('button')].find(el=>el.textContent==='Browser')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Browser').click()`);
    await wait(`!!document.querySelector('.browser-panel') && document.querySelectorAll('.browser-tab').length===1`);
    await win.webContents.executeJavaScript(`document.querySelector('.browser-extension-button').click()`);
    await wait(`!!document.querySelector('.browser-setup')`);
    await new Promise(resolve=>setTimeout(resolve,700));
    await win.webContents.executeJavaScript(`document.querySelector('.browser-cookie-button').click()`);
    await wait(`!!document.querySelector('.browser-cookie-setup')`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.browser-cookie-setup h2').textContent`),'Import cookies');
    peer = new WebSocket(browser.pairing().endpoint,{origin:`chrome-extension://${'a'.repeat(32)}`});
    await once(peer,'open'); const ready=once(peer,'message');
    peer.send(JSON.stringify({type:'hello',token:browser.pairing().token,name:'Chromium'}));await ready;
    peer.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='command')peer.send(JSON.stringify({type:'result',id:message.id,result:message.command.action==='cookies-clear'?{cleared:true}:{cookies:[{name:'ui-test',value:'local-only',domain:'example.com',path:'/',secure:true,httpOnly:true,hostOnly:true,session:true,sameSite:'lax',storeId:'0'}],total:1,omitted:0}}));});
    peer.send(JSON.stringify({type:'tabs',tabs:[],cookieImportAvailable:true}));
    await wait(`!!document.querySelector('.browser-cookie-setup .browser-client button:not(:disabled)')`);
    await win.webContents.executeJavaScript(`document.querySelector('.browser-cookie-setup .browser-client button').click()`);
    await wait(`document.querySelector('.browser-cookie-setup [role="status"]')?.textContent.includes('1 imported')`);
    const cookieImagePath=path.join(os.tmpdir(),'codex-cookie-import-ui.png');await writeFile(cookieImagePath,(await win.webContents.capturePage()).toPNG());
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.browser-cookie-setup').textContent.includes('local-only')`),false);
    await win.webContents.executeJavaScript(`document.querySelector('.browser-extension-button').click()`);
    await wait(`!!document.querySelector('.browser-setup') && !document.querySelector('.browser-cookie-setup')`);
    const imagePath=path.join(os.tmpdir(),'codex-browser-ui.png'); await writeFile(imagePath,(await win.webContents.capturePage()).toPNG());
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.browser-setup h2').textContent`),'Connect your web apps');
    assert.deepEqual(errors,[]);
    console.log(`PASS: production renderer/preload browser tab, extension setup, and cookie import button through real IPC. Screenshot: ${imagePath}`);
  } catch(error) { console.error(error); process.exitCode=1; } finally {peer?.close();browser.shutdown();win.destroy();await rm(profile,{recursive:true,force:true});app.exit(process.exitCode || 0);}
}
void main().catch(error=>{console.error(error);app.exit(1);});
