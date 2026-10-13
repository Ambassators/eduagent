import { defaultSettings, type Settings } from '../shared.js';

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid input.');
  return value;
}

export function cleanSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
  const data = value as Record<string, unknown>;
  // Earlier OS voice identifiers are intentionally discarded during migration.
  const voice = text(data.voice ?? '', 50);
  return { ...defaultSettings, voice: /^[a-z]*$/.test(voice) ? voice : '', model: text(data.model ?? defaultSettings.model, 150),
    prompt: text(data.prompt ?? defaultSettings.prompt, 8000), codexPath: text(data.codexPath ?? '', 2000),
    inputDevice: text(data.inputDevice ?? '', 300),
    reasoningEffort: ['low','medium','high','xhigh'].includes(String(data.reasoningEffort)) ? data.reasoningEffort as Settings['reasoningEffort'] : defaultSettings.reasoningEffort,
    quizModel: text(data.quizModel ?? data.model ?? defaultSettings.quizModel, 150),
    quizReasoningEffort: ['low','medium','high','xhigh'].includes(String(data.quizReasoningEffort ?? data.reasoningEffort)) ? (data.quizReasoningEffort ?? data.reasoningEffort) as Settings['reasoningEffort'] : defaultSettings.quizReasoningEffort,
    transparency: ['mica','acrylic','opaque'].includes(String(data.transparency)) ? data.transparency as Settings['transparency'] : 'acrylic',
    theme: ['system','light','dark'].includes(String(data.theme)) ? data.theme as Settings['theme'] : 'system',
    lowPowerMode: typeof data.lowPowerMode === 'boolean' ? data.lowPowerMode : defaultSettings.lowPowerMode,
    demoPlacement: data.demoPlacement === 'popup' ? 'popup' : 'side', autoCompact: data.autoCompact !== false, agentTools: typeof data.agentTools === 'boolean' ? data.agentTools : defaultSettings.agentTools, bridgeResearch: typeof data.bridgeResearch === 'boolean' ? data.bridgeResearch : defaultSettings.bridgeResearch, proactiveExplain: data.proactiveExplain === true, priority:typeof data.priority === 'boolean' ? data.priority : defaultSettings.priority,
    compactAtTokens: typeof data.compactAtTokens === 'number' && Number.isFinite(data.compactAtTokens) ? Math.min(200000,Math.max(8000,Math.floor(data.compactAtTokens))) : defaultSettings.compactAtTokens,
    voiceCatchUp: data.voiceCatchUp === 'fast' || data.voiceCatchUp === 'burst' ? data.voiceCatchUp : 'realtime',
    voiceAckFiller: data.voiceAckFiller !== false,
    standbyWakeMs: typeof data.standbyWakeMs === 'number' && Number.isFinite(data.standbyWakeMs) ? Math.min(2000,Math.max(100,Math.floor(data.standbyWakeMs))) : defaultSettings.standbyWakeMs,
    standbyFalseWakeSeconds: typeof data.standbyFalseWakeSeconds === 'number' && Number.isFinite(data.standbyFalseWakeSeconds) ? Math.min(120,Math.max(0,Math.floor(data.standbyFalseWakeSeconds))) : defaultSettings.standbyFalseWakeSeconds,
    standbyAfterSeconds: typeof data.standbyAfterSeconds === 'number' && Number.isFinite(data.standbyAfterSeconds) ? Math.min(600,Math.max(0,Math.floor(data.standbyAfterSeconds))) : defaultSettings.standbyAfterSeconds };
}
