import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent, DesktopAPI, Settings, TranscriptEntry } from '../shared.js';
const api: DesktopAPI = {
  onWindowActivity: handler => {
    let received = false, disposed = false;
    const listener = (_event: Electron.IpcRendererEvent, active: boolean) => { received = true; handler(active); };
    ipcRenderer.on('voice:windowActivity', listener);
    // Subscribe before requesting the initial state; an intervening event wins.
    void ipcRenderer.invoke('voice:windowActivity').then(active => {
      if (!disposed && !received) handler(active);
    }).catch(() => {});
    return () => { disposed = true; ipcRenderer.removeListener('voice:windowActivity', listener); };
  },
  browserState: () => ipcRenderer.invoke('voice:browserState'),
  browserOpen: url => ipcRenderer.invoke('voice:browserOpen', url),
  browserSelect: id => ipcRenderer.invoke('voice:browserSelect', id),
  browserClose: id => ipcRenderer.invoke('voice:browserClose', id),
  browserNavigate: (id, url) => ipcRenderer.invoke('voice:browserNavigate', id, url),
  browserControl: (id, action) => ipcRenderer.invoke('voice:browserControl', id, action),
  browserBounds: bounds => ipcRenderer.invoke('voice:browserBounds', bounds),
  browserPairing: () => ipcRenderer.invoke('voice:browserPairing'),
  browserRotatePairing: () => ipcRenderer.invoke('voice:browserRotatePairing'),
  browserRevoke: id => ipcRenderer.invoke('voice:browserRevoke', id),
  browserImportCookies: id => ipcRenderer.invoke('voice:browserImportCookies', id),
  browserExportExtensions: () => ipcRenderer.invoke('voice:browserExportExtensions'),
  status: () => ipcRenderer.invoke('voice:status'),
  login: () => ipcRenderer.invoke('voice:login'),
  cancelLogin: () => ipcRenderer.invoke('voice:cancelLogin'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('voice:settings', settings),
  microphoneAccess: () => ipcRenderer.invoke('voice:microphone'),
  startVoice: (sdp: string, resume?: boolean) => ipcRenderer.invoke('voice:start', sdp, resume === true),
  stopVoice: () => ipcRenderer.invoke('voice:stop'),
  appendVoiceAudio: (data: string, sampleRate: number) => ipcRenderer.invoke('voice:appendAudio', data, sampleRate),
  voiceLog: (label: string, detail?: string) => ipcRenderer.invoke('voice:log', label, detail),
  interrupt: () => ipcRenderer.invoke('voice:interrupt'),
  sendText: (text: string) => ipcRenderer.invoke('voice:text', text),
  newConversation: () => ipcRenderer.invoke('voice:new'),
  exportTranscript: (entries: TranscriptEntry[]) => ipcRenderer.invoke('voice:export', entries),
  saveChat: chat => ipcRenderer.invoke('voice:saveChat', chat),
  listChats: () => ipcRenderer.invoke('voice:listChats'),
  loadChat: id => ipcRenderer.invoke('voice:loadChat', id),
  deleteChat: id => ipcRenderer.invoke('voice:deleteChat', id),
  openHelp: () => ipcRenderer.invoke('voice:help'),
  workspace: () => ipcRenderer.invoke('voice:workspace'),
  openFiles: () => ipcRenderer.invoke('voice:openFiles'),
  openPaths: paths => ipcRenderer.invoke('voice:openPaths', paths),
  filePath: file => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  selectFile: id => ipcRenderer.invoke('voice:selectFile', id),
  closeFile: id => ipcRenderer.invoke('voice:closeFile', id),
  document: id => ipcRenderer.invoke('voice:document', id),
  documentBytes: id => ipcRenderer.invoke('voice:documentBytes', id),
  saveDocument: (id,original) => ipcRenderer.invoke('voice:saveDocument', id, original),
  updateDocument: (id,body) => ipcRenderer.invoke('voice:updateDocument', id, body),
  updateTeXDocument: (id,body,revision) => ipcRenderer.invoke('voice:updateTeXDocument', id, body, revision),
  exportTeXPDF: (id,settings) => ipcRenderer.invoke('voice:exportTeXPDF', id, settings),
  setPage: (id,page) => ipcRenderer.invoke('voice:page', id, page),
  pointer: text => ipcRenderer.invoke('voice:pointer', text),
  syncTranscript: (entries,routeSpokenQuiz) => ipcRenderer.invoke('voice:syncTranscript', entries, routeSpokenQuiz===true),
  think: message => ipcRenderer.invoke('voice:think', message),
  cancelThink: () => ipcRenderer.invoke('voice:cancelThink'),
  compact: () => ipcRenderer.invoke('voice:compact'),
  present: (id,placement) => ipcRenderer.invoke('voice:present', id, placement),
  dismissPresentation: id => ipcRenderer.invoke('voice:dismissPresentation', id),
  savePresentation: id => ipcRenderer.invoke('voice:savePresentation', id),
  openURL: url => ipcRenderer.invoke('voice:openURL', url),
  resolvePDFTool: (id,result,error) => ipcRenderer.invoke('voice:resolvePDFTool',id,result,error),
  dismissPDFAnnotation: id => ipcRenderer.invoke('voice:dismissPDFAnnotation',id),
  answerQuiz: input => ipcRenderer.invoke('voice:answerQuiz',input),
  setQuizAdaptive: enabled => ipcRenderer.invoke('voice:setQuizAdaptive',enabled),
  setQuizMaxQuestions: count => ipcRenderer.invoke('voice:setQuizMaxQuestions',count),
  setQuizMode: mode => ipcRenderer.invoke('voice:setQuizMode',mode),
  closeQuiz: () => ipcRenderer.invoke('voice:closeQuiz'),
  openQuizSource: source => ipcRenderer.invoke('voice:openQuizSource',source),
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) => handler(data);
    ipcRenderer.on('voice:event', listener);
    return () => { ipcRenderer.removeListener('voice:event', listener); };
  }
};
contextBridge.exposeInMainWorld('desktop', api);
