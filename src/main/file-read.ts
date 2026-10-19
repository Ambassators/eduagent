import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const exec = promisify(execFile);
const downloadScript = `ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const manager = $.NSFileManager.defaultManager;
  if (manager.isUbiquitousItemAtURL(url)) manager.startDownloadingUbiquitousItemAtURLError(url, null);
}`;
async function requestDownload(source: string) {
  if (process.platform !== 'darwin') return;
  // Foundation requests hydration through iCloud; paths are arguments, never script text.
  await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', downloadScript, source], { timeout: 10_000, maxBuffer: 4096 });
}
const fileIO = { read: (source: string) => readFile(source), download: requestDownload, pause: (ms: number) => delay(ms) };

export async function readDocumentFile(source: string, waiting: (name: string) => void = () => {}, io = fileIO): Promise<Buffer> {
  const cloudPath = /[\\/]Library[\\/](Mobile Documents|CloudStorage)[\\/]/.test(source);
  if (cloudPath) await io.download(source).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    try { return await io.read(source); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!['ETIMEDOUT', 'EAGAIN', 'EWOULDBLOCK'].includes(code ?? '')) throw error;
      if (attempt === 2) throw new Error(`Could not download or read "${path.basename(source)}" after retrying. Check that your sync app is online, or make the file available offline and open it again.`, { cause: error });
      waiting(path.basename(source));
      if (attempt === 0 && !cloudPath) await io.download(source).catch(() => {});
      await io.pause((attempt + 1) * 1000);
    }
  }
}
