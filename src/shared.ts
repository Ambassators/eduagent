import type { QuizAnswerInput, QuizState, QuizSource } from './quiz.js';
export interface Settings {
  voice: string;
  model: string;
  prompt: string;
  codexPath: string;
  inputDevice: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  transparency: 'mica' | 'acrylic' | 'opaque';
  theme: 'system' | 'light' | 'dark';
  demoPlacement: 'side' | 'popup';
  autoCompact: boolean;
  compactAtTokens: number;
  agentTools: boolean;
  priority: boolean;
  debug: boolean;
}
export const defaultSettings: Settings = {
  voice: '', model: 'gpt-6.1-sol', codexPath: '', inputDevice: '', reasoningEffort: 'low',
  transparency: 'acrylic', theme: 'system', demoPlacement: 'side', autoCompact: true, compactAtTokens: 48000,
  agentTools: false,
  priority: true,
  debug: false,
  prompt: 'You are a thoughtful voice companion in a document workspace. Speak naturally. You already receive the currently open file as quiet context. Answer simple questions directly. For deep reasoning, web search, document edits, or screen demonstrations, delegate to the backend and ask it to call think with an optional message. The Think thread already has the full conversation transcript and current file context; do not repeat them. Keep talking while it works. Only describe completed actions after their tools succeed.'
};
export interface ModelOption { model: string; displayName: string; isDefault: boolean; efforts?: string[] }
export interface Status {
  connected: boolean;
  account: { type: string; email?: string; planType?: string } | null;
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
export interface TranscriptEntry { id: string; role: 'user' | 'assistant'; text: string; time: number; final: boolean }
export type DocumentKind = 'pdf' | 'word' | 'markdown' | 'text' | 'image' | 'html' | 'binary';
export interface DocumentInfo {
  id: string; name: string; kind: DocumentKind; extension: string; originalPath: string;
  size: number; revision: number; dirty: boolean; pageCount?: number; warning?: string;
}
export interface DocumentContent { info: DocumentInfo; text: string; html?: string; pages?: { number: number; text: string; width: number; height: number }[]; fields?: { name: string; type: string; value: string | boolean }[] }
export interface Presentation { id: string; title: string; kind: 'text' | 'demo'; content: string; placement: 'side' | 'popup'; time: number }
export interface ThinkState { threadId: string | null; busy: boolean; compacting: boolean; queued: number; tokens: number; contextWindow: number | null; lastCompacted?: number; contextVersion: number }
/** PDF annotations use fractions of the rendered page, independent of scroll and zoom. */
export interface PageRect { x: number; y: number; width: number; height: number }
export interface PDFOverlay { id: string; fileId: string; page: number; revision: number; version: number; rect: PageRect; title: string; kind: 'text' | 'embed'; format: 'text' | 'markdown' | 'latex' | 'mermaid'; content: string }
export interface PDFHighlight { id: string; fileId: string; page: number; revision: number; text: string; rects: PageRect[] }
export interface PDFPointer { fileId: string; page: number; revision: number; target: PageRect; dot: { x: number; y: number }; label: string }
export interface PDFAnnotations { overlays: PDFOverlay[]; highlights: PDFHighlight[]; pointer: PDFPointer | null }
export interface PDFToolRequest { id: string; tool: string; fileId: string; revision: number; args: Record<string, unknown> }
export interface WorkspaceState { files: DocumentInfo[]; activeId: string | null; artifacts: Presentation[]; thinking: ThinkState; annotations: PDFAnnotations; quiz: QuizState }
export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed'; detail: string; time: number }
export interface DesktopAPI {
  status(): Promise<Status>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  microphoneAccess(): Promise<boolean>;
  startVoice(sdp: string): Promise<{threadId: string; sdp: string}>;
  stopVoice(): Promise<void>;
  interrupt(): Promise<void>;
  sendText(text: string): Promise<void>;
  newConversation(): Promise<void>;
  exportTranscript(entries: TranscriptEntry[]): Promise<boolean>;
  openHelp(): Promise<void>;
  onEvent(handler: (event: AppEvent) => void): () => void;
  workspace(): Promise<WorkspaceState>;
  openFiles(): Promise<WorkspaceState>;
  openPaths(paths: string[]): Promise<WorkspaceState>;
  filePath(file: unknown): string;
  selectFile(id: string): Promise<WorkspaceState>;
  closeFile(id: string): Promise<WorkspaceState>;
  document(id: string): Promise<DocumentContent>;
  documentBytes(id: string): Promise<Uint8Array>;
  saveDocument(id: string, original: boolean): Promise<boolean>;
  updateDocument(id: string, text: string): Promise<DocumentContent>;
  setPage(id: string, page: number): Promise<void>;
  syncTranscript(entries: TranscriptEntry[]): Promise<void>;
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
  closeQuiz(): Promise<QuizState>;
  openQuizSource(source: QuizSource): Promise<unknown>;
}
