import type { Protocol } from 'electron';
import type { DocumentStore } from './documents.js';
import { demoDocument, PRESENTATION_CSP } from '../presentation.js';

/** Sidebar HTML files use the same isolated viewer as floating demos. */
export function documentPresentationResponse(documents: Pick<DocumentStore, 'content'>, request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== '/document') return;
  try {
    const content = documents.content(url.hostname);
    if (content.info.kind !== 'html' || !['.html', '.htm'].includes(content.info.extension)) return new Response('HTML document not found.', { status: 404 });
    return new Response(demoDocument(content.text), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PRESENTATION_CSP } });
  } catch {
    return new Response('HTML document not found.', { status: 404 });
  }
}

export function ensurePresentationProtocol(protocol: Protocol, handler: Parameters<Protocol['handle']>[1]): void {
  // A popup's partition keeps its session (and handler) after the window closes.
  if (!protocol.isProtocolHandled('codex-presentation')) protocol.handle('codex-presentation', handler);
}
