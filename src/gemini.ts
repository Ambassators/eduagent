export interface GeminiModelOption { model: string; displayName: string }
// Conversational Live models. Translation, transcription and TTS use separate APIs/configuration.
export const geminiLiveModels: GeminiModelOption[] = [
  { model: 'gemini-3.8-live', displayName: 'Gemini 3.8 Live' },
  { model: 'gemini-3.8-live-extended-thinking', displayName: 'Gemini 3.8 Live Extended Thinking' },
  { model: 'gemini-3.1-flash-live-preview', displayName: 'Gemini 3.1 Flash Live (preview)' },
  { model: 'gemini-2.5-flash-native-audio-preview-12-2025', displayName: 'Gemini 2.5 Flash Native Audio (legacy preview)' }
];
export const geminiAnswerModels: GeminiModelOption[] = [
  { model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
  { model: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
  { model: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
  { model: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite' },
  { model: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (preview)' },
  { model: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite' },
  { model: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (preview)' },
  { model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro (legacy)' },
  { model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash (legacy)' },
  { model: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite (legacy)' }
];
export const geminiVoices = ['Achernar','Achird','Algenib','Algieba','Alnilam','Aoede','Autonoe','Callirrhoe','Charon','Despina','Enceladus','Erinome','Fenrir','Gacrux','Iapetus','Kore','Laomedeia','Leda','Orus','Puck','Pulcherrima','Rasalgethi','Sadachbia','Sadaltager','Schedar','Sulafat','Umbriel','Vindemiatrix','Zephyr','Zubenelgenubi'];

export function geminiCatalog(models: unknown[]): { live: GeminiModelOption[]; answer: GeminiModelOption[] } {
  const live = new Map(geminiLiveModels.map(item => [item.model, item]));
  const answer = new Map(geminiAnswerModels.map(item => [item.model, item]));
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown };
    if (typeof item.name !== 'string' || !Array.isArray(item.supportedGenerationMethods)) continue;
    const model = item.name.replace(/^models\//, '');
    if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) continue;
    const option = { model, displayName: typeof item.displayName === 'string' ? item.displayName : model };
    if (item.supportedGenerationMethods.includes('bidiGenerateContent') && !/translate|transcribe/.test(model)) live.set(model, option);
    if (item.supportedGenerationMethods.includes('generateContent') && !/audio|live|tts|image|embed|transcribe|robotics|omni/.test(model)) answer.set(model, option);
  }
  return { live: [...live.values()], answer: [...answer.values()] };
}
