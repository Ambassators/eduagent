import { app, BrowserWindow, protocol } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePresentationProtocol } from '../dist/main/main/presentation-protocol.js';
import { demoDocument, PRESENTATION_CSP } from '../dist/main/presentation.js';

protocol.registerSchemesAsPrivileged([{scheme:'codex-presentation',privileges:{standard:true,secure:true}}]);
app.on('window-all-closed',()=>{});
async function main() {
  const profile=await mkdtemp(path.join(os.tmpdir(),'eduagent-presentation-popups-'));
  app.setPath('userData',profile);
  const windows=new Set();
  const timeout=setTimeout(()=>{console.error('Presentation popup test timed out');app.exit(1);},20000);

  try {
    await app.whenReady();
    const content=new Map([
      ['text-popup','<h1>LEFT JOIN: basic syntax</h1><pre>SELECT * FROM customers LEFT JOIN orders ON customers.id = orders.customer_id;</pre>'],
      ['demo-popup','<h1>Join demonstration</h1><button onclick="this.textContent=\'Joined\'">Join</button>']
    ]);
    const handler=request=>new Response(demoDocument(content.get(new URL(request.url).hostname)),{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':PRESENTATION_CSP}});
    const open=async id=>{
      const window=new BrowserWindow({show:false,width:880,height:680,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:'presentation-'+id}});
      windows.add(window);
      window.on('closed',()=>windows.delete(window));
      ensurePresentationProtocol(window.webContents.session.protocol,handler);
      await window.loadURL(`codex-presentation://${id}/`);
      return window;
    };
    for(const id of content.keys()) {
      let originalSession;
      for(let attempt=0;attempt<3;attempt++) {
        const window=await open(id);
        if(originalSession)assert.equal(window.webContents.session,originalSession,'Reopening must reuse the same partition');
        else originalSession=window.webContents.session;
        assert.equal(await window.webContents.executeJavaScript('document.querySelector("h1").textContent'),id==='text-popup'?'LEFT JOIN: basic syntax':'Join demonstration');
        if(id==='demo-popup')assert.equal(await window.webContents.executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'Joined','Inline interaction still works after reopening');
        if(id==='text-popup'&&attempt===0)content.set(id,'<h1>LEFT JOIN: basic syntax</h1><pre>Updated SQL explanation</pre>');
        if(id==='text-popup'&&attempt>0)assert.equal(await window.webContents.executeJavaScript('document.querySelector("pre").textContent'),'Updated SQL explanation','Reopening serves current content');
        window.destroy();
      }
    }
    const textWindow=await open('text-popup'),demoWindow=await open('demo-popup');
    assert.notEqual(textWindow.webContents.session,demoWindow.webContents.session,'Separate artifacts keep separate sessions');
    textWindow.destroy();demoWindow.destroy();
    console.log('PASS: text and interactive popups load and reopen repeatedly, serve updated content, and keep separate sessions.');
  } catch(error) {
    console.error(error);process.exitCode=1;
  } finally {
    clearTimeout(timeout);
    for(const window of windows)window.destroy();
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    app.exit(process.exitCode||0);
  }

}
void main().catch(error=>{console.error(error);app.exit(1);});
