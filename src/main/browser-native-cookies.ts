import { createHash, createDecipheriv, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CookieImportResult, CookieImportSource } from '../browser.js';
import { importedCookie } from './browser-cookies.ts';

const LIMIT = 20000;
const MAX_FILE = 64 * 1024 * 1024;
type Family = 'chromium' | 'firefox' | 'safari';
interface Source extends CookieImportSource { family: Family; file: string; root: string; service?: string; application?: string }
interface Environment { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
type CookieDetails = NonNullable<ReturnType<typeof importedCookie>>;
type Row = Record<string, string | number | bigint | null | Uint8Array>;

async function exists(file: string) {
  try { return (await stat(file)).isFile(); } catch (error) {
    // Keep protected Safari stores visible so the import can explain how to grant access.
    return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}
async function directories(root: string) {
  try { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
  catch { return []; }
}
async function boundedFile(file: string) {
  if ((await stat(file)).size > MAX_FILE) throw new Error('Cookie file is too large.');
  return readFile(file);
}
async function jsonFile(file: string): Promise<Record<string, any>> {
  try { return JSON.parse((await boundedFile(file)).toString('utf8')); } catch { return {}; }
}

// No shell, no credentials in argv, and no child-process stderr in diagnostics.
function command(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('Browser encryption key is unavailable.'));
      else resolve(stdout.replace(/\r?\n$/, ''));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export function decryptChromiumCookie(encrypted: Uint8Array, key: Buffer, domain: string, version: number, platform: NodeJS.Platform) {
  const data = Buffer.from(encrypted), prefix = data.subarray(0, 3).toString('ascii');
  if (!['v10', 'v11'].includes(prefix)) throw new Error('Unsupported browser encryption.');
  let plaintext: Buffer;
  if (platform === 'win32') {
    if (data.length < 31 || key.length !== 32) throw new Error('Invalid encrypted cookie.');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(3, 15));
    decipher.setAuthTag(data.subarray(-16));
    plaintext = Buffer.concat([decipher.update(data.subarray(15, -16)), decipher.final()]);
  } else {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    plaintext = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  }
  // Chromium schema 24 binds encrypted values to their exact host_key.
  if (version >= 24) {
    const hash = createHash('sha256').update(domain).digest();
    if (plaintext.length < 32 || !timingSafeEqual(hash, plaintext.subarray(0, 32))) throw new Error('Cookie domain verification failed.');
    plaintext = plaintext.subarray(32);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

// Safari's persistent binary store uses big-endian page sizes and little-endian
// records. Bounds are checked before reading strings or following any offsets.
export function safariCookies(data: Buffer): { cookies: unknown[]; omitted: number } {
  const invalid = () => { throw new Error('Unsupported or damaged Safari cookie file.'); };
  if (data.length < 8 || data.subarray(0, 4).toString() !== 'cook') invalid();
  const pages = data.readUInt32BE(4);
  if (pages > 100000 || 8 + pages * 4 > data.length) invalid();
  const cookies: unknown[] = [];
  let offset = 8 + pages * 4, omitted = 0;
  for (let index = 0; index < pages; index++) {
    const size = data.readUInt32BE(8 + index * 4);
    if (size < 12 || offset + size > data.length) invalid();
    const page = data.subarray(offset, offset + size); offset += size;
    if (page.readUInt32BE(0) !== 0x00000100) invalid();
    const count = page.readUInt32LE(4), header = 12 + count * 4;
    if (header > size) invalid();
    for (let item = 0; item < count; item++) {
      const start = page.readUInt32LE(8 + item * 4);
      if (start < header || start + 56 > size) invalid();
      const length = page.readUInt32LE(start);
      if (length < 56 || start + length > size) invalid();
      if (cookies.length === LIMIT) { omitted++; continue; }
      const record = page.subarray(start, start + length);
      const string = (field: number) => {
        const position = record.readUInt32LE(field), end = record.indexOf(0, position);
        if (position < 56 || position >= length || end < position) invalid();
        return new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(position, end));
      };
      const flags = record.readUInt32LE(8), domain = string(16);
      // Unknown record/flag layouts may include scope information we cannot retain.
      if (record.readUInt32LE(4) !== 0 || record.readUInt32LE(12) !== 0 || (flags & ~5)) { omitted++; continue; }
      cookies.push({ domain, name: string(20), path: string(24), value: string(28),
        hostOnly: !domain.startsWith('.'), secure: !!(flags & 1), httpOnly: !!(flags & 4),
        session: false, expirationDate: record.readDoubleLE(40) + 978307200, sameSite: 'unspecified' });
    }
  }
  return { cookies, omitted };
}

export class NativeCookieImporter {
  private sources = new Map<string, Source>();
  private home: string;
  private platform: NodeJS.Platform;
  private env: NodeJS.ProcessEnv;
  constructor(environment: Environment = {}) {
    this.home = environment.home ?? os.homedir();
    this.platform = environment.platform ?? process.platform;
    this.env = environment.env ?? process.env;
  }
  async list(): Promise<CookieImportSource[]> {
    const found = new Map<string, Source>();
    const add = async (browser: string, profile: string, family: Family, file: string, root: string, service?: string, application?: string) => {
      if (!await exists(file)) return;
      try { file = await realpath(file); } catch { /* Protected Safari stores still need an actionable entry. */ }
      const id = `native:${createHash('sha256').update(file).digest('hex').slice(0, 32)}`;
      if (!found.has(id)) found.set(id, { id, browser, profile, family, file, root, service, application });
    };
    const mac = path.join(this.home, 'Library/Application Support');
    const local = this.env.LOCALAPPDATA || path.join(this.home, 'AppData/Local');
    const roaming = this.env.APPDATA || path.join(this.home, 'AppData/Roaming');
    const config = this.env.XDG_CONFIG_HOME || path.join(this.home, '.config');
    const chromium = [
      ['Chrome', 'Google/Chrome', 'Google/Chrome/User Data', 'google-chrome', 'Chrome', 'chrome'],
      ['Chrome Beta', 'Google/Chrome Beta', 'Google/Chrome Beta/User Data', 'google-chrome-beta', 'Chrome', 'chrome'],
      ['Chromium', 'Chromium', 'Chromium/User Data', 'chromium', 'Chromium', 'chromium'],
      ['Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser/User Data', 'BraveSoftware/Brave-Browser', 'Brave', 'brave'],
      ['Edge', 'Microsoft Edge', 'Microsoft/Edge/User Data', 'microsoft-edge', 'Microsoft Edge', 'microsoft-edge'],
      ['Vivaldi', 'Vivaldi', 'Vivaldi/User Data', 'vivaldi', 'Vivaldi', 'vivaldi'],
      ['Arc', 'Arc/User Data', 'Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data', '', 'Arc', 'arc'],
      ['Opera', 'com.operasoftware.Opera', '', 'opera', 'Opera', 'opera'],
    ];
    for (const [browser, macPath, winPath, linuxPath, keyName, application] of chromium) {
      if (this.platform === 'linux' && !linuxPath) continue;
      const root = this.platform === 'darwin' ? path.join(mac, macPath) : this.platform === 'win32' ?
        (browser === 'Opera' ? path.join(roaming, 'Opera Software/Opera Stable') : path.join(local, winPath)) : path.join(config, linuxPath);
      const state = await jsonFile(path.join(root, 'Local State'));
      const names: Record<string, { name?: string }> = state.profile?.info_cache ?? {};
      const profiles = new Set(['Default', ...await directories(root), ...Object.keys(names)]);
      for (const profile of profiles) {
        if (['Guest Profile', 'System Profile'].includes(profile) || (!/^Default$|^Profile \d+$/.test(profile) && !Object.hasOwn(names, profile))) continue;
        if (path.basename(profile) !== profile || profile === '.' || profile === '..') continue;
        for (const relative of ['Network/Cookies', 'Cookies']) {
          const file = path.join(root, profile, relative);
          if (await exists(file)) { await add(browser, names[profile]?.name || profile, 'chromium', file, root, `${keyName} Safe Storage`, application); break; }
        }
      }
      // Opera and older Chromium derivatives can use the root as their profile.
      for (const relative of ['Network/Cookies', 'Cookies']) if (await exists(path.join(root, relative))) {
        await add(browser, 'Default', 'chromium', path.join(root, relative), root, `${keyName} Safe Storage`, application); break;
      }
    }
    const firefox = [
      ['Zen', ['zen', 'Zen', 'ZenBrowser'], ['zen'], ['.zen', '.var/app/app.zen_browser.zen/zen', '.var/app/app.zen_browser.zen/.zen']],
      ['Firefox', ['Firefox'], ['Mozilla/Firefox'], ['.mozilla/firefox', '.var/app/org.mozilla.firefox/.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox']],
      ['LibreWolf', ['librewolf'], ['librewolf'], ['.librewolf', '.var/app/io.gitlab.librewolf-community/.librewolf']],
      ['Waterfox', ['Waterfox'], ['Waterfox'], ['.waterfox']],
      ['Floorp', ['Floorp'], ['Floorp'], ['.floorp']],
    ] as const;
    for (const [browser, macPaths, winPaths, linuxPaths] of firefox) {
      const roots = this.platform === 'darwin' ? macPaths.map(value => path.join(mac, value)) :
        this.platform === 'win32' ? winPaths.map(value => path.join(roaming, value)) : linuxPaths.map(value => path.join(this.home, value));
      for (const root of roots) {
        const profiles = new Map<string, string>();
        try {
          const ini = (await boundedFile(path.join(root, 'profiles.ini'))).toString('utf8');
          for (const section of ini.split(/(?=^\[)/m)) {
            if (!/^\[Profile[^\]]*\]/.test(section)) continue;
            const fields = Object.fromEntries(section.split(/\r?\n/).flatMap(line => {
              const match = /^([^=;#]+)=(.*)$/.exec(line); return match ? [[match[1].trim(), match[2].trim()]] : [];
            }));
            if (fields.Path) profiles.set(fields.IsRelative === '0' ? path.resolve(fields.Path) : path.resolve(root, fields.Path), fields.Name || path.basename(fields.Path));
          }
        } catch { /* Also discover profiles not registered in the INI. */ }
        for (const parent of [root, path.join(root, 'Profiles')]) for (const name of await directories(parent)) {
          const directory = path.join(parent, name); if (!profiles.has(directory)) profiles.set(directory, name);
        }
        for (const [directory, name] of profiles) await add(browser, name, 'firefox', path.join(directory, 'cookies.sqlite'), root);
      }
    }
    if (this.platform === 'darwin') {
      const safari = path.join(this.home, 'Library/Containers/com.apple.Safari/Data/Library');
      for (const file of [path.join(safari, 'Cookies/Cookies.binarycookies'), path.join(this.home, 'Library/Cookies/Cookies.binarycookies')]) {
        if (await exists(file)) { await add('Safari', 'Default', 'safari', file, safari); break; }
      }
      for (const parent of [path.join(safari, 'WebKit/WebsiteDataStore'), path.join(this.home, 'Library/WebKit/com.apple.Safari/WebsiteDataStore')]) {
        for (const name of await directories(parent)) await add('Safari', `Profile ${name}`, 'safari', path.join(parent, name, 'Cookies/Cookies.binarycookies'), parent);
      }
    }
    this.sources = found;
    return [...found.values()].map(({ id, browser, profile }) => ({ id, browser, profile }));
  }
  private async encryptionKey(source: Source): Promise<Buffer> {
    if (this.platform === 'darwin') {
      const password = await command('/usr/bin/security', ['find-generic-password', '-w', '-s', source.service!]);
      if (!password) throw new Error('Browser encryption key is unavailable.');
      return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    }
    if (this.platform === 'linux') {
      const password = await command('secret-tool', ['lookup', 'application', source.application!]);
      if (!password) throw new Error('Browser encryption key is unavailable.');
      return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
    }
    const state = await jsonFile(path.join(source.root, 'Local State'));
    const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64');
    if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Browser encryption key is unavailable.');
    // DPAPI input travels over stdin, never through process arguments or a file.
    const script = 'Add-Type -AssemblyName System.Security; try { $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($k)) } catch { exit 1 }';
    const executable = path.join(this.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const key = Buffer.from(await command(executable, ['-NoProfile', '-NonInteractive', '-Command', script], wrapped.subarray(5).toString('base64')), 'base64');
    if (key.length !== 32) throw new Error('Browser encryption key is unavailable.');
    return key;
  }
  async import(id: string, set: (cookie: CookieDetails) => Promise<void>): Promise<CookieImportResult> {
    const result: CookieImportResult = { imported: 0, skipped: 0, failed: 0 };
    const source = this.sources.get(id);
    if (!source) return { ...result, error: 'Browser profile is no longer available. Refresh the browser list.' };
    let db: DatabaseSync | undefined, key: Buffer | undefined, keyAttempted = false, decryptionFailed = false, protectedCookies = false;
    const save = async (cookie: unknown) => {
      const details = importedCookie(cookie);
      if (!details) { result.skipped++; return; }
      try { await set(details); result.imported++; } catch { result.failed++; }
    };
    try {
      if (source.family === 'safari') {
        const batch = safariCookies(await boundedFile(source.file)); result.skipped += batch.omitted;
        for (const cookie of batch.cookies) await save(cookie);
      } else {
        db = new DatabaseSync(source.file, { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
        const table = source.family === 'firefox' ? 'moz_cookies' : 'cookies';
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
        const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
        result.skipped += Math.max(0, total - LIMIT);
        const statement = db.prepare(`SELECT * FROM ${table} LIMIT ${LIMIT}`);
        // Chromium timestamps exceed JavaScript's safe integer range.
        statement.setReadBigInts(true);
        const rows = statement.all() as Row[];
        let version = 0;
        if (source.family === 'chromium') {
          try { version = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0); } catch { /* Legacy databases predate meta. */ }
        }
        // Release the read transaction before Keychain prompts or Electron writes.
        db.close(); db = undefined;
        for (const row of rows) {
          if (source.family === 'firefox') {
            if (row.originAttributes || Number(row.isPartitioned ?? 0)) { result.skipped++; continue; }
            const expiry = Number(row.expiry);
            await save({ domain: row.host, name: row.name, value: row.value, path: row.path,
              secure: !!row.isSecure, httpOnly: !!row.isHttpOnly, hostOnly: !String(row.host).startsWith('.'),
              session: expiry === 0, expirationDate: expiry, sameSite: ['no_restriction', 'lax', 'strict'][Number(row.sameSite)] ?? 'unspecified' });
          } else {
            if (row.top_frame_site_key || Number(row.is_partitioned ?? 0)) { result.skipped++; continue; }
            const expiry = Number(row.expires_utc) / 1e6 - 11644473600;
            const persistent = columns.has('is_persistent') ? !!row.is_persistent : Number(row.expires_utc) > 0;
            if (persistent && expiry <= Date.now() / 1000) { result.skipped++; continue; }
            let value = row.value;
            const encrypted = row.encrypted_value instanceof Uint8Array ? Buffer.from(row.encrypted_value) : Buffer.alloc(0);
            if (encrypted.length) {
              const prefix = encrypted.subarray(0, 3).toString();
              if (!['v10', 'v11'].includes(prefix)) { result.failed++; protectedCookies = true; continue; }
              try {
                const legacyLinux = this.platform === 'linux' && prefix === 'v10';
                if (!legacyLinux && !keyAttempted) { keyAttempted = true; key = await this.encryptionKey(source); }
                if (!legacyLinux && !key) throw new Error('Browser encryption key is unavailable.');
                value = decryptChromiumCookie(encrypted, legacyLinux ? pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1') : key!, String(row.host_key), version, this.platform);
              } catch { result.failed++; decryptionFailed = true; continue; }
            }
            await save({ domain: row.host_key, name: row.name, value, path: row.path,
              secure: !!row.is_secure, httpOnly: !!row.is_httponly, hostOnly: !String(row.host_key).startsWith('.'),
              session: !persistent, expirationDate: expiry, sameSite: ({ '-1': 'unspecified', '0': 'no_restriction', '1': 'lax', '2': 'strict' } as Record<string, string>)[String(row.samesite)] ?? 'unspecified' });
          }
        }
        if (protectedCookies) result.error = 'Some cookies use browser-bound encryption. Import those through the browser extension.';
        else if (decryptionFailed) result.error = this.platform === 'darwin' ?
          'Some cookies could not be decrypted. Allow access to this browser’s Safe Storage item in Keychain, then retry; or use the extension.' :
          'Some cookies could not be decrypted. Unlock your system keyring or use the browser extension.';
      }
    } catch {
      // SQLite/OS errors can contain paths and data. Only actionable summaries cross IPC.
      result.error = source.family === 'safari' ?
        'Safari cookies could not be read. Grant this app Full Disk Access in System Settings → Privacy & Security, restart the app, and retry. Quit Safari first if needed.' :
        'Browser cookies could not be read. Close the source browser and retry, or use its extension.';
    } finally { db?.close(); key?.fill(0); }
    return result;
  }
}
