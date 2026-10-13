import type { QuizAnswerResult, QuizQuestion } from '../quiz.js';

/** Select fresh bank practice without a model call. Avoid stacking practice for the same topic. */
export function selectPractice(bank: QuizQuestion[], queue: QuizQuestion[], results: QuizAnswerResult[]): QuizQuestion | null {
  const latest = results.at(-1);
  if (!latest || queue.slice(results.length).some(q => q.topic === latest.topic)) return null;
  const previous = results.at(-2);
  if (latest.correct && (!previous?.correct || previous.topic !== latest.topic)) return null;
  const target = Math.max(1, Math.min(3, latest.difficulty + (latest.correct ? 1 : -1)));
  const used = new Set(queue.map(q => q.id));
  const prompts = new Set(queue.map(q => q.prompt.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')));
  return bank.filter(q => q.topic === latest.topic && !used.has(q.id)
    && !prompts.has(q.prompt.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' '))
    && (latest.correct ? q.difficulty >= latest.difficulty : q.difficulty <= latest.difficulty))
    .sort((a, b) => Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target))[0] ?? null;
}

/** Keep a small ready queue, balancing topic coverage and an appropriate next difficulty. */
export function selectBufferQuestion(bank: QuizQuestion[], queue: QuizQuestion[], results: QuizAnswerResult[], retired: Set<string>): QuizQuestion | null {
  const used = new Set([...queue.map(q => q.id), ...retired]);
  const available = bank.filter(q => !used.has(q.id));
  const targeted = selectPractice(available, queue, results);
  if (targeted) return targeted;
  const latest = results.at(-1);
  const target = latest ? Math.max(1, Math.min(3, latest.difficulty + (latest.correct && results.at(-2)?.correct ? 1 : latest.correct ? 0 : -1))) : 1;
  const coverage = (topic: string) => queue.filter(q => q.topic === topic).length;
  return available.sort((a,b) => coverage(a.topic)-coverage(b.topic) || Math.abs(a.difficulty-target)-Math.abs(b.difficulty-target))[0] ?? null;
}
