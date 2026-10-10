import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { BrowserClient } from '../browser.js';

export class BrowserBridge {
  private server: Server | null = null;
  private sockets = new Map<string, { socket: WebSocket; client: BrowserClient; alive: boolean; origin: string }>();
  private revokedOrigins = new Set<string>();
  private pending = new Map<string, { clientId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private wss?: WebSocketServer;
  available = false;
  error?: string;
  port = 48765;
  private token: string;
  private changed: () => void;
  private revokedChanged: (origins: string[]) => void;
  constructor(token: string, changed: () => void, revoked: string[] = [], revokedChanged: (origins: string[]) => void = () => {}) { this.token = token; this.changed = changed; this.revokedOrigins = new Set(revoked); this.revokedChanged = revokedChanged; }
  clients(): BrowserClient[] { return [...this.sockets.values()].map(item => item.client); }
  async start(port = 48765): Promise<void> {
    const server = this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      // Reject web pages and DNS rebinding before accepting a socket. Token is sent
      // in the first frame rather than a URL, so it never enters HTTP access logs.
      const origin = request.headers.origin ?? '';
      if (!/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-z0-9-]+)$/i.test(origin) || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '') || request.url !== '/bridge' || this.revokedOrigins.has(origin) || wss.clients.size >= 16) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, ws => {
        const id = randomUUID(); let authenticated = false;
        const timeout = setTimeout(() => ws.terminate(), 5000);
        ws.on('error', () => ws.terminate());
        ws.on('pong', () => { const item = this.sockets.get(id); if (item) item.alive = true; });
        ws.on('message', raw => {
          try {
            const data = JSON.parse(raw.toString());
            if (!authenticated) {
              if (data.type !== 'hello' || data.token !== this.token || typeof data.name !== 'string') { ws.close(1008, 'Pairing failed'); return; }
              authenticated = true; clearTimeout(timeout);
              this.sockets.set(id, { socket: ws, client: { id, name: data.name.slice(0,80), tabs: [] }, alive: true, origin });
              ws.send(JSON.stringify({ type: 'ready', clientId: id })); this.changed(); return;
            }
            if (data.type === 'tabs' && Array.isArray(data.tabs)) {
              const tabs = data.tabs.slice(0,100).filter((tab: any) => Number.isSafeInteger(tab.id) && tab.id >= 0 && typeof tab.url === 'string' && /^https?:\/\//.test(tab.url) && typeof tab.title === 'string').map((tab: any) => ({ id: tab.id, title: tab.title.slice(0,300), url: tab.url.slice(0,8000) }));
              this.sockets.get(id)!.client.cookieImportAvailable = data.cookieImportAvailable === true;
              this.sockets.get(id)!.client.tabs = tabs; this.changed();
            } else if (data.type === 'result' && typeof data.id === 'string') {
              const task = this.pending.get(data.id);
              if (!task || task.clientId !== id) return;
              clearTimeout(task.timer); this.pending.delete(data.id);
              if (typeof data.error === 'string') task.reject(new Error(data.error.slice(0,1000))); else task.resolve(data.result);
            }
          } catch { ws.close(1008, 'Invalid message'); }
        });
        ws.on('close', () => {
          clearTimeout(timeout); this.sockets.delete(id);
          for (const [key, task] of this.pending) if (task.clientId === id) { clearTimeout(task.timer); task.reject(new Error('Extension disconnected.')); this.pending.delete(key); }
          this.changed();
        });
      });
    });
    await new Promise<void>(resolve => {
      const listen = (wantedPort: number) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && wantedPort !== 0) listen(0);
          else { this.error = `Extension bridge unavailable: ${error.message}`; resolve(); }
        });
        server.listen(wantedPort, '127.0.0.1', () => { this.available = true; this.port = (server.address() as { port: number }).port; resolve(); });
      };
      listen(port);
    });
    this.heartbeat = setInterval(() => {
      for (const item of this.sockets.values()) { if (!item.alive) item.socket.terminate(); else { item.alive = false; item.socket.ping(); item.socket.send(JSON.stringify({ type: 'ping' })); } }
    }, 20000); this.heartbeat.unref();
    this.changed();
  }
  request(clientId: string, tabId: string, command: Record<string, unknown>): Promise<unknown> {
    const client = this.sockets.get(clientId);
    if (!client || !client.client.tabs.some(tab => String(tab.id) === tabId)) throw new Error('That external tab is not shared. Share it from the extension first.');
    return this.send(clientId, { tabId: Number(tabId), command });
  }
  requestCookies(clientId: string, transferId: string, offset: number, clear = false): Promise<unknown> {
    const client = this.sockets.get(clientId);
    if (!client) throw new Error('The source browser disconnected.');
    if (!clear && !client.client.cookieImportAvailable) throw new Error('Enable cookie import in the source browser’s extension popup first.');
    return this.send(clientId, { command: { action: clear ? 'cookies-clear' : 'cookies', transferId, offset } }, 'Cookie transfer timed out. Start the import again.');
  }
  private send(clientId: string, payload: Record<string, unknown>, timeoutMessage = 'Extension action timed out; it may have occurred. Read the page before retrying.'): Promise<unknown> {
    const client = this.sockets.get(clientId);
    if (!client) throw new Error('Extension disconnected.');
    if (this.pending.size >= 32) throw new Error('Too many pending browser actions.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(timeoutMessage)); }, 15000);
      this.pending.set(id, { clientId, resolve, reject, timer });
      client.socket.send(JSON.stringify({ type: 'command', id, ...payload }));
    });
  }
  private disconnect(id: string, reason: string) {
    const item = this.sockets.get(id); if (!item) return;
    this.sockets.delete(id);
    for (const [key, task] of this.pending) if (task.clientId === id) { clearTimeout(task.timer); task.reject(new Error(reason)); this.pending.delete(key); }
    item.socket.close(1008, reason); this.changed();
  }
  revoke(clientId: string) { const item = this.sockets.get(clientId); if (item) { this.revokedOrigins.add(item.origin); this.revokedChanged([...this.revokedOrigins]); for (const [id, client] of [...this.sockets]) if (client.origin === item.origin) this.disconnect(id, 'Revoked by app'); } }
  rotate(token: string) { this.token = token; this.revokedOrigins.clear(); this.revokedChanged([]); for (const id of [...this.sockets.keys()]) this.disconnect(id, 'Pairing reset'); }
  close() {
    clearInterval(this.heartbeat);
    for (const item of this.sockets.values()) item.socket.terminate();
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser bridge closed.')); }
    this.pending.clear(); this.wss?.close(); this.server?.close(); this.available = false;
  }
}
