import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const noLaunch = process.argv.includes('--no-launch');
let app, builder, timer, building = false, stopping = false, restartNeeded = false;
const pending = new Set(), watchers = [];

function build() {
  return new Promise(resolve => {
    builder = spawn(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    builder.once('error', error => { console.error(error.message); builder = null; resolve(false); });
    builder.once('exit', code => { builder = null; resolve(code === 0); });
  });
}
function launch() {
  if (stopping || noLaunch) return;
  const child = spawn(electron, ['.'], { cwd: root, env: { ...process.env, CODEX_VOICE_DEV_RELOAD: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  app = child;
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', () => {
    if (app === child) { app = null; if (!stopping) stop(0); }
  });
}
async function restart() {
  const child = app;
  if (!child) { launch(); return; }
  app = null;
  await new Promise(resolve => {
    const fallback = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(fallback); resolve(); });
    child.send({ type: 'dev/restart' });
  });
  launch();
}
async function rebuild() {
  if (building || stopping || !pending.size) return;
  const changed = [...pending]; pending.clear(); building = true;
  restartNeeded ||= changed.some(file => !file.startsWith('src/renderer/') && file !== 'vite.config.ts');
  console.log(`[dev] Rebuilding ${changed.length} changed file(s)…`);
  const success = await build();
  if (success && !stopping) {
    if (restartNeeded) { console.log('[dev] Backend updated; restarting Electron.'); await restart(); }
    else { console.log('[dev] UI updated; reloading window.'); app?.send({ type: 'dev/reload' }); }
    restartNeeded = false;
  } else if (!stopping) console.error('[dev] Build failed. Keeping the current app; save a fix to retry.');
  building = false;
  if (pending.size && !stopping) void rebuild();
}
function changed(file) {
  pending.add(file.replaceAll('\\', '/'));
  clearTimeout(timer); timer = setTimeout(() => void rebuild(), 250);
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true; clearTimeout(timer); for (const watcher of watchers) watcher.close();
  builder?.kill();
  if (app?.connected) { const child = app; child.send({ type: 'dev/restart' }); setTimeout(() => child.kill(), 5000).unref(); }
  else app?.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
const initial = await build();
if (!initial) process.exitCode = 1;
else {
  for (const folder of ['src', 'scripts']) watchers.push(watch(path.join(root, folder), { recursive: true }, (_, file) => {
    if (file && (folder === 'src' || String(file).startsWith('copy-'))) changed(`${folder}/${file}`);
  }));
  const configs = new Set(['vite.config.ts', 'tsconfig.json', 'tsconfig.main.json', 'package.json']);
  watchers.push(watch(root, (_, file) => { if (configs.has(String(file))) changed(String(file)); }));
  launch(); console.log('[dev] Auto-reload ready. Watching src, build config, and asset-copy scripts. Ctrl+C to stop.');
}
