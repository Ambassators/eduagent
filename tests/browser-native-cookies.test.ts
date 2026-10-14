import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { NativeCookieImporter, decryptChromiumCookie, safariCookies } from '../src/main/browser-native-cookies.ts';

const future = Date.now() / 1000 + 86400;
const chromiumKey = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
function encrypted(domain: string, value: string, version = 24, key = chromiumKey) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([version >= 24 ? createHash('sha256').update(domain).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}
async function firefoxDB(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, isSecure INTEGER, isHttpOnly INTEGER, expiry INTEGER, sameSite INTEGER, originAttributes TEXT)');
  const insert = db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('.example.com', 'login', 'fixture-secret', '/', 1, 1, future, 2, '');
  insert.run('example.com', 'session', 'session-value', '/app', 1, 0, 0, 1, '');
  insert.run('example.com', 'expired', 'x', '/', 1, 0, 1, 1, '');
  insert.run('example.com', 'container', 'x', '/', 1, 0, future, 1, '^userContextId=1');
  insert.run('example.com', 'private', 'x', '/', 1, 0, future, 1, '^privateBrowsingId=1');
  insert.run('example.com', 'partition', 'x', '/', 1, 0, future, 1, '^partitionKey=%28https%2Cexample.com%29');
  return db;
}
async function chromiumDB(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, is_persistent INTEGER, samesite INTEGER, top_frame_site_key TEXT); CREATE TABLE meta (key TEXT, value INTEGER); INSERT INTO meta VALUES ('version', 24)");
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const expiry = Math.round((future + 11644473600) * 1e6);
  insert.run('.example.com', 'encrypted', '', encrypted('.example.com', 'fixture-secret'), '/', expiry, 1, 1, 1, 0, '');
  insert.run('example.com', 'session', 'plain-value', Buffer.alloc(0), '/app', 0, 1, 0, 0, 1, '');
  insert.run('example.com', 'partition', '', encrypted('example.com', 'x'), '/', expiry, 1, 0, 1, 2, 'https://example.com');
  insert.run('example.com', 'expired', 'x', Buffer.alloc(0), '/', 1, 1, 0, 1, 1, '');
  insert.run('example.com', 'bound', '', Buffer.from('v20browser-bound-fixture'), '/', expiry, 1, 0, 1, 1, '');
  insert.run('example.com', 'wrong-domain', '', encrypted('.other.com', 'x'), '/', expiry, 1, 0, 1, 1, '');
  return db;
}
function safariFixture() {
  const strings = ['.example.com', 'login', '/', 'safari-fixture-secret'].map(value => Buffer.from(`${value}\0`));
  const record = Buffer.alloc(56 + strings.reduce((sum, value) => sum + value.length, 0));
  record.writeUInt32LE(record.length, 0); record.writeUInt32LE(5, 8); record.writeDoubleLE(future - 978307200, 40);
  let position = 56;
  strings.forEach((value, index) => { record.writeUInt32LE(position, 16 + index * 4); value.copy(record, position); position += value.length; });
  const page = Buffer.alloc(16 + record.length); page.writeUInt32BE(0x100, 0); page.writeUInt32LE(1, 4); page.writeUInt32LE(16, 8); record.copy(page, 16);
  const header = Buffer.alloc(12); header.write('cook'); header.writeUInt32BE(1, 4); header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page]);
}
async function temporary(t: any) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cookie-import-test-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}

