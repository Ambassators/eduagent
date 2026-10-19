import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import * as pdfjs from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { DocumentContent, DocumentInfo, DocumentSource, PDFAnnotations } from '../shared';
import Icon from './Icon';
import SourcePreview from './SourcePreview';
import { RichMarkdown } from './RichText';
import PDFAnnotationLayer from './PDFAnnotationLayer';
import type { OrbTone } from './Orb';
pdfjs.GlobalWorkerOptions.workerSrc=workerURL;
type PDFVoice = {tone:OrbTone;label:string;disabled:boolean;onClick:()=>void;onVisible:(visible:boolean)=>void};
const PDF_DARK_KEY='codex-voice-pdf-dark';
function readPDFDark():boolean|null {
  try{const value=localStorage.getItem(PDF_DARK_KEY);return value==='1'?true:value==='0'?false:null;}catch{return null;}
}

export function MarkdownView({text}:{text:string}) {
  return <RichMarkdown text={text}/>;
}
function PDFPage({pdf,page,width,zoom,scrollHost,onError,file,annotations,voice}:{pdf:pdfjs.PDFDocumentProxy;page:number;width:number;zoom:number;scrollHost:HTMLDivElement;onError:(message:string)=>void;file:DocumentInfo;annotations:PDFAnnotations;voice:PDFVoice}) {
  const [pdfPage,setPDFPage]=useState<pdfjs.PDFPageProxy|null>(null),[nearViewport,setNearViewport]=useState(false);
  const sheet=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),layer=useRef<HTMLDivElement>(null);
  const errorRef=useRef(onError);errorRef.current=onError;
  useEffect(()=>{
    let current=true;
    void pdf.getPage(page).then(value=>{if(current)setPDFPage(value);}).catch(error=>{if(current)errorRef.current(error.message);});
    return()=>{current=false;};
  },[pdf,page]);
  useEffect(()=>{
    const element=sheet.current;if(!element)return;
    const observer=new IntersectionObserver(entries=>setNearViewport(entries[0].isIntersecting),{root:scrollHost,rootMargin:'800px 0px'});
    observer.observe(element);return()=>observer.disconnect();
  },[scrollHost]);
  useEffect(()=>{
    if(sheet.current)sheet.current.dataset.textReady='false';
    if(!nearViewport||!pdfPage||!canvas.current||!layer.current)return;
    let current=true,render:pdfjs.RenderTask|undefined,textLayer:pdfjs.TextLayer|undefined;
    void (async()=>{
      const natural=pdfPage.getViewport({scale:1});
      const viewport=pdfPage.getViewport({scale:width/natural.width*zoom});
      const element=canvas.current!,context=element.getContext('2d')!,density=Math.min(window.devicePixelRatio||1,2);
      element.width=Math.ceil(viewport.width*density);element.height=Math.ceil(viewport.height*density);
      element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;
      const textHost=layer.current!;textHost.replaceChildren();textHost.style.width=`${viewport.width}px`;textHost.style.height=`${viewport.height}px`;
      textHost.style.setProperty('--scale-factor',String(viewport.scale));
      render=pdfPage.render({canvas:element,canvasContext:context,viewport,transform:density===1?undefined:[density,0,0,density,0,0]});
      await render.promise;if(!current)return;
      const textContent=await pdfPage.getTextContent();if(!current)return;
      textLayer=new pdfjs.TextLayer({textContentSource:textContent,container:textHost,viewport});
      await textLayer.render();
      if(current&&sheet.current)sheet.current.dataset.textReady='true';
    })().catch(error=>{if(current&&error.name!=='RenderingCancelledException')errorRef.current(error.message);});
    return()=>{current=false;if(sheet.current)sheet.current.dataset.textReady='false';render?.cancel();textLayer?.cancel();};
  },[pdfPage,nearViewport,zoom,width]);
  const natural=pdfPage?.getViewport({scale:1});
  const scaledWidth=width*zoom,scaledHeight=scaledWidth*(natural?natural.height/natural.width:1.414);
  return <div className="pdf-sheet" ref={sheet} data-page={page} role="region" aria-label={`Page ${page}`} style={{width:scaledWidth,height:scaledHeight}}>
    {nearViewport&&<><canvas ref={canvas}/><div className="textLayer" ref={layer}/></>}
    <PDFAnnotationLayer annotations={annotations} fileId={file.id} revision={file.revision} page={page} width={scaledWidth} height={scaledHeight} tone={voice.tone} voiceLabel={voice.label} voiceDisabled={voice.disabled} onVoiceClick={voice.onClick} onPointerVisible={voice.onVisible} scrollHost={scrollHost} onError={onError}/>
  </div>;
}

