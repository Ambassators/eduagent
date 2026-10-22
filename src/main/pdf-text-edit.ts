import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PDFTextChange } from '../shared.js';

const require = createRequire(import.meta.url);
const MAX_TEXT_LENGTH = 20_000;
type Rect = Pick<PDFTextChange, 'x' | 'y' | 'width' | 'height'>;

function validateRect(rect: Rect, label = 'text box'): void {
  if (!rect || typeof rect !== 'object') throw new Error(`The ${label} must be a rectangle.`);
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error(`The ${label} must be a non-empty rectangle inside the visible page.`);
  }
}

function visibleRectToMupdf(rect: Rect, bounds: number[]): [number, number, number, number] {
  const [left, top, right, bottom] = bounds;
  const pageWidth = right - left;
  const pageHeight = bottom - top;
  return [
    left + rect.x * pageWidth,
    top + rect.y * pageHeight,
    left + (rect.x + rect.width) * pageWidth,
    top + (rect.y + rect.height) * pageHeight,
  ];
}

function inkFor(hex: string) {
  if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex)) throw new Error('Use a #RRGGBB text color.');
  return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

interface TextFonts {
  standard: PDFFont;
  forCharacter(character: string): Promise<PDFFont>;
  all(): PDFFont[];
}

async function fontsFor(pdf: PDFDocument, family: PDFTextChange['fontFamily']): Promise<TextFonts> {
  const standardFont = family === 'serif' ? StandardFonts.TimesRoman
    : family === 'mono' ? StandardFonts.Courier : StandardFonts.Helvetica;
  const standard = await pdf.embedFont(standardFont);
  let noto: PDFFont | undefined;
  const characters = new Map<string, PDFFont>();
  const loadNoto = async (): Promise<PDFFont> => {
    if (noto) return noto;
    pdf.registerFontkit(fontkit);
    const file = require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff');
    const data = await readFile(file);
    noto = await pdf.embedFont(data, { subset: true });
    return noto;
  };
  return {
    standard,
    async forCharacter(character: string) {
      const cached = characters.get(character);
      if (cached) return cached;
      const codePoint = character.codePointAt(0)!;
      if (standard.getCharacterSet().includes(codePoint)) { characters.set(character, standard); return standard; }
      const fallback = await loadNoto();
      if (fallback.getCharacterSet().includes(codePoint)) { characters.set(character, fallback); return fallback; }
      throw new Error(`The bundled Noto Sans fonts do not include “${character}”. Remove it or use a supported character.`);
    },
    all() { return noto ? [standard, noto] : [standard]; },
  };
}

interface StyledRun { text: string; font: PDFFont }
type StyledLine = StyledRun[];

function lineWidth(line: StyledRun[], fontSize: number): number {
  return line.reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, fontSize), 0);
}

function appendRun(line: StyledLine, character: string, font: PDFFont): void {
  const last = line.at(-1);
  if (last?.font === font) last.text += character;
  else line.push({ text: character, font });
}

async function wrapText(fonts: TextFonts, text: string, fontSize: number, maxWidth: number): Promise<StyledLine[]> {
  const result: StyledLine[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { result.push([]); continue; }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line: StyledLine = [];
    for (const word of words) {
      const wordRuns: StyledLine = [];
      for (const character of word) appendRun(wordRuns, character, await fonts.forCharacter(character));
      const space = line.length ? [{ text: ' ', font: fonts.standard }] : [];
      const candidate = [...line, ...space, ...wordRuns];
      if (lineWidth(candidate, fontSize) <= maxWidth + 0.01) {
        line = candidate;
        continue;
      }
      if (line.length) { result.push(line); line = []; }
      if (lineWidth(wordRuns, fontSize) > maxWidth + 0.01) {
        throw new Error('A word is wider than the text box. Increase its width or reduce the font size.');
      }
      line = wordRuns;
    }
    result.push(line);
  }
  return result;
}

function visiblePointToPdf(x: number, y: number, crop: { x: number; y: number; width: number; height: number }, rotation: number): [number, number] {
  switch (rotation) {
    case 0: return [crop.x + x, crop.y + crop.height - y];
    case 90: return [crop.x + y, crop.y + x];
    case 180: return [crop.x + crop.width - x, crop.y + y];
    case 270: return [crop.x + crop.width - y, crop.y + crop.height - x];
    default: throw new Error('This PDF page has an unsupported rotation.');
  }
}

