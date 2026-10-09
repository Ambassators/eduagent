import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultSettings, type AppEvent, type DesktopAPI, type DocumentInfo, type Settings, type Status, type TranscriptEntry, type WorkspaceState, type ToolActivity, type PDFToolRequest } from '../shared';
import { VoiceSession, type LiveEvent } from './voice';
import DocumentViewer, { MarkdownView } from './DocumentViewer';
import Icon from './Icon';
import { Orb, type OrbTone } from './Orb';
import QuizPanel from './QuizPanel';
import { executePDFViewTool } from './pdf-view-tools';
declare global { interface Window { desktop?: DesktopAPI } }
type Phase = 'idle' | 'starting' | 'listening' | 'thinking' | 'speaking';
const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
const api = () => { if (!window.desktop) throw new Error('Open Codex Voice as a desktop app with npm start.'); return window.desktop; };

export default function App() {
  const [workspace,setWorkspace]=useState<WorkspaceState|null>(null);
  const workspaceRef=useRef(workspace);workspaceRef.current=workspace;
  const [pointerVisible,setPointerVisible]=useState(false);
  const [pane,setPane]=useState<'think'|'transcript'>('think');
  const [thinkMessages,setThinkMessages]=useState<TranscriptEntry[]>([]);
  const [activities,setActivities]=useState<ToolActivity[]>([]);
  const [presentationId,setPresentationId]=useState<string|null>(null);
  const [dropActive,setDropActive]=useState(false);
  const [opening,setOpening]=useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const [sessionOn, setSessionOn] = useState(false);
  const sessionRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [speaker, setSpeaker] = useState(true);
  const speakerRef = useRef(true);
  const [level, setLevel] = useState(0);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const entriesRef=useRef(entries);entriesRef.current=entries;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [loginPending, setLoginPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings>({ ...defaultSettings });
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [backendBusy, setBackendBusy] = useState(false);
  const typedPending = useRef(false);
  const transcriptBottom = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operation = useRef(0);
  const call = useRef<VoiceSession | null>(null);
  const segments = useRef(new Map<string, { entryId: string; text: string }>());
  const group = useRef<{ id: string; role: 'user' | 'assistant'; time: number } | null>(null);
  const lastOutput = useRef(0);
  const changePhase = useCallback((value: Phase) => {
    if (phaseRef.current !== value) { phaseRef.current = value; setPhase(value); }
  }, []);
  const endSession = useCallback(async () => {
    operation.current += 1; sessionRef.current = false; setSessionOn(false);
    call.current?.close(); call.current = null;
    changePhase('idle'); setLevel(0); group.current = null;
    try { await api().stopVoice(); await api().interrupt(); }
    catch (e) { setError(errorMessage(e)); }
  }, [changePhase]);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { const [next,files] = await Promise.all([api().status(),api().workspace()]); setStatus(next); setDraft(next.settings);setWorkspace(files); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  const handleLive = useCallback((event: LiveEvent) => {
    const role = event.type === 'input_transcript.added' ? 'user' : event.type === 'output_transcript.added' ? 'assistant' : null;
    if (role && typeof event.item?.text === 'string' && event.item.id) {
      const key = `${role}:${event.item.id}`, text = event.item.text;
      const previous = segments.current.get(key);
      if (previous?.text === text || !text.trim()) return;
      const time = Date.now();
      if (!previous && (!group.current || group.current.role !== role || time - group.current.time > 5000)) {
        group.current = { id: `live:${crypto.randomUUID()}`, role, time };
      }
      const id = previous?.entryId ?? group.current!.id;
      if (group.current) group.current.time = time;
      segments.current.set(key, { entryId: id, text });
      if (segments.current.size > 20000) segments.current.delete(segments.current.keys().next().value!);
      setEntries(old => {
        const entry = old.find(item => item.id === id);
        const delta = previous ? text.slice(previous.text.length) : text;
        return entry ? old.map(item => item.id === id ? { ...item, text: item.text + delta } : item)
          : [...old, { id, role, text: text.trimStart(), time, final: true }];
      });
      if (role === 'user' && phaseRef.current !== 'speaking') changePhase('thinking');
      return;
    }
    if (event.type === 'error' || event.type === 'session.error') {
      const detail = event.error as { message?: string } | undefined;
      setError(detail?.message ?? String(event.message ?? 'The voice service reported an error.'));
      void endSession();
    }
  }, [changePhase, endSession]);
  const startSession = useCallback(async () => {
    if (call.current) return;
    const token = ++operation.current;
    setError('');setPane('transcript'); changePhase('starting'); sessionRef.current = true; setSessionOn(true);
    mutedRef.current = false; setMuted(false); lastOutput.current = 0; group.current = null;
    const current = new VoiceSession(api(), {
      event: event => { if (token === operation.current) handleLive(event); },
      connected: () => { if (token === operation.current) changePhase('listening'); },
      level: (mic, output) => {
        if (token !== operation.current) return;
        const now = Date.now();
        if (output > 0.035) lastOutput.current = now;
        setLevel(Math.max(mic, output));
        if (now - lastOutput.current < 400) changePhase('speaking');
        else if (phaseRef.current !== 'thinking' || now - (group.current?.time ?? 0) > 2500) changePhase(mutedRef.current ? 'idle' : 'listening');
      },
      error: e => { if (token === operation.current) { setError(errorMessage(e)); void endSession(); } }
    });
    call.current = current; current.muteOutput(!speakerRef.current);
    try {
      await current.start(status?.settings.inputDevice ?? '');
      if (token !== operation.current) { current.close(); return; }
      const available = await navigator.mediaDevices.enumerateDevices();
      if (token === operation.current) setDevices(available.filter(device => device.kind === 'audioinput'));
    } catch (e) {
      if (token !== operation.current) return;
      current.close(); call.current = null; sessionRef.current = false; setSessionOn(false); changePhase('idle');
      setError(errorMessage(e)); await api().stopVoice().catch(() => {});
    }
  }, [status, handleLive, changePhase, endSession]);
  const send = useCallback(async (raw: string) => {
    if (typedPending.current) return;
    const message=raw.trim();typedPending.current=true;setBackendBusy(true);setError('');setPane('think');
    const next=message?[...entriesRef.current,{id:crypto.randomUUID(),role:'user' as const,text:message,time:Date.now(),final:true}]:entriesRef.current;
    if(message){entriesRef.current=next;setEntries(next);setInput('');}
    try { await api().syncTranscript(next);await api().think(message); }
    catch(e){setError(errorMessage(e));}
    finally{typedPending.current=false;setBackendBusy(false);}
  }, []);
  useEffect(()=>{const timer=setTimeout(()=>{void api().syncTranscript(entries).catch(e=>setError(errorMessage(e)));},180);return()=>clearTimeout(timer);},[entries]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(timer);},[notice]);
  useEffect(() => {
    if (!window.desktop) return;
    return window.desktop.onEvent((event: AppEvent) => {
      const p = event.params;
      switch (event.method) {
        case 'workspace/changed':setWorkspace(p.workspace as unknown as WorkspaceState);break;
        case 'workspace/annotations':setWorkspace(old=>old?{...old,annotations:p.annotations as unknown as WorkspaceState['annotations']}:old);break;
        case 'quiz/state':setWorkspace(old=>old?{...old,quiz:p.state as unknown as WorkspaceState['quiz']}:old);break;
        case 'pdf/tool': {
          const request=p.request as unknown as PDFToolRequest;
          void(async()=>{
            try{
              const started=performance.now(),deadline=started+13000;
              let host:HTMLDivElement|undefined;
              while(performance.now()<deadline){
                if(performance.now()-started>250&&workspaceRef.current?.activeId!==request.fileId)throw new Error('The selected PDF changed. Try again.');
                host=[...document.querySelectorAll<HTMLDivElement>('.pdf-scroll')].find(item=>item.dataset.fileId===request.fileId&&Number(item.dataset.revision)===request.revision&&item.querySelector('.pdf-sheet'));
                if(host)break;
                await new Promise(resolve=>setTimeout(resolve,40));
              }
              if(!host)throw new Error('The selected PDF is still loading. Try again in a moment.');
              const result=await executePDFViewTool(host,request);
              await api().resolvePDFTool(request.id,result);
            }catch(error){await api().resolvePDFTool(request.id,null,errorMessage(error)).catch(()=>{});}
          })();break;
        }
        case 'workspace/presentation': {
          const presentation=p.presentation as unknown as NonNullable<WorkspaceState['artifacts']>[number];
          setWorkspace(old=>old?{...old,artifacts:[...old.artifacts.filter(item=>item.id!==presentation.id),presentation]}:old);
          if(presentation.placement==='side')setPresentationId(presentation.id);break;
        }
        case 'appearance/changed':setStatus(old=>old?{...old,darkMode:Boolean(p.darkMode)}:old);break;
        case 'think/state':setWorkspace(old=>old?{...old,thinking:p.state as unknown as WorkspaceState['thinking']}:old);break;
        case 'think/started':setThinkMessages(old=>[...old,{id:String(p.jobId),role:'user',text:String(p.message),time:Date.now(),final:true}]);break;
        case 'think/delta': {
          const id=String(p.itemId);
          setThinkMessages(old=>old.some(item=>item.id===id)?old.map(item=>item.id===id?{...item,text:item.text+String(p.delta??'')}:item):[...old,{id,role:'assistant',text:String(p.delta??''),time:Date.now(),final:false}]);break;
        }
        case 'think/message': {
          const item=p.item as {id:string;text:string};
          setThinkMessages(old=>old.some(entry=>entry.id===item.id)?old.map(entry=>entry.id===item.id?{...entry,text:item.text,final:true}:entry):[...old,{id:item.id,role:'assistant',text:item.text,time:Date.now(),final:true}]);break;
        }
        case 'think/activity': {
          const activity=p.activity as unknown as ToolActivity;
          setActivities(old=>[...old.filter(item=>item.id!==activity.id),activity].slice(-50));break;
        }
        case 'think/completed':case 'think/error':case 'think/contextError':break;
        case 'item/agentMessage/delta': {
          if (sessionRef.current && !typedPending.current) break;
          const id = String(p.itemId);
          setEntries(old => old.some(entry => entry.id === id)
            ? old.map(entry => entry.id === id ? { ...entry, text: entry.text + String(p.delta ?? '') } : entry)
            : [...old, { id, role: 'assistant', text: String(p.delta ?? ''), time: Date.now(), final: false }]); break;
        }
        case 'item/completed': {
          if (sessionRef.current && !typedPending.current) break;
          const item = p.item as { id?: string; type?: string; text?: string } | undefined;
          if (item?.type === 'agentMessage' && item.id && typeof item.text === 'string') {
            setEntries(old => old.some(entry => entry.id === item.id)
              ? old.map(entry => entry.id === item.id ? { ...entry, text: item.text!, final: true } : entry)
              : [...old, { id: item.id!, role: 'assistant', text: item.text!, time: Date.now(), final: true }]);
          } break;
        }
        case 'client/replyCompleted':
          typedPending.current = false; setBackendBusy(false);
          setEntries(old => old.map(entry => ({ ...entry, final: true })));
          if (p.status === 'failed') setError(String(p.message ?? 'Codex could not finish this response. Try again.'));
          if (!sessionRef.current) changePhase('idle'); break;
        case 'thread/realtime/error':
          setError(String(p.message ?? 'Subscription voice could not start.')); void endSession(); break;
        case 'thread/realtime/closed':
          if (sessionRef.current && phaseRef.current !== 'starting') {
            setNotice('The live voice session ended. Start again to reconnect.'); void endSession();
          } break;
        case 'account/login/completed':
          setLoginPending(false);
          if (p.success) void refresh(); else setError(String(p.error ?? 'Sign-in did not complete.')); break;
        case 'account/updated': void refresh(); break;
        case 'client/toolDeclined': setNotice(String(p.message)); break;
        case 'client/disconnected':
          setStatus(old => old ? { ...old, connected: false } : null);
          typedPending.current = false; setBackendBusy(false); setError(String(p.message)); void endSession(); break;
        case 'error': if (p.willRetry !== true) setError(String((p.error as {message?: string})?.message ?? 'Codex reported an error.')); break;
      }
    });
  }, [changePhase, endSession, refresh]);
  useEffect(() => { if(pane==='transcript')transcriptBottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries,pane]);
  useEffect(() => { if(pane==='think')transcriptBottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [thinkMessages,pane]);
  useEffect(() => { if (settingsOpen) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [settingsOpen]);
  useEffect(() => { const close = () => call.current?.close(); window.addEventListener('beforeunload', close); return () => { window.removeEventListener('beforeunload', close); close(); }; }, []);
  function toggleMute() {
    const next = !mutedRef.current; mutedRef.current = next; setMuted(next); call.current?.muteInput(next);
    if (phaseRef.current !== 'speaking') changePhase(next ? 'idle' : 'listening');
  }
  function toggleSpeaker() {
    const next = !speakerRef.current; speakerRef.current = next; setSpeaker(next); call.current?.muteOutput(!next);
  }
  const primary = useCallback(async () => {
    if (sessionRef.current) await endSession();
    else await startSession();
  }, [endSession, startSession]);
  const newChat = useCallback(async () => {
    await endSession();
    try { await api().newConversation(); setEntries([]);entriesRef.current=[];setThinkMessages([]);setActivities([]);setPresentationId(null); segments.current.clear(); group.current = null; setNotice(''); setError('');setWorkspace(await api().workspace()); }
    catch (e) { setError(errorMessage(e)); }
  }, [endSession]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if(!settingsOpen&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='o'){event.preventDefault();void openFiles();return;}
      if (settingsOpen || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return;
      if (event.code === 'Space' && !event.repeat && status?.voiceAvailable && phaseRef.current !== 'starting') {
        event.preventDefault(); if (sessionRef.current) toggleMute(); else void startSession();
      }
      if (event.key === 'Escape') { event.preventDefault(); void endSession(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); void newChat(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [settingsOpen, status, startSession, endSession, newChat, changePhase]);
  async function saveSettings() {
    setSaving(true); setError('');
    try { await endSession(); await api().saveSettings(draft); setSettingsOpen(false); await refresh(); }
    catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }
  const signedIn = status?.account?.type === 'chatgpt' && status.connected;
  const title: Record<Phase, string> = { idle: muted && sessionOn ? 'Take your time.' : 'A little room\nto think aloud.', starting: 'One moment.', listening: 'I’m listening.', thinking: 'I’m listening.', speaking: 'Let’s talk.' };
  const caption: Record<Phase, string> = { idle: muted && sessionOn ? 'Your microphone is muted. Unmute whenever you’re ready.' : 'Bring a question. Follow a thought. See where it goes.', starting: 'Connecting your subscription voice session…', listening: 'Speak naturally. You can interrupt by talking.', thinking: 'Speak naturally. You can interrupt by talking.', speaking: 'Keep talking whenever a thought comes to you.' };
  const buttonLabel = sessionOn ? 'End voice (Esc)' : 'Start a conversation';
  const activeFile=workspace?.files.find(file=>file.id===workspace.activeId);
  const presentation=workspace?.artifacts.find(item=>item.id===presentationId);
  const thinking=workspace?.thinking;
  async function openFiles(){setOpening(true);setError('');try{setWorkspace(await api().openFiles());}catch(e){setError(errorMessage(e));}finally{setOpening(false);}}
  async function dropFiles(event:React.DragEvent){event.preventDefault();setDropActive(false);setOpening(true);try{const paths=[...event.dataTransfer.files].map(file=>api().filePath(file)).filter(Boolean);if(paths.length)setWorkspace(await api().openPaths(paths));}catch(e){setError(errorMessage(e));}finally{setOpening(false);}}
  const contextPercent=Math.min(100,(thinking?.tokens??0)/draft.compactAtTokens*100);
  const showMessages=pane==='think'?thinkMessages:entries;
  const platform=status?.platform??(navigator.userAgent.includes('Mac')?'darwin':'win32');
  const mod=platform==='darwin'?'⌘':'Ctrl ';
  const userTurns=entries.filter(item=>item.role==='user').length;
  const openSettings=()=>{setDraft(status?.settings??defaultSettings);setSettingsOpen(true);};
  const selectFile=(id:string)=>void api().selectFile(id).then(setWorkspace).catch(e=>setError(errorMessage(e)));
  const closeFile=(id:string)=>void api().closeFile(id).then(setWorkspace).catch(e=>setError(errorMessage(e)));
  const fileMeta=(file:DocumentInfo)=>file.dirty?'Edited copy':file.pageCount?`${file.pageCount} ${file.pageCount===1?'page':'pages'}`:file.kind==='binary'?`${Math.max(1,Math.round(file.size/1024))} KB`:file.kind;
  const live=sessionOn&&phase!=='starting';
  const tone:OrbTone=!sessionOn?'idle':phase==='speaking'?'speaking':phase==='thinking'?'capturing':'on';
  const materials:[Settings['transparency'],string][]=platform==='win32'?[['acrylic','Acrylic'],['mica','Mica'],['opaque','Opaque']]:[['acrylic','Glass'],['opaque','Opaque']];
  return <div className={`studio ${status?.darkMode?'dark':'light'} ${status?.settings.transparency??'acrylic'} platform-${platform}`} onDragOver={event=>{event.preventDefault();if(event.dataTransfer.types.includes('Files'))setDropActive(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDropActive(false);}} onDrop={event=>void dropFiles(event)}>
    <div className={`workspace ${presentation?'with-presentation':''}`}>
      <aside className="rail rail-left">
        <div className="rail-top drag"/>
        <button className="open-files" onClick={()=>void openFiles()} disabled={opening}>
          <span className="open-files-icon">{opening?<span className="loading-ring"/>:<Icon name="plus" size={16}/>}</span>
          <strong>{opening?'Opening…':'Open files'}</strong>
          <kbd>{mod}O</kbd>
        </button>
        <div className="rail-section library">
          <div className="file-list">
            {workspace?.files.map(file=><div className={`file-row ${file.id===workspace.activeId?'active':''}`} key={file.id}>
              <button className="file-select" onClick={()=>selectFile(file.id)} aria-current={file.id===workspace.activeId?'true':undefined} title={file.originalPath||file.name}>
                <span className={`file-glyph ${file.kind}`}>{file.extension.slice(1).toUpperCase().slice(0,4)||'—'}</span>
                <span className="file-text"><strong>{file.name}</strong><small>{file.dirty&&<i className="dirty-dot"/>}{fileMeta(file)}</small></span>
              </button>
              <button className="close-file" aria-label={`Close ${file.name}`} title="Close" onClick={()=>closeFile(file.id)}><Icon name="close" size={12}/></button>
            </div>)}
          </div>
        </div>
        {!!workspace?.artifacts.length&&<div className="rail-section artifacts">
          <div className="section-label"><span>On screen</span><span>{workspace.artifacts.length}</span></div>
          <div className="artifact-list">{workspace.artifacts.map(item=><button key={item.id} className={presentationId===item.id?'active':''} onClick={()=>{setPresentationId(item.id);void api().present(item.id,'side').catch(e=>setError(errorMessage(e)));}}><span className="artifact-icon"><Icon name={item.kind==='demo'?'panel':'file'} size={14}/></span><span>{item.title}</span></button>)}</div>
        </div>}
        <div className="rail-bottom">
          <button className="rail-action" onClick={()=>void newChat()}><Icon name="plus" size={15}/>New conversation</button>
          <div className="account">
            <button className="account-settings" title="Open settings" aria-label="Open settings" aria-haspopup="dialog" onClick={openSettings}>
              <span className={`status-dot ${signedIn?'connected':''}`}/>
              <strong title={status?.account?.email}>{loading?'Connecting…':signedIn?status?.account?.email||'Connected':'Signed out'}</strong>
            </button>
            <button className="icon-button" title="Reconnect" disabled={loading} onClick={()=>void refresh()}><Icon name="refresh" size={14}/></button>
          </div>
          {!signedIn&&!loading&&<button className="login-button" disabled={loginPending} onClick={()=>{setLoginPending(true);void api().login().catch(e=>{setLoginPending(false);setError(errorMessage(e));});}}>{loginPending?'Waiting for browser…':'Sign in'}</button>}
        </div>
      </aside>

      <main className="stage document-column">
        <div className="stage-top drag" aria-hidden="true"/>
        <div className="sheet">
          {activeFile?<DocumentViewer key={activeFile.id} file={activeFile} onError={setError} annotations={workspace!.annotations} voice={{tone,label:buttonLabel,disabled:!sessionOn&&(!signedIn||!status?.voiceAvailable||loading),onClick:()=>void primary().catch(e=>setError(errorMessage(e))),onVisible:setPointerVisible}}/>:<div className="welcome">
            <div className="welcome-inner">
              <h1>Open something.<br/><mark>Talk it through.</mark></h1>
              <div className="welcome-actions"><button className="button-primary" onClick={()=>void openFiles()} disabled={opening}><Icon name="folder" size={16}/>Open a file</button></div>
            </div>
          </div>}
          {(error||notice||status?.warning)&&<div className={`toast ${error?'error':''}`} role={error?'alert':'status'}><i/><span>{error||notice||status?.warning}</span><button className="icon-button" aria-label="Dismiss" onClick={()=>{setError('');setNotice('');setStatus(old=>old?{...old,warning:undefined}:old);}}><Icon name="close" size={13}/></button></div>}
        </div>
      </main>

      {presentation&&<section className="stage stage-presentation">
        <div className="stage-top drag"><span className="section-label"><span>{presentation.kind==='demo'?'Interactive demonstration':'On screen'}</span></span></div>
        <div className="sheet presentation-sheet">
          <div className="presentation-heading"><h2 title={presentation.title}>{presentation.title}</h2><div>
            <button className="icon-button" title="Open in a popup" onClick={()=>void api().present(presentation.id,'popup').catch(e=>setError(errorMessage(e)))}><Icon name="popout" size={15}/></button>
            <button className="icon-button" title="Save presentation" onClick={()=>void api().savePresentation(presentation.id).catch(e=>setError(errorMessage(e)))}><Icon name="download" size={15}/></button>
            <button className="icon-button" title="Close side view" onClick={()=>setPresentationId(null)}><Icon name="close" size={15}/></button>
          </div></div>
          {presentation.kind==='demo'?<iframe title={presentation.title} sandbox="allow-scripts" src={`codex-presentation://${presentation.id}/`}/>:<div className="presentation-text"><MarkdownView text={presentation.content}/></div>}
        </div>
      </section>}

      <section className="rail rail-right">
        <div className="rail-top drag"><span/><button className="icon-button" title="Preferences" onClick={openSettings}><Icon name="settings" size={16}/></button></div>
        <div className={`voice-stage ${phase} ${live?'live':''} ${muted?'muted':''}`} style={{'--level':level} as React.CSSProperties} title={caption[phase]}>
          <button className={`mic-button ${tone} ${pointerVisible?'pointing-on-page':''}`} data-tone={tone} title={pointerVisible?'Voice dot is pointing on the PDF':buttonLabel} aria-label={buttonLabel} aria-pressed={sessionOn} disabled={!sessionOn&&(!signedIn||!status?.voiceAvailable||loading)} onClick={()=>void primary().catch(e=>setError(errorMessage(e)))}>
            <span className="halo orb-glow" aria-hidden="true" style={tone==='capturing'?{transform:`scale(${1.08+Math.min(.3,level*3)})`}:undefined}/>
            <span className="face" aria-hidden="true"><Orb tone={tone}/><Icon name={sessionOn?(muted?'mute':'wave'):'mic'} size={30}/></span>
          </button>
          {sessionOn&&<div className="voice-copy"><strong>{muted?'Muted':title[phase].replace('\n',' ')}</strong></div>}
          <div className="voice-controls">
            <button className="round" disabled={!sessionOn} title={muted?'Unmute microphone':'Mute microphone'} aria-label={muted?'Unmute microphone':'Mute microphone'} aria-pressed={muted} onClick={toggleMute}><Icon name={muted?'mute':'mic'} size={15}/></button>
            <button className="round" title={speaker?'Mute voice':'Enable voice'} aria-label={speaker?'Mute voice':'Enable voice'} aria-pressed={!speaker} onClick={toggleSpeaker}><Icon name={speaker?'speaker':'silent'} size={15}/></button>
          </div>
        </div>
        <div className="pane-row">
          <div className="pane-switch" role="tablist" data-pane={pane}>
            <button role="tab" aria-selected={pane==='think'} onClick={()=>setPane('think')}><Icon name="brain" size={15}/>Think</button>
            <button role="tab" aria-selected={pane==='transcript'} onClick={()=>setPane('transcript')}><Icon name="wave" size={14}/>Transcript{!!userTurns&&<span>{userTurns}</span>}</button>
          </div>
        </div>
        {workspace&&<QuizPanel state={workspace.quiz} onAnswer={input=>api().answerQuiz(input)} onToggleAdaptive={enabled=>api().setQuizAdaptive(enabled)} onClose={()=>api().closeQuiz()} onOpenSource={source=>api().openQuizSource(source)}/>}
        <div className="think-status">
          <span/>
          <div>
            {thinking?.busy&&<button className="icon-button" title="Stop Think" onClick={()=>void api().cancelThink().catch(e=>setError(errorMessage(e)))}><Icon name="stop" size={14}/></button>}
            <button className="icon-button" title="Compact Think context" disabled={!signedIn||thinking?.compacting} onClick={()=>void api().compact().catch(e=>setError(errorMessage(e)))}><Icon name="compact" size={15}/></button>
            <button className="icon-button" title="Export voice transcript" disabled={!entries.length} onClick={()=>void api().exportTranscript(entries).catch(e=>setError(errorMessage(e)))}><Icon name="export" size={15}/></button>
          </div>
        </div>
        <div className="agent-scroll" aria-live="polite">
          {!showMessages.length&&pane==='think'&&<div className="suggestions">{['Summarize this file','Make it interactive','Research this on the web'].map(suggestion=><button key={suggestion} disabled={!signedIn} onClick={()=>void send(suggestion)}><span>{suggestion}</span><Icon name="arrow-right" size={14}/></button>)}</div>}
          {showMessages.map(entry=><article className={`message ${entry.role} ${pane}`} key={entry.id}>
            {entry.role==='assistant'&&<div className="message-meta"><span>{pane==='think'?'Think':'Voice'}</span>{!entry.final&&<i className="writing-dot"/>}</div>}
            {pane==='think'&&entry.role==='assistant'?<MarkdownView text={entry.text}/>:<p className="message-body">{entry.text}</p>}
          </article>)}
          {status?.settings.debug===true&&pane==='think'&&!!activities.length&&<details className="tool-activity">
            <summary><span>Tool activity</span><span>{activities.length}</span></summary>
            {activities.slice(-12).map(activity=><div key={activity.id}><i className={activity.status==='failed'?'failed':activity.status==='running'&&thinking?.busy?'busy':'complete'}/><span>{activity.name.replaceAll('_',' ')}<small>{activity.detail}</small></span>{activity.status==='completed'&&<Icon name="check" size={12}/>}</div>)}
          </details>}
          <div ref={transcriptBottom}/>
        </div>
        <div className={`context-meter ${contextPercent>80?'high':''}`} title={`Context ${((thinking?.tokens??0)/1000).toFixed(1)}k of ${(draft.compactAtTokens/1000).toFixed(0)}k`}><i><b style={{width:`${contextPercent}%`}}/></i></div>
        <form className="composer" onSubmit={event=>{event.preventDefault();void send(input);}}>
          <label className="visually-hidden" htmlFor="message">Optional message for Think</label>
          <textarea id="message" rows={2} placeholder="Ask Think…" value={input} maxLength={32000} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(signedIn&&!backendBusy)void send(input);}}}/>
          <div className="composer-foot">
            <span className="context-chip" title={activeFile?.name}>{activeFile&&<><Icon name="file" size={12}/>{activeFile.name}</>}</span>
            <button type="submit" className="think-button" disabled={!signedIn||backendBusy||(thinking?.queued??0)>=8}><Icon name="brain" size={14}/>{backendBusy?'Sending…':'Think'}<kbd>↵</kbd></button>
          </div>
        </form>
      </section>
    </div>

    {dropActive&&<div className="drop-overlay"><span className="drop-icon"><Icon name="folder" size={28}/></span><h2>Drop to open</h2></div>}

    <dialog ref={dialogRef} className="settings-dialog" onCancel={()=>setSettingsOpen(false)}>
      <header className="dialog-header"><h2>Preferences</h2><button className="icon-button" title="Close preferences" onClick={()=>setSettingsOpen(false)}><Icon name="close" size={18}/></button></header>
      <section className="settings-section"><h3>Window</h3>
        <div className="material-picker" role="radiogroup" aria-label="Window background">{materials.map(([value,label])=><label key={value} className={`material-option ${draft.transparency===value?'selected':''}`}>
          <input type="radio" className="visually-hidden" name="material" value={value} checked={draft.transparency===value} onChange={()=>setDraft({...draft,transparency:value})}/>
          <span className={`material-swatch ${value}`}><i/><b/><i/></span><strong>{label}</strong>
        </label>)}</div>
        <div className="settings-grid">
          <div className="field"><span>Appearance</span><div className="segmented" role="radiogroup" aria-label="Appearance">{([['system','System'],['light','Light'],['dark','Dark']] as const).map(([value,label])=><button type="button" role="radio" aria-checked={draft.theme===value} key={value} onClick={()=>setDraft({...draft,theme:value})}>{label}</button>)}</div></div>
          <label className="field"><span>Demonstrations</span><select value={draft.demoPlacement} onChange={event=>setDraft({...draft,demoPlacement:event.target.value as Settings['demoPlacement']})}><option value="side">Side view by default</option><option value="popup">Popup by default</option></select></label>
        </div>
      </section>
      <section className="settings-section"><h3>Think</h3>
        <div className="settings-grid">
          <label className="field"><span>Backend model</span><select value={draft.model} onChange={event=>setDraft({...draft,model:event.target.value})}><option value="">Codex default</option>{draft.model&&!status?.models.some(model=>model.model===draft.model)&&<option value={draft.model}>{draft.model==='gpt-6.1-sol'?'GPT-6.1 Sol':draft.model}</option>}{status?.models.map(model=><option key={model.model} value={model.model}>{model.displayName}</option>)}</select></label>
          <label className="field"><span>Thinking effort</span><select value={draft.reasoningEffort} onChange={event=>setDraft({...draft,reasoningEffort:event.target.value as Settings['reasoningEffort']})}>{['low','medium','high','xhigh'].map(effort=><option key={effort} value={effort}>{effort==='xhigh'?'Extra high':effort.charAt(0).toUpperCase()+effort.slice(1)}</option>)}</select></label>
          <label className="field"><span>Compact context at</span><input type="number" min={8000} max={200000} step={4000} value={draft.compactAtTokens} onChange={event=>setDraft({...draft,compactAtTokens:Number(event.target.value)})}/></label>
          <label className="check-setting"><input type="checkbox" checked={draft.autoCompact} onChange={event=>setDraft({...draft,autoCompact:event.target.checked})}/><span>Auto compact</span></label>
          <label className="check-setting"><input type="checkbox" checked={draft.priority} onChange={event=>setDraft({...draft,priority:event.target.checked})}/><span>Fast / Priority</span></label>
        </div>
      </section>
      <section className="settings-section"><h3>Voice</h3>
        <div className="settings-grid">
          <label className="field"><span>Voice</span><select value={draft.voice} onChange={event=>setDraft({...draft,voice:event.target.value})}><option value="">Service default</option>{status?.voices.map(voice=><option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>
          <label className="field"><span>Microphone</span><select value={draft.inputDevice} onChange={event=>setDraft({...draft,inputDevice:event.target.value})}><option value="">System default</option>{devices.filter(device=>device.deviceId&&device.deviceId!=='default').map(device=><option key={device.deviceId} value={device.deviceId}>{device.label||'Microphone'}</option>)}</select></label>
        </div>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.agentTools} onChange={event=>setDraft({...draft,agentTools:event.target.checked})}/><span>Voice agent tools<small>Highlight, point, place PDF content, and manage quizzes directly.</small></span></label>
        <label className="field wide"><span>Voice instructions</span><textarea rows={4} maxLength={8000} value={draft.prompt} onChange={event=>setDraft({...draft,prompt:event.target.value})}/></label>
      </section>
      <details className="settings-section advanced"><summary>Advanced</summary>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.debug} onChange={event=>setDraft({...draft,debug:event.target.checked})}/><span>Debug mode<small>Show tool activity in the Think conversation.</small></span></label>
        <label className="field wide"><span>Codex executable</span><input value={draft.codexPath} placeholder="Use bundled Codex" onChange={event=>setDraft({...draft,codexPath:event.target.value})}/></label>
      </details>
      {error&&<p className="dialog-error" role="alert">{error}</p>}
      <footer className="dialog-footer"><button className="button-secondary" onClick={()=>setSettingsOpen(false)}>Cancel</button><button className="button-primary" disabled={saving} onClick={()=>void saveSettings()}>{saving?'Saving…':'Save'}</button></footer>
    </dialog>
  </div>;
}
