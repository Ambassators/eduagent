import { isValidElement, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import type { PDFOverlay } from '../shared';

let mermaidModule: Promise<typeof import('mermaid')> | undefined;
export function MermaidView({ text }: { text: string }) {
  const [svg,setSVG]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    let current=true;setSVG('');setError('');
    mermaidModule ??= import('mermaid');
    void mermaidModule.then(async({default:mermaid})=>{
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',suppressErrorRendering:true,maxTextSize:50000,htmlLabels:false,secure:['secure','securityLevel','startOnLoad','maxTextSize','suppressErrorRendering','maxEdges','htmlLabels']});
      const result=await mermaid.render(`diagram-${crypto.randomUUID()}`,text);
      if(current)setSVG(DOMPurify.sanitize(result.svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject']}));
    }).catch(error=>{if(current)setError(error instanceof Error?error.message:'Diagram could not render.');});
    return()=>{current=false;};
  },[text]);
  return error?<div className="rich-text-error" role="status"><strong>Diagram could not render</strong><pre>{text}</pre><small>{error}</small></div>:svg?<div className="mermaid-diagram" dangerouslySetInnerHTML={{__html:svg}}/>:<span role="status">Rendering diagram…</span>;
}
// remark-math only understands $…$ / $$…$$; convert LaTeX-style \(…\) and \[…\] (outside code) so they render.
export function normalizeMath(text: string) {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part,index)=>index%2?part:part
    .replace(/\\\[([\s\S]+?)\\\]/g,(_,math:string)=>`\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g,(_,math:string)=>`$${math.trim()}$`)).join('');
}
export function RichMarkdown({ text }: { text: string }) {
  return <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[[rehypeKatex,{trust:false,throwOnError:false,maxExpand:1000}]]} components={{
    a:({href,children})=><a href={href} onClick={event=>{event.preventDefault();if(href)void window.desktop?.openURL(href);}}>{children}</a>,
    pre:({children})=>{
      if(isValidElement<{className?:string;children?:unknown}>(children)&&children.props.className==='language-mermaid')return <MermaidView text={String(children.props.children??'').trim()}/>;
      return <pre>{children}</pre>;
    }
  }}>{normalizeMath(text)}</Markdown></div>;
}
export function OverlayText({ overlay }: { overlay: PDFOverlay }) {
  if(overlay.format==='mermaid')return <MermaidView text={overlay.content}/>;
  if(overlay.format==='latex')return <div className="overlay-math" dangerouslySetInnerHTML={{__html:katex.renderToString(overlay.content,{displayMode:true,throwOnError:false,trust:false,maxExpand:1000,maxSize:20})}}/>;
  if(overlay.format==='text')return <div className="overlay-plain">{overlay.content}</div>;
  return <RichMarkdown text={overlay.content}/>;
}
