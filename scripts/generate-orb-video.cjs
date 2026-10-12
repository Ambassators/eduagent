/* Regenerate the bundled 192px, 60/30fps silent orb loops on macOS. Runtime is cross-platform. */
const { app, BrowserWindow } = require('electron');
const { readFile, writeFile, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const fps = 60;
const count = 11 * fps;
if (process.platform !== 'darwin') throw new Error('Asset regeneration uses macOS AVFoundation; the committed videos work on every platform.');
app.on('window-all-closed', () => {});
app.setActivationPolicy('accessory');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(command + ' exited ' + code)));
});
let win, temporary;
app.whenReady().then(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'eduagent-orb-frames-'));
  const output = path.join(root, 'src/renderer/public/orb-video');
  await mkdir(output, { recursive: true });
  const fluid = (await readFile(path.join(root, 'scripts/orb-fluid.cjs'), 'utf8')).replace('module.exports = { createFluidRenderer };', '');
  const css = await readFile(path.join(root, 'src/renderer/orb.css'), 'utf8');
  win = new BrowserWindow({ show: false, width: 192, height: 192, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  // Keep the edge shading in CSS at runtime; bake only the interior.
  const fixture = path.join(temporary, 'fixture.html');
  await writeFile(fixture, `<!doctype html><style>${css}html,body{margin:0;width:192px;height:192px}[data-tone]{transition:none}.orb{box-shadow:none;border-radius:0}.orb::after{display:none}.swirl{will-change:auto!important}</style><div id="face" data-tone="on"><span class="orb" data-animated="true"><canvas width="192" height="192"></canvas></span></div>`);
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(fluid + `;window.fluid=createFluidRenderer(document.querySelector('canvas'));void 0;`);
  for (const tone of ['on', 'capturing', 'speaking']) {
    const directory = path.join(temporary, tone);
    await mkdir(directory);
    const lowDirectory = path.join(temporary, tone + '-low');
    await mkdir(lowDirectory);
    await win.webContents.executeJavaScript(`document.querySelector('#face').dataset.tone=${JSON.stringify(tone)}`);
    for (let i = 0; i < count; i++) {
      await win.webContents.executeJavaScript(`fluid.draw(${i * Math.PI * 2 / count}, ${JSON.stringify(tone)});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const frame = await win.webContents.capturePage({ x: 0, y: 0, width: 192, height: 192 });
      const png = frame.resize({ width: 192, height: 192 }).toPNG();
      await writeFile(path.join(directory, String(i).padStart(4, '0') + '.png'), png);
      if (i % 2 === 0) await writeFile(path.join(lowDirectory, String(i / 2).padStart(4, '0') + '.png'), png);
      if (i === 0) await writeFile(path.join(output, `texture-${tone}.png`), png);
    }
    await run('swift', [path.join(root, 'scripts/encode-orb-video.swift'), directory, path.join(output, tone + '-smooth.mp4'), String(count), String(fps)]);
    await run('swift', [path.join(root, 'scripts/encode-orb-video.swift'), lowDirectory, path.join(output, tone + '.mp4'), String(count / 2), String(fps / 2)]);
  }
  win.destroy(); await rm(temporary, { recursive: true, force: true }); app.exit(0);
}).catch(async error => {
  console.error(error); win?.destroy(); if (temporary) await rm(temporary, { recursive: true, force: true }); app.exit(1);
});
