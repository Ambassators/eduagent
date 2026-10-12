export const PRESENTATION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
// Sandboxed demos have their own animation clocks, independent of the React shell.
const DEMO_ACTIVITY = `<style>html[data-render-active="false"] *,html[data-render-active="false"] *::before,html[data-render-active="false"] *::after{animation-play-state:paused!important;transition:none!important}</style><script>(()=>{
  const embedded=parent!==window, request=window.requestAnimationFrame.bind(window), cancel=window.cancelAnimationFrame.bind(window);
  let focused=!embedded&&document.hasFocus(), active=false, sequence=0;
  const pending=new Map(), pausedMedia=new Set();
  function schedule(id,job){job.frame=request(time=>{pending.delete(id);job.callback(time);});}
  function update(){
    const next=focused&&!document.hidden;
    document.documentElement.dataset.renderActive=String(next);
    if(next===active)return;
    active=next;
    for(const [id,job] of pending){if(active)schedule(id,job);else{cancel(job.frame);job.frame=null;}}
    if(active){for(const media of pausedMedia)if(media.isConnected)void media.play().catch(()=>{});pausedMedia.clear();}
    else for(const media of document.querySelectorAll('video'))if(!media.paused){pausedMedia.add(media);media.pause();}
  }
  window.requestAnimationFrame=callback=>{const id=++sequence,job={callback,frame:null};pending.set(id,job);if(active)schedule(id,job);return id;};
  window.cancelAnimationFrame=id=>{const job=pending.get(id);if(job){cancel(job.frame);pending.delete(id);}};
  if(embedded)window.addEventListener('message',event=>{if(event.source===parent&&event.data?.channel==='eduagent-render-activity'){focused=event.data.active===true;update();}});
  else{window.addEventListener('focus',()=>{focused=true;update();});window.addEventListener('blur',()=>{focused=false;update();});}
  document.addEventListener('visibilitychange',update);
  document.addEventListener('play',event=>{if(!active&&event.target instanceof HTMLVideoElement){pausedMedia.add(event.target);event.target.pause();}},true);
  update();
})();</script>`;
export function demoDocument(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PRESENTATION_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">${DEMO_ACTIVITY}`;
  if (/<head\b[^>]*>/i.test(content)) return content.replace(/<head\b[^>]*>/i, head => head + policy);
  return `<!doctype html><html><head>${policy}<style>html,body{margin:0;min-height:100%;font-family:Segoe UI,sans-serif}*{box-sizing:border-box}</style></head><body>${content}</body></html>`;
}
export function popupDocument(title: string, content: string): string {
  const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src about:; object-src 'none'"><title>${escape(title)}</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#f7f8fa}</style></head><body><iframe title="${escape(title)}" sandbox="allow-scripts" srcdoc="${escape(content)}"></iframe></body></html>`;
}
