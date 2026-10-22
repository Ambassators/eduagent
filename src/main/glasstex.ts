import { BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TeXSettings } from '../glasstex.js';
export { cleanTeXSettings } from '../glasstex.js';

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };
export function glassTeXResponse(root: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname !== 'editor' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    try {
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(await readFile(file)), { headers: { 'Content-Type': mime[path.extname(file)] ?? 'text/plain', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}
/** Export a separate snapshot so printing leaves the live editor and its selection untouched. */
export async function renderTeXPDF(source: string, settings: TeXSettings, assets: Record<string, string> = {}): Promise<Buffer> {
  const renderer = new BrowserWindow({ show: false, width: 720, height: 960, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  renderer.webContents.on('will-navigate', event => event.preventDefault());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await renderer.loadURL('codex-glasstex://editor/index.html');
        const payload = JSON.stringify({ source, assets, settings: { ...settings, appearance: 'light', automatic: false, autoEquations: false } });
        await renderer.webContents.executeJavaScript(`(async () => {
          const {source, settings, assets} = ${payload};
          if (!window.GlassTeX || !window.MathfieldElement) throw new Error('GlassTeX could not load.');
          document.documentElement.classList.add('pdf-export');
          GlassTeX.receive({action:'settings', settings});
          GlassTeX.receive({action:'assets', assets});
          GlassTeX.setDocument({source, revision:0, initial:true, force:true});
          GlassTeX.receive({action:'preview', enabled:true});
          document.activeElement?.blur();
          document.querySelectorAll('[contenteditable]').forEach(el => el.contentEditable = 'false');
          await document.fonts.ready;
          await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        return renderer.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, margins: { top: .5, bottom: .5, left: .5, right: .5 }, preferCSSPageSize: false });
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('The PDF renderer did not finish. Try exporting again.')), 60_000); })
    ]);
  } finally { clearTimeout(timeout); renderer.destroy(); }
}
