/** Clear creation requests only; ordinary quiz discussion must remain conversation. */
export function isInteractiveQuizRequest(text: string): boolean {
  const value=text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  if (/\b(?:don['’]?t|do not|stop|without)\s+(?:using\s+|use\s+|making\s+|make\s+|creating\s+|create\s+|starting\s+|start\s+)?(?:a\s+|the\s+)?quiz\b/.test(value)) return false;
  if (/\b(?:quiz|test)\b.*\b(?:stats|progress|maximum|limit|replace|remove|delete|close)\b/.test(value)) return false;
  return /^(?:(?:can|could|would|will)\s+you\s+|please\s+|(?:okay|ok|hey|wait)[,!.\s]+)*(?:use|start|make|create|generate|build|set\s*up|give|quiz)\b/.test(value)
    && /\b(?:quiz(?:\s+tool)?|question bank|practice test)\b/.test(value);
}

/** Includes question edits; discussing an answer still uses the answer generator. */
export function isQuizGenerationRequest(text: string): boolean {
  if (isInteractiveQuizRequest(text)) return true;
  const value=text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  if (/\b(?:don['’]?t|do not|stop|without)\b/.test(value)) return false;
  return /^(?:(?:can|could|would|will)\s+you\s+|please\s+)*(?:add|append|replace|rewrite|regenerate|generate|create|make|build)\b/.test(value)
    && /\b(?:questions?|question bank|quiz|practice test)\b/.test(value);
}

export const interactiveQuizVoiceInstructions = `Quiz creation requests are actions, not invitations to conduct a spoken quiz. When the user asks to create/start a quiz, make a quiz from a PDF, or use the quiz tool, delegate to the backend and ask it to call think to create_question_bank and start_quiz. This is required even when optional voice agent tools are off. Do not substitute spoken questions, claim the quiz tool is ready, or say a quiz was created/opened until a successful backend result confirms the interactive .quiz file exists. While work is pending, acknowledge briefly without asking the first quiz question. If creation fails, report the failure accurately. For an existing interactive quiz, discuss its actual current question rather than inventing a separate spoken quiz.`;
