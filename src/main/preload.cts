import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent, DesktopAPI, Settings, TranscriptEntry } from '../shared.js';
const api: DesktopAPI = {
  status: () => ipcRenderer.invoke('voice:status'),
  login: () => ipcRenderer.invoke('voice:login'),
  cancelLogin: () => ipcRenderer.invoke('voice:cancelLogin'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('voice:settings', settings),
  microphoneAccess: () => ipcRenderer.invoke('voice:microphone'),
  startVoice: (sdp: string) => ipcRenderer.invoke('voice:start', sdp),
  stopVoice: () => ipcRenderer.invoke('voice:stop'),
  interrupt: () => ipcRenderer.invoke('voice:interrupt'),
  sendText: (text: string) => ipcRenderer.invoke('voice:text', text),
  newConversation: () => ipcRenderer.invoke('voice:new'),
  exportTranscript: (entries: TranscriptEntry[]) => ipcRenderer.invoke('voice:export', entries),
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
  setPage: (id,page) => ipcRenderer.invoke('voice:page', id, page),
  syncTranscript: entries => ipcRenderer.invoke('voice:syncTranscript', entries),
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
  closeQuiz: () => ipcRenderer.invoke('voice:closeQuiz'),
  openQuizSource: source => ipcRenderer.invoke('voice:openQuizSource',source),
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) => handler(data);
    ipcRenderer.on('voice:event', listener);
    return () => { ipcRenderer.removeListener('voice:event', listener); };
  }
};
contextBridge.exposeInMainWorld('desktop', api);
