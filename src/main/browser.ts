import { BrowserWindow, WebContentsView, session, dialog, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserURL, browserCommand, type BrowserBounds, type BrowserState, type BrowserTab, type BrowserDownload, type CookieImportResult } from '../browser.js';
import { importedCookie } from './browser-cookies.js';
import { BrowserBridge } from './browser-bridge.js';
import { NativeCookieImporter } from './browser-native-cookies.js';

export class BrowserWorkspace {
  private tabs = new Map<string, { view: WebContentsView; info: BrowserTab; ready: Promise<void> }>();
  private activeId: string | null = null;
  private window: BrowserWindow | null = null;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private downloads: BrowserDownload[] = [];
  private importingCookies = false;
  private token = '';
  private pageScript = '';
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saved: { urls: string[]; active: number } = { urls: [], active: 0 };
  bridge!: BrowserBridge;
  constructor(private directory: string, private extensionDirectory: string, private changed: (state: BrowserState) => void, private nativeCookies = new NativeCookieImporter()) {}
  async initialize(bridgePort = 48765) {
    this.pageScript = await readFile(path.join(this.extensionDirectory, 'common/page.js'), 'utf8');
    try { this.token = (await readFile(path.join(this.directory, 'browser-pairing'), 'utf8')).trim(); } catch { /* first launch */ }
    if (!/^[a-f0-9]{64}$/.test(this.token)) await this.rotatePairing();
    try { const data = JSON.parse(await readFile(path.join(this.directory, 'browser-tabs.json'), 'utf8')); if (Array.isArray(data.urls)) this.saved = { urls: data.urls.slice(0,30).map((url: unknown) => browserURL(url)), active: Number(data.active) || 0 }; } catch { /* fresh session */ }
    const browserSession = session.fromPartition('persist:workspace-browser');
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: 'Save browser download' });
      const download: BrowserDownload = { id: randomUUID(), name: item.getFilename(), received: 0, total: item.getTotalBytes(), state: 'progressing' };
      this.downloads = [...this.downloads.slice(-19), download]; this.notify();
      item.on('updated', (_event, state) => { download.received = item.getReceivedBytes(); download.state = state; this.notify(); });
      item.once('done', (_event, state) => { download.state = state; this.notify(); });
    });
    let revoked: string[] = [];
    try { const data = JSON.parse(await readFile(path.join(this.directory, 'browser-revoked.json'), 'utf8')); if (Array.isArray(data)) revoked = data.filter(value => typeof value === 'string').slice(0,100); } catch { /* no revoked browsers */ }
    this.bridge = new BrowserBridge(this.token, () => this.notify(), revoked, origins => { void writeFile(path.join(this.directory,'browser-revoked.json'),JSON.stringify(origins),{mode:0o600}).catch(() => {}); }); await this.bridge.start(bridgePort);
  }
  state(): BrowserState { return { tabs: [...this.tabs.values()].map(tab => ({ ...tab.info })), activeId: this.activeId, clients: this.bridge?.clients() ?? [], downloads: this.downloads.map(item => ({ ...item })), bridge: { available: this.bridge?.available ?? false, error: this.bridge?.error } }; }
  private notify() { this.changed(this.state()); }
  attach(window: BrowserWindow) {
    this.window = window;
    window.on('resize', () => this.layout());
    for (const url of this.saved.urls) this.open(url);
    const ids = [...this.tabs.keys()]; this.activeId = ids[this.saved.active] ?? ids[0] ?? null; this.layout(); this.notify();
  }
  setBounds(input: BrowserBounds) {
    if (!input || !['x','y','width','height'].every(key => typeof input[key as keyof BrowserBounds] === 'number' && Number.isFinite(input[key as keyof BrowserBounds]) && Number(input[key as keyof BrowserBounds]) >= 0 && Number(input[key as keyof BrowserBounds]) <= 20000) || typeof input.visible !== 'boolean') throw new Error('Invalid browser bounds.');
    this.bounds = input; this.layout();
  }
  private layout() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    for (const [id, tab] of this.tabs) {
      const visible = this.bounds.visible && id === this.activeId && this.bounds.width > 0 && this.bounds.height > 0;
      if (visible && !this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view);
      tab.view.setVisible(visible);
      if (visible) tab.view.setBounds({ x: Math.round(Math.min(width, this.bounds.x)), y: Math.round(Math.min(height, this.bounds.y)), width: Math.round(Math.max(0, Math.min(this.bounds.width, width - this.bounds.x))), height: Math.round(Math.max(0, Math.min(this.bounds.height, height - this.bounds.y))) });
    }
  }
  open(input = 'about:blank'): BrowserState {
    if (!this.window) throw new Error('Browser window is not open.');
    if (this.tabs.size >= 30) throw new Error('Close a tab before opening more (30 tab limit).');
    const url = browserURL(input, true), id = randomUUID();
    const view = new WebContentsView({ webPreferences: { partition: 'persist:workspace-browser', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const info: BrowserTab = { id, title: 'New tab', url, loading: false, canGoBack: false, canGoForward: false };
    this.tabs.set(id, { view, info, ready: Promise.resolve() }); this.activeId = id;
    const wc = view.webContents;
    const update = () => { if (wc.isDestroyed()) return; info.url = wc.getURL() || url; info.title = wc.getTitle() || 'New tab'; info.loading = wc.isLoading(); info.canGoBack = wc.navigationHistory.canGoBack(); info.canGoForward = wc.navigationHistory.canGoForward(); this.notify(); this.scheduleSave(); };
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('page-title-updated', update);
    wc.on('will-navigate', (event, address) => { try { browserURL(address); } catch { event.preventDefault(); } });
    wc.on('will-redirect', (event, address) => { try { browserURL(address); } catch { event.preventDefault(); } });
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { info.error = description; update(); } });
    wc.on('render-process-gone', () => { info.error = 'Page process stopped. Reload to recover.'; update(); });
    wc.setWindowOpenHandler(({ url: address }) => { try { this.open(browserURL(address)); } catch { /* blocked unsupported popup */ } return { action: 'deny' }; });
    this.layout(); this.notify();
    const loading = wc.loadURL(url);
    this.tabs.get(id)!.ready = loading;
    void loading.catch(error => { if (error.code !== 'ERR_ABORTED') { info.error = error.message; this.notify(); } });
    this.scheduleSave(); return this.state();
  }
  private tab(id: string) { const tab = this.tabs.get(id); if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Browser tab is closed.'); return tab; }
  select(id: string) { this.tab(id); this.activeId = id; this.layout(); this.notify(); this.scheduleSave(); return this.state(); }
  closeTab(id: string) {
    const tab = this.tab(id); this.window?.contentView.removeChildView(tab.view); tab.view.webContents.close(); this.tabs.delete(id);
    if (id === this.activeId) this.activeId = [...this.tabs.keys()].at(-1) ?? null;
    this.layout(); this.notify(); this.scheduleSave(); return this.state();
  }
  async navigate(id: string, url: string) { const address = browserURL(url, true), tab = this.tab(id); tab.info.error = undefined; const loading = tab.ready.catch(() => {}).then(() => tab.view.webContents.loadURL(address)); tab.ready = loading; await loading; return this.state(); }
  control(id: string, action: string) {
    const wc = this.tab(id).view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') { this.tab(id).info.error = undefined; wc.reload(); }
    else if (action === 'stop') wc.stop();
    else if (action === 'external') { const url = browserURL(wc.getURL()); if (url !== 'about:blank') void shell.openExternal(url); }
    return this.state();
  }
  async execute(name: string, args: Record<string, unknown>) {
    if (name === 'browser_tabs') return this.state();
    if (name === 'browser_open') return this.open(browserURL(args.url));
    if (typeof args.tabId !== 'string') throw new Error('tabId is required.');
    if (name === 'browser_navigate') {
      const url = browserURL(args.url);
      if (typeof args.clientId === 'string') return this.bridge.request(args.clientId, args.tabId, { action: 'navigate', url });
      return this.navigate(args.tabId, url);
    }
    const command = browserCommand(name === 'browser_read' ? { action: 'snapshot' } : args);
    if (typeof args.clientId === 'string') return this.bridge.request(args.clientId, args.tabId, { ...command });
    const wc = this.tab(args.tabId).view.webContents;
    await this.tab(args.tabId).ready.catch(() => {});
    if (wc.isLoading()) await new Promise<void>((resolve, reject) => {
      const finished = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { wc.removeListener('did-stop-loading', finished); reject(new Error('Page is still loading. Try reading it again shortly.')); }, 10000);
      wc.once('did-stop-loading', finished);
    });
    if (!/^https?:\/\//.test(wc.getURL())) throw new Error('Navigate to a web page first.');
    const response = await wc.executeJavaScript(`(() => { ${this.pageScript}\n;try { return { ok: true, result: globalThis.codexPageAction(${JSON.stringify(command)}) }; } catch (error) { return { ok: false, error: String(error.message || error) }; } })()`, true);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }
  cookieSources() { return this.nativeCookies.list(); }
  async importCookies(clientId: string): Promise<CookieImportResult> {
    if (this.importingCookies) throw new Error('A cookie import is already running.');
    this.importingCookies = true;
    const result: CookieImportResult = { imported: 0, skipped: 0, failed: 0 };
    const transferId = randomUUID(), cookies = session.fromPartition('persist:workspace-browser').cookies;
    let offset = 0;
    try {
      if (clientId.startsWith('native:')) {
        Object.assign(result, await this.nativeCookies.import(clientId, details => cookies.set(details)));
      } else {
        do {
          const batch = await this.bridge.requestCookies(clientId, transferId, offset) as { cookies: unknown[]; total: number; omitted: number };
          if (!batch || !Array.isArray(batch.cookies) || batch.cookies.length > 25 || !Number.isSafeInteger(batch.total) || batch.total < offset || batch.total > 20000 || !Number.isSafeInteger(batch.omitted) || batch.omitted < 0 || offset + batch.cookies.length > batch.total || (!batch.cookies.length && offset < batch.total)) throw new Error('Invalid cookie transfer response.');
          if (offset === 0) result.skipped += batch.omitted;
          for (const item of batch.cookies) {
            try {
              const details = importedCookie(item);
              if (!details) { result.skipped++; continue; }
              await cookies.set(details); result.imported++;
            } catch { result.failed++; }
          }
          offset += batch.cookies.length;
          if (offset === batch.total) break;
        } while (offset < 20000);
      }
    } catch (error) { result.error = error instanceof Error ? error.message : 'Cookie import interrupted.'; }
    finally {
      if (!clientId.startsWith('native:')) try { await this.bridge.requestCookies(clientId, transferId, offset, true); } catch { /* disconnected source clears its temporary snapshot */ }
      try { await cookies.flushStore(); } catch { result.error = 'Cookies were copied, but saving them failed.'; }
      this.importingCookies = false;
    }
    return result;
  }
  pairing() { return { token: this.token, endpoint: `ws://127.0.0.1:${this.bridge.port}/bridge` }; }
  async rotatePairing() { const token = randomBytes(32).toString('hex'); await writeFile(path.join(this.directory, 'browser-pairing'), token, { mode: 0o600 }); this.token = token; this.bridge?.rotate(token); return token; }
  async exportExtensions() {
    const result = await dialog.showOpenDialog(this.window!, { title: 'Choose extension export folder', properties: ['openDirectory','createDirectory'] });
    if (result.canceled) return false;
    const { cp, mkdir } = await import('node:fs/promises');
    for (const browser of ['chromium','firefox']) {
      const destination = path.join(result.filePaths[0], `codex-voice-${browser}`); await mkdir(destination, { recursive: true });
      await cp(path.join(this.extensionDirectory, browser), destination, { recursive: true }); await cp(path.join(this.extensionDirectory, 'common'), destination, { recursive: true });
    }
    await shell.openPath(result.filePaths[0]); return true;
  }
  private scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { void this.save().catch(() => {}); }, 300); }
  private save() { this.saved = { urls: [...this.tabs.values()].map(tab => tab.info.url), active: [...this.tabs.keys()].indexOf(this.activeId ?? '') }; return writeFile(path.join(this.directory, 'browser-tabs.json'), JSON.stringify(this.saved), { mode: 0o600 }); }
  detach() { if (!this.window) return; clearTimeout(this.saveTimer); void this.save().catch(() => {}); for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); this.tabs.clear(); this.window = null; this.activeId = null; this.bounds.visible = false; }
  shutdown() { this.detach(); this.bridge?.close(); }
}
