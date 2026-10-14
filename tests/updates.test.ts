import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppUpdates } from '../src/main/updates.ts';
import type { UpdateState } from '../src/shared.ts';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  checkImpl = async () => { this.emit('update-available', { version: '0.0.5' }); };
  downloadImpl = async () => { this.emit('update-downloaded', { version: '0.0.5' }); };
  async checkForUpdates() { this.checks++; await this.checkImpl(); }
  async downloadUpdate() { this.downloads++; await this.downloadImpl(); }
  quitAndInstall(silent: boolean, relaunch: boolean) { assert.equal(silent, false); assert.equal(relaunch, true); this.installs++; }
}
function setup(disabled?: string) {
  const updater = new FakeUpdater(), events: UpdateState[] = [];
  const updates = new AppUpdates(updater, '0.0.4', disabled, state => events.push(state));
  return { updater, updates, events };
}

test('checks announce an update but never download or install without a click', async () => {
  const { updater, updates } = setup();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false); assert.equal(updater.allowDowngrade, false);
  await updates.download(); await updates.install(async () => { throw Error('Must not prepare'); });
  assert.equal(updater.downloads, 0); assert.equal(updater.installs, 0);
  assert.equal((await updates.check()).status, 'available');
  assert.equal(updates.state.version, '0.0.5'); assert.equal(updater.downloads, 0);
  assert.equal((await updates.download()).status, 'downloaded'); assert.equal(updater.installs, 0);
  let saved = false;
  await updates.install(async () => { assert.equal(updater.installs, 0); saved = true; });
  assert.equal(saved, true); assert.equal(updater.installs, 1);
});

test('source and unsupported builds cannot check, download, or install', async () => {
  const { updater, updates } = setup('Use an installed build.');
  await updates.check(); await updates.download(); await updates.install(async () => {});
  assert.equal(updates.state.status, 'disabled');
  assert.equal(updater.checks + updater.downloads + updater.installs, 0);
});

test('up to date and offline checks can be retried', async () => {
  const { updater, updates } = setup();
  updater.checkImpl = async () => { throw Error('Offline'); };
  assert.equal((await updates.check()).status, 'error'); assert.equal(updates.state.retry, 'check');
  updater.checkImpl = async () => { updater.emit('update-not-available'); };
  assert.equal((await updates.check()).status, 'up-to-date');
  assert.equal(updates.state.version, undefined); assert.equal(updater.checks, 2);
});

test('download progress is bounded and rounded; duplicate clicks and checks are ignored', async () => {
  const { updater, updates, events } = setup();
  await updates.check();
  let finish!: () => void;
  updater.downloadImpl = () => new Promise<void>(resolve => { finish = resolve; });
  const downloading = updates.download();
  await updates.download(); await updates.check();
  updater.emit('download-progress', { percent: 33.7 });
  assert.equal(updates.state.percent, 34);
  const count = events.length;
  updater.emit('download-progress', { percent: 33.9 });
  updater.emit('download-progress', { percent: NaN });
  assert.equal(events.length, count);
  updater.emit('download-progress', { percent: 120 }); assert.equal(updates.state.percent, 100);
  updater.emit('update-downloaded', { version: '0.0.5' });
  updater.emit('download-progress', { percent: 70 });
  assert.equal(updates.state.status, 'downloaded');
  finish(); await downloading;
  assert.equal(updater.downloads, 1); assert.equal(updater.checks, 1);
});

test('download failure retains version and retries download instead of checking', async () => {
  const { updater, updates } = setup();
  await updates.check();
  updater.downloadImpl = async () => { const error = Error('Checksum mismatch'); updater.emit('error', error); throw error; };
  await updates.download();
  assert.equal(updates.state.status, 'error'); assert.equal(updates.state.retry, 'download'); assert.equal(updates.state.version, '0.0.5');
  await updates.check(); assert.equal(updater.checks, 1);
  updater.downloadImpl = async () => { updater.emit('update-downloaded', { version: '0.0.5' }); };
  assert.equal((await updates.download()).status, 'downloaded'); assert.equal(updater.downloads, 2);
});

test('failed persistence prevents installation and permits retry; duplicate restart is ignored', async () => {
  const { updater, updates } = setup();
  await updates.check(); await updates.download();
  await updates.install(async () => { throw Error('Save failed'); });
  assert.equal(updater.installs, 0); assert.equal(updates.state.retry, 'install');
  let finish!: () => void;
  const installing = updates.install(() => new Promise<void>(resolve => { finish = resolve; }));
  await updates.install(async () => { throw Error('Duplicate'); });
  await updates.check(); await updates.download();
  finish(); await installing;
  assert.equal(updater.installs, 1); assert.equal(updater.checks, 1); assert.equal(updater.downloads, 1);
});