async function drawText(page: PDFPage, crop: { x: number; y: number; width: number; height: number }, rotation: number, rect: Rect, text: string, fontSize: number, family: PDFTextChange['fontFamily'], color: ReturnType<typeof rgb>): Promise<void> {
  const visualWidth = (rotation === 90 || rotation === 270) ? crop.height : crop.width;
  const visualHeight = (rotation === 90 || rotation === 270) ? crop.width : crop.height;
  const left = rect.x * visualWidth;
  const top = rect.y * visualHeight;
  const width = rect.width * visualWidth;
  const height = rect.height * visualHeight;
  const fonts = await fontsFor(page.doc, family);
  const lines = await wrapText(fonts, text, fontSize, width);
  const ascent = Math.max(...fonts.all().map(font => font.heightAtSize(fontSize, { descender: false })));
  const glyphHeight = Math.max(...fonts.all().map(font => font.heightAtSize(fontSize)));
  const lineAdvance = fontSize * 1.2;
  const neededHeight = lines.length ? glyphHeight + Math.max(0, lines.length - 1) * lineAdvance : 0;
  if (neededHeight > height + 0.01) {
    throw new Error(`The text needs ${neededHeight.toFixed(1)} pt of height, but the text box is ${height.toFixed(1)} pt high. Increase its height or reduce the font size.`);
  }

  lines.forEach((line, index) => {
    let offset = 0;
    for (const run of line) {
      // Rotation is applied by the page viewer. Rotating the text by the same
      // amount in PDF user space keeps its baseline horizontal on screen.
      const [x, y] = visiblePointToPdf(left + offset, top + ascent + index * lineAdvance, crop, rotation);
      page.drawText(run.text, { x, y, font: run.font, size: fontSize, color, rotate: degrees(rotation) });
      offset += run.font.widthOfTextAtSize(run.text, fontSize);
    }
  });
}

/** Apply one PDF text replacement or insertion and return a new PDF buffer. */
export async function applyPDFTextChange(bytes: Buffer, change: PDFTextChange): Promise<Buffer> {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('The PDF is empty or invalid.');
  if (!change || typeof change !== 'object' || !Number.isInteger(change.page) || change.page < 1) throw new Error('Page must be a positive integer.');
  if (change.action !== 'replace_text' && change.action !== 'add_text') throw new Error('Unsupported PDF text action.');
  if (typeof change.text !== 'string' || change.text.length > MAX_TEXT_LENGTH) throw new Error('Text must be a string of at most 20,000 characters.');
  if (change.originalText !== undefined && (typeof change.originalText !== 'string' || change.originalText.length > MAX_TEXT_LENGTH)) throw new Error('Original text must be a string of at most 20,000 characters.');
  if (change.action === 'add_text' && !change.text.trim()) throw new Error('Provide text to add.');
  if (typeof change.fontSize !== 'number' || !Number.isFinite(change.fontSize) || change.fontSize < 5 || change.fontSize > 120) throw new Error('Font size must be from 5 to 120 points.');
  if (change.fontFamily !== undefined && !['sans', 'serif', 'mono'].includes(change.fontFamily)) throw new Error('Choose a sans, serif, or mono font.');
  const color = inkFor(change.color);
  validateRect(change, 'text box');
  const eraseRect = change.originalRect === undefined ? change : change.originalRect;
  if (change.action === 'replace_text') validateRect(eraseRect, 'original text area');

  let workingBytes = bytes;
  if (change.action === 'replace_text') {
    const { default: mupdf } = await import('mupdf');
    let document: InstanceType<typeof mupdf.PDFDocument> | undefined;
    let page: ReturnType<InstanceType<typeof mupdf.PDFDocument>['loadPage']> | undefined;
    let annotation: ReturnType<ReturnType<InstanceType<typeof mupdf.PDFDocument>['loadPage']>['createAnnotation']> | undefined;
    try {
      const opened = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
      if (!opened) throw new Error('This file is not a readable PDF.');
      document = opened;
      if (change.page > document.countPages()) throw new Error('Page is outside the PDF.');
      page = document.loadPage(change.page - 1);
      const bounds = page.getBounds(mupdf.Page.CROP_BOX);
      if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error('This PDF page has invalid visible bounds.');
      annotation = page.createAnnotation('Redact');
      annotation.setRect(visibleRectToMupdf(eraseRect, bounds));
      // Applying the new annotation directly avoids applying any unrelated
      // redaction annotations already present on the page.
      annotation.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      const saved = document.saveToBuffer('compress');
      try { workingBytes = Buffer.from(saved.asUint8Array()); }
      finally { saved.destroy(); }
    } finally {
      annotation?.destroy();
      page?.destroy();
      document?.destroy();
    }
    if (!change.text.length) return workingBytes;
  }

  const pdf = await PDFDocument.load(workingBytes);
  if (change.page > pdf.getPageCount()) throw new Error('Page is outside the PDF.');
  const page = pdf.getPage(change.page - 1);
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('This PDF page has an unsupported rotation.');
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) throw new Error('This PDF page has invalid visible bounds.');
  await drawText(page, crop, rotation, change, change.text, change.fontSize, change.fontFamily, color);
  return Buffer.from(await pdf.save());
}
