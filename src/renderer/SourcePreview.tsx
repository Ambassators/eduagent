import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { highlightSource } from './source-highlight';

export default function SourcePreview({text,extension,name,wrap}:{text:string;extension:string;name:string;wrap:boolean}) {
  const highlighted=useMemo(()=>{
    const html=highlightSource(text,extension);
    return html===null?null:DOMPurify.sanitize(html,{ALLOWED_TAGS:['span'],ALLOWED_ATTR:['class']});
  },[text,extension]);
  return <pre className={`plain-document${wrap?' wrap-lines':''}`} aria-label={`${name} source`}>{highlighted===null?<code>{text}</code>:<code dangerouslySetInnerHTML={{__html:highlighted}}/>}</pre>;
}
