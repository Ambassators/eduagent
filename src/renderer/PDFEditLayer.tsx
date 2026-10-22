import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, KeyboardEvent, CSSProperties } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PDFTextChange } from '../shared';

type TextHit = { text: string; x: number; y: number; width: number; height: number; fontSize: number; fontFamily: 'sans'|'serif'|'mono' };
type Draft = { x: number; y: number; width: number; height: number; text: string; fontSize: number; color: string; fontFamily: 'sans'|'serif'|'mono'; originalText?: string; originalRect?:{x:number;y:number;width:number;height:number} };

const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const cssRect=(r:{x:number;y:number;width:number;height:number}):CSSProperties=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});

/** Inline text replacement and answer placement tools for the currently visible PDF page. */
export default function PDFEditLayer({pdfPage,page,width,height,mode,onApply,busy}:{pdfPage:PDFPageProxy|null;page:number;width:number;height:number;mode:'replace'|'add'|null;onApply:(change:PDFTextChange)=>Promise<void>;busy:boolean}) {
  const [draft,setDraft]=useState<Draft|null>(null);
  const [applyError,setApplyError]=useState('');
  const textareaRef=useRef<HTMLTextAreaElement>(null),layerRef=useRef<HTMLDivElement>(null);
  const [textLayout,setTextLayout]=useState<{hits:TextHit[];hasAngledText:boolean}>({hits:[],hasAngledText:false});
  const [textReady,setTextReady]=useState(false);
  useEffect(()=>{setDraft(null);setApplyError('');},[page,pdfPage,mode]);
  useEffect(()=>{
    let current=true;
    if(!pdfPage||width<=0||height<=0){setTextLayout({hits:[],hasAngledText:false});setTextReady(false);return()=>{current=false;};}
    setTextReady(false);
    const viewport=pdfPage.getViewport({scale:1}),sx=width/viewport.width,sy=height/viewport.height;
    void pdfPage.getTextContent().then(content=>{
      if(!current)return;
      let angled=false;
      const hits=content.items.flatMap(item=>{
        if(!('str' in item)||!item.str.trim())return [];
        const t=item.transform,vt=viewport.transform;
        // Compose the page viewport with the text transform to get visual-page coordinates.
        const b=vt[1]*t[0]+vt[3]*t[1],c=vt[0]*t[2]+vt[2]*t[3];
        const e=vt[0]*t[4]+vt[2]*t[5]+vt[4],f=vt[1]*t[4]+vt[3]*t[5]+vt[5];
        // Horizontal runs have a rectangular editing area. Angled runs need oriented
        // selection and replacement geometry, so keep those out of this tool.
        if(Math.abs(b)>0.01||Math.abs(c)>0.01){angled=true;return [];}
        const left=e*sx,baseline=f*sy,runWidth=Math.max(2,item.width*sx),runHeight=Math.max(4,item.height*sy);
        const style=content.styles[item.fontName],ascent=style?.ascent??.82,descent=Math.abs(style?.descent??-.18);
        const top=baseline-runHeight*ascent,boxX=clamp(left/width),boxY=clamp(top/height);
        const box={x:boxX,y:boxY,width:clamp(Math.min(runWidth,width-boxX*width)/width),height:clamp(Math.min(runHeight*(ascent+descent),height-boxY*height)/height)};
        const familyName=style?.fontFamily??'';
        const family:TextHit['fontFamily']=/mono|courier/i.test(familyName)?'mono':/sans/i.test(familyName)?'sans':/serif|times/i.test(familyName)?'serif':'sans';
        return [{...box,text:item.str,fontSize:Math.max(6,Math.min(72,Math.round(item.height*100)/100)),fontFamily:family}];
      });
      setTextLayout({hits,hasAngledText:angled});
      setTextReady(true);
    }).catch(()=>{if(current){setTextLayout({hits:[],hasAngledText:false});setTextReady(true);}});
    return()=>{current=false;};
  },[pdfPage,width,height]);
  const {hits,hasAngledText}=textLayout;

  if(!mode||!pdfPage)return null;
  const openHit=(hit:TextHit)=>{
    setApplyError('');
    setDraft({...hit,color:'#202124',originalText:hit.text,originalRect:{x:hit.x,y:hit.y,width:hit.width,height:hit.height}});
  };
  const openAdd=(event:MouseEvent<HTMLDivElement>)=>{
    if((event.target as HTMLElement).closest('.pdf-edit-target,.pdf-edit-card'))return;
    const bounds=event.currentTarget.getBoundingClientRect();
    const x=clamp((event.clientX-bounds.left)/bounds.width),y=clamp((event.clientY-bounds.top)/bounds.height);
    setApplyError('');
    setDraft({x,y,width:Math.min(.4,1-x),height:Math.min(.15,1-y),text:'',fontSize:12,color:'#202124',fontFamily:'sans'});
  };
  const apply=async()=>{
    if(!draft||(!draft.originalText&&!draft.text.trim())||busy)return;
    let geometry=draft;
    if(!draft.originalText&&textareaRef.current&&layerRef.current){
      const host=layerRef.current.getBoundingClientRect(),box=textareaRef.current.getBoundingClientRect();
      geometry={...draft,width:clamp(Math.min(box.width,host.right-host.left-draft.x*host.width)/host.width),height:clamp(Math.min(box.height,host.bottom-host.top-draft.y*host.height)/host.height)};
    }
    const change:PDFTextChange={action:draft.originalText?'replace_text':'add_text',page,x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height,text:draft.text,fontSize:draft.fontSize,color:draft.color,fontFamily:draft.fontFamily,...(draft.originalText?{originalText:draft.originalText,originalRect:draft.originalRect}:{})};
    setApplyError('');
    try{await onApply(change);setDraft(null);}catch(error){setApplyError((error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+': Error: /,''));}
  };
  const stop=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setDraft(null);}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void apply();}};
  const editorStyle:CSSProperties|undefined=draft?{left:`${Math.min(draft.x*width,Math.max(0,width-320))}px`,top:`${Math.min(draft.y*height,Math.max(0,height-180))}px`}:undefined;
  return <div ref={layerRef} className={`pdf-edit-layer ${mode==='add'?'is-add':''}`} onClick={mode==='add'?openAdd:undefined}>
    {mode==='replace'&&hits.map((hit,index)=><button type="button" key={`${index}-${hit.x}-${hit.y}`} className="pdf-edit-target" style={cssRect(hit)} title={`Replace text: ${hit.text}`} aria-label={`Replace text: ${hit.text}`} onClick={event=>{event.stopPropagation();openHit(hit);}}/>)}
    {mode==='add'&&<div className="pdf-edit-hint">Click where you want to add an answer or note</div>}
    {mode==='replace'&&textReady&&!hits.length&&<div className="pdf-edit-note">No selectable text on this page.</div>}
    {hasAngledText&&mode==='replace'&&<div className="pdf-edit-note">Some rotated or angled text can’t be replaced safely here.</div>}
    {draft&&<section className={`pdf-edit-card ${draft.originalText?'is-replace':''}`} style={editorStyle} onClick={event=>event.stopPropagation()} aria-label={draft.originalText?'Replace PDF text':'Add PDF text'}>
      <textarea ref={textareaRef} autoFocus value={draft.text} placeholder={draft.originalText?'Clear to remove this text':'Type answer or note…'} onChange={event=>setDraft({...draft,text:event.target.value})} onKeyDown={stop}/>
      <div className="pdf-edit-controls">
        <label>Size <input type="number" min="6" max="72" value={draft.fontSize} onChange={event=>setDraft({...draft,fontSize:Math.max(6,Math.min(72,Number(event.target.value)||12))})}/></label>
        {draft.originalText&&<><label>W px <input aria-label="Replacement width in pixels" type="number" min="8" max={Math.round(width*(1-draft.x))} value={Math.round(draft.width*width)} onChange={event=>setDraft({...draft,width:Math.min(1-draft.x,Math.max(8,Number(event.target.value)||8)/width)})}/></label><label>H px <input aria-label="Replacement height in pixels" type="number" min="8" max={Math.round(height*(1-draft.y))} value={Math.round(draft.height*height)} onChange={event=>setDraft({...draft,height:Math.min(1-draft.y,Math.max(8,Number(event.target.value)||8)/height)})}/></label></>}
        <label>Color <input aria-label="Text color" type="color" value={draft.color} onChange={event=>setDraft({...draft,color:event.target.value})}/></label>
        <select aria-label="Font" value={draft.fontFamily} onChange={event=>setDraft({...draft,fontFamily:event.target.value as Draft['fontFamily']})}><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
      </div>
      {applyError&&<div className="pdf-edit-error" role="alert">{applyError}</div>}
      <footer><span>⌘/Ctrl + Enter to apply</span><button type="button" onClick={()=>setDraft(null)} disabled={busy}>Cancel</button><button type="button" className="primary" onClick={()=>void apply()} disabled={busy||(!draft.originalText&&!draft.text.trim())}>{busy?'Applying…':'Apply'}</button></footer>
    </section>}
  </div>;
}
