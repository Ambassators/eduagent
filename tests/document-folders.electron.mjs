// Run after npm run build: electron tests/document-folders.electron.mjs [screenshot-directory]
import {app,BrowserWindow,ipcMain} from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {defaultSettings} from '../dist/main/shared.js';
const shots=process.argv[2];
async function main() {
await app.whenReady();
const file=(id,name,folderId)=>({id,name,kind:'text',extension:'.txt',originalPath:`/tmp/${name}`,size:10,revision:1,dirty:false,...(folderId?{folderId}:{})});
let state={files:[file('f1','notes.txt','d1'),file('f2','essay.txt'),file('f3','lab.txt')],folders:[{id:'d1',name:'Chemistry',collapsed:false}],activeId:null,artifacts:[],thinking:{tokens:0},annotations:{overlays:[],highlights:[],pointer:null},quiz:{}};
const calls=[];
const update=change=>{state={...state,...change};return state;};
const handlers={windowActivity:()=>true,status:()=>({connected:true,account:null,models:[],voices:[],voiceAvailable:false,settings:{...defaultSettings,transparency:'opaque'},platform:process.platform,darkMode:false}),workspace:()=>state,browserState:()=>null,stop:()=>{},interrupt:()=>{},saveChat:()=>{},syncTranscript:()=>{},
  createFolder:name=>{calls.push(['createFolder',name]);const folder={id:'d2',name,collapsed:false};return {id:folder.id,workspace:update({folders:[...state.folders,folder]})};},
  renameFolder:(id,name)=>{calls.push(['renameFolder',id,name]);return update({folders:state.folders.map(folder=>folder.id===id?{...folder,name}:folder)});},
  setFolderCollapsed:(id,collapsed)=>{calls.push(['setFolderCollapsed',id,collapsed]);return update({folders:state.folders.map(folder=>folder.id===id?{...folder,collapsed}:folder)});},
  moveFile:(fileId,folderId)=>{calls.push(['moveFile',fileId,folderId]);return update({files:state.files.map(item=>{if(item.id!==fileId)return item;const next={...item};if(folderId)next.folderId=folderId;else delete next.folderId;return next;})});}};
for(const [name,fn] of Object.entries(handlers))ipcMain.handle(`voice:${name}`,(_,...args)=>fn(...args));
ipcMain.handle('voice:updateState',()=>({status:'disabled',currentVersion:'0.0.0',message:'Test build'}));
const win=new BrowserWindow({width:1100,height:760,show:false,webPreferences:{preload:path.resolve('dist/main/main/preload.cjs'),contextIsolation:true,sandbox:true,offscreen:true}});
const js=source=>win.webContents.executeJavaScript(source);
const wait=async source=>{for(let i=0;i<100;i++){if(await js(source))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timeout: '+source);};
const names=`[...document.querySelectorAll('.file-list > .file-row .file-text strong')].map(node=>node.textContent)`;
const inFolder=index=>`[...document.querySelectorAll('.folder')[${index}].querySelectorAll('.file-row .file-text strong')].map(node=>node.textContent)`;
const shot=async name=>{if(!shots)return;await new Promise(r=>setTimeout(r,300));await writeFile(path.join(shots,name),(await win.webContents.capturePage({x:0,y:0,width:300,height:440})).toPNG());};
try{
  await win.loadFile(path.resolve('dist/renderer/index.html'));
  await wait(`document.querySelectorAll('.folder').length===1`);
  assert.deepEqual(await js(inFolder(0)),['notes.txt']);
  assert.deepEqual(await js(names),['essay.txt','lab.txt']);
  await shot('folders-initial.png');

  await js(`document.querySelector('[aria-label="New folder"]').click()`);
  await wait(`document.activeElement?.classList.contains('folder-rename')`);
  await js(`(()=>{const input=document.activeElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Reading');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await wait(`[...document.querySelectorAll('.folder-name')].map(node=>node.textContent).join()==='Chemistry,Reading'`);
  assert.deepEqual(calls.slice(-2),[['createFolder','New folder'],['renameFolder','d2','Reading']]);

  await js(`(()=>{const data=new DataTransfer();const row=[...document.querySelectorAll('.file-list > .file-row')].find(node=>node.textContent.includes('lab.txt'));row.dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));const target=document.querySelectorAll('.folder')[1];target.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`);
  await wait(`${inFolder(1)}.join()==='lab.txt'`);
  assert.deepEqual(calls.at(-1),['moveFile','f3','d2']);
  assert.deepEqual(await js(names),['essay.txt']);
  await shot('folders-moved.png');

  await js(`document.querySelector('.folder-toggle').click()`);
  await wait(`document.querySelector('.folder-toggle').getAttribute('aria-expanded')==='false'`);
  assert.deepEqual(await js(inFolder(0)),[]);
  assert.deepEqual(calls.at(-1),['setFolderCollapsed','d1',true]);
  await shot('folders-collapsed.png');

  await js(`(()=>{const data=new DataTransfer();const row=document.querySelectorAll('.folder')[1].querySelector('.file-row');row.dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));const target=document.querySelector('.file-list');target.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`);
  await wait(`${names}.join()==='essay.txt,lab.txt'`);
  assert.deepEqual(calls.at(-1),['moveFile','f3',null]);
  console.log('Document folder UI checks passed');
}finally{win.destroy();app.quit();}
}
main().catch(error=>{console.error(error);process.exitCode=1;app.quit();});
