import { useEffect, useState } from 'react';
import type { UpdateState } from '../shared';
import Icon from './Icon';

export function useAppUpdates(prepareRestart: () => Promise<void>) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) return;
    let disposed = false, received = false;
    const unsubscribe = desktop.onEvent(event => {
      if (event.method === 'app/update') { received = true; setState(event.params.state as unknown as UpdateState); }
    });
    void desktop.updateState().then(next => { if (!disposed && !received) setState(next); }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const action = async () => {
    if (!state || !window.desktop || busy) return;
    setBusy(true); setError('');
    try {
      const desktop = window.desktop;
      if (state.status === 'downloaded' || state.retry === 'install') {
        await prepareRestart();
        setState(await desktop.installUpdate());
      } else if (state.status === 'available' || state.retry === 'download') setState(await desktop.downloadUpdate());
      else setState(await desktop.checkForUpdates());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const downloads = () => { void window.desktop?.updateDownloads().catch(() => setError('Could not open Downloads. Try again.')); };
  const key = `${state?.version}:${state?.status}`;
  const visible = !!state && ['available', 'downloading', 'downloaded', 'installing'].includes(state.status)
    || !!state && state.status === 'error' && !!state.version;
  return { state, error, busy, action, downloads, visible: visible && dismissed !== key, dismiss: () => setDismissed(key) };
}

type Updates = ReturnType<typeof useAppUpdates>;
export function UpdateControls({ updates, toast = false }: { updates: Updates; toast?: boolean }) {
  const { state, busy, error } = updates;
  if (!state) return null;
  const pending = busy || ['checking', 'downloading', 'installing'].includes(state.status);
  const restart = state.status === 'downloaded' || state.retry === 'install';
  const download = state.status === 'available' || state.retry === 'download';
  const label = restart ? 'Restart to install' : download ? state.status === 'error' ? 'Retry download' : 'Update now'
    : state.status === 'error' ? 'Try again' : 'Check for updates';
  const message = error || state.message || ({
    idle: 'Check for a newer version.', checking: 'Checking for updates…', available: `Version ${state.version} is available.`,
    downloading: `Downloading update… ${state.percent ?? 0}%`, downloaded: `Version ${state.version} is ready to install.`,
    installing: 'Restarting to install…', 'up-to-date': 'You’re up to date.', disabled: '', error: 'Could not update.'
  })[state.status];
  return <div className={toast ? `toast update-toast ${error || state.status === 'error' ? 'error' : ''}` : 'app-updates'}>
    {toast && <i/>}
    <div className="update-copy" role={error || state.status === 'error' ? 'alert' : 'status'}>
      {!toast && <strong>Codex Voice · {state.currentVersion}</strong>}
      <span>{message}</span>
      {state.status === 'downloading' && <progress aria-label="Update download" max={100} value={state.percent ?? 0}/>}
    </div>
    <div className="update-actions">
      {state.status !== 'disabled' && <button className={toast ? 'update-action' : 'button-secondary'} disabled={pending} onClick={() => void updates.action()}>{pending ? state.status === 'downloading' ? 'Downloading…' : state.status === 'checking' ? 'Checking…' : 'Please wait…' : label}</button>}
      {(state.status === 'error' || state.status === 'disabled') && <button className={toast ? 'update-action' : 'button-secondary'} onClick={updates.downloads}>Downloads</button>}
    </div>
    {toast && <button className="icon-button" aria-label="Remind me later" onClick={updates.dismiss}><Icon name="close" size={13}/></button>}
  </div>;
}