test('macOS detects Zen, Chrome, Brave, Edge, Safari and named profiles without exposing file paths or cookies', async t => {
  const home = await temporary(t), mac = path.join(home, 'Library/Application Support');
  for (const root of ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']) {
    const directory = path.join(mac, root);
    const db = await chromiumDB(path.join(directory, 'Default/Network/Cookies')); db.close();
    await writeFile(path.join(directory, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
  }
  const zen = path.join(mac, 'zen');
  (await firefoxDB(path.join(zen, 'Profiles/abc.default/cookies.sqlite'))).close();
  await writeFile(path.join(zen, 'profiles.ini'), '[Profile0]\nName=My Zen\nIsRelative=1\nPath=Profiles/abc.default\n');
  const safari = path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies');
  await mkdir(safari, { recursive: true }); await writeFile(path.join(safari, 'Cookies.binarycookies'), safariFixture());
  const importer = new NativeCookieImporter({ home, platform: 'darwin', env: {} });
  const sources = await importer.list();
  assert.equal(sources.length, 5);
  assert.deepEqual(new Set(sources.map(source => source.browser)), new Set(['Chrome', 'Brave', 'Edge', 'Zen', 'Safari']));
  assert.equal(sources.find(source => source.browser === 'Zen')?.profile, 'My Zen');
  assert.equal(sources.find(source => source.browser === 'Chrome')?.profile, 'Personal');
  assert.equal(JSON.stringify(sources).includes(home), false);
  assert.equal(JSON.stringify(sources).includes('fixture-secret'), false);
  assert.deepEqual(Object.keys(sources[0]).sort(), ['browser', 'id', 'profile']);
  const imported: any[] = [];
  assert.deepEqual(await importer.import(sources.find(source => source.browser === 'Safari')!.id, async cookie => { imported.push(cookie); }), { imported: 1, skipped: 0, failed: 0 });
  assert.equal(imported[0].httpOnly, true); assert.equal(imported[0].secure, true); assert.equal(imported[0].value, 'safari-fixture-secret');
});

test('Zen reads active WAL cookies, preserves scope, and excludes private/container/partitioned cookies', async t => {
  const home = await temporary(t), root = path.join(home, '.zen');
  const file = path.join(root, 'Profiles/abc.default/cookies.sqlite');
  const db = await firefoxDB(file);
  try {
  db.exec("PRAGMA journal_mode=WAL; INSERT INTO moz_cookies VALUES ('example.com', 'wal-cookie', 'fresh', '/', 1, 0, 0, 0, '')");
  const before = await readFile(file);
  const importer = new NativeCookieImporter({ home, platform: 'linux', env: {} });
  const [source] = await importer.list(), cookies: any[] = [];
  const result = await importer.import(source.id, async cookie => { cookies.push(cookie); });
  assert.deepEqual(result, { imported: 3, skipped: 4, failed: 0 });
  assert.deepEqual(await readFile(file), before);
  assert.equal(cookies[0].domain, '.example.com'); assert.equal(cookies[0].sameSite, 'strict'); assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[1].path, '/app'); assert.equal('domain' in cookies[1], false); assert.equal('expirationDate' in cookies[1], false);
  assert.equal(cookies[2].name, 'wal-cookie');
  } finally { db.close(); }
});

test('Chromium decrypts schema 24, counts blocked/mismatched cookies, and keeps session cookies', async t => {
  const home = await temporary(t), file = path.join(home, '.config/google-chrome/Profile 2/Cookies');
  (await chromiumDB(file)).close();
  const before = await readFile(file);
  const importer = new NativeCookieImporter({ home, platform: 'linux', env: {} });
  const [source] = await importer.list(), cookies: any[] = [];
  const result = await importer.import(source.id, async cookie => { cookies.push(cookie); });
  assert.deepEqual({ ...result, error: undefined }, { imported: 2, skipped: 2, failed: 2, error: undefined });
  assert.match(result.error!, /browser-bound encryption/);
  assert.equal(cookies[0].value, 'fixture-secret'); assert.equal(cookies[0].sameSite, 'no_restriction');
  assert.equal('expirationDate' in cookies[1], false);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.deepEqual(await readFile(file), before);
});

test('macOS CBC and Windows GCM validate cookie domain hashes and authentication', () => {
  const key = pbkdf2Sync('mac-safe-storage-fixture', 'saltysalt', 1003, 16, 'sha1');
  assert.equal(decryptChromiumCookie(encrypted('.example.com', 'secret', 24, key), key, '.example.com', 24, 'darwin'), 'secret');
  assert.equal(decryptChromiumCookie(encrypted('.example.com', 'old', 23, key), key, '.example.com', 23, 'darwin'), 'old');
  assert.throws(() => decryptChromiumCookie(encrypted('.example.com', 'secret', 24, key), key, 'example.com', 24, 'darwin'), /domain verification/);
  const gcmKey = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', gcmKey, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([createHash('sha256').update('example.com').digest(), Buffer.from('windows-fixture')])), cipher.final()]);
  const blob = Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]);
  assert.equal(decryptChromiumCookie(blob, gcmKey, 'example.com', 24, 'win32'), 'windows-fixture');
  blob[blob.length - 1] ^= 1;
  assert.throws(() => decryptChromiumCookie(blob, gcmKey, 'example.com', 24, 'win32'));
});

test('Safari parser rejects invalid lengths, offsets and unterminated strings', () => {
  const valid = safariFixture(); assert.equal(safariCookies(valid).cookies.length, 1);
  assert.throws(() => safariCookies(valid.subarray(0, -1)), /damaged Safari/);
  const badOffset = Buffer.from(valid); badOffset.writeUInt32LE(0xffffffff, 20);
  assert.throws(() => safariCookies(badOffset), /damaged Safari/);
  const badString = Buffer.from(valid); badString.writeUInt32LE(0xffffffff, 44);
  assert.throws(() => safariCookies(badString), /damaged Safari/);
  const noTerminator = Buffer.from(valid); noTerminator[noTerminator.length - 1] = 65;
  assert.throws(() => safariCookies(noTerminator), /damaged Safari/);
});

test('discovery supports Windows overrides and absolute Firefox profiles while rejecting renderer paths', async t => {
  const home = await temporary(t), roaming = path.join(home, 'roaming'), local = path.join(home, 'local');
  (await chromiumDB(path.join(local, 'Microsoft/Edge/User Data/Default/Cookies'))).close();
  const external = path.join(home, 'external'); (await firefoxDB(path.join(external, 'cookies.sqlite'))).close();
  await mkdir(path.join(roaming, 'zen'), { recursive: true });
  await writeFile(path.join(roaming, 'zen/profiles.ini'), `[Profile0]\nName=External\nIsRelative=0\nPath=${external}\n`);
  const importer = new NativeCookieImporter({ home, platform: 'win32', env: { APPDATA: roaming, LOCALAPPDATA: local } });
  assert.deepEqual(new Set((await importer.list()).map(source => source.browser)), new Set(['Edge', 'Zen']));
  let called = false;
  const result = await importer.import(external, async () => { called = true; });
  assert.match(result.error!, /Refresh/); assert.equal(called, false);
});

test('missing databases and cookie setter failures return counts without leaking data', async t => {
  const home = await temporary(t), file = path.join(home, '.zen/Profiles/test/cookies.sqlite');
  (await firefoxDB(file)).close();
  const importer = new NativeCookieImporter({ home, platform: 'linux', env: {} }), [source] = await importer.list();
  const failed = await importer.import(source.id, async () => { throw new Error('fixture-secret'); });
  assert.equal(failed.failed, 2); assert.equal(JSON.stringify(failed).includes('fixture-secret'), false);
  await rm(file);
  const missing = await importer.import(source.id, async () => {});
  assert.match(missing.error!, /Close the source browser/); assert.equal(JSON.stringify(missing).includes(home), false);
});
