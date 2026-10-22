import type { BrowserState, BrowserBounds, CookieImportResult, CookieImportSource } from './browser.js';
import type { QuizAnswerInput, QuizState, QuizSource } from './quiz.js';
import type { TeXSettings } from './glasstex.js';
export interface Settings {
  voice: string;
  model: string;
  prompt: string;
  codexPath: string;
  inputDevice: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  quizModel: string;
  quizReasoningEffort: Settings['reasoningEffort'];
  transparency: 'mica' | 'acrylic' | 'opaque';
  theme: 'system' | 'light' | 'dark';
  /** Use a prerecorded microphone orb loop instead of live gradient animation. */
  lowPowerMode: boolean;
  demoPlacement: 'side' | 'popup' | 'file';
  autoCompact: boolean;
  compactAtTokens: number;
  agentTools: boolean;
  /** Opt-in: the voice bridge may read open files and search the web itself instead of always queuing Think. */
  bridgeResearch: boolean;
  /** Opt-in: answers to questions about the open PDF are highlighted, and explained with overlays or embeds, without the user asking. */
  proactiveExplain: boolean;
  priority: boolean;
  /** Seconds of quiet before the live voice connection is closed to save usage; it reconnects when you speak. 0 keeps it open. */
  standbyAfterSeconds: number;
  /** How speech that woke standby reaches the reconnected session: replayed at normal speed, replayed faster until caught up, or sent in one burst (experimental). */
  voiceCatchUp: 'realtime' | 'fast' | 'burst';
  /** Spoken acknowledgement ("let me check") when voice hands a request to the bridge. */
  voiceAckFiller: boolean;
  /** Milliseconds of detected speech needed to wake standby, so coughs and short noises do not reconnect. */
  standbyWakeMs: number;
  /** Return to standby if a wake hears no words within this many seconds. 0 turns it off. */
  standbyFalseWakeSeconds: number;
}
export const defaultSettings: Settings = {
  voice: '', model: 'gpt-6.1-sol', codexPath: '', inputDevice: '', reasoningEffort: 'medium',
  quizModel: 'gpt-6.1-sol', quizReasoningEffort: 'medium',
  transparency: 'acrylic', theme: 'system', lowPowerMode: true, demoPlacement: 'side', autoCompact: true, compactAtTokens: 200000,
  agentTools: true,
  bridgeResearch: true,
  proactiveExplain: false,
  priority: false,
  standbyAfterSeconds: 60,
  voiceCatchUp: 'realtime',
  voiceAckFiller: true,
  standbyWakeMs: 100,
  standbyFalseWakeSeconds: 10,
  prompt: 'You are a thoughtful voice companion in a document workspace. Speak naturally. You already receive the currently open file as quiet context. Answer simple questions directly. For deep reasoning, web search, document edits, or screen demonstrations, delegate to the backend and ask it to call think with an optional message. The Think thread already has the full conversation transcript and current file context; do not repeat them. Keep talking while it works. Only describe completed actions after their tools succeed.'
};
export interface ModelOption { model: string; displayName: string; isDefault: boolean; efforts?: string[] }
export interface Status {
  connected: boolean;
  account: { type: string; email?: string; name?: string; planType?: string } | null;
  models: ModelOption[];
  voices: { id: string; name: string }[];
  voiceAvailable: boolean;
  settings: Settings;
  executable: string;
  platform: string;
  warning?: string;
  darkMode: boolean;
}
export interface AppEvent { method: string; params: Record<string, unknown> }
export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error';
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
  retry?: 'check' | 'download' | 'install';
}
export interface TranscriptEntry { id: string; role: 'user' | 'assistant'; text: string; time: number; final: boolean }
/** A saved chat. `think` holds Think's side of the conversation, kept apart as in the live timeline. */
export interface SavedChat { id: string; title: string; created: number; updated: number; entries: TranscriptEntry[]; think: TranscriptEntry[] }
export interface ChatSummary { id: string; title: string; created: number; updated: number; count: number }
export type DocumentKind = 'pdf' | 'word' | 'markdown' | 'text' | 'tex' | 'image' | 'html' | 'quiz' | 'binary';
export interface DocumentInfo {
  id: string; name: string; kind: DocumentKind; extension: string; originalPath: string;
  size: number; revision: number; dirty: boolean; pageCount?: number; warning?: string;
  /** Sidebar folder holding this file; absent for files at the top level. */
  folderId?: string;
}
/** A sidebar group of open files. `path` is set when it was opened from a folder on disk. */
export interface DocumentFolder { id: string; name: string; collapsed: boolean; path?: string }
export interface DocumentContent { info: DocumentInfo; text: string; html?: string; pages?: { number: number; text: string; width: number; height: number }[]; fields?: { name: string; type: string; value: string | boolean }[] }
export interface DocumentSource { fileId: string; label: string; page?: number; quote?: string }
/** PDF positions are fractions of the visible page, including its crop and rotation. */
export interface PDFTextChange {
  action: 'replace_text' | 'add_text'; page: number;
  x: number; y: number; width: number; height: number;
  text: string; fontSize: number; color: string;
  fontFamily?: 'sans' | 'serif' | 'mono'; originalText?: string;
  originalRect?: { x: number; y: number; width: number; height: number };
}
export interface Presentation { id: string; title: string; kind: 'text' | 'demo'; content: string; placement: 'side' | 'popup'; time: number }
/** `delegating`: the voice bridge is handling a request (it may run tools directly without a Think job). */
export interface ThinkState { threadId: string | null; busy: boolean; delegating: boolean; compacting: boolean; queued: number; tokens: number; contextWindow: number | null; lastCompacted?: number; contextVersion: number }
/** PDF annotations use fractions of the rendered page, independent of scroll and zoom. */
export interface PageRect { x: number; y: number; width: number; height: number }
export interface PDFOverlay { id: string; fileId: string; page: number; revision: number; version: number; rect: PageRect; title: string; kind: 'text' | 'embed'; format: 'text' | 'markdown' | 'latex' | 'mermaid'; content: string }
export interface PDFHighlight { id: string; fileId: string; page: number; revision: number; text: string; rects: PageRect[] }
export interface PDFPointer { fileId: string; page: number; revision: number; target: PageRect; dot: { x: number; y: number }; label: string }
export interface PDFAnnotations { overlays: PDFOverlay[]; highlights: PDFHighlight[]; pointer: PDFPointer | null }
export interface PDFToolRequest { id: string; tool: string; fileId: string; revision: number; args: Record<string, unknown> }
export interface WorkspaceState { files: DocumentInfo[]; folders: DocumentFolder[]; activeId: string | null; artifacts: Presentation[]; thinking: ThinkState; annotations: PDFAnnotations; quiz: QuizState }
/** One line of the debug log. `agent` is the thread that acted: the realtime voice, the bridge text thread behind it, or Think. */
export interface DebugLog { id: string; time: number; agent: 'voice' | 'bridge' | 'think' | 'app'; kind: 'tool' | 'route' | 'event' | 'error'; label: string; detail?: string; model?: string; status?: 'running' | 'completed' | 'failed'; ms?: number }
export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed'; detail: string; time: number }
export interface DesktopAPI {
  updateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  updateDownloads(): Promise<void>;
  onWindowActivity(handler: (active: boolean) => void): () => void;
  browserState(): Promise<BrowserState>;
  browserOpen(url?: string): Promise<BrowserState>;
  browserSelect(id: string): Promise<BrowserState>;
  browserClose(id: string): Promise<BrowserState>;
  browserNavigate(id: string, url: string): Promise<BrowserState>;
  browserControl(id: string, action: string): Promise<BrowserState>;
  browserBounds(bounds: BrowserBounds): Promise<void>;
  browserPairing(): Promise<{ token: string; endpoint: string }>;
  browserRotatePairing(): Promise<void>;
  browserRevoke(clientId: string): Promise<void>;
  browserImportCookies(clientId: string): Promise<CookieImportResult>;
  browserCookieSources(): Promise<CookieImportSource[]>;
  browserExportExtensions(): Promise<boolean>;
  status(): Promise<Status>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  microphoneAccess(): Promise<boolean>;
  /** resume: reconnecting after standby on the same bridge thread, so its context is still there. */
  startVoice(sdp: string, resume?: boolean): Promise<{threadId: string; sdp: string}>;
  stopVoice(): Promise<void>;
  /** Experimental: base64 16-bit mono PCM sent straight to the live session's input. */
  appendVoiceAudio(data: string, sampleRate: number): Promise<void>;
  /** Adds a line to the debug log panel. */
  voiceLog(label: string, detail?: string): Promise<void>;
  interrupt(): Promise<void>;
  sendText(text: string): Promise<void>;
  newConversation(): Promise<void>;
  exportTranscript(entries: TranscriptEntry[]): Promise<boolean>;
  saveChat(chat: SavedChat): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  loadChat(id: string): Promise<SavedChat>;
  resumeChat(id: string): Promise<SavedChat>;
  deleteChat(id: string): Promise<void>;
  openHelp(): Promise<void>;
  onEvent(handler: (event: AppEvent) => void): () => void;
  workspace(): Promise<WorkspaceState>;
  openFiles(): Promise<WorkspaceState>;
  openPaths(paths: string[]): Promise<WorkspaceState>;
  /** Opens the supported files directly inside a chosen folder into a matching sidebar folder. */
  openFolder(): Promise<WorkspaceState>;
  createFolder(name: string, fileIds?: string[]): Promise<{ id: string; workspace: WorkspaceState }>;
  renameFolder(id: string, name: string): Promise<WorkspaceState>;
  setFolderCollapsed(id: string, collapsed: boolean): Promise<WorkspaceState>;
  moveFile(fileId: string, folderId: string | null): Promise<WorkspaceState>;
  /** Native context menus. Renaming and closing are sent back as `sidebar/renameFolder` and `sidebar/closeFiles` events. */
  fileMenu(fileId: string): Promise<void>;
  folderMenu(folderId: string): Promise<void>;
  filePath(file: unknown): string;
  selectFile(id: string): Promise<WorkspaceState>;
  closeFile(id: string): Promise<WorkspaceState>;
  document(id: string): Promise<DocumentContent>;
  documentBytes(id: string): Promise<Uint8Array>;
  saveDocument(id: string, original: boolean): Promise<boolean>;
  updateDocument(id: string, text: string): Promise<DocumentContent>;
  editPDFText(id: string, revision: number, change: PDFTextChange): Promise<DocumentContent>;
  undoPDFText(id: string, revision: number): Promise<DocumentContent>;
  updateTeXDocument(id: string, text: string, revision: number): Promise<DocumentContent>;
  exportTeXPDF(id: string, settings: TeXSettings): Promise<boolean>;
  texAssets(id: string): Promise<Record<string, string>>;
  setPage(id: string, page: number): Promise<void>;
  /** Where the mouse pointer is in the open document while the user speaks. */
  pointer(text: string): Promise<void>;
  syncTranscript(entries: TranscriptEntry[], routeSpokenQuiz?: boolean): Promise<void>;
  think(message?: string): Promise<void>;
  cancelThink(): Promise<void>;
  compact(): Promise<void>;
  present(id: string, placement: 'side' | 'popup'): Promise<void>;
  dismissPresentation(id: string): Promise<void>;
  savePresentation(id: string): Promise<boolean>;
  openURL(url: string): Promise<void>;
  resolvePDFTool(id: string, result: unknown, error?: string): Promise<void>;
  dismissPDFAnnotation(id?: string): Promise<void>;
  answerQuiz(input: QuizAnswerInput): Promise<QuizState>;
  setQuizAdaptive(enabled: boolean): Promise<QuizState>;
  setQuizMode(mode: 'ai' | 'programmatic'): Promise<QuizState>;
  setQuizMaxQuestions(count: number): Promise<QuizState>;
  closeQuiz(): Promise<QuizState>;
  openQuizSource(source: QuizSource): Promise<unknown>;
}
