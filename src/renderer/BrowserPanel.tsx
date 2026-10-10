import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserState, CookieImportResult } from '../browser';
import Icon from './Icon';
import './browser.css';
const api = () => { if (!window.desktop) throw new Error('Run the desktop app to use the browser.'); return window.desktop; };
export default function BrowserPanel({ state, blocked, onError }: { state: BrowserState | null; blocked: boolean; onError: (error: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState('');
  const [extensions, setExtensions] = useState(false);
  const [cookiePanel, setCookiePanel] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cookieResult, setCookieResult] = useState<CookieImportResult | null>(null);
  const [pairing, setPairing] = useState<{ token: string; endpoint: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  const run = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } };
  useEffect(() => { setAddress(active?.url === 'about:blank' ? '' : active?.url ?? ''); }, [active?.id, active?.url]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        void api().browserBounds({ x: Math.max(0,rect.x), y: Math.max(0,rect.y), width: rect.width, height: rect.height, visible: !blocked && !extensions && !cookiePanel && !!active && active.url !== 'about:blank' && !active.error }).catch(onError);
      });
    };
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener('resize', update); update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update); void api().browserBounds({ x:0,y:0,width:0,height:0,visible:false }).catch(() => {}); };
  }, [blocked, extensions, cookiePanel, active?.id, active?.url, active?.error, onError]);
  const openExtensions = () => { setCookiePanel(false); setExtensions(value => !value); setPairing(null); setCopied(false); };
  return <div className="browser-panel">
    <div className="browser-tabs drag"><div className="browser-tab-list">{state?.tabs.map(tab => <div key={tab.id} className={`browser-tab ${tab.id === state.activeId ? 'active' : ''}`}>
      <button onClick={() => void run(() => api().browserSelect(tab.id))} title={tab.url}>{tab.loading ? '◌ ' : ''}{tab.title}</button>
      <button className="icon-button" aria-label={`Close ${tab.title}`} onClick={() => void run(() => api().browserClose(tab.id))}><Icon name="close" size={12}/></button>
    </div>)}</div><button className="icon-button" title="New browser tab" onClick={() => void run(() => api().browserOpen())}><Icon name="plus" size={16}/></button></div>
    <div className="browser-toolbar">
      <button className="icon-button" title="Back" disabled={!active?.canGoBack} onClick={() => void run(() => api().browserControl(active!.id,'back'))}><Icon name="left" size={17}/></button>
      <button className="icon-button" title="Forward" disabled={!active?.canGoForward} onClick={() => void run(() => api().browserControl(active!.id,'forward'))}><Icon name="right" size={17}/></button>
      <button className="icon-button" title={active?.loading ? 'Stop loading' : 'Reload'} disabled={!active} onClick={() => void run(() => api().browserControl(active!.id,active!.loading?'stop':'reload'))}><Icon name={active?.loading?'close':'refresh'} size={16}/></button>
      <form onSubmit={event => { event.preventDefault(); setExtensions(false); setCookiePanel(false); void run(() => active ? api().browserNavigate(active.id,address) : api().browserOpen(address)); }}><input aria-label="Web address or search" placeholder="Search or enter a web address" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false}/></form>
      <button className="icon-button" title="Open in default browser" disabled={!active || active.url === 'about:blank'} onClick={() => void run(() => api().browserControl(active!.id,'external'))}><Icon name="popout" size={16}/></button>
      <button className={`browser-cookie-button ${cookiePanel?'active':''}`} onClick={() => { setCookiePanel(value => !value); setExtensions(false); }}>Import cookies</button>
      <button className={`browser-extension-button ${extensions?'active':''}`} onClick={openExtensions}>Extensions {state?.clients.length ? `(${state.clients.length})` : ''}</button>
    </div>
    <div className="browser-viewport" ref={viewport}>
      {cookiePanel ? <div className="browser-setup browser-cookie-setup">
        <h2>Import cookies</h2><p>Copy cookies from your Chrome/Chromium or Firefox profile into this browser to reuse website sign-ins. Matching cookies in this app will be replaced.</p>
        <p>Connect a browser using <button className="button-quiet" onClick={openExtensions}>Extensions</button>, then open its extension popup and choose <strong>Enable cookie import</strong>.</p>
        {!state?.clients.length && <p>No source browsers connected.</p>}
        {state?.clients.map(client => <div className="browser-client" key={client.id}><strong>{client.name === 'Chromium' ? 'Chrome / Chromium' : client.name}</strong><button disabled={importing || !client.cookieImportAvailable} onClick={() => void run(async () => { setImporting(true); setCookieResult(null); try { setCookieResult(await api().browserImportCookies(client.id)); } finally { setImporting(false); } })}>{importing ? 'Importing…' : 'Import cookies'}</button>{!client.cookieImportAvailable && <p>Enable cookie import in this browser’s extension popup.</p>}</div>)}
        {cookieResult && <p role={cookieResult.error ? 'alert' : 'status'}>{cookieResult.imported} imported · {cookieResult.skipped} skipped · {cookieResult.failed} failed.{cookieResult.error && ` ${cookieResult.error}`} Reload your tabs to use the imported cookies.</p>}
        <p>Cookie values stay on this device and are kept out of chat. Private browsing, Firefox containers, and partitioned cookies are excluded. Some websites may still ask you to sign in.</p>
      </div> : extensions ? <div className="browser-setup">
        <h2>Connect your web apps</h2><p>Install the bridge in Chrome, Chromium, Edge, Brave, or Firefox. Pair it here, then choose <strong>Share current tab</strong> in the extension to let Think read and interact with that web app.</p>
        {state?.bridge.error && <p role="alert">{state.bridge.error}</p>}
        <ol><li><button className="button-quiet" onClick={() => void run(() => api().browserExportExtensions())}>Export extensions…</button></li>
          <li>Chromium: open <code>chrome://extensions</code>, enable Developer mode, and load the exported <code>codex-voice-chromium</code> folder. Firefox: open <code>about:debugging#/runtime/this-firefox</code>, choose Load Temporary Add-on, and select the Firefox manifest.</li>
          <li><button className="button-quiet" disabled={!state?.bridge.available} onClick={() => void run(async () => { setPairing(await api().browserPairing()); setCopied(false); })}>Show pairing details</button>{pairing && <div className="browser-pairing"><label>Endpoint<input readOnly value={pairing.endpoint}/></label><label>Pairing key<input type="password" readOnly value={pairing.token}/></label><button onClick={() => void run(async () => { await navigator.clipboard.writeText(pairing.token); setCopied(true); })}>{copied?'Copied':'Copy pairing key'}</button></div>}</li>
          <li>Paste these details into the extension’s pairing section, then share the web app tab.</li></ol>
        <p>Shared page content can be sent to your Think/voice backend when you ask it to use the page. Sharing stops when the tab closes or changes sites. Firefox temporary installs last until Firefox restarts; permanent installation requires Mozilla signing.</p>
        <h3>Connected browsers</h3>{!state?.clients.length && <p>No paired browsers connected.</p>}
        {state?.clients.map(client => <div className="browser-client" key={client.id}><strong>{client.name}</strong><button onClick={() => void run(() => api().browserRevoke(client.id))}>Disconnect</button>{client.tabs.map(tab => <p key={tab.id} title={tab.url}>{tab.title || tab.url}</p>)}</div>)}
        <button className="button-quiet" onClick={() => void run(async () => { await api().browserRotatePairing(); setPairing(null); setCopied(false); })}>Reset pairing key and revoke all connections</button>
      </div> : active?.error ? <div className="browser-empty"><h2>Page could not load</h2><p>{active.error}</p><button onClick={() => void run(() => api().browserControl(active.id,'reload'))}>Try again</button></div> : (!active || active.url === 'about:blank') ? <div className="browser-empty"><Icon name="globe" size={42}/><h2>Your browser workspace</h2><p>Enter a web address above, or connect an external browser using Extensions.</p><p>Ask Think to read or interact with an open page.</p></div> : null}
    </div>
    {!!state?.downloads.length && <div className="browser-downloads">{state.downloads.slice(-3).map(item => <span key={item.id} title={`${item.received} / ${item.total} bytes`}>{item.name} · {item.state === 'progressing' && item.total ? `${Math.round(item.received/item.total*100)}%` : item.state}</span>)}</div>}
  </div>;
}
