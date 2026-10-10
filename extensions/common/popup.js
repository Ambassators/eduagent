const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
let activeId;
async function send(message) {
  try {
    const state = await api.runtime.sendMessage(message);
    if (state.error) throw new Error(state.error);
    $('status').textContent = state.connected ? `Connected · ${state.shared.length} shared tab(s)` : state.paired ? 'Paired · waiting for desktop app' : 'Pair with the desktop app first';
    $('setup').open = !state.paired;
    if (state.endpoint) $('endpoint').value = state.endpoint;
    $('cookies').textContent = state.cookieImportAvailable ? 'Disable cookie import' : 'Enable cookie import';
    $('cookies').dataset.enabled = String(state.cookieImportAvailable);
    $('share').disabled = !state.paired;
    $('unshare').disabled = !state.shared.includes(activeId);
  } catch (error) { $('status').textContent = error.message; }
}
$('pair').onclick = () => { void send({ type:'pair', token:$('token').value.trim(), endpoint:$('endpoint').value.trim() }); $('token').value = ''; };
$('share').onclick = () => void send({ type:'share' });
$('unshare').onclick = () => void send({ type:'unshare', tabId:activeId });
$('disconnect').onclick = () => void send({ type:'disconnect' });
void api.tabs.query({ active:true,currentWindow:true }).then(tabs => { activeId = tabs[0]?.id; return send({ type:'status' }); });

setInterval(() => void send({ type:'status' }), 1000);

$('cookies').onclick = async () => {
  try {
    const permission = { permissions: ['cookies'], origins: ['http://*/*','https://*/*'] };
    if ($('cookies').dataset.enabled === 'true') await api.permissions.remove(permission);
    else if (!await api.permissions.request(permission)) { $('status').textContent = 'Cookie access was not enabled.'; return; }
    await send({ type: 'cookie-permission' });
  } catch (error) { $('status').textContent = error.message; }
};
