import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentInfo, DesktopAPI } from '../shared';
import type { QuizAttachment, QuizState } from '../quiz';
import QuizPanel from './QuizPanel';
import Icon from './Icon';

export default function QuizDocument({file,state,onClose,onError}:{file:DocumentInfo;state:QuizState;onClose:()=>void;onError:(message:string)=>void}) {
  const api=window.desktop as DesktopAPI;
  const [toggling,setToggling]=useState(false);
  const quiz=state.quiz;
  const [showAttachments,setShowAttachments]=useState(false);
  const attachmentsPopup=useRef<HTMLDivElement>(null),closeAttachments=useRef<HTMLButtonElement>(null),attachmentsButton=useRef<HTMLButtonElement>(null);
  const [sourceError,setSourceError]=useState(''),[openingSource,setOpeningSource]=useState(false);
  useEffect(()=>{setShowAttachments(false);setSourceError('');},[quiz?.id]);
  useLayoutEffect(()=>{
    const popup=attachmentsPopup.current,button=attachmentsButton.current;
    if(!popup||!button)return;
    if(!showAttachments){if(popup.matches(':popover-open'))popup.hidePopover();return;}
    button.focus({preventScroll:true});popup.showPopover();
    const position=()=>{
      const anchor=button.getBoundingClientRect();
      const width=Math.min(360,innerWidth-24);
      popup.style.width=`${width}px`;popup.style.maxHeight=`${innerHeight-24}px`;
      const height=popup.getBoundingClientRect().height;
      const above=anchor.top-height-8;
      const top=above>=12?above:anchor.bottom+8;
      popup.style.left=`${Math.max(12,Math.min(anchor.right-width,innerWidth-width-12))}px`;
      popup.style.top=`${top}px`;popup.style.maxHeight=`${Math.max(80,innerHeight-top-12)}px`;
    };
    position();closeAttachments.current?.focus({preventScroll:true});
    window.addEventListener('resize',position);
    return()=>window.removeEventListener('resize',position);
  },[showAttachments,quiz?.attachments.length]);
  const openSource=async(source:QuizAttachment,page:number)=>{setOpeningSource(true);setSourceError('');try{await api.openQuizSource({fileId:source.fileId,page,label:source.name});setShowAttachments(false);}catch(error){setSourceError(error instanceof Error?error.message:String(error));}finally{setOpeningSource(false);}};
  const toggleAdaptive=async(enabled:boolean)=>{setToggling(true);try{await api.setQuizAdaptive(enabled);}catch(error){onError(error instanceof Error?error.message:String(error));}finally{setToggling(false);}};
  const toggleMode=async()=>{if(!quiz)return;setToggling(true);try{await api.setQuizMode(quiz.adaptiveMode==='ai'?'programmatic':'ai');}catch(error){onError(error instanceof Error?error.message:String(error));}finally{setToggling(false);}};
  return <div className="document-view quiz-document">
    <div className="doc-toolbar drag"><div className="doc-title"><span className="file-glyph small quiz">QUIZ</span><strong>{file.name}</strong></div>
      <div className="doc-actions">
        {quiz&&<label className="qz-switch" title="Let the coach add questions that target what you miss">
          <input type="checkbox" role="switch" checked={quiz.adaptive} disabled={toggling} onChange={event=>void toggleAdaptive(event.target.checked)}/>
          <span className="qz-switch-track" aria-hidden="true"><span/></span>Adaptive
        </label>}
        {quiz&&<label className="qz-switch" title="Programmatic selects bank questions using rules; AI selects or writes questions in the background">
          <input type="checkbox" role="switch" aria-label="AI question selection" checked={quiz.adaptiveMode==='ai'} disabled={toggling} onChange={()=>void toggleMode()}/>
          <span className="qz-switch-track" aria-hidden="true"><span/></span>{quiz.adaptiveMode==='ai'?'AI':'Programmatic'}
        </label>}
        {quiz&&<button ref={attachmentsButton} className="quiet-button" aria-haspopup="dialog" aria-expanded={showAttachments} aria-controls="quiz-attachments" onClick={()=>setShowAttachments(open=>!open)}><Icon name="file" size={14}/>Sources ({quiz.attachments.length})</button>}
        <button className="quiet-button" onClick={()=>void api.saveDocument(file.id,false).catch(error=>onError(error.message))}><Icon name="download" size={14}/>Save copy</button>
      </div>
    </div>
    {quiz&&<div ref={attachmentsPopup} id="quiz-attachments" popover="auto" role="dialog" className="qz-attachments-popup" aria-labelledby="quiz-attachments-title"
      onToggle={event=>{if((event.nativeEvent as ToggleEvent).newState==='closed')setShowAttachments(false);}}>
      <header className="qz-attachments-header"><h2 id="quiz-attachments-title">Quiz sources</h2>
        <button ref={closeAttachments} type="button" className="icon-button" aria-label="Close attachments" onClick={()=>{setShowAttachments(false);attachmentsButton.current?.focus({preventScroll:true});}}><Icon name="close" size={16}/></button>
      </header>
      <div className="qz-attachments-body">
        {quiz.attachments.length?<ul>{quiz.attachments.map(source=><li key={source.fileId}>
          <button type="button" className="qz-attachment-file" disabled={!source.available||openingSource} onClick={()=>void openSource(source,1)}>
            <Icon name="file" size={18}/><span><strong>{source.name}</strong><small>{source.available?`Entire PDF · ${source.indexedPages} ${source.indexedPages===1?'page':'pages'}`:'File not open'}</small></span><Icon name="arrow-right" size={14}/>
          </button>
        </li>)}</ul>:<p>No PDFs attached.</p>}
        {sourceError&&<p className="qz-error" role="alert">{sourceError}</p>}
      </div>
    </div>}
    {quiz?<QuizPanel state={state} onSetMaxQuestions={count=>api.setQuizMaxQuestions(count)} onAnswer={input=>api.answerQuiz(input)} onClose={async()=>onClose()} onOpenSource={source=>api.openQuizSource(source)}/>
      :<div className="unsupported-preview"><h2>{file.name}</h2><button className="button-primary" onClick={()=>void api.selectFile(file.id).catch(error=>onError(error.message))}>Open quiz</button></div>}
  </div>;
}
