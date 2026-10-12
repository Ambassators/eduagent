/** GlassTeX uses UTF-16 offsets, matching JavaScript and the original native source buffer. */
export const TEX_MAX_BYTES = 8 * 1024 * 1024;
export const isTeXExtension = (extension: string) => ['.tex', '.ltx', '.latex'].includes(extension.toLowerCase());
export interface TeXPatch { start: number; end: number; expected: string; replacement: string; revision: number }
export interface TeXCommand { id: string; title: string; category: string; latex: string; symbol: string; mode: string; shortcut?: string | null; keywords?: string | null }
export interface TeXSettings {
  appearance: 'system' | 'light' | 'dark'; automatic: boolean; autoEquations: boolean;
  angleMode: 'radians' | 'degrees'; fontSize: number; documentSpacing: 'compact' | 'comfortable' | 'spacious' | 'custom';
  customLineSpacing: number; customBlockSpacing: number; customEquationSpacing: number; customListSpacing: number;
}
export const defaultTeXSettings: TeXSettings = { appearance: 'system', automatic: true, autoEquations: true, angleMode: 'radians', fontSize: 22, documentSpacing: 'compact', customLineSpacing: 1.25, customBlockSpacing: .6, customEquationSpacing: .4, customListSpacing: .35 };
export function canonicalTeXShortcut(value: string): string {
  const entered = value.toLowerCase().replaceAll(/\s/g, '');
  if (!entered) return '';
  const parts = entered.split('+'), key = parts.pop()!, order = ['cmd', 'ctrl', 'alt', 'shift'];
  if (!/^[a-z0-9]$/.test(key) || !parts.some(part => part === 'cmd' || part === 'ctrl') || parts.some(part => !order.includes(part)) || new Set(parts).size !== parts.length) throw new Error('Use Command or Control plus one letter or digit.');
  const modifiers = order.filter(part => parts.includes(part));
  const shortcut = [...modifiers, key].join('+');
  const reserved = ['q', 'w', 's', 'o', 'n', 'k', 'z', 'x', 'c', 'v', 'a', 'h', 'm'].includes(key) && modifiers.length === 1
    || modifiers.includes('shift') && modifiers.length === 2 && ['z', 'l', 'p', 'i', 't', 's'].includes(key)
    || modifiers.includes('alt') && modifiers.length === 2 && ['h', 'e'].includes(key);
  if (reserved) throw new Error('That shortcut belongs to the application or GlassTeX.');
  return shortcut;
}
export function cleanTeXSettings(value: unknown): TeXSettings {
  const result = { ...defaultTeXSettings };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  for (const [key, options] of Object.entries({ appearance: ['system', 'light', 'dark'], angleMode: ['radians', 'degrees'], documentSpacing: ['compact', 'comfortable', 'spacious', 'custom'] })) {
    if (typeof input[key] === 'string' && options.includes(input[key] as string)) Object.assign(result, { [key]: input[key] });
  }
  for (const key of ['automatic', 'autoEquations'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  for (const [key, min, max] of [['fontSize', 16, 32], ['customLineSpacing', 1.1, 2.2], ['customBlockSpacing', 0, 2], ['customEquationSpacing', 0, 2], ['customListSpacing', 0, 1.5]] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = Math.max(min, Math.min(max, input[key]));
  }
  return result;
}
export const texCategoryOrder = ['Document blocks', 'Math structures', 'Essentials', 'Text & layout', 'Functions', 'Greek', 'Operators', 'Relations', 'Sets & logic', 'Arrows', 'Large operators', 'Accents & styling', 'Spacing', 'Symbols', 'References & source'];
/** Undo and redo as whole-source snapshots, bounded by count and, for large documents, by memory. */
export class TeXHistory {
  private past: string[] = [];
  private future: string[] = [];
  private readonly limit: number;
  private readonly maxBytes: number;
  constructor(limit = 200, maxBytes = 32 * 1024 * 1024) { this.limit = limit; this.maxBytes = maxBytes; }
  /** Remember the source as it was before an edit. A new edit discards whatever could be redone. */
  record(previous: string) {
    this.past.push(previous);
    this.future = [];
    let bytes = this.past.reduce((total, text) => total + text.length * 2, 0);
    while (this.past.length > this.limit || (this.past.length > 1 && bytes > this.maxBytes)) bytes -= this.past.shift()!.length * 2;
  }
  /** The source to go back to, or null; `current` becomes redoable. */
  undo(current: string): string | null { return TeXHistory.move(this.past, this.future, current); }
  /** The source to go forward to, or null; `current` becomes undoable. */
  redo(current: string): string | null { return TeXHistory.move(this.future, this.past, current); }
  clear() { this.past = []; this.future = []; }
  private static move(from: string[], to: string[], current: string) {
    const next = from.pop();
    if (next === undefined) return null;
    to.push(current);
    return next;
  }
}
export function applyTeXPatch(source: string, revision: number, patch: TeXPatch): string {
  if (patch.revision !== revision) throw new Error('The document changed while this edit was being made.');
  const { start, end } = patch;
  const splitsPair = (offset: number) => offset > 0 && offset < source.length && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length || splitsPair(start) || splitsPair(end)) throw new Error('Invalid source range.');
  if (typeof patch.replacement !== 'string' || source.slice(start, end) !== patch.expected) throw new Error('The source and editor no longer agree.');
  return source.slice(0, start) + patch.replacement + source.slice(end);
}
