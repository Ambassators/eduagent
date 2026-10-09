import type { PageRect, PDFPointer, PDFToolRequest } from '../shared';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const box = (value: unknown): PageRect => {
  const r = value as PageRect;
  if (!r || ![r.x,r.y,r.width,r.height].every(finite) || r.width <= 0 || r.height <= 0) throw new Error('Provide a rectangle with finite coordinates and positive width/height.');
  return r;
};
const screenBox = (r: DOMRect): PageRect => ({ x:r.x, y:r.y, width:r.width, height:r.height });
const normalized = (r: PageRect, sheet: DOMRect): PageRect => ({ x:(r.x-sheet.x)/sheet.width, y:(r.y-sheet.y)/sheet.height, width:r.width/sheet.width, height:r.height/sheet.height });
function withinPage(r: PageRect) {
  if(r.x < 0 || r.y < 0 || r.x+r.width > 1.0001 || r.y+r.height > 1.0001) throw new Error('The rectangle must fit inside a PDF page. Read get_pdf_view for its current bounds.');
  return r;
}
const visible = (sheet: DOMRect, host: DOMRect) => sheet.bottom > host.top && sheet.top < host.bottom && sheet.right > host.left && sheet.left < host.right;
async function ready(host: HTMLDivElement, request: PDFToolRequest, page: number, reveal: boolean) {
  const sheet = host.querySelector<HTMLElement>(`.pdf-sheet[data-page="${page}"]`);
  if(!sheet) throw new Error('This PDF page does not exist or is still loading.');
  if(!visible(sheet.getBoundingClientRect(),host.getBoundingClientRect())) {
    if(!reveal) throw new Error('Screen coordinates require a visible PDF page. Call get_pdf_view with a page number first.');
    host.scrollTo({ top:host.scrollTop+sheet.getBoundingClientRect().top-host.getBoundingClientRect().top-24, behavior:'instant' });
  }
  const deadline = performance.now()+10000;
  while(performance.now()<deadline) {
    if(host.dataset.fileId!==request.fileId || Number(host.dataset.revision)!==request.revision || !sheet.isConnected) throw new Error('The active PDF changed. Try again.');
    if(sheet.dataset.textReady==='true')return sheet;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw new Error('PDF text is still rendering. Try again in a moment.');
}
function quoteRects(sheet: HTMLElement, quote: string, occurrence: number): PageRect[] {
  const layer=sheet.querySelector('.textLayer');
  if(!layer)throw new Error('PDF text is not ready.');
  const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT),nodes:Text[]=[];
  while(walker.nextNode())if(walker.currentNode.textContent)nodes.push(walker.currentNode as Text);
  if(!nodes.length)throw new Error('This page has no selectable text. For a scanned PDF, point using page coordinates.');
  let text='';const positions:{node:Text;offset:number}[]=[];
  const append=(char:string,node:Text,offset:number)=>{
    const lower=char.toLowerCase();
    if(/\s/u.test(char)){if(text.endsWith(' '))return;text+=' ';positions.push({node,offset});}
    else for(const part of lower){text+=part;positions.push({node,offset});}
  };
  for(const node of nodes){if(text&&!text.endsWith(' '))append(' ',node,0);for(let i=0;i<node.length;i++)append(node.data[i],node,i);}
  const needle=quote.replace(/\s+/gu,' ').trim().toLowerCase();
  let start=-1;
  for(let i=0;i<occurrence;i++){start=text.indexOf(needle,start+1);if(start<0)throw new Error(`Quote occurrence ${occurrence} was not found on this page. Copy text from read_file or get_pdf_view.`);}
  const first=positions[start],last=positions[start+needle.length-1],bounds=sheet.getBoundingClientRect(),rects:PageRect[]=[];
  const from=nodes.indexOf(first.node),to=nodes.indexOf(last.node);
  for(let i=from;i<=to;i++){
    const node=nodes[i],range=document.createRange();
    range.setStart(node,i===from?first.offset:0);range.setEnd(node,i===to?last.offset+1:node.length);
    for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0){
      const x=Math.max(rect.left,bounds.left),y=Math.max(rect.top,bounds.top),right=Math.min(rect.right,bounds.right),bottom=Math.min(rect.bottom,bounds.bottom);
      if(right>x&&bottom>y)rects.push(normalized({x,y,width:right-x,height:bottom-y},bounds));
    }
  }
  if(!rects.length)throw new Error('The quote has no visible text bounds.');
  return rects;
}
function pointer(request: PDFToolRequest, page: number, target: PageRect, sheet: HTMLElement): PDFPointer {
  const bounds=sheet.getBoundingClientRect(),requested=request.args.dot as {x:number;y:number}|undefined;
  let dot:{x:number;y:number};
  if(requested){
    if(!finite(requested.x)||!finite(requested.y))throw new Error('Provide finite dot coordinates.');
    dot=request.args.space==='screen'?{x:(requested.x-bounds.x)/bounds.width,y:(requested.y-bounds.y)/bounds.height}:requested;
    if(dot.x<0||dot.x>1||dot.y<0||dot.y>1)throw new Error('The voice dot must be inside the PDF page.');
  }else{
    const roomLeft=target.x*bounds.width,roomRight=(1-target.x-target.width)*bounds.width;
    dot={x:roomRight>=roomLeft?target.x+target.width+64/bounds.width:target.x-64/bounds.width,y:target.y+target.height/2};
    // For full-width targets, use the vertical margin instead of covering the quote.
    if(Math.max(roomLeft,roomRight)<90)dot={x:target.x+target.width/2,y:target.y+target.height+64/bounds.height};
  }
  dot={x:Math.max(32/bounds.width,Math.min(1-32/bounds.width,dot.x)),y:Math.max(32/bounds.height,Math.min(1-32/bounds.height,dot.y))};
  return {fileId:request.fileId,revision:request.revision,page,target,dot,label:typeof request.args.label==='string'?request.args.label.slice(0,120):request.tool==='highlight_pdf_text'?String(request.args.text).slice(0,120):'Look here'};
}
export async function executePDFViewTool(host: HTMLDivElement, request: PDFToolRequest): Promise<Record<string,unknown>> {
  const {args,tool}=request;
  const hostRect=host.getBoundingClientRect(),sheets=[...host.querySelectorAll<HTMLElement>('.pdf-sheet')];
  const readingLine=hostRect.top+Math.min(host.clientHeight/3,200);
  const current=sheets.find(sheet=>sheet.getBoundingClientRect().bottom>readingLine);
  let page=typeof args.page==='number'?args.page:Number(current?.dataset.page??1);
  if(args.space==='screen'&&args.page===undefined&&args.rect){
    const r=box(args.rect);
    const match=sheets.find(sheet=>{const b=sheet.getBoundingClientRect();return r.x+r.width/2>=b.left&&r.x+r.width/2<=b.right&&r.y+r.height/2>=b.top&&r.y+r.height/2<=b.bottom;});
    if(!match)throw new Error('Those screen coordinates do not target a PDF page.');
    page=Number(match.dataset.page);
  }
  if(!Number.isInteger(page)||page<1)throw new Error('Page must be a positive integer.');
  if(tool==='get_pdf_view'){
    if(args.page!==undefined)await ready(host,request,page,true);
    const pages=[];
    for(const sheet of sheets){
      if(!visible(sheet.getBoundingClientRect(),host.getBoundingClientRect()))continue;
      await ready(host,request,Number(sheet.dataset.page),false);
      const bounds=sheet.getBoundingClientRect();
      const spans=[...sheet.querySelectorAll<HTMLElement>('.textLayer span')].filter(span=>span.childNodes.length&&span.textContent?.trim()&&visible(span.getBoundingClientRect(),host.getBoundingClientRect())).slice(0,300).map(span=>({text:span.textContent?.slice(0,250),rect:screenBox(span.getBoundingClientRect())}));
      pages.push({page:Number(sheet.dataset.page),rect:screenBox(bounds),textSpans:spans});
    }
    return {fileId:request.fileId,coordinateSpace:'screen',units:'CSS viewport pixels',viewport:screenBox(host.getBoundingClientRect()),pages};
  }
  const sheet=await ready(host,request,page,args.space!=='screen');
  if(tool==='highlight_pdf_text'){
    const occurrence=args.occurrence??1;
    if(!Number.isInteger(occurrence)||Number(occurrence)<1||Number(occurrence)>1000)throw new Error('occurrence must be a positive integer under 1001.');
    const rects=quoteRects(sheet,String(args.text),Number(occurrence));
    const target=rects[0],b=sheet.getBoundingClientRect();
    host.scrollTo({top:host.scrollTop+b.top+target.y*b.height-host.getBoundingClientRect().top-host.clientHeight/3,behavior:'instant'});
    return {page,rects,pointer:pointer(request,page,target,sheet)};
  }
  if(!['screen','page'].includes(String(args.space)))throw new Error('Choose screen or page coordinate space.');
  const r=box(args.rect),rect=withinPage(args.space==='screen'?normalized(r,sheet.getBoundingClientRect()):r);
  if(tool==='show_pdf_overlay')return {page,rect};
  if(tool==='point_on_pdf')return {page,pointer:pointer(request,page,rect,sheet)};
  throw new Error('Unknown PDF viewer tool.');
}
