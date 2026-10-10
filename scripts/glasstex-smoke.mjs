import { spawn } from 'node:child_process';
import electron from 'electron';

const child = spawn(electron, ['tests/glasstex.electron.cjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
let passed = false, output = '';
child.stdout.on('data', data => {
  process.stdout.write(data);
  output += data.toString();
  passed ||= output.includes('GlassTeX Electron smoke passed:');
});
const timeout = setTimeout(() => { console.error('GlassTeX Electron check timed out.'); child.kill('SIGKILL'); }, 65_000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); if (code !== 0 || !passed) process.exitCode = 1; });
