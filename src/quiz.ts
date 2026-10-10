/** Answer keys stay in the main process; only answered questions reveal them. */
export interface QuizSource { fileId: string; page: number; label: string; quote?: string }
export interface QuizQuestionView {
  id: string;
  kind: 'choice' | 'short';
  prompt: string;
  topic: string;
  difficulty: 1 | 2 | 3;
  choices?: string[];
  /** Written by the coach in response to the learner's previous answer. */
  followUp?: boolean;
}
export interface QuizQuestion extends QuizQuestionView {
  correctIndex?: number;
  /** Required for choice questions. Never exposed before the learner answers. */
  choiceExplanations?: string[];
  choiceSources?: QuizSource[][];
  acceptedAnswers?: string[];
  explanation: string;
  sources?: QuizSource[];
}
export interface QuizAnswerInput { quizId: string; questionId: string; choiceIndex?: number; text?: string }
export interface QuizAnswerResult {
  questionId: string;
  prompt: string;
  correct: boolean;
  submitted: string;
  answer: string;
  explanation: string;
  choices?: { text: string; explanation: string; correct: boolean; selected: boolean; sources?: QuizSource[] }[];
  sources?: QuizSource[];
  topic: string;
  difficulty: 1 | 2 | 3;
  seconds: number;
}
export interface QuizStats {
  answered: number;
  correct: number;
  accuracy: number | null;
  streak: number;
  bestStreak: number;
  averageSeconds: number | null;
  topics: { topic: string; answered: number; correct: number; accuracy: number }[];
}
export interface QuizState {
  banks: { id: string; title: string; count: number }[];
  quiz: {
    id: string;
    title: string;
    bankId: string;
    adaptive: boolean;
    status: 'active' | 'completed';
    answered: number;
    total: number;
    remaining: number;
    current: QuizQuestionView | null;
    lastResult: QuizAnswerResult | null;
    stats: QuizStats;
    coachBusy: boolean;
    coachError: string | null;
    /** Follow-up mode (an opt-in setting): the coach writes the next question after every answer. */
    followUps: boolean;
    /** The answered question still awaiting its follow-up; the panel waits before moving on. */
    followUpPending: boolean;
  } | null;
}
