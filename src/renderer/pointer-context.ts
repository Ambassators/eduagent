/** Describes what the mouse pointer is over in the document viewer, so spoken "this" and "here" can be resolved. */
let pointer: { x: number; y: number } | null = null;
window.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; }, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer = null; });

const clip = (text: string, limit: number) => { const value = text.replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit)}…` : value; };
const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;

function wordAt(x: number, y: number) {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!range || node?.nodeType !== Node.TEXT_NODE) return '';
  const text = node.textContent ?? '';
  let start = range.startOffset, end = range.startOffset;
  while (start > 0 && /[\p{L}\p{N}_.'-]/u.test(text[start - 1])) start--;
  while (end < text.length && /[\p{L}\p{N}_.'-]/u.test(text[end])) end++;
  return text.slice(start, end).replace(/^[.'-]+|[.'-]+$/g, '');
}

/** Text-layer lines within about a line and a half of the pointer, top to bottom. */
function pdfLinesNear(sheet: HTMLElement, y: number) {
  const spans = Array.from(sheet.querySelectorAll<HTMLElement>('.textLayer span')).filter(span => !span.children.length && span.textContent?.trim());
  const boxes = spans.map(span => ({ span, rect: span.getBoundingClientRect() })).filter(({ rect }) => rect.height > 0);
  const lineHeight = boxes.find(({ rect }) => rect.top <= y && rect.bottom >= y)?.rect.height ?? 14;
  const near = boxes.filter(({ rect }) => Math.abs((rect.top + rect.bottom) / 2 - y) <= lineHeight * 1.5)
    .sort((a, b) => Math.abs(a.rect.top - b.rect.top) > lineHeight / 2 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left);
  const lines: string[][] = [];
  let top = -Infinity;
  for (const { span, rect } of near) {
    if (rect.top - top > lineHeight / 2) { lines.push([]); top = rect.top; }
    lines[lines.length - 1].push(span.textContent!);
  }
  return lines.map(line => line.join(' ')).join('\n');
}

export function pointerContext() {
  const parts: string[] = [];
  const selection = window.getSelection()?.toString() ?? '';
  if (selection.trim()) parts.push(`Selected text: ${JSON.stringify(clip(selection, 600))}`);
  const at = pointer && document.elementFromPoint(pointer.x, pointer.y);
  if (!pointer || !at?.closest('.document-view')) { parts.push('The pointer is not over the open document.'); return parts.join('\n'); }
  const word = wordAt(pointer.x, pointer.y);
  const sheet = at.closest<HTMLElement>('.pdf-sheet[data-page]');
  const image = at.closest<HTMLElement>('.image-preview img');
  if (sheet) {
    const rect = sheet.getBoundingClientRect();
    parts.push(`The pointer is on PDF page ${sheet.dataset.page}, ${percent((pointer.x - rect.left) / rect.width)} from the left and ${percent((pointer.y - rect.top) / rect.height)} from the top.`);
    const lines = pdfLinesNear(sheet, pointer.y);
    if (lines) parts.push(`Text around the pointer:\n${clip(lines, 500)}`);
  } else if (image) {
    const rect = image.getBoundingClientRect();
    parts.push(`The pointer is on the image, ${percent((pointer.x - rect.left) / rect.width)} from the left and ${percent((pointer.y - rect.top) / rect.height)} from the top.`);
  } else {
    const block = at.closest('p, li, pre, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption');
    parts.push(block?.textContent?.trim() ? `The pointer is over this passage: ${JSON.stringify(clip(block.textContent, 500))}` : 'The pointer is over the document, but not over text.');
  }
  if (word) parts.push(`Word under the pointer: ${JSON.stringify(word)}`);
  return parts.join('\n');
}