export default function DocumentViewer({file,onError,annotations,voice,source,darkMode=false}:{file:DocumentInfo;onError:(message:string)=>void;annotations:PDFAnnotations;voice:PDFVoice;source?:DocumentSource|null;darkMode?:boolean}) {
  const documentRoot=useRef<HTMLDivElement>(null);
  const [content,setContent]=useState<DocumentContent|null>(null),[bytes,setBytes]=useState<Uint8Array|null>(null);
  const [page,setPage]=useState(1),[zoom,setZoom]=useState(1),[editing,setEditing]=useState(false),[draft,setDraft]=useState(''),[loading,setLoading]=useState(true);
  const [wrapText,setWrapText]=useState(false);
  const sourceText=file.kind==='text'&&file.extension!=='.rtf';
  const [pdf,setPDF]=useState<pdfjs.PDFDocumentProxy|null>(null),[imageURL,setImageURL]=useState('');
  const [pdfRevision,setPDFRevision]=useState<number|null>(null);
  const [hostWidth,setHostWidth]=useState(800);
  const [pdfDarkPreference,setPDFDarkPreference]=useState(readPDFDark);
  const pdfDark=pdfDarkPreference??darkMode;
  const pageHost=useRef<HTMLDivElement>(null);
  const errorRef=useRef(onError);errorRef.current=onError;
  useEffect(()=>{
    let current=true;setLoading(true);setEditing(false);setContent(null);setBytes(null);
    void Promise.all([window.desktop!.document(file.id),['pdf','image'].includes(file.kind)?window.desktop!.documentBytes(file.id):Promise.resolve(null)]).then(([next,data])=>{
      if(!current)return;setContent(next);setDraft(next.text);setBytes(data?new Uint8Array(data):null);setLoading(false);
    }).catch(error=>{if(current){errorRef.current(error.message);setLoading(false);}});
    return()=>{current=false;};
  },[file.id,file.revision]);
  useEffect(()=>{setWrapText(false);setPage(1);setZoom(1);pageHost.current?.scrollTo(0,0);},[file.id]);
  useEffect(()=>{const host=pageHost.current;if(!host)return;const observer=new ResizeObserver(entries=>setHostWidth(entries[0].contentRect.width));observer.observe(host);return()=>observer.disconnect();},[file.id,file.kind,loading]);
  useEffect(()=>{
    if(file.kind!=='image'||!bytes){setImageURL('');return;}
    const url=URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));setImageURL(url);return()=>URL.revokeObjectURL(url);
  },[bytes,file.kind]);
  useEffect(()=>{
    if(file.kind!=='pdf'||!bytes){setPDF(null);setPDFRevision(null);return;}
    let current=true;
    const task=pdfjs.getDocument({data:bytes.slice(),useSystemFonts:false,standardFontDataUrl:new URL('pdf-assets/standard_fonts/',window.location.href).href,cMapUrl:new URL('pdf-assets/cmaps/',window.location.href).href,wasmUrl:new URL('pdf-assets/wasm/',window.location.href).href});
    void task.promise.then(document=>{if(current){setPDF(document);setPDFRevision(file.revision);setPage(1);void window.desktop!.setPage(file.id,1).catch(error=>{if(current)errorRef.current(error.message);});}}).catch(error=>{if(current)errorRef.current(error.message);});
    return()=>{current=false;setPDF(null);setPDFRevision(null);void task.destroy();};
  },[bytes,file.kind,file.id,file.revision]);
  function trackPage() {
    const host=pageHost.current;if(!host)return;
    const readingLine=host.getBoundingClientRect().top+Math.min(host.clientHeight/3,200);
    const sheets=Array.from(host.querySelectorAll<HTMLElement>('.pdf-sheet'));
    const current=sheets.find(sheet=>sheet.getBoundingClientRect().bottom>readingLine);
    const next=Number(current?.dataset.page??1);
    if(next===page)return;
    setPage(next);void window.desktop!.setPage(file.id,next).catch(error=>errorRef.current(error.message));
  }
  async function saveDraft(){try{const next=await window.desktop!.updateDocument(file.id,draft);setContent(next);setEditing(false);}catch(error){errorRef.current(error instanceof Error?error.message:String(error));}}
  function togglePDFDark(){const next=!pdfDark;setPDFDarkPreference(next);try{localStorage.setItem(PDF_DARK_KEY,next?'1':'0');}catch{}}
  const editable=['text','markdown','html'].includes(file.kind)&&file.extension!=='.rtf';
  const sanitized=content?.html?DOMPurify.sanitize(content.html,{FORBID_TAGS:['script','iframe','form','object','embed','style'],FORBID_ATTR:['style'],ADD_DATA_URI_TAGS:['img']}):'';
  useEffect(()=>{
    const root=documentRoot.current;
    if(loading||editing||!root||source?.fileId!==file.id||!source.quote||file.kind==='pdf')return;
    const paper=root.querySelector('.document-paper');if(!paper)return;
    const walker=document.createTreeWalker(paper,NodeFilter.SHOW_TEXT),nodes:Text[]=[];let combined='',node;
    while((node=walker.nextNode())){nodes.push(node as Text);combined+=node.textContent??'';}
    let offset=combined.indexOf(source.quote);
    if(offset<0){errorRef.current('The cited passage could not be located in the preview. Switch to Edit to find the exact source text.');return;}
    let first:Text|undefined;
    for(const node of nodes){if(offset<node.length){first=node;break;}offset-=node.length;}
    const target=first?.parentElement?.closest('p,li,pre,h1,h2,h3,h4,blockquote')??first?.parentElement;
    target?.classList.add('source-passage');target?.scrollIntoView({block:'center',behavior:'smooth'});
    return()=>target?.classList.remove('source-passage');
  },[source,file.id,file.kind,loading,editing,content]);
  const annotationCount=annotations.overlays.filter(item=>item.fileId===file.id).length+annotations.highlights.filter(item=>item.fileId===file.id).length+(annotations.pointer?.fileId===file.id?1:0);
  return <div className="document-view" ref={documentRoot}>
    <div className="doc-toolbar drag"><div className="doc-title"><span className={`file-glyph small ${file.kind}`}>{file.extension.slice(1).toUpperCase().slice(0,4)}</span><strong title={file.originalPath||file.name}>{file.name}</strong></div><div className="doc-actions">
      {file.kind==='pdf'&&<><span className="page-count">{page}<em>/</em>{pdf?.numPages??file.pageCount??'…'}</span>
      {annotationCount>0&&<button className="quiet-button" title="Clear temporary overlays, highlights, and pointing" onClick={()=>void window.desktop!.dismissPDFAnnotation().catch(error=>errorRef.current(error.message))}><Icon name="close" size={14}/>Clear overlays</button>}
      <button className="icon-button pdf-dark-toggle" title={pdfDark?'Turn off dark PDF pages':'Turn on dark PDF pages'} aria-label="Dark PDF pages" aria-pressed={pdfDark} onClick={togglePDFDark}><Icon name="moon" size={16}/></button>
      <div className="control-group"><button title="Zoom out" aria-label="Zoom out" disabled={zoom<=.5} onClick={()=>setZoom(old=>Math.max(.5,old-.15))}><Icon name="minus" size={14}/></button><span>{Math.round(zoom*100)}%</span><button title="Zoom in" aria-label="Zoom in" disabled={zoom>=2} onClick={()=>setZoom(old=>Math.min(2,old+.15))}><Icon name="plus" size={14}/></button></div></>}
      {sourceText&&<button className="quiet-button" aria-label="Wrap lines" aria-pressed={wrapText} onClick={()=>setWrapText(old=>!old)}>Wrap lines</button>}
      {editable&&<button className="quiet-button" title={editing?'Preview':'Edit'} onClick={()=>setEditing(old=>!old)}><Icon name={editing?'eye':'edit'} size={14}/>{editing?'Preview':'Edit'}</button>}
      <button className="quiet-button" title="Save copy" onClick={()=>void window.desktop!.saveDocument(file.id,false).catch(error=>errorRef.current(error.message))}><Icon name="download" size={14}/>Save copy</button>
      {file.dirty&&file.originalPath&&<button className="quiet-button strong" title="A timestamped backup is created first" onClick={()=>void window.desktop!.saveDocument(file.id,true).catch(error=>errorRef.current(error.message))}><Icon name="save" size={14}/>Save original</button>}
    </div></div>
    {file.warning&&<div className="document-warning">{file.warning}</div>}
    {loading?<div className="viewer-loading"><span className="loading-ring"/></div>:editing?<div className="text-editor"><textarea aria-label="Edit document text" spellCheck={false} wrap={sourceText&&!wrapText?'off':'soft'} value={draft} onChange={event=>setDraft(event.target.value)}/><div><span/><button className="button-primary" onClick={()=>void saveDraft()}><Icon name="check" size={15}/>Apply changes</button></div></div>:
      file.kind==='pdf'?<div className={`pdf-scroll${pdfDark?' pdf-dark':''}`} ref={pageHost} data-file-id={file.id} data-revision={file.revision} onScroll={trackPage}>{pdf&&pdfRevision===file.revision&&pageHost.current?Array.from({length:pdf.numPages},(_,index)=><PDFPage key={`${file.id}-${file.revision}-${index}`} pdf={pdf} page={index+1} width={Math.max(200,Math.min(840,hostWidth-56))} zoom={zoom} scrollHost={pageHost.current!} onError={onError} file={file} annotations={annotations} voice={voice}/>):<div className="viewer-loading"><span className="loading-ring"/></div>}</div>:
      file.kind==='image'?<div className="image-preview"><img src={imageURL} alt={file.name}/></div>:
      file.kind==='binary'?<div className="unsupported-preview"><span className={`file-glyph large ${file.kind}`}>{file.extension.slice(1).toUpperCase().slice(0,4)}</span><h2>{file.name}</h2><p>No preview · {(file.size/1024).toFixed(1)} KB</p></div>:
      file.kind==='html'&&['.html','.htm'].includes(file.extension)?<iframe className="document-demo" title={file.name} sandbox="allow-scripts" src={`codex-presentation://${file.id}/document?revision=${file.revision}`}/>:
      <div className={`paper-scroll${sourceText?' source-scroll':''}`}><article className={`document-paper${sourceText?' source-paper':''}`}>{file.kind==='markdown'?<MarkdownView text={content?.text??''}/>:sanitized?<div className="word-body" onClick={event=>{const anchor=(event.target as HTMLElement).closest('a');if(anchor){event.preventDefault();void window.desktop!.openURL(anchor.href).catch(error=>errorRef.current(error.message));}}} dangerouslySetInnerHTML={{__html:sanitized}}/>:sourceText?<SourcePreview text={content?.text??''} extension={file.extension} name={file.name} wrap={wrapText}/>:<pre className="plain-document">{content?.text||'This document contains no readable text.'}</pre>}</article></div>}
  </div>;
}
