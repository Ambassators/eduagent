export interface BrowserTab { id: string; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export interface BrowserClient { id: string; name: string; cookieImportAvailable?: boolean; tabs: { id: number; title: string; url: string }[] }
export interface BrowserDownload { id: string; name: string; received: number; total: number; state: string }
export interface BrowserState { tabs: BrowserTab[]; activeId: string | null; clients: BrowserClient[]; downloads: BrowserDownload[]; bridge: { available: boolean; error?: string } }
export interface BrowserBounds { x: number; y: number; width: number; height: number; visible: boolean }
export interface BrowserCommand { action: 'snapshot' | 'click' | 'fill' | 'select' | 'scroll'; selector?: string; value?: string; x?: number; y?: number }
export function browserURL(input: unknown, search = false): string {
  if (typeof input !== 'string' || input.length > 8000) throw new Error('Invalid web address.');
  const value = input.trim();
  if (value === 'about:blank') return value;
  if (!value) return 'about:blank';
  if (search && value !== 'localhost' && !/^[a-z][a-z\d+.-]*:/i.test(value) && (value.includes(' ') || !/[.:]/.test(value))) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  const url = new URL(/^localhost(?::\d+)?(?:[/?#]|$)/i.test(value) ? `http://${value}` : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}
export function browserCommand(input: Record<string, unknown>): BrowserCommand {
  if (!['snapshot', 'click', 'fill', 'select', 'scroll'].includes(String(input.action))) throw new Error('Unsupported browser action.');
  const result: BrowserCommand = { action: input.action as BrowserCommand['action'] };
  if (['click', 'fill', 'select'].includes(result.action)) {
    if (typeof input.selector !== 'string' || !input.selector || input.selector.length > 2000) throw new Error('A bounded CSS selector is required.');
    result.selector = input.selector;
  }
  if (['fill', 'select'].includes(result.action)) {
    if (typeof input.value !== 'string' || input.value.length > 20000) throw new Error('Invalid field value.');
    result.value = input.value;
  }
  if (result.action === 'scroll') for (const key of ['x', 'y'] as const) {
    const value = input[key] ?? (key === 'y' ? 600 : 0);
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000) throw new Error('Invalid scroll distance.');
    result[key] = value;
  }
  return result;
}

export interface CookieImportResult { imported: number; skipped: number; failed: number; error?: string }
export interface CookieImportSource { id: string; browser: string; profile: string }
