import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PageRect, PDFAnnotations } from '../shared';
import { OverlayText } from './RichText';
import { Orb, type OrbTone } from './Orb';
import Icon from './Icon';
import { layoutPDFPointer, type PointerLayout } from './pdf-pointer-layout';

const position=(r:PageRect):CSSProperties=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});
export default function PDFAnnotationLayer({annotations,fileId,page,revision,width,height,tone,voiceLabel,voiceDisabled,onVoiceClick,onPointerVisible,scrollHost,onError}:{annotations:PDFAnnotations;fileId:string;page:number;revision:number;width:number;height:number;tone:OrbTone;voiceLabel:string;voiceDisabled:boolean;onVoiceClick:()=>void;onPointerVisible:(visible:boolean)=>void;scrollHost:HTMLDivElement;onError:(message:string)=>void}) {
  const overlays=annotations.overlays.filter(item=>item.fileId===fileId&&item.page===page&&item.revision===revision);
  const highlights=annotations.highlights.filter(item=>item.fileId===fileId&&item.page===page&&item.revision===revision);
  const pointer=annotations.pointer?.fileId===fileId&&annotations.pointer.page===page&&annotations.pointer.revision===revision?annotations.pointer:null;
  const layer=useRef<HTMLDivElement>(null),dot=useRef<HTMLDivElement>(null),gradientId=useId().replace(/:/g,'');
  const [pointerLayout,setPointerLayout]=useState<PointerLayout|null>(null);
  useLayoutEffect(()=>{
    const sheet=layer.current?.parentElement;
    if(!pointer||!sheet){setPointerLayout(null);return;}
    const place=()=>setPointerLayout(sheet.dataset.textReady==='true'?layoutPDFPointer(pointer,sheet,width,height):null);
    place();
    const observer=new MutationObserver(place);
    observer.observe(sheet,{attributes:true,attributeFilter:['data-text-ready']});
    return()=>observer.disconnect();
  },[pointer,width,height]);
  useEffect(()=>{
    if(!pointerLayout||!dot.current)return;
    const observer=new IntersectionObserver(entries=>onPointerVisible(entries[0].isIntersecting),{root:scrollHost});
    observer.observe(dot.current);return()=>{observer.disconnect();onPointerVisible(false);};
  },[pointerLayout,scrollHost,onPointerVisible]);
  const dismiss=(id:string)=>void window.desktop!.dismissPDFAnnotation(id).catch(error=>onError(error.message));
  return <div ref={layer} className="pdf-annotations">
    {highlights.map(item=><div key={item.id} className="pdf-highlight-group" aria-label={`Highlighted: ${item.text}`}>{item.rects.map((r,index)=><span className="pdf-text-highlight" style={position(r)} key={index}/>)}</div>)}
    {overlays.map(overlay=><section key={overlay.id} className={`pdf-overlay ${overlay.kind}`} style={position(overlay.rect)} aria-label={overlay.title}>
      <header><strong>{overlay.title}</strong><button title="Remove overlay" aria-label={`Remove ${overlay.title}`} onClick={()=>dismiss(overlay.id)}><Icon name="close" size={13}/></button></header>
      {overlay.kind==='embed'?<iframe title={overlay.title} sandbox="allow-scripts" src={`codex-presentation://${overlay.id}/?version=${overlay.version}`}/>:<div className="pdf-overlay-content"><OverlayText overlay={overlay}/></div>}
    </section>)}
    {pointer&&pointerLayout&&<>
      <svg className="pdf-pointing-arrow" data-tone={tone} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="pdf-arrow-color-start"/><stop offset="1" className="pdf-arrow-color-end"/></linearGradient></defs><path d={pointerLayout.arrow} fill={`url(#${gradientId})`}/></svg>
      <div ref={dot} className="pdf-voice-dot" style={{transform:`translate3d(${pointerLayout.dot.x-26}px,${pointerLayout.dot.y-26}px,0)`}}>
        <button className={`mic-button ${tone}`} data-tone={tone} title={`${pointer.label} · ${voiceLabel}`} aria-label={voiceLabel} disabled={voiceDisabled} onClick={onVoiceClick}><span className="face"><Orb tone={tone}/><Icon name={tone==='idle'?'mic':'wave'} size={20}/></span></button>
        <button className="pdf-pointer-return" title="Return voice dot" aria-label="Return voice dot" onClick={()=>dismiss('pointer')}><Icon name="close" size={12}/></button>
      </div>
    </>}
  </div>;
}
