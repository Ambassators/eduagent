export const PRESENTATION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function demoDocument(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PRESENTATION_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">`;
  if (/<head\b[^>]*>/i.test(content)) return content.replace(/<head\b[^>]*>/i, head => head + policy);
  return `<!doctype html><html><head>${policy}<style>html,body{margin:0;min-height:100%;font-family:Segoe UI,sans-serif}*{box-sizing:border-box}</style></head><body>${content}</body></html>`;
}
export function popupDocument(title: string, content: string): string {
  const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src about:; object-src 'none'"><title>${escape(title)}</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#f7f8fa}</style></head><body><iframe title="${escape(title)}" sandbox="allow-scripts" srcdoc="${escape(content)}"></iframe></body></html>`;
}
