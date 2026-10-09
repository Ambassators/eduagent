import { useEffect, useRef, useState } from 'react';
import type { QuizAnswerInput, QuizSource, QuizState } from '../quiz';
import { RichMarkdown } from './RichText';
import './quiz.css';

export interface QuizPanelProps {
  state: QuizState;
  onAnswer: (input: QuizAnswerInput) => Promise<unknown>;
  onToggleAdaptive: (enabled: boolean) => Promise<unknown>;
  onClose: () => Promise<unknown>;
  onOpenSource: (source: QuizSource) => Promise<unknown>;
}
export default function QuizPanel({ state, onAnswer, onToggleAdaptive, onClose, onOpenSource }: QuizPanelProps) {
  const quiz = state.quiz;
  const [choice, setChoice] = useState<number | null>(null), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const questionTitle = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const current = quiz?.current;
  useEffect(() => { setChoice(null); setText(''); setError(''); }, [quiz?.id, current?.id]);
  useEffect(() => { setDismissedResult(null); }, [quiz?.id]);
  async function act(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const sourceLinks = (sources?: QuizSource[]) => sources?.length ? <div className="quiz-sources" aria-label="Teaching passages">{sources.map((source, index) => <button type="button" key={`${source.fileId}:${source.page}:${index}`} disabled={busy} onClick={() => void act(() => onOpenSource(source))} aria-label={`${source.label}, page ${source.page}`} title={source.quote ?? `Open page ${source.page}`}><span aria-hidden="true">↗</span> {source.label} <span className="quiz-source-page">p. {source.page}</span></button>)}</div> : null;
  if (!quiz) return null;
  const feedback = quiz.lastResult && quiz.lastResult.questionId !== dismissedResult ? quiz.lastResult : null;
  const progress = quiz.total ? quiz.answered / quiz.total * 100 : 0;
  return <section className="quiz-panel" aria-label={`Quiz: ${quiz.title}`}>
    <header className="quiz-heading">
      <div><span className="quiz-eyebrow">Practice / {quiz.answered} of {quiz.total}</span><h3 title={quiz.title}>{quiz.title}</h3></div>
      <button type="button" className="quiz-close" aria-label="Close quiz" disabled={busy} onClick={() => void act(onClose)}>×</button>
    </header>
    <div className="quiz-progress" role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={quiz.total} aria-valuenow={quiz.answered}><span style={{ width: `${progress}%` }} /></div>
    <div className="quiz-metrics" aria-label="Live performance">
      <span><strong>{quiz.stats.accuracy === null ? '—' : `${quiz.stats.accuracy}%`}</strong> accuracy</span>
      <span><strong>{quiz.stats.streak}</strong> streak</span>
      <label className="quiz-adaptive"><input type="checkbox" checked={quiz.adaptive} disabled={busy} onChange={e => void act(() => onToggleAdaptive(e.target.checked))} /><span>Adaptive</span></label>
    </div>
    <div className="quiz-body">
      {feedback ? <div className={`quiz-feedback ${feedback.correct ? 'is-correct' : 'is-incorrect'}`}>
        <div className="quiz-question-meta"><span>{feedback.topic}</span><span>{['Foundation', 'Application', 'Challenge'][feedback.difficulty - 1]}</span></div>
        <div role="heading" aria-level={4} className="quiz-question"><RichMarkdown text={feedback.prompt} /></div>
        <p className="quiz-verdict" role="status">{feedback.correct ? '✓ Correct' : 'That choice is incorrect'}</p>
        {feedback.choices ? <div className="quiz-revealed-choices" aria-label="Answers and explanations">{feedback.choices.map((option, index) => <div className={`quiz-revealed-choice ${option.correct ? 'is-right' : 'is-wrong'} ${option.selected ? 'was-selected' : ''}`} key={index}>
          <div className="quiz-revealed-answer"><span className="quiz-choice-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span><div><RichMarkdown text={option.text} /></div></div>
          <span className="quiz-answer-state">{option.correct ? '✓ Correct' : 'Incorrect'}{option.selected ? ' · Your answer' : ''}</span>
          <div className="quiz-choice-rationale"><RichMarkdown text={option.explanation} />{sourceLinks(option.sources)}</div>
        </div>)}</div> : !feedback.correct && <div className="quiz-answer-review"><span>Your answer</span><RichMarkdown text={feedback.submitted} /><span>Correct answer</span><RichMarkdown text={feedback.answer} /></div>}
        <div className="quiz-overall-explanation">
        <RichMarkdown text={feedback.explanation} />
        {sourceLinks(feedback.sources)}</div>
        <button type="button" className="quiz-primary" disabled={busy} onClick={() => { setDismissedResult(feedback.questionId); requestAnimationFrame(() => questionTitle.current?.focus()); }}>{current ? 'Next question' : 'See results'} <span aria-hidden="true">→</span></button>
      </div> : current ? <form onSubmit={e => { e.preventDefault(); if (busyRef.current || current.kind !== 'short' || !text.trim()) return; void act(() => onAnswer({ quizId: quiz.id, questionId: current.id, text })); }}>
        <div className="quiz-question-meta"><span>{current.topic}</span><span>{['Foundation', 'Application', 'Challenge'][current.difficulty - 1]}</span></div>
        <div ref={questionTitle} role="heading" aria-level={4} tabIndex={-1} className="quiz-question"><RichMarkdown text={current.prompt} /></div>
        {current.kind === 'choice' ? <><p className="quiz-answer-cue">Choose an answer to see why every option is right or wrong.</p><div className="quiz-choices" role="group" aria-label="Choose an answer">{current.choices!.map((option, index) => <button type="button" className={`quiz-choice ${choice === index ? 'is-selected' : ''}`} key={index} disabled={busy} onClick={() => { if (busyRef.current) return; setChoice(index); void act(() => onAnswer({ quizId: quiz.id, questionId: current.id, choiceIndex: index })); }}>
          <span className="quiz-choice-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span><div><RichMarkdown text={option} /></div>
        </button>)}</div></> : <label className="quiz-short-answer"><span>Your answer</span><input type="text" value={text} maxLength={2000} disabled={busy} autoComplete="off" onChange={e => setText(e.target.value)} placeholder="A word or a short phrase" /><small>Press Enter to check your answer. Use concise wording that matches an accepted answer.</small></label>}
      </form> : <div className="quiz-summary"><span className="quiz-eyebrow">Quiz complete</span><h4>{quiz.stats.correct} / {quiz.stats.answered} correct</h4><p>Best streak: {quiz.stats.bestStreak}. {quiz.adaptive ? 'Adaptive practice can add questions when your answers or conversation suggest a useful next exercise.' : 'Ask for another quiz when you are ready.'}</p>
        {quiz.stats.topics.length > 0 && <ul className="quiz-topics" aria-label="Performance by topic">{quiz.stats.topics.map(topic => <li key={topic.topic}><span>{topic.topic}</span><strong>{topic.correct}/{topic.answered}</strong></li>)}</ul>}
      </div>}
      {error && <p className="quiz-error" role="alert">{error}</p>}
    </div>
  </section>;
}
