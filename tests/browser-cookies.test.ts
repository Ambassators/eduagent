import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedCookie } from '../src/main/browser-cookies.ts';
const cookie = { name:'session',value:'secret',domain:'.example.com',path:'/',secure:true,httpOnly:true,hostOnly:false,session:false,expirationDate:200,sameSite:'no_restriction',storeId:'0' };
test('cookie conversion preserves scope, expiry, HTTP-only and same-site flags',()=>{
  assert.deepEqual(importedCookie(cookie,100),{url:'https://example.com/',name:'session',value:'secret',domain:'.example.com',path:'/',secure:true,httpOnly:true,expirationDate:200,sameSite:'no_restriction'});
  const hostOnly = importedCookie({...cookie,hostOnly:true,session:true},100)!;
  assert.equal('domain' in hostOnly,false); assert.equal('expirationDate' in hostOnly,false);
});
test('cookie import rejects expired, private, container, partitioned and malformed cookies',()=>{
  for(const change of [{expirationDate:99},{storeId:'1'},{storeId:'firefox-container-1'},{partitionKey:{topLevelSite:'https://example.com'}},{firstPartyDomain:'example.com'},{domain:'example.com/evil'},{domain:'127.1'},{path:'bad'},{value:42},{sameSite:'bad'}]) assert.equal(importedCookie({...cookie,...change},100),null);
});
