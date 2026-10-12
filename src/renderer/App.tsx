import BrowserPanel from './BrowserPanel';
import type { BrowserState } from '../browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultSettings, type AppEvent, type DesktopAPI, type DocumentInfo, type Settings, type Status, type TranscriptEntry, type WorkspaceState, type ToolActivity, type PDFToolRequest, type DebugLog, type SavedChat, type ChatSummary } from '../shared';
import { VoiceSession, type LiveEvent } from './voice';
import { CaptionGroups, EchoFilter } from './voice-input';
import { pointerContext } from './pointer-context';
import DocumentViewer, { MarkdownView } from './DocumentViewer';
import GlassTeXEditor from './GlassTeXEditor';
import { flushTeX } from './tex-persistence';
import Icon from './Icon';
import { Orb, VoiceGlyph, type OrbTone } from './Orb';
import QuizPanel from './QuizPanel';
import { ThinkOrb, type ThinkJob } from './ThinkOrb';
import { executePDFViewTool } from './pdf-view-tools';
import ResizeHandle, { readPaneSizes, writePaneSizes, type PaneSizes } from './ResizeHandle';
import { isRenderActive } from './render-activity';
import { LowPowerContext } from './LowPowerContext';
declare global { interface Window { desktop?: DesktopAPI } }
type Phase = 'idle' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'standby';
const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
const LOGS_KEY='codex-voice:logs';
const standbyExperiments = (settings: Settings) => ({ catchUp: settings.voiceCatchUp, wakeMs: settings.standbyWakeMs, falseWakeSeconds: settings.standbyFalseWakeSeconds });
const readLogsPref=()=>{try{return localStorage.getItem(LOGS_KEY)==='1';}catch{return false;}};
const logTime=(time:number)=>new Date(time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
type TimelineItem={kind:'message';entry:TranscriptEntry;source:'voice'|'think'}|{kind:'log';log:DebugLog};
type ChatMessage={entry:TranscriptEntry;source:'voice'|'think'};
/** Spoken and typed turns plus Think's answers, in time order. Think's copy of each request is skipped; it already shows as the user's turn. */
const chatMessages=(entries:TranscriptEntry[],think:TranscriptEntry[]):ChatMessage[]=>[
  ...entries.map(entry=>({entry,source:'voice' as const})),
  ...think.filter(entry=>entry.role==='assistant').map(entry=>({entry,source:'think' as const}))
].sort((a,b)=>a.entry.time-b.entry.time);
const chatTitle=(entries:TranscriptEntry[],think:TranscriptEntry[])=>{
  const first=entries.find(entry=>entry.role==='user'&&entry.text.trim())??entries.find(entry=>entry.text.trim())??think.find(entry=>entry.text.trim());
  const line=first?.text.trim().replace(/\s+/g,' ')??'';
  return line?line.length>80?`${line.slice(0,80)}…`:line:'Untitled chat';
};
const chatDate=(time:number)=>new Date(time).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const api = () => { if (!window.desktop) throw new Error('Open Codex Voice as a desktop app with npm start.'); return window.desktop; };

export default function App() {
  const [browserState,setBrowserState]=useState<BrowserState|null>(null);
  const [browserVisible,setBrowserVisible]=useState(false);
  const browserCount=useRef(0);
  const [workspace,setWorkspace]=useState<WorkspaceState|null>(null);
  const [texSidebar,setTeXSidebar]=useState<HTMLDivElement|null>(null);
  const workspaceRef=useRef(workspace);workspaceRef.current=workspace;
  const [pointerVisible,setPointerVisible]=useState(false);
  const [logsOn,setLogsOn]=useState(readLogsPref);
  const [paneSizes,setPaneSizes]=useState(readPaneSizes);
  const resizePane=(key:keyof PaneSizes)=>(size:number|undefined)=>setPaneSizes(old=>{const next={...old,[key]:size};writePaneSizes(next);return next;});
  const px=(size?:number)=>size===undefined?undefined:`${size}px`;
  const logsOnRef=useRef(logsOn);logsOnRef.current=logsOn;
  // Logs are always collected, but only copied into state while visible so they do not re-render the app.
  const logBuffer=useRef<DebugLog[]>([]);
  const [logs,setLogs]=useState<DebugLog[]>([]);
  const toggleLogs=(on:boolean)=>{setLogsOn(on);if(on)setLogs(logBuffer.current.slice());try{localStorage.setItem(LOGS_KEY,on?'1':'0');}catch{}};
  const [thinkMessages,setThinkMessages]=useState<TranscriptEntry[]>([]);
  const thinkMessagesRef=useRef(thinkMessages);thinkMessagesRef.current=thinkMessages;
  // Every chat is saved as it goes, so starting a new one never loses the old one.
  const chat=useRef({id:crypto.randomUUID(),created:Date.now()});
  const [historyOpen,setHistoryOpen]=useState(false);
  const [pastChats,setPastChats]=useState<ChatSummary[]>([]);
  const [viewingChat,setViewingChat]=useState<SavedChat|null>(null);
  const historyRef=useRef<HTMLDialogElement>(null);
  const [activities,setActivities]=useState<ToolActivity[]>([]);
  const [thinkJob,setThinkJob]=useState<ThinkJob|null>(null);
  const [spitting,setSpitting]=useState(false);
  const spitTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  // The big orb gulps as it spits out the mini orb.
  const spit=useCallback(()=>{clearTimeout(spitTimer.current);setSpitting(true);spitTimer.current=setTimeout(()=>setSpitting(false),450);},[]);
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
  const voiceStage = useRef<HTMLDivElement>(null);
  const visualLevel = useRef(0);
  const showLevel = useCallback((value: number) => {
    if (!isRenderActive()) return;
    const next = Math.round(value * 100) / 100;
    if (next === visualLevel.current) return;
    visualLevel.current = next;
    voiceStage.current?.style.setProperty('--level', String(next));
  }, []);
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
  const echo = useRef(new EchoFilter());
  const groups = useRef(new CaptionGroups());
  const lastOutput = useRef(0);
  /** Bridge or Think work in flight; standby waits so results can still be spoken. */
  const backendWorking = useRef(false);
  const changePhase = useCallback((value: Phase) => {
    if (phaseRef.current !== value) { phaseRef.current = value; setPhase(value); }
  }, []);
  const endSession = useCallback(async () => {
    operation.current += 1; sessionRef.current = false; setSessionOn(false);
    call.current?.close(); call.current = null;
    changePhase('idle'); showLevel(0); groups.current.reset();
    try { await api().stopVoice(); await api().interrupt(); }
    catch (e) { setError(errorMessage(e)); }
  }, [changePhase, showLevel]);
  const refresh = useCallback(async (quiet = false) => {
    setLoading(true); if (!quiet) setError('');
    try { const [next,files] = await Promise.all([api().status(),api().workspace()]); setStatus(next); setDraft(next.settings);setWorkspace(files);setBrowserState(await api().browserState()); }
    catch (e) { if (!quiet) setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  const handleLive = useCallback((event: LiveEvent) => {
    const role = event.type === 'input_transcript.added' ? 'user' : event.type === 'output_transcript.added' ? 'assistant' : null;
    if (role === 'user' && mutedRef.current) return;
    if (role && typeof event.item?.text === 'string' && event.item.id) {
      const key = `${role}:${event.item.id}`, text = event.item.text;
      const previous = segments.current.get(key);
      if (previous?.text === text || !text.trim() || previous?.entryId === '') return;
      const time = Date.now();
      if (role === 'assistant') echo.current.heard(event.item.id, text, time);
      else if (echo.current.isEcho(text, time)) {
        // Assistant speech must never appear as the user's words; withdraw any part already shown.
        segments.current.set(key, { entryId: '', text });
        if (previous) setEntries(old => old.flatMap(item => {
          if (item.id !== previous.entryId) return [item];
          const rest = item.text.replace(previous.text.trimStart(), '');
          return rest.trim() ? [{ ...item, text: rest }] : [];
        }));
        return;
      }
      const id = previous?.entryId ?? groups.current.pick(role, time, () => `live:${crypto.randomUUID()}`);
      if (previous) groups.current.touch(role, id, time);
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
    setError(''); changePhase('starting'); sessionRef.current = true; setSessionOn(true);
    mutedRef.current = false; setMuted(false); lastOutput.current = 0; groups.current.reset();
    const current = new VoiceSession(api(), {
      event: event => { if (token === operation.current) handleLive(event); },
      connected: () => { if (token === operation.current) changePhase(mutedRef.current ? 'idle' : 'listening'); },
      standby: asleep => { if (token === operation.current) changePhase(asleep ? 'standby' : 'starting'); },
      speech: () => { if (token === operation.current) void api().pointer(pointerContext()).catch(() => {}); },
      level: (mic, output) => {
        if (token !== operation.current) return;
        if (phaseRef.current === 'standby' || phaseRef.current === 'starting') { showLevel(mic); return; }
        const now = Date.now();
        if (output > 0.035) lastOutput.current = now;
        showLevel(Math.max(mic, output));
        if (now - lastOutput.current < 400) changePhase('speaking');
        else if (phaseRef.current !== 'thinking' || now - groups.current.last > 2500) changePhase(mutedRef.current ? 'idle' : 'listening');
      },
      error: e => { if (token === operation.current) { setError(errorMessage(e)); void endSession(); } }
    }, () => !typedPending.current && !backendWorking.current && (phaseRef.current === 'listening' || phaseRef.current === 'idle'));
    call.current = current; current.muteOutput(!speakerRef.current);
    current.setStandby(status?.settings.standbyAfterSeconds ?? 0);
    if (status) current.setExperiments(standbyExperiments(status.settings));
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
  }, [status, handleLive, changePhase, endSession, showLevel]);
  const send = useCallback(async (raw: string) => {
    if (typedPending.current) return;
    const message=raw.trim();typedPending.current=true;setBackendBusy(true);setError('');
    const next=message?[...entriesRef.current,{id:crypto.randomUUID(),role:'user' as const,text:message,time:Date.now(),final:true}]:entriesRef.current;
    if(message){entriesRef.current=next;setEntries(next);setInput('');}
    try { await api().syncTranscript(next);await api().think(message); }
    catch(e){setError(errorMessage(e));}
    finally{typedPending.current=false;setBackendBusy(false);}
  }, []);
  useEffect(()=>{const timer=setTimeout(()=>{void api().syncTranscript(entries).catch(e=>setError(errorMessage(e)));},180);return()=>clearTimeout(timer);},[entries]);
  const saveChat=useCallback(async()=>{
    const entries=entriesRef.current,think=thinkMessagesRef.current;
    if(!entries.length&&!think.length)return;
    await api().saveChat({...chat.current,title:chatTitle(entries,think),updated:Date.now(),entries,think});
  },[]);
  useEffect(()=>{const timer=setTimeout(()=>{void saveChat().catch(e=>setError(errorMessage(e)));},800);return()=>clearTimeout(timer);},[entries,thinkMessages,saveChat]);
  useEffect(()=>{const save=()=>void saveChat().catch(()=>{});window.addEventListener('beforeunload',save);return()=>window.removeEventListener('beforeunload',save);},[saveChat]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(timer);},[notice]);
  useEffect(() => {
    if (!window.desktop) return;
    return window.desktop.onEvent((event: AppEvent) => {
      const p = event.params;
      switch (event.method) {
        case 'browser/state': { const state=p.state as unknown as BrowserState;setBrowserState(state);if(state.tabs.length>browserCount.current)void flushTeX().then(()=>setBrowserVisible(true)).catch(e=>setError(errorMessage(e)));browserCount.current=state.tabs.length;break; }
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
        case 'think/state':{const state=p.state as {busy?:boolean;delegating?:boolean;queued?:number};backendWorking.current=!!(state.busy||state.delegating||state.queued);}setWorkspace(old=>old?{...old,thinking:p.state as unknown as WorkspaceState['thinking']}:old);break;
        case 'think/started':setThinkJob({id:String(p.jobId),message:String(p.message??''),startedAt:Date.now()});setThinkMessages(old=>[...old,{id:String(p.jobId),role:'user',text:String(p.message),time:Date.now(),final:true}]);break;
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
        case 'debug/log': {
          const log=p.log as unknown as DebugLog,buffer=logBuffer.current,index=buffer.findIndex(item=>item.id===log.id);
          // A tool or turn reports again when it finishes; update its line in place and keep when it started.
          if(index>=0)buffer[index]={...log,time:buffer[index].time};else{buffer.push(log);if(buffer.length>600)buffer.splice(0,buffer.length-600);}
          if(logsOnRef.current)setLogs(buffer.slice());break;
        }
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
          // Standby closes the live session on purpose; it reconnects when the user speaks.
          if (sessionRef.current && phaseRef.current !== 'starting' && phaseRef.current !== 'standby') {
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
  useEffect(() => { call.current?.setStandby(status?.settings.standbyAfterSeconds ?? 0); }, [status?.settings.standbyAfterSeconds]);
  useEffect(() => { if (status) call.current?.setExperiments(standbyExperiments(status.settings)); }, [status]);
  useEffect(() => { if (isRenderActive()) transcriptBottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries,thinkMessages,logs]);
  useEffect(() => { if (settingsOpen) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [settingsOpen]);
  useEffect(() => { if (historyOpen) historyRef.current?.showModal(); else historyRef.current?.close(); }, [historyOpen]);
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
  // Debug logs carry over: they record what the app did, not one chat's content.
  const newChat = useCallback(async () => {
    await endSession();
    try { await saveChat(); await api().newConversation(); chat.current={id:crypto.randomUUID(),created:Date.now()}; setEntries([]);entriesRef.current=[];setThinkMessages([]);thinkMessagesRef.current=[];setActivities([]);setThinkJob(null);setPresentationId(null); segments.current.clear(); echo.current.clear(); groups.current.reset(); setNotice(''); setError('');setWorkspace(await api().workspace()); }
    catch (e) { setError(errorMessage(e)); }
  }, [endSession, saveChat]);
  const openHistory=useCallback(async()=>{
    setViewingChat(null);setHistoryOpen(true);
    try{await saveChat();setPastChats(await api().listChats());}catch(e){setError(errorMessage(e));}
  },[saveChat]);
  const viewChat=(id:string)=>void api().loadChat(id).then(setViewingChat).catch(e=>setError(errorMessage(e)));
  const deleteChat=(id:string)=>void api().deleteChat(id).then(()=>{setPastChats(old=>old.filter(item=>item.id!==id));setViewingChat(old=>old?.id===id?null:old);}).catch(e=>setError(errorMessage(e)));
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if(!settingsOpen&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='o'){event.preventDefault();void openFiles();return;}
      if (settingsOpen || historyOpen || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return;
      if (event.code === 'Space' && !event.repeat && status?.voiceAvailable && phaseRef.current !== 'starting') {
        event.preventDefault(); if (sessionRef.current) toggleMute(); else void startSession();
      }
      if (event.key === 'Escape') { event.preventDefault(); void endSession(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); void newChat(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [settingsOpen, historyOpen, status, startSession, endSession, newChat, changePhase]);
  async function saveSettings() {
    setSaving(true); setError('');
    try { await endSession(); await api().saveSettings(draft); setSettingsOpen(false); await refresh(); }
    catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }
  const signedIn = status?.account?.type === 'chatgpt' && status.connected;
  const offline = !status?.connected;
  const accountState = signedIn ? 'online' : loading ? 'connecting' : offline ? 'offline' : 'signed-out';
  const accountLabel = { online: status?.account?.name || status?.account?.email || 'Connected', connecting: status ? 'Reconnecting…' : 'Connecting…', offline: 'Offline', 'signed-out': 'Signed out' }[accountState];
  // With no reconnect button, retry on our own: 2s, 4s, 8s… capped at 30s.
  const reconnectAttempts = useRef(0);
  useEffect(() => {
    if (accountState !== 'offline') { if (accountState === 'online') reconnectAttempts.current = 0; return; }
    const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempts.current++);
    const timer = setTimeout(() => void refresh(true), delay);
    return () => clearTimeout(timer);
  }, [accountState, refresh]);
  const title: Record<Phase, string> = { idle: muted && sessionOn ? 'Take your time.' : 'A little room\nto think aloud.', starting: 'One moment.', standby: 'Standing by.', listening: 'I’m listening.', thinking: 'I’m listening.', speaking: 'Let’s talk.' };
  const caption: Record<Phase, string> = { idle: muted && sessionOn ? 'Your microphone is muted. Unmute whenever you’re ready.' : 'Bring a question. Follow a thought. See where it goes.', starting: 'Connecting your subscription voice session…', standby: 'Voice is paused to save usage. Start talking and it reconnects.', listening: 'Speak naturally. You can interrupt by talking.', thinking: 'Speak naturally. You can interrupt by talking.', speaking: 'Keep talking whenever a thought comes to you.' };
  const buttonLabel = sessionOn ? 'End voice (Esc)' : 'Start a conversation';
  const activeFile=workspace?.files.find(file=>file.id===workspace.activeId);
  const presentation=workspace?.artifacts.find(item=>item.id===presentationId);
  const quizOpen=!!workspace?.quiz.quiz;
  const thinking=workspace?.thinking;
  const lastThink=thinkMessages[thinkMessages.length-1];
  const thinkPreview=lastThink?.role==='assistant'&&!lastThink.final?lastThink.text:'';
  async function openFiles(){setBrowserVisible(false);setOpening(true);setError('');try{await flushTeX();setWorkspace(await api().openFiles());}catch(e){setError(errorMessage(e));}finally{setOpening(false);}}
  async function dropFiles(event:React.DragEvent){event.preventDefault();setDropActive(false);setOpening(true);try{const paths=[...event.dataTransfer.files].map(file=>api().filePath(file)).filter(Boolean);await flushTeX();if(paths.length)setWorkspace(await api().openPaths(paths));}catch(e){setError(errorMessage(e));}finally{setOpening(false);}}
  const contextPercent=Math.min(100,(thinking?.tokens??0)/draft.compactAtTokens*100);
  // One timeline: spoken and typed turns, Think's answers, and (with Logs on) what ran in between.
  // Think's own copy of each request is skipped; the request already shows as the user's turn or as a route log.
  const timeline:TimelineItem[]=[
    ...chatMessages(entries,thinkMessages).map(item=>({kind:'message' as const,...item})),
    ...(logsOn?logs.map(log=>({kind:'log' as const,log})):[])
  ].sort((a,b)=>(a.kind==='message'?a.entry.time:a.log.time)-(b.kind==='message'?b.entry.time:b.log.time));
  const hasMessages=entries.length>0||thinkMessages.length>0;
  const platform=status?.platform??(navigator.userAgent.includes('Mac')?'darwin':'win32');
  const mod=platform==='darwin'?'⌘':'Ctrl ';
  const openSettings=()=>{setDraft(status?.settings??defaultSettings);setSettingsOpen(true);};
  const selectFile=(id:string)=>void flushTeX().then(()=>{setBrowserVisible(false);return api().selectFile(id);}).then(setWorkspace).catch(e=>setError(errorMessage(e)));
  const closeFile=(id:string)=>void flushTeX(id).then(()=>api().closeFile(id)).then(setWorkspace).catch(e=>setError(errorMessage(e)));
  const fileMeta=(file:DocumentInfo)=>file.dirty?'Edited copy':file.pageCount?`${file.pageCount} ${file.pageCount===1?'page':'pages'}`:file.kind==='binary'?`${Math.max(1,Math.round(file.size/1024))} KB`:file.kind;
  const live=sessionOn&&phase!=='starting';
  const tone:OrbTone=!sessionOn||phase==='standby'?'idle':phase==='starting'?'connecting':phase==='speaking'?'speaking':phase==='thinking'?'capturing':'on';
  const materials:[Settings['transparency'],string][]=platform==='win32'?[['acrylic','Acrylic'],['mica','Mica'],['opaque','Opaque']]:[['acrylic','Glass'],['opaque','Opaque']];
  return <LowPowerContext.Provider value={status?.settings.lowPowerMode ?? false}><div className={`studio ${status?.darkMode?'dark':'light'} ${status?.settings.transparency??'acrylic'} platform-${platform}`} onDragOver={event=>{event.preventDefault();if(event.dataTransfer.types.includes('Files'))setDropActive(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDropActive(false);}} onDrop={event=>void dropFiles(event)}>
    <div className={`workspace ${presentation||quizOpen?'with-presentation':''} ${!browserVisible&&activeFile?.kind==='tex'?'with-tex-document':''}`} style={{'--left-w':px(paneSizes.left),'--right-w':px(paneSizes.right),'--present-w':px(paneSizes.present),'--tex-h':px(paneSizes.tex)} as React.CSSProperties}>
      <aside className="rail rail-left">
        <ResizeHandle edge="right" min={200} shrinks=".document-column" keep={340} label="Resize sidebar" onResize={resizePane('left')}/>
        <div className="rail-top drag"/>
        <button className="open-files" onClick={()=>void openFiles()} disabled={opening}>
          <span className="open-files-icon">{opening?<span className="loading-ring"/>:<Icon name="plus" size={16}/>}</span>
          <strong>{opening?'Opening…':'Open files'}</strong>
          <kbd>{mod}O</kbd>
        </button>
        <button className="rail-action" onClick={()=>void flushTeX().then(()=>{setBrowserVisible(true);if(!browserState?.tabs.length)return api().browserOpen();}).catch(e=>setError(errorMessage(e)))}><Icon name="globe" size={15}/>Browser<span>{browserState?.tabs.length || ''}</span></button>
        {browserVisible&&<button className="rail-action" onClick={()=>setBrowserVisible(false)}><Icon name="file" size={15}/>Documents</button>}
        <div className={`rail-library-stack ${!browserVisible&&activeFile?.kind==='tex'?'with-tex':''}`}>
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
        {!browserVisible&&activeFile?.kind==='tex'&&<div className="rail-tex-slot"><ResizeHandle edge="top" min={160} shrinks=".rail-library-stack > .library" keep={60} label="Resize GlassTeX panel" onResize={resizePane('tex')}/><div className="rail-tex-portal" ref={setTeXSidebar}/></div>}
        </div>
        {!!workspace?.artifacts.length&&<div className="rail-section artifacts">
          <div className="section-label"><span>On screen</span><span>{workspace.artifacts.length}</span></div>
          <div className="artifact-list">{workspace.artifacts.map(item=><button key={item.id} className={presentationId===item.id?'active':''} onClick={()=>{setPresentationId(item.id);void api().present(item.id,'side').catch(e=>setError(errorMessage(e)));}}><span className="artifact-icon"><Icon name={item.kind==='demo'?'panel':'file'} size={14}/></span><span>{item.title}</span></button>)}</div>
        </div>}
        <div className="rail-bottom">
          <button className="rail-action" onClick={()=>void newChat()}><Icon name="plus" size={15}/>New conversation</button>
          <div className={`account ${accountState}`}>
            <button className="account-settings" title="Open settings" aria-label={`${accountLabel}. Open settings`} aria-haspopup="dialog" onClick={openSettings}>
              <strong title={status?.account?.email} aria-live="polite">{accountLabel}</strong>
            </button>
          </div>
          {accountState==='signed-out'&&<button className="login-button" disabled={loginPending} onClick={()=>{setLoginPending(true);void api().login().catch(e=>{setLoginPending(false);setError(errorMessage(e));});}}>{loginPending?'Waiting for browser…':'Sign in'}</button>}
        </div>
      </aside>

      <main className="stage document-column">
        {!browserVisible&&!activeFile&&<div className="stage-top drag" aria-hidden="true"/>}
        <div className="sheet">
          {browserVisible?<BrowserPanel state={browserState} blocked={settingsOpen||dropActive||!!error||!!notice||!!status?.warning} onError={setError}/>:activeFile?activeFile.kind==='tex'?<GlassTeXEditor key={activeFile.id} file={activeFile} sidebar={texSidebar} onError={setError} onOpenFiles={()=>void openFiles()}/>:<DocumentViewer key={activeFile.id} file={activeFile} onError={setError} annotations={workspace!.annotations} voice={{tone,label:buttonLabel,disabled:!sessionOn&&(!signedIn||!status?.voiceAvailable||loading),onClick:()=>void primary().catch(e=>setError(errorMessage(e))),onVisible:setPointerVisible}}/>:<div className="welcome">
            <div className="welcome-inner">
              <h1>Open something.<br/><mark>Talk it through.</mark></h1>
              <div className="welcome-actions"><button className="button-primary" onClick={()=>void openFiles()} disabled={opening}><Icon name="folder" size={16}/>Open a file</button></div>
            </div>
          </div>}
          {(error||notice||status?.warning)&&<div className={`toast ${error?'error':''}`} role={error?'alert':'status'}><i/><span>{error||notice||status?.warning}</span><button className="icon-button" aria-label="Dismiss" onClick={()=>{setError('');setNotice('');setStatus(old=>old?{...old,warning:undefined}:old);}}><Icon name="close" size={13}/></button></div>}
        </div>
      </main>

      {(presentation||quizOpen)&&<section className="stage stage-presentation">
        <ResizeHandle edge="left" min={280} shrinks=".document-column" keep={340} label="Resize side view" onResize={resizePane('present')}/>
        <div className="stage-top drag"><span className="section-label"><span>{presentation?presentation.kind==='demo'?'Interactive demonstration':'On screen':'Practice'}</span></span></div>
        {presentation&&<div className="sheet presentation-sheet">
          <div className="presentation-heading"><h2 title={presentation.title}>{presentation.title}</h2><div>
            <button className="icon-button" title="Open in a popup" onClick={()=>void api().present(presentation.id,'popup').catch(e=>setError(errorMessage(e)))}><Icon name="popout" size={15}/></button>
            <button className="icon-button" title="Save presentation" onClick={()=>void api().savePresentation(presentation.id).catch(e=>setError(errorMessage(e)))}><Icon name="download" size={15}/></button>
            <button className="icon-button" title="Close side view" onClick={()=>setPresentationId(null)}><Icon name="close" size={15}/></button>
          </div></div>
          {presentation.kind==='demo'?<iframe title={presentation.title} sandbox="allow-scripts" src={`codex-presentation://${presentation.id}/`}/>:<div className="presentation-text"><MarkdownView text={presentation.content}/></div>}
        </div>}
        {quizOpen&&<div className={`quiz-side ${presentation?'with-presentation':''}`}><QuizPanel state={workspace!.quiz} onAnswer={input=>api().answerQuiz(input)} onToggleAdaptive={enabled=>api().setQuizAdaptive(enabled)} onClose={()=>api().closeQuiz()} onSkipFollowUp={()=>api().skipQuizFollowUp()} onOpenSource={source=>api().openQuizSource(source)}/></div>}
      </section>}

      <section className="rail rail-right">
        <ResizeHandle edge="left" min={280} shrinks=".document-column" keep={340} label="Resize assistant panel" onResize={resizePane('right')}/>
        <div className="rail-top drag"><span/><button className="icon-button" title="Preferences" onClick={openSettings}><Icon name="settings" size={16}/></button></div>
        <div ref={voiceStage} className={`voice-stage ${phase} ${live?'live':''} ${muted?'muted':''}`} title={caption[phase]}>
          <div className={`orb-wrap ${spitting?'spitting':''}`}>
          <button className={`mic-button ${tone} ${pointerVisible?'pointing-on-page':''}`} data-tone={tone} title={pointerVisible?'Voice dot is pointing on the PDF':buttonLabel} aria-label={buttonLabel} aria-pressed={sessionOn} disabled={!sessionOn&&(!signedIn||!status?.voiceAvailable||loading)} onClick={()=>void primary().catch(e=>setError(errorMessage(e)))}>
            <span className="halo orb-glow" aria-hidden="true"/>
            <span className="face" aria-hidden="true"><Orb tone={tone}/><VoiceGlyph tone={tone} muted={sessionOn&&muted} size={30}/></span>
          </button>
          <ThinkOrb busy={!!thinking?.busy} delegating={!!thinking?.delegating} compacting={!!thinking?.compacting} queued={thinking?.queued??0} job={thinkJob} activities={activities} preview={thinkPreview} onSpit={spit} onStop={()=>void api().cancelThink().catch(e=>setError(errorMessage(e)))} onOpenThink={()=>transcriptBottom.current?.scrollIntoView({behavior:'smooth'})}/>
          </div>
          {sessionOn&&<div className="voice-copy"><strong>{muted?'Muted':title[phase].replace('\n',' ')}</strong></div>}
          <div className="voice-controls">
            <button className="round" disabled={!sessionOn} title={muted?'Unmute microphone':'Mute microphone'} aria-label={muted?'Unmute microphone':'Mute microphone'} aria-pressed={muted} onClick={toggleMute}><Icon name={muted?'mute':'mic'} size={15}/></button>
            <button className="round" title={speaker?'Mute voice':'Enable voice'} aria-label={speaker?'Mute voice':'Enable voice'} aria-pressed={!speaker} onClick={toggleSpeaker}><Icon name={speaker?'speaker':'silent'} size={15}/></button>
          </div>
        </div>
        <div className="think-status">
          <label className="logs-toggle" title="Show debug logs: tool calls, the route each took, and which model ran it"><input type="checkbox" checked={logsOn} onChange={event=>toggleLogs(event.target.checked)}/><span>Logs</span>{logsOn&&!!logs.length&&<small>{logs.length}</small>}</label>
          <div>
            {thinking?.busy&&<button className="icon-button" title="Stop Think" onClick={()=>void api().cancelThink().catch(e=>setError(errorMessage(e)))}><Icon name="stop" size={14}/></button>}
            <button className="icon-button" title={`New chat (${mod}N)`} disabled={!hasMessages} onClick={()=>void newChat()}><Icon name="new-chat" size={15}/></button>
            <button className="icon-button" title="Compact Think context" disabled={!signedIn||thinking?.compacting} onClick={()=>void api().compact().catch(e=>setError(errorMessage(e)))}><Icon name="compact" size={15}/></button>
            <button className="icon-button" title="Past chats" onClick={()=>void openHistory()}><Icon name="history" size={15}/></button>
            <button className="icon-button" title="Export voice transcript" disabled={!entries.length} onClick={()=>void api().exportTranscript(entries).catch(e=>setError(errorMessage(e)))}><Icon name="export" size={15}/></button>
          </div>
        </div>
        <div className="agent-scroll" aria-live="polite">
          {!hasMessages&&<div className="suggestions">{['Summarize this file','Make it interactive','Research this on the web'].map(suggestion=><button key={suggestion} disabled={!signedIn} onClick={()=>void send(suggestion)}><span>{suggestion}</span><Icon name="arrow-right" size={14}/></button>)}</div>}
          {timeline.map(item=>item.kind==='log'?<LogLine key={`log:${item.log.id}`} log={item.log}/>:<Message key={item.entry.id} {...item}/>)}
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

    <dialog ref={historyRef} className="settings-dialog history-dialog" onCancel={()=>setHistoryOpen(false)}>
      <header className="dialog-header">
        <div className="history-title">{viewingChat&&<button className="icon-button" title="All chats" onClick={()=>setViewingChat(null)}><Icon name="left" size={18}/></button>}<h2>{viewingChat?viewingChat.title:'Past chats'}</h2></div>
        <div>
          {viewingChat&&<button className="icon-button" title="Delete this chat" onClick={()=>deleteChat(viewingChat.id)}><Icon name="trash" size={17}/></button>}
          <button className="icon-button" title="Close past chats" onClick={()=>setHistoryOpen(false)}><Icon name="close" size={18}/></button>
        </div>
      </header>
      {viewingChat?<div className="history-transcript">
        <p className="history-meta">{chatDate(viewingChat.created)}</p>
        {chatMessages(viewingChat.entries,viewingChat.think).map(item=><Message key={item.entry.id} entry={{...item.entry,final:true}} source={item.source}/>)}
      </div>:<div className="history-list">
        {!pastChats.length&&<p className="settings-intro">No past chats yet. Chats are saved here as you go.</p>}
        {pastChats.map(item=><div className={`history-row ${item.id===chat.current.id?'current':''}`} key={item.id}>
          <button className="history-open" onClick={()=>viewChat(item.id)}><strong>{item.title}</strong><small>{chatDate(item.updated)} · {item.count} {item.count===1?'message':'messages'}{item.id===chat.current.id?' · current':''}</small></button>
          <button className="icon-button" title="Delete chat" aria-label={`Delete ${item.title}`} onClick={()=>deleteChat(item.id)}><Icon name="trash" size={14}/></button>
        </div>)}
      </div>}
    </dialog>

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
        <label className="check-setting voice-tools-setting"><input type="checkbox" name="lowPowerMode" checked={draft.lowPowerMode ?? false} onChange={event=>setDraft({...draft,lowPowerMode:event.target.checked})}/><span>Low power mode<small>Use gentler orb playback to save power. Animation pauses when the app is unfocused.</small></span></label>
      </section>
      <section className="settings-section"><h3>Think</h3>
        <div className="settings-grid">
          <label className="field"><span>Backend model</span><select value={draft.model} onChange={event=>setDraft({...draft,model:event.target.value})}><option value="">Codex default</option>{draft.model&&!status?.models.some(model=>model.model===draft.model)&&<option value={draft.model}>{draft.model==='gpt-6.1-sol'?'GPT-6.1 Sol':draft.model}</option>}{status?.models.map(model=><option key={model.model} value={model.model}>{model.displayName}</option>)}</select></label>
          <label className="field"><span>Thinking effort</span><select value={draft.reasoningEffort} onChange={event=>setDraft({...draft,reasoningEffort:event.target.value as Settings['reasoningEffort']})}>{['low','medium','high','xhigh'].map(effort=><option key={effort} value={effort}>{effort==='xhigh'?'Extra high':effort.charAt(0).toUpperCase()+effort.slice(1)}</option>)}</select></label>
          <label className="field"><span>Compact context at</span><input type="number" min={8000} max={200000} step={4000} value={draft.compactAtTokens} onChange={event=>setDraft({...draft,compactAtTokens:Number(event.target.value)})}/></label>
          <label className="check-setting"><input type="checkbox" checked={draft.autoCompact} onChange={event=>setDraft({...draft,autoCompact:event.target.checked})}/><span>Auto compact</span></label>
          <label className="check-setting"><input type="checkbox" checked={draft.priority} onChange={event=>setDraft({...draft,priority:event.target.checked})}/><span>Fast / Priority</span></label>
        </div>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.quizFollowUps} onChange={event=>setDraft({...draft,quizFollowUps:event.target.checked})}/><span>Quiz follow-ups<small>After every answer, add a follow-up question: simpler after a miss, harder after a correct answer.</small></span></label>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.proactiveExplain} onChange={event=>setDraft({...draft,proactiveExplain:event.target.checked})}/><span>Show answers on the page<small>When you ask about a PDF, the answer is highlighted automatically, with an explanation or interactive beside it when that helps.</small></span></label>
      </section>
      <section className="settings-section"><h3>Voice</h3>
        <div className="settings-grid">
          <label className="field"><span>Voice</span><select value={draft.voice} onChange={event=>setDraft({...draft,voice:event.target.value})}><option value="">Service default</option>{status?.voices.map(voice=><option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>
          <label className="field"><span>Microphone</span><select value={draft.inputDevice} onChange={event=>setDraft({...draft,inputDevice:event.target.value})}><option value="">System default</option>{devices.filter(device=>device.deviceId&&device.deviceId!=='default').map(device=><option key={device.deviceId} value={device.deviceId}>{device.label||'Microphone'}</option>)}</select></label>
        </div>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.agentTools} onChange={event=>setDraft({...draft,agentTools:event.target.checked})}/><span>Voice agent tools<small>Voice highlights, points, and reads quiz progress directly. Think still writes quizzes, explanations, and edits.</small></span></label>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.bridgeResearch} onChange={event=>setDraft({...draft,bridgeResearch:event.target.checked})}/><span>Voice research<small>Voice can read open files and search the web for quick answers. Bigger work still goes to Think.</small></span></label>
        <h4>Usage saving (experimental)</h4>
        <div className="settings-grid">
          <label className="field" title="Closes the live voice connection after this much quiet to save usage; talking reconnects it. 0 keeps it open."><span>Standby after (seconds, 0 = never)</span><input type="number" min={0} max={600} step={15} value={draft.standbyAfterSeconds} onChange={event=>setDraft({...draft,standbyAfterSeconds:Number(event.target.value)})}/></label>
          <label className="field" title="How what you said while it reconnected reaches the voice. Real time adds the reconnect time to the first reply. Faster replays at 1.3× (slightly higher pitch) until caught up. Burst sends it all at once through an experimental Codex call and falls back to real time if that fails."><span>Catch-up after standby</span><select value={draft.voiceCatchUp} onChange={event=>setDraft({...draft,voiceCatchUp:event.target.value as Settings['voiceCatchUp']})}><option value="realtime">Replay in real time</option><option value="fast">Replay faster (1.3×)</option><option value="burst">Send as burst (experimental)</option></select></label>
          <label className="field" title="How much speech it needs to hear before waking from standby. Higher ignores coughs and short noises."><span>Wake after speech of (ms)</span><input type="number" min={100} max={2000} step={50} value={draft.standbyWakeMs} onChange={event=>setDraft({...draft,standbyWakeMs:Number(event.target.value)})}/></label>
          <label className="field" title="If a wake hears no words within this time, it goes back to standby. 0 turns it off."><span>Re-sleep on false wake (seconds, 0 = off)</span><input type="number" min={0} max={120} step={5} value={draft.standbyFalseWakeSeconds} onChange={event=>setDraft({...draft,standbyFalseWakeSeconds:Number(event.target.value)})}/></label>
        </div>
        <label className="check-setting voice-tools-setting"><input type="checkbox" checked={draft.voiceAckFiller} onChange={event=>setDraft({...draft,voiceAckFiller:event.target.checked})}/><span>Spoken “let me check” filler<small>Off skips the acknowledgement voice says before handing a request to the bridge. Applies from the next voice connection.</small></span></label>
        <label className="field wide"><span>Voice instructions</span><textarea rows={4} maxLength={8000} value={draft.prompt} onChange={event=>setDraft({...draft,prompt:event.target.value})}/></label>
      </section>
      <details className="settings-section advanced"><summary>Advanced</summary>
        <label className="field wide"><span>Codex executable</span><input value={draft.codexPath} placeholder="Use bundled Codex" onChange={event=>setDraft({...draft,codexPath:event.target.value})}/></label>
      </details>
      {error&&<p className="dialog-error" role="alert">{error}</p>}
      <footer className="dialog-footer"><button className="button-secondary" onClick={()=>setSettingsOpen(false)}>Cancel</button><button className="button-primary" disabled={saving} onClick={()=>void saveSettings()}>{saving?'Saving…':'Save'}</button></footer>
    </dialog>
  </div></LowPowerContext.Provider>;
}

function Message({entry,source}:ChatMessage) {
  return <article className={`message ${entry.role} ${source}`}>
    {entry.role==='assistant'&&<div className="message-meta"><span>{source==='think'?'Think':'Voice'}</span>{!entry.final&&<i className="writing-dot"/>}</div>}
    {source==='think'?<MarkdownView text={entry.text}/>:<p className="message-body">{entry.text}</p>}
  </article>;
}

function LogLine({log}:{log:DebugLog}) {
  return <div className={`log-line ${log.kind} ${log.status??''}`}>
    <div className="log-head">
      <time>{logTime(log.time)}</time>
      <span className={`log-agent ${log.agent}`}>{log.agent}</span>
      <strong>{log.label}</strong>
      {log.status&&<i className="log-status" title={log.status}/>}
      {log.ms!==undefined&&<span className="log-ms">{log.ms<1000?`${log.ms}ms`:`${(log.ms/1000).toFixed(1)}s`}</span>}
    </div>
    {log.detail&&<p className="log-detail">{log.detail}</p>}
    {log.model&&<p className="log-model">{log.model}</p>}
  </div>;
}
