import { randomUUID } from 'node:crypto';
import type { AppEvent, PDFAnnotations, PDFHighlight, PDFOverlay, PDFPointer } from '../shared.js';
import type { DocumentStore } from './documents.js';

/** The renderer measures the actual PDF. The main process owns temporary workspace state. */
export class PDFOverlays {
  state: PDFAnnotations = { overlays: [], highlights: [], pointer: null };
  private pending = new Map<string, { fileId: string; revision: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private lane: Promise<unknown> = Promise.resolve();
  constructor(private files: DocumentStore, private emit: (event: AppEvent) => void) {}
  private changed() { this.emit({ method: 'workspace/annotations', params: { annotations: this.state } }); }
  prune() {
    const valid = (item: { fileId: string; revision: number }) => this.files.list().some(file => file.id === item.fileId && file.revision === item.revision);
    this.state.overlays = this.state.overlays.filter(valid); this.state.highlights = this.state.highlights.filter(valid);
    if (this.state.pointer && !valid(this.state.pointer)) this.state.pointer = null;
  }
  dismiss(id?: string, fileId?: string) {
    const matches = (item: { id?: string; fileId: string }) => id ? item.id === id : !fileId || item.fileId === fileId;
    const highlight = this.state.highlights.find(item => matches(item));
    this.state.overlays = this.state.overlays.filter(item => !matches(item));
    this.state.highlights = this.state.highlights.filter(item => !matches(item));
    if (this.state.pointer && (!id && (!fileId || this.state.pointer.fileId === fileId) || highlight && highlight.fileId === this.state.pointer.fileId && highlight.page === this.state.pointer.page)) this.state.pointer = null;
    if (id === 'pointer') this.state.pointer = null;
    this.changed();
  }
  reset() {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('PDF action cancelled.')); }
    this.pending.clear(); this.state = { overlays: [], highlights: [], pointer: null }; this.changed();
  }
  resolve(id: string, value: unknown, error?: string) {
    const job = this.pending.get(id); if (!job) return;
    this.pending.delete(id); clearTimeout(job.timer);
    const file = this.files.list().find(item => item.id === job.fileId);
    if (!file || file.revision !== job.revision || this.files.activeId !== job.fileId) { job.reject(new Error('The PDF changed while the tool was running. Try again.')); return; }
    if (error) { job.reject(new Error(error.slice(0,1000))); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { job.reject(new Error('Invalid PDF viewer response.')); return; }
    job.resolve(value as Record<string,unknown>);
  }
  execute(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = this.lane.then(() => this.run(tool, args)); this.lane = result.catch(() => {}); return result;
  }
  private async run(tool: string, args: Record<string, unknown>) {
    const fileId = typeof args.fileId === 'string' ? args.fileId : this.files.activeId;
    const file = this.files.list().find(item => item.id === fileId);
    if (!file || file.kind !== 'pdf') throw new Error('Open a PDF first.');
    if (this.files.activeId !== file.id) throw new Error('Select this PDF before using its overlay tools.');
    if (tool === 'clear_pdf_overlays') { this.dismiss(typeof args.id === 'string' ? args.id : undefined, file.id); return { cleared: true }; }
    if (tool === 'show_pdf_overlay') {
      if (args.id !== undefined && (typeof args.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(args.id) || args.id === 'pointer')) throw new Error('Overlay IDs must use lowercase letters, digits, and hyphens, and cannot be pointer.');
      if (!['text','embed'].includes(String(args.kind)) || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 300000) throw new Error('Provide text or embed content under 300,000 characters.');
      if (args.format !== undefined && !['text','markdown','latex','mermaid'].includes(String(args.format))) throw new Error('Invalid text format.');
      if (this.state.overlays.length >= 100 && !this.state.overlays.some(item => item.id === args.id)) throw new Error('Clear an overlay before adding another.');
    }
    if (tool === 'highlight_pdf_text' && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4000)) throw new Error('Provide a quote under 4,000 characters.');
    if (args.page !== undefined && (!Number.isInteger(args.page) || Number(args.page) < 1)) throw new Error('Page must be a positive integer.');
    const requestId = randomUUID();
    const result = await new Promise<Record<string, unknown>>((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The PDF viewer did not respond. Let it finish loading and try again.')); }, 15000);
      this.pending.set(requestId,{ fileId:file.id, revision:file.revision, resolve,reject,timer });
      this.emit({ method:'pdf/tool',params:{request:{id:requestId,tool,fileId:file.id,revision:file.revision,args}} });
    });
    if (tool === 'show_pdf_overlay') {
      const id = typeof args.id === 'string' ? args.id.slice(0,100) : randomUUID();
      const previous=this.state.overlays.find(item=>item.id===id);
      const overlay: PDFOverlay = { id, fileId:file.id, revision:file.revision, version:previous&&previous.content===args.content?previous.version:(previous?.version??0)+1, page:Number(result.page), rect:result.rect as PDFOverlay['rect'], kind:args.kind as PDFOverlay['kind'], format:(args.format ?? 'markdown') as PDFOverlay['format'], title:typeof args.title === 'string' ? args.title.slice(0,160) : args.kind === 'embed' ? 'Interactive' : 'Note', content:args.content as string };
      this.state.overlays = [...this.state.overlays.filter(item => item.id !== id), overlay];
      this.changed(); return { id, shown:true, page:overlay.page, rect:overlay.rect };
    }
    if (tool === 'highlight_pdf_text') {
      const highlight: PDFHighlight = { id:randomUUID(), fileId:file.id, revision:file.revision, page:Number(result.page), text:args.text as string, rects:result.rects as PDFHighlight['rects'] };
      this.state.highlights = [...this.state.highlights.slice(-99),highlight];
      this.state.pointer = result.pointer as PDFPointer; this.changed();
      return { id:highlight.id, highlighted:true, pointing:true, page:highlight.page, rects:highlight.rects };
    }
    if (tool === 'point_on_pdf') { this.state.pointer = result.pointer as PDFPointer; this.changed(); return { pointing:true, pointer:this.state.pointer }; }
    return result;
  }
}
