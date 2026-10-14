import type { UpdateState } from '../shared.ts';

// Keep Electron outside this controller so the lifecycle can be tested without installing an update.
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export class AppUpdates {
  private value: UpdateState;
  private operation: 'check' | 'download' | 'install' = 'check';
  private updater: Updater;
  private changed: (state: UpdateState) => void;
  constructor(updater: Updater, version: string, disabledReason: string | undefined,
    changed: (state: UpdateState) => void) {
    this.updater = updater;
    this.changed = changed;
    this.value = { status: disabledReason ? 'disabled' : 'idle', currentVersion: version, message: disabledReason };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('update-available', info => this.set({ status: 'available', version: info.version }));
    updater.on('update-not-available', () => this.set({ status: 'up-to-date' }));
    updater.on('download-progress', progress => {
      if (this.value.status !== 'downloading') return;
      const percent = Math.round(Math.max(0, Math.min(100, progress.percent)));
      if (Number.isFinite(percent) && percent !== this.value.percent) this.set({ ...this.value, percent });
    });
    updater.on('update-downloaded', info => this.set({ status: 'downloaded', version: info.version }));
    updater.on('error', error => this.failed(error));
  }
  get state(): UpdateState { return { ...this.value }; }
  private set(next: Omit<UpdateState, 'currentVersion'>) {
    this.value = { ...next, currentVersion: this.value.currentVersion };
    this.changed(this.state);
  }
  private failed(error: unknown) {
    this.set({ status: 'error', version: this.value.version, retry: this.operation,
      message: this.operation === 'check' ? 'Could not check for updates. Check your connection and try again.'
        : this.operation === 'download' ? 'The update could not be downloaded or verified. Try again or open Downloads.'
        : 'The update could not be installed. Try again or open Downloads.' });
    console.warn('App update failed:', error instanceof Error ? error.message : String(error));
  }
  async check(): Promise<UpdateState> {
    if (!['idle', 'up-to-date', 'error'].includes(this.value.status) || this.value.status === 'error' && this.value.retry !== 'check') return this.state;
    this.operation = 'check';
    this.set({ status: 'checking' });
    try { await this.updater.checkForUpdates(); }
    catch (error) { this.failed(error); }
    return this.state;
  }
  async download(): Promise<UpdateState> {
    if (this.value.status !== 'available' && !(this.value.status === 'error' && this.value.retry === 'download')) return this.state;
    this.operation = 'download';
    this.set({ status: 'downloading', version: this.value.version, percent: 0 });
    try { await this.updater.downloadUpdate(); }
    catch (error) { this.failed(error); }
    return this.state;
  }
  async install(prepare: () => Promise<void>): Promise<UpdateState> {
    if (this.value.status !== 'downloaded' && !(this.value.status === 'error' && this.value.retry === 'install')) return this.state;
    this.operation = 'install';
    this.set({ status: 'installing', version: this.value.version });
    try {
      await prepare();
      this.updater.quitAndInstall(false, true);
    } catch (error) { this.failed(error); }
    return this.state;
  }
}
