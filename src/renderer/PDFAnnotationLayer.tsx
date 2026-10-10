import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PageRect, PDFAnnotations } from '../shared';
import { OverlayText } from './RichText';
import { Orb, VoiceGlyph, type OrbTone } from './Orb';
import Icon from './Icon';
import { layoutPDFPointer, type PointerLayout } from './pdf-pointer-layout';

/** Where the voice dot last sat, so moving to another page flies from there instead of from the main orb. */
let lastDot:{sheet:HTMLElement;x:number;y:number;time:number}|null=null;
const FLY_MS=560;
const reducedMotion=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const position=(r:PageRect):CSSProperties=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});
export default function PDFAnnotationLayer({annotations,fileId,page,revision,width,height,tone,voiceLabel,voiceDisabled,onVoiceClick,onPointerVisible,scrollHost,onError}:{annotations:PDFAnnotations;fileId:string;page:number;revision:number;width:number;height:number;tone:OrbTone;voiceLabel:string;voiceDisabled:boolean;onVoiceClick:()=>void;onPointerVisible:(visible:boolean)=>void;scrollHost:HTMLDivElement;onError:(message:string)=>void}) {
  const overlays=annotations.overlays.filter(item=>item.fileId===fileId&&item.page===page&&item.revision===revision);
  const highlights=annotations.highlights.filter(item=>item.fileId===fileId&&item.page===page&&item.revision===revision);
  const pointer=annotations.pointer?.fileId===fileId&&annotations.pointer.page===page&&annotations.pointer.revision===revision?annotations.pointer:null;
  const layer=useRef<HTMLDivElement>(null),dot=useRef<HTMLDivElement>(null),gradientId=useId().replace(/:/g,'');
  const [pointerLayout,setPointerLayout]=useState<PointerLayout|null>(null);
  const body=useRef<HTMLDivElement>(null),placed=useRef<{x:number;y:number}|null>(null);
  // Bumped on every arrival; restarts the ping and the arrow, which wait for the dot to get there.
  const [arrival,setArrival]=useState({key:0,delay:0,ready:false});
  useLayoutEffect(()=>{
    const sheet=layer.current?.parentElement;
    if(!pointer||!sheet){setPointerLayout(null);return;}
    const place=()=>setPointerLayout(sheet.dataset.textReady==='true'?layoutPDFPointer(pointer,sheet,width,height):null);
    place();
    const observer=new MutationObserver(place);
    observer.observe(sheet,{attributes:true,attributeFilter:['data-text-ready']});
    return()=>observer.disconnect();
  },[pointer,width,height]);
  useLayoutEffect(()=>{
    const sheet=layer.current?.parentElement,previous=placed.current;
    if(!pointerLayout){if(previous&&sheet)lastDot={sheet,...previous,time:Date.now()};placed.current=null;setArrival(old=>old.ready?{...old,ready:false}:old);return;}
    placed.current=pointerLayout.dot;
    if(previous) {
      // Same page: the CSS transition glides it over.
      if(previous.x!==pointerLayout.dot.x||previous.y!==pointerLayout.dot.y)setArrival(old=>({key:old.key+1,delay:reducedMotion()?0:420,ready:true}));
      return;
    }
    // Wait for the microtask so the page the dot is leaving has recorded lastDot, still before paint.
    queueMicrotask(()=>{
      const element=dot.current,inner=body.current;
      if(!element||!inner||reducedMotion()){setArrival(old=>({key:old.key+1,delay:0,ready:true}));return;}
      const end=element.getBoundingClientRect(),endX=end.x+end.width/2,endY=end.y+end.height/2;
      const recent=lastDot&&Date.now()-lastDot.time<800&&lastDot.sheet.isConnected?lastDot:null;lastDot=null;
      let from:{x:number;y:number}|null=null;
      if(recent){const bounds=recent.sheet.getBoundingClientRect();from={x:bounds.x+recent.x,y:bounds.y+recent.y};}
      else{const rail=document.querySelector('.orb-wrap > .mic-button')?.getBoundingClientRect();if(rail)from={x:rail.x+rail.width/2,y:rail.y+rail.height/2};}
      if(!from){setArrival(old=>({key:old.key+1,delay:0,ready:true}));return;}
      const dx=from.x-endX,dy=from.y-endY,lift=Math.min(90,Math.hypot(dx,dy)*.18);
      // The PDF scroller clips its children, so a copy makes the flight over the window and the real dot appears when it lands.
      const ghost=element.cloneNode(true) as HTMLElement;
      ghost.querySelectorAll('.pdf-pointer-return,.pdf-dot-ping').forEach(node=>node.remove());
      ghost.setAttribute('aria-hidden','true');ghost.removeAttribute('style');ghost.classList.add('pdf-voice-ghost');
      Object.assign(ghost.style,{left:`${end.x}px`,top:`${end.y}px`});
      (element.closest('.studio')??document.body).appendChild(ghost);
      inner.style.opacity='0';
      const flight=ghost.animate([
        {transform:`translate(${dx}px,${dy}px) scale(${recent?1:.55})`,opacity:recent?1:.5},
        {transform:`translate(${dx*.45}px,${dy*.45-lift}px) scale(.9)`,opacity:1,offset:.5},
        {transform:'translate(0,0) scale(1.1)',offset:.82},
        {transform:'none'}
      ],{duration:FLY_MS,easing:'cubic-bezier(.35,.6,.3,1)'});
      void flight.finished.catch(()=>{}).finally(()=>{ghost.remove();inner.style.opacity='';});
      setArrival(old=>({key:old.key+1,delay:FLY_MS-60,ready:true}));
    });
  },[pointerLayout]);
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
      <svg className="pdf-pointing-arrow" data-tone={tone} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="pdf-arrow-color-start"/><stop offset="1" className="pdf-arrow-color-end"/></linearGradient></defs>{arrival.ready&&<path key={arrival.key} d={pointerLayout.arrow} fill={`url(#${gradientId})`} style={{transformOrigin:`${pointerLayout.dot.x}px ${pointerLayout.dot.y}px`,'--arrival-delay':`${arrival.delay}ms`} as CSSProperties}/>}</svg>
      <div ref={dot} className="pdf-voice-dot" style={{transform:`translate3d(${pointerLayout.dot.x-26}px,${pointerLayout.dot.y-26}px,0)`,'--arrival-delay':`${arrival.delay}ms`} as CSSProperties}><div ref={body} className="pdf-voice-dot-body">
        {arrival.ready&&<span key={arrival.key} className="pdf-dot-ping" aria-hidden="true"/>}
        <button className={`mic-button ${tone}`} data-tone={tone} title={`${pointer.label} · ${voiceLabel}`} aria-label={voiceLabel} disabled={voiceDisabled} onClick={onVoiceClick}><span className="face"><Orb tone={tone}/><VoiceGlyph tone={tone} size={20}/></span></button>
        <button className="pdf-pointer-return" title="Return voice dot" aria-label="Return voice dot" onClick={()=>dismiss('pointer')}><Icon name="close" size={12}/></button>
      </div></div>
    </>}
  </div>;
}
