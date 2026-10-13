import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('watcher reloads UI, preserves running builds on failure, and restarts after backend fixes', { timeout: 120000 }, async () => {
  const renderer = 'src/renderer/dev-reload-smoke.css', backend = 'src/main/dev-reload-smoke.ts';
  const child = spawn(process.execPath, ['scripts/dev.mjs', '--no-launch'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const wait = async text => {
    const deadline = Date.now() + 60000;
    while (!output.includes(text) && Date.now() < deadline && child.exitCode === null) await delay(100);
    assert.ok(output.includes(text), `Missing ${text}: ${output.slice(-2000)}`);
    output = '';
  };
  try {
    await wait('[dev] Auto-reload ready.');
    await writeFile(renderer, '/* watch fixture */\n');
    await wait('[dev] UI updated; reloading window.');
    await writeFile(backend, 'const broken: number = "invalid";\n');
    await wait('[dev] Build failed. Keeping the current app');
    assert.equal(child.exitCode, null);
    await writeFile(backend, 'export const valid = true;\n');
    await wait('[dev] Backend updated; restarting Electron.');
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    await Promise.all([rm(renderer, { force: true }), rm(backend, { force: true })]);
    // The fixture is emitted by tsc; do not leave a stray runtime module behind.
    await rm('dist/main/main/dev-reload-smoke.js', { force: true });
  }
});
