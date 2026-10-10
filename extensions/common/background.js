const api = globalThis.browser || globalThis.chrome;
const isFirefox = api.runtime.getURL('').startsWith('moz-extension://');
let socket, connecting = false, reconnectTimer;
let grants = new Map();
let ready = false, suspended = false;
const cookiePermission = { permissions: ['cookies'], origins: ['http://*/*', 'https://*/*'] };
let cookieTransfer, cookieTimer;
function clearCookies() { clearTimeout(cookieTimer); cookieTransfer = undefined; }
async function cookieBatch(command) {
  if (command.action === 'cookies-clear') { if (cookieTransfer?.id === command.transferId) clearCookies(); return { cleared: true }; }
  if (!await api.permissions.contains(cookiePermission)) throw new Error('Enable cookie import in the extension popup first.');
  if (typeof command.transferId !== 'string' || command.transferId.length > 100 || !Number.isSafeInteger(command.offset) || command.offset < 0) throw new Error('Invalid cookie transfer.');
  if (command.offset === 0) {
    clearCookies();
    const all = await api.cookies.getAll({ storeId: isFirefox ? 'firefox-default' : '0' });
    cookieTransfer = { id: command.transferId, cookies: all.slice(0,20000), omitted: Math.max(0, all.length-20000), next: 0 };
  }
  if (!cookieTransfer || cookieTransfer.id !== command.transferId || cookieTransfer.next !== command.offset) throw new Error('Cookie transfer expired. Start the import again.');
  clearTimeout(cookieTimer); cookieTimer = setTimeout(clearCookies, 60000);
  const cookies = cookieTransfer.cookies.slice(command.offset, command.offset+25);
  cookieTransfer.next += cookies.length;
  return { cookies, total: cookieTransfer.cookies.length, omitted: cookieTransfer.omitted };
}
const loaded = api.storage.session.get('grants').then(data => { grants = new Map(data.grants || []); });
const saveGrants = () => api.storage.session.set({ grants: [...grants] });
async function publish() {
  await loaded;
  if (!ready || socket?.readyState !== WebSocket.OPEN) return;
  const tabs = [];
  for (const [id, origin] of grants) {
    try { const tab = await api.tabs.get(id); if (tab.url && new URL(tab.url).origin === origin && !tab.incognito) tabs.push({ id, title: tab.title || '', url: tab.url }); else grants.delete(id); } catch { grants.delete(id); }
  }
  await saveGrants();
  socket.send(JSON.stringify({ type: 'tabs', tabs, cookieImportAvailable: await api.permissions.contains(cookiePermission) }));
  await api.action.setBadgeText({ text: tabs.length ? String(tabs.length) : '' });
}
async function connect() {
  if (suspended || connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try {
    const { token, endpoint = 'ws://127.0.0.1:48765/bridge' } = await api.storage.local.get(['token', 'endpoint']);
    if (!/^[a-f0-9]{64}$/.test(token || '') || !/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/.test(endpoint)) return;
    const ws = socket = new WebSocket(endpoint);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, name: isFirefox ? 'Firefox' : 'Chromium' }));
    ws.onmessage = async event => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') { ready = true; await publish(); }
        if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); await publish(); }
        if (message.type === 'command') {
          let result, error;
          try {
            await loaded;
            const command = message.command;
            if (command.action === 'cookies' || command.action === 'cookies-clear') {
              result = await cookieBatch(command);
            } else {
              const tab = await api.tabs.get(message.tabId);
              const origin = grants.get(message.tabId);
              if (!origin || !tab.url || new URL(tab.url).origin !== origin || tab.incognito) throw new Error('Tab is no longer shared.');
              if (command.action === 'navigate') {
                const url = new URL(command.url);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported address.');
                // Revoke before crossing origins, even if navigation later fails.
                if (url.origin !== origin) { grants.delete(message.tabId); await saveGrants(); }
                await api.tabs.update(message.tabId, { url: url.href }); result = { navigated: true, sharingContinues: url.origin === origin };
              } else {
                await api.scripting.executeScript({ target: { tabId: message.tabId }, files: ['page.js'] });
                // Navigation can race injection. Recheck both URL and grant.
                const current = await api.tabs.get(message.tabId);
                if (grants.get(message.tabId) !== origin || new URL(current.url).origin !== origin) throw new Error('Tab changed during action.');
                const values = await api.scripting.executeScript({ target: { tabId: message.tabId }, func: (args, allowedOrigin) => { try { if (location.origin !== allowedOrigin) throw new Error('Origin changed.'); return { ok:true, result:globalThis.codexPageAction(args) }; } catch(error) { return { ok:false, error:error.message || String(error) }; } }, args: [command, origin] });
                if (values[0]?.error) throw new Error(values[0].error.message || 'Page action failed.');
                const response = values[0]?.result;
                if (!response?.ok) throw new Error(response?.error || 'Page action failed.');
                result = response.result;
                if (result === undefined) throw new Error('No page action result.');
              }
            }
          } catch (failure) { error = failure.message || String(failure); }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result, error }));
          await publish();
        }
      } catch { /* malformed server message */ }
    };
    ws.onclose = event => { if (socket !== ws) return; if (event.code === 1008) suspended = true; ready = false; clearCookies(); socket = null; clearTimeout(reconnectTimer); if (!suspended) reconnectTimer = setTimeout(connect, 5000); };
    ws.onerror = () => ws.close();
  } finally { connecting = false; }
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  // Only the extension's own popup/options page may change grants or pairing.
  if (sender.id !== api.runtime.id || sender.tab) return false;
  (async () => {
    await loaded;
    if (message.type === 'pair') {
      if (!/^[a-f0-9]{64}$/.test(message.token) || !/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/.test(message.endpoint)) throw new Error('Paste the pairing key and local endpoint from the app.');
      suspended = false; grants.clear(); await saveGrants(); await api.storage.local.set({ token: message.token, endpoint: message.endpoint });
      clearCookies(); socket?.close(); socket = null; ready = false; await connect();
    }
    if (message.type === 'share') {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular HTTP/HTTPS web app tab first.');
      // activeTab is granted by opening the popup. It expires on origin change.
      await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title });
      grants.set(tab.id, new URL(tab.url).origin); await saveGrants(); await connect(); await publish();
    }
    if (message.type === 'unshare') { grants.delete(message.tabId); await saveGrants(); await publish(); }
    if (message.type === 'disconnect') { grants.clear(); await saveGrants(); await api.storage.local.remove('token'); clearCookies(); socket?.close(); socket = null; ready = false; }
    if (message.type === 'cookie-permission') { clearCookies(); await publish(); }
    const { token, endpoint } = await api.storage.local.get(['token','endpoint']);
    return { cookieImportAvailable: await api.permissions.contains(cookiePermission), connected: ready, paired: !!token, endpoint, shared: [...grants.keys()] };
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
api.tabs.onRemoved.addListener(async id => { await loaded; grants.delete(id); await saveGrants(); await publish(); });
api.tabs.onUpdated.addListener(async (id, change) => { if (change.url || change.title || change.status === 'complete') await publish(); });
api.alarms.onAlarm.addListener(() => { void connect(); });
api.runtime.onStartup.addListener(() => { void connect(); });
api.runtime.onInstalled.addListener(() => { void api.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 }); void connect(); });
void api.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
void connect();

api.permissions.onAdded.addListener(() => { void publish(); });
api.permissions.onRemoved.addListener(() => { clearCookies(); void publish(); });
