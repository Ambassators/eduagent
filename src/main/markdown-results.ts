import type { DocumentSource } from '../shared.js';
import type { DocumentStore } from './documents.js';

export const isLongMarkdown = (markdown: string) => markdown.length > 3000 || markdown.trim().split(/\s+/).length > 400;
export function sourceURL(source: DocumentSource): string {
  const url = new URL(`codex-source://${source.fileId}`);
  if (source.page !== undefined) url.searchParams.set('page', String(source.page));
  if (source.quote) url.searchParams.set('quote', source.quote);
  return url.href;
}
export function parseSourceURL(value: string): DocumentSource {
  const url = new URL(value);
  if (url.protocol !== 'codex-source:' || !url.hostname || url.username || url.password) throw new Error('Invalid source link.');
  const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined;
  return {fileId: url.hostname, label:'Source passage', page, quote:url.searchParams.get('quote') || undefined};
}
export function verifySource(files: DocumentStore, value: unknown): DocumentSource {
  if (!value || typeof value !== 'object') throw new Error('Provide a source reference.');
  const raw = value as DocumentSource;
  if (typeof raw.fileId !== 'string' || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 200) throw new Error('Source needs fileId and label.');
  const file = files.get(raw.fileId), content = files.content(raw.fileId);
  if (raw.page !== undefined && (!Number.isInteger(raw.page) || raw.page < 1 || file.info.kind !== 'pdf' || raw.page > (file.info.pageCount ?? 0))) throw new Error('Source page must identify an existing PDF page.');
  if (file.info.kind === 'pdf' && raw.page === undefined) throw new Error('PDF sources need a specific page.');
  if (['quiz','image','binary'].includes(file.info.kind)) throw new Error('Use a readable study document as the source.');
  if (raw.quote !== undefined && (typeof raw.quote !== 'string' || !raw.quote.trim() || raw.quote.length > 4000)) throw new Error('Source quote must contain 1–4000 characters.');
  if (file.info.kind !== 'pdf' && !raw.quote) throw new Error('Text sources need an exact quote to locate the passage.');
  const passage = raw.page === undefined ? content.text : content.pages?.find(page => page.number === raw.page)?.text;
  if (raw.quote && !passage?.includes(raw.quote)) throw new Error('Source quote was not found. Read the file and use an exact passage.');
  return {fileId:raw.fileId,label:raw.label.trim(),page:raw.page,quote:raw.quote};
}
export function markdownWithSources(files: DocumentStore, markdown: string, raw: unknown): string {
  const sources = raw === undefined ? [] : raw;
  if (!Array.isArray(sources) || sources.length > 30) throw new Error('Provide at most thirty source references.');
  const verified = sources.map(source => verifySource(files, source));
  for (const match of markdown.matchAll(/\]\((codex-source:[^\s)]+)\)/g)) verifySource(files, parseSourceURL(match[1]));
  if (!verified.length) return markdown;
  const escape = (label: string) => label.replace(/[\\[\]]/g, '\\$&');
  return `${markdown}\n\n## Source passages\n\n${verified.map(source => `- [${escape(source.label)}${source.page ? ` · page ${source.page}` : ''}](${sourceURL(source)})`).join('\n')}\n`;
}
