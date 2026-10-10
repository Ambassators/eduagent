import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { BrowserBridge } from '../src/main/browser-bridge.ts';
const origin = `chrome-extension://${'a'.repeat(32)}`;
async function paired(bridge: BrowserBridge, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin });
  await once(socket, 'open');
  const next = once(socket,'message');
  socket.send(JSON.stringify({ type:'hello', token, name:'test browser' }));
  const [message] = await next;
  return { socket, clientId:JSON.parse(message.toString()).clientId };
}
test('bridge authenticates extensions and routes only explicitly shared tabs', async () => {
  let updated!: () => void;
  const bridge = new BrowserBridge('b'.repeat(64), () => updated?.());
  await bridge.start(0);
  try {
    const { socket, clientId } = await paired(bridge,'b'.repeat(64));
    assert.equal(bridge.clients().length,1);
    assert.throws(() => bridge.request(clientId,'42',{action:'snapshot'}), /not shared/);
    const changed = new Promise<void>(resolve => { updated = resolve; });
    socket.send(JSON.stringify({ type:'tabs', tabs:[{id:42,title:'Study app',url:'https://example.com'}, {id:5,title:'unsafe',url:'file:///secret'}] }));
    await changed;
    assert.equal(bridge.clients()[0].tabs.length,1);
    const message = once(socket,'message');
    const result = bridge.request(clientId,'42',{ action:'snapshot' });
    const [raw] = await message; const command = JSON.parse(raw.toString());
    socket.send(JSON.stringify({type:'result',id:command.id,result:{title:'Study app'}}));
    assert.deepEqual(await result,{title:'Study app'});
    const pending = bridge.request(clientId,'42',{ action:'snapshot' });
    const rejected = assert.rejects(pending,/disconnected/);
    socket.close(); await rejected;
  } finally { bridge.close(); }
});
test('bridge rejects ordinary web origins and incorrect pairing keys', async () => {
  const bridge = new BrowserBridge('b'.repeat(64), () => {}); await bridge.start(0);
  try {
    const web = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin:'https://example.com' });
    await once(web,'error'); assert.equal(bridge.clients().length,0);
    const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin }); await once(bad,'open');
    const closed = once(bad,'close'); bad.send(JSON.stringify({type:'hello',token:'wrong',name:'browser'})); await closed;
    assert.equal(bridge.clients().length,0);
  } finally { bridge.close(); }
});
test('rotating pairing revokes existing connections and old keys', async () => {
  const bridge = new BrowserBridge('b'.repeat(64), () => {}); await bridge.start(0);
  try {
    const {socket} = await paired(bridge,'b'.repeat(64)); const closed = once(socket,'close');
    bridge.rotate('c'.repeat(64)); await closed; assert.equal(bridge.clients().length,0);
    const next = await paired(bridge,'c'.repeat(64)); next.socket.close();
  } finally { bridge.close(); }
});
test('revocation removes access immediately and survives persisted origin lists', async () => {
  let revoked: string[] = [];
  const bridge = new BrowserBridge('b'.repeat(64), () => {}, [], origins => { revoked = origins; }); await bridge.start(0);
  try {
    const {socket,clientId} = await paired(bridge,'b'.repeat(64));
    const closed = once(socket,'close'); bridge.revoke(clientId);
    assert.equal(bridge.clients().length,0);
    assert.throws(()=>bridge.request(clientId,'42',{action:'snapshot'}),/not shared/);
    assert.deepEqual(revoked,[origin]); await closed;
    const denied = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`,{origin}); await once(denied,'error');
    bridge.rotate('c'.repeat(64)); assert.deepEqual(revoked,[]);
    const next = await paired(bridge,'c'.repeat(64)); next.socket.close();
  } finally { bridge.close(); }
});
test('an occupied default bridge port falls back to another loopback port', async () => {
  const first = new BrowserBridge('b'.repeat(64),()=>{}), second = new BrowserBridge('c'.repeat(64),()=>{});
  await first.start(0);
  try { await second.start(first.port); assert.equal(second.available,true); assert.notEqual(first.port,second.port); }
  finally {first.close();second.close();}
});

test('cookie transfer requires an enabled paired browser, without sharing a tab', async () => {
  let updated!: () => void;
  const bridge = new BrowserBridge('b'.repeat(64), () => updated?.()); await bridge.start(0);
  try {
    const {socket,clientId} = await paired(bridge,'b'.repeat(64));
    assert.throws(()=>bridge.requestCookies(clientId,'transfer',0),/Enable cookie import/);
    const changed = new Promise<void>(resolve=>{updated=resolve;});
    socket.send(JSON.stringify({type:'tabs',tabs:[],cookieImportAvailable:true})); await changed;
    const next = once(socket,'message'), result = bridge.requestCookies(clientId,'transfer',0);
    const [raw] = await next, message = JSON.parse(raw.toString());
    assert.equal(message.tabId,undefined); assert.equal(message.command.action,'cookies');
    socket.send(JSON.stringify({type:'result',id:message.id,result:{cookies:[],total:0,omitted:0}}));
    assert.deepEqual(await result,{cookies:[],total:0,omitted:0});
    assert.deepEqual(bridge.clients()[0].tabs,[]); socket.close();
  } finally { bridge.close(); }
});
