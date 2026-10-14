// Synthetic browser profiles only; smoke tests never read personal cookie stores.
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
export async function cookieProfiles(home) {
  const support = path.join(home, 'Library/Application Support');
  const zen = path.join(support, 'zen/Profiles/test.default');
  await mkdir(zen, { recursive: true });
  const firefox = new DatabaseSync(path.join(zen, 'cookies.sqlite'));
  firefox.exec("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, isSecure INTEGER, isHttpOnly INTEGER, expiry INTEGER, sameSite INTEGER, originAttributes TEXT); INSERT INTO moz_cookies VALUES ('example.com', 'native-fixture', 'local-native-only', '/', 1, 1, 0, 1, '')");
  firefox.close();
  await writeFile(path.join(support, 'zen/profiles.ini'), '[Profile0]\nName=Personal\nIsRelative=1\nPath=Profiles/test.default\n');
  for (const root of ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']) {
    const directory = path.join(support, root, 'Default/Network');
    await mkdir(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, 'Cookies'));
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, is_persistent INTEGER, samesite INTEGER, top_frame_site_key TEXT); INSERT INTO cookies VALUES ('example.com', 'chromium-fixture', 'local-chromium-only', X'', '/', 0, 1, 1, 0, 1, '')");
    db.close();
  }
  const directory = path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies');
  await mkdir(directory, { recursive: true });
  const strings = ['example.com', 'safari-fixture', '/', 'local-safari-only'].map(value => Buffer.from(`${value}\0`));
  const record = Buffer.alloc(56 + strings.reduce((sum, value) => sum + value.length, 0));
  record.writeUInt32LE(record.length); record.writeUInt32LE(5, 8); record.writeDoubleLE(Date.now() / 1000 + 86400 - 978307200, 40);
  let offset = 56;
  strings.forEach((value, index) => { record.writeUInt32LE(offset, 16 + index * 4); value.copy(record, offset); offset += value.length; });
  const page = Buffer.alloc(16 + record.length); page.writeUInt32BE(0x100); page.writeUInt32LE(1, 4); page.writeUInt32LE(16, 8); record.copy(page, 16);
  const header = Buffer.alloc(12); header.write('cook'); header.writeUInt32BE(1, 4); header.writeUInt32BE(page.length, 8);
  await writeFile(path.join(directory, 'Cookies.binarycookies'), Buffer.concat([header, page]));
}
