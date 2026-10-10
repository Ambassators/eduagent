import { useEffect, useRef, useState } from 'react';
import type { QuizAnswerInput, QuizAnswerResult, QuizSource, QuizState } from '../quiz';
import Icon from './Icon';
import { RichMarkdown } from './RichText';
import './quiz.css';

export interface QuizPanelProps {
  state: QuizState;
  onAnswer: (input: QuizAnswerInput) => Promise<unknown>;
  onToggleAdaptive: (enabled: boolean) => Promise<unknown>;
  onClose: () => Promise<unknown>;
  onSkipFollowUp: () => Promise<unknown>;
  onOpenSource: (source: QuizSource) => Promise<unknown>;
}

type Quiz = NonNullable<QuizState['quiz']>;
const LEVELS = ['Foundation', 'Application', 'Challenge'] as const;
const letter = (index: number) => String.fromCharCode(65 + index);
/** Above this many questions the progress track becomes one continuous bar. */
const MAX_SEGMENTS = 20;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
}

export default function QuizPanel({ state, onAnswer, onToggleAdaptive, onClose, onSkipFollowUp, onOpenSource }: QuizPanelProps) {
  const quiz = state.quiz;
  const current = quiz?.current;
  const [choice, setChoice] = useState<number | null>(null), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  /** Per-question outcomes seen in this session, so the progress track can colour each step. */
  const [history, setHistory] = useState<{ quizId: string; results: boolean[] }>({ quizId: '', results: [] });
  const busyRef = useRef(false);
  const questionRef = useRef<HTMLDivElement>(null), bodyRef = useRef<HTMLDivElement>(null), nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setChoice(null); setText(''); setError(''); }, [quiz?.id, current?.id]);
  useEffect(() => { setDismissedResult(null); }, [quiz?.id]);
  useEffect(() => {
    const result = quiz?.lastResult;
    if (!quiz || !result) return;
    setHistory(old => {
      const results = old.quizId === quiz.id ? old.results.slice() : [];
      results[quiz.answered - 1] = result.correct;
      return { quizId: quiz.id, results };
    });
  }, [quiz?.id, quiz?.lastResult?.questionId, quiz?.answered]);

  const feedback = quiz?.lastResult && quiz.lastResult.questionId !== dismissedResult ? quiz.lastResult : null;
  const view = !quiz ? null : feedback ? 'feedback' : current ? 'question' : 'summary';
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); if (view === 'feedback') nextRef.current?.focus({ preventScroll: true }); }, [view, current?.id, feedback?.questionId]);

  async function act(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function pick(index: number) {
    if (!quiz || !current || busyRef.current) return;
    setChoice(index);
    void act(() => onAnswer({ quizId: quiz.id, questionId: current.id, choiceIndex: index }));
  }
  function advance() {
    if (!feedback) return;
    setDismissedResult(feedback.questionId);
    requestAnimationFrame(() => questionRef.current?.focus({ preventScroll: true }));
  }

  // A–Z or 1–9 pick a choice; Enter moves on from feedback. Typing anywhere else in the app is left alone.
  useEffect(() => {
    if (view !== 'question' && view !== 'feedback') return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTyping(event.target)) return;
      if (view === 'question' && current?.kind === 'choice' && current.choices) {
        const key = event.key.toUpperCase();
        const index = /^[1-9]$/.test(key) ? Number(key) - 1 : /^[A-Z]$/.test(key) ? key.charCodeAt(0) - 65 : -1;
        if (index >= 0 && index < current.choices.length) { event.preventDefault(); pick(index); }
      } else if (view === 'feedback' && event.key === 'Enter' && !quiz?.followUpPending && (event.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        event.preventDefault(); advance();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (!quiz) return null;
  const results = history.quizId === quiz.id ? history.results : [];
  const sources = (list?: QuizSource[]) => list?.length ? <div className="qz-sources" aria-label="Teaching passages">{list.map((source, index) =>
    <button type="button" key={`${source.fileId}:${source.page}:${index}`} disabled={busy} onClick={() => void act(() => onOpenSource(source))} aria-label={`${source.label}, page ${source.page}`} title={source.quote ?? `Open page ${source.page}`}>
      <Icon name="file" size={12} /><span className="qz-source-label">{source.label}</span><span className="qz-source-page">p.{source.page}</span>
    </button>)}</div> : null;

  return <section className={`qz is-${view}`} aria-label={`Quiz: ${quiz.title}`} aria-busy={busy}>
    <header className="qz-head">
      <div className="qz-title">
        <h3 title={quiz.title}>{quiz.title}</h3>
        <p><span className="qz-count">{Math.min(quiz.answered + (view === 'question' ? 1 : 0), quiz.total)}<span>/{quiz.total}</span></span>{quiz.followUps && <span className="qz-pill">Follow-ups</span>}</p>
      </div>
      <button type="button" className="icon-button qz-close" title="Close quiz" aria-label="Close quiz" disabled={busy} onClick={() => void act(onClose)}><Icon name="close" size={15} /></button>
    </header>

    <Progress quiz={quiz} results={results} onQuestion={view === 'question'} />

    <div className="qz-stats" aria-label="Live performance">
      <Stat label="Accuracy" value={quiz.stats.accuracy === null ? '—' : `${quiz.stats.accuracy}%`} />
      <Stat label="Streak" value={String(quiz.stats.streak)} hot={quiz.stats.streak >= 3} />
      <label className="qz-switch" title="Let the coach add questions that target what you miss">
        <input type="checkbox" role="switch" checked={quiz.adaptive} disabled={busy} onChange={e => void act(() => onToggleAdaptive(e.target.checked))} />
        <span className="qz-switch-track" aria-hidden="true"><span /></span>
        <span>Adaptive</span>
      </label>
    </div>

    <div className="qz-body" ref={bodyRef}>
      {view === 'question' && current && <form key={current.id} className="qz-step" onSubmit={e => { e.preventDefault(); if (busyRef.current || current.kind !== 'short' || !text.trim()) return; void act(() => onAnswer({ quizId: quiz.id, questionId: current.id, text })); }}>
        <Meta followUp={current.followUp} topic={current.topic} difficulty={current.difficulty} />
        <div ref={questionRef} role="heading" aria-level={4} tabIndex={-1} className="qz-prompt"><RichMarkdown text={current.prompt} /></div>
        {current.kind === 'choice' ? <div className="qz-choices" role="group" aria-label="Choose an answer">
          {current.choices!.map((option, index) => <button type="button" key={index} className={`qz-choice ${choice === index ? 'is-picked' : ''}`} disabled={busy} aria-keyshortcuts={letter(index)} onClick={() => pick(index)}>
            <span className="qz-key" aria-hidden="true">{busy && choice === index ? <span className="loading-ring" /> : letter(index)}</span>
            <div className="qz-choice-text"><RichMarkdown text={option} /></div>
          </button>)}
        </div> : <div className="qz-short">
          <label htmlFor={`qz-answer-${current.id}`} className="qz-label">Your answer</label>
          <div className="qz-input">
            <input id={`qz-answer-${current.id}`} type="text" value={text} maxLength={2000} disabled={busy} autoComplete="off" autoFocus onChange={e => setText(e.target.value)} placeholder="A word or short phrase" />
            <button type="submit" className="qz-submit" disabled={busy || !text.trim()} aria-label="Check answer">{busy ? <span className="loading-ring" /> : <Icon name="arrow-right" size={16} />}</button>
          </div>
          <small>Keep it concise. Press <kbd>Enter</kbd> to check.</small>
        </div>}
        {current.kind === 'choice' && <p className="qz-hint">Press <kbd>A</kbd>–<kbd>{letter(current.choices!.length - 1)}</kbd> to answer. Every option is explained afterwards.</p>}
      </form>}

      {view === 'feedback' && feedback && <Feedback key={feedback.questionId} feedback={feedback} sources={sources} />}

      {view === 'summary' && <Summary quiz={quiz} />}

      {error && <p className="qz-error" role="alert"><Icon name="close" size={13} />{error}</p>}
    </div>

    {view === 'feedback' && feedback && <footer className="qz-foot">
      {quiz.followUpPending ? <div className="qz-wait" role="status">
        <span className="loading-ring" aria-hidden="true" />
        <span>{feedback.correct ? 'Writing a harder follow-up…' : 'Writing a follow-up on this idea…'}</span>
        <button type="button" disabled={busy} onClick={() => void act(onSkipFollowUp)}>Skip</button>
      </div> : <button type="button" ref={nextRef} className="qz-next" disabled={busy} onClick={advance}>
        <span>{current ? current.followUp ? 'Follow-up question' : 'Next question' : 'See results'}</span>
        <span className="qz-next-hint"><kbd>↵</kbd><Icon name="arrow-right" size={16} /></span>
      </button>}
    </footer>}
  </section>;
}

function Progress({ quiz, results, onQuestion }: { quiz: Quiz; results: boolean[]; onQuestion: boolean }) {
  const label = { role: 'progressbar', 'aria-label': 'Questions answered', 'aria-valuemin': 0, 'aria-valuemax': quiz.total, 'aria-valuenow': quiz.answered } as const;
  if (quiz.total > MAX_SEGMENTS) return <div className="qz-track is-bar" {...label}><span style={{ width: `${quiz.total ? quiz.answered / quiz.total * 100 : 0}%` }} /></div>;
  return <div className="qz-track" {...label}>{Array.from({ length: quiz.total }, (_, index) => {
    const state = index < quiz.answered ? results[index] === true ? 'is-right' : results[index] === false ? 'is-wrong' : 'is-done' : index === quiz.answered && onQuestion ? 'is-now' : '';
    return <span key={index} className={state} />;
  })}</div>;
}

function Stat({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return <div className={`qz-stat ${hot ? 'is-hot' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function Meta({ followUp, topic, difficulty }: { followUp?: boolean; topic: string; difficulty: 1 | 2 | 3 }) {
  return <div className="qz-meta">
    {followUp && <span className="qz-tag is-accent">Follow-up</span>}
    <span className="qz-topic" title={topic}>{topic}</span>
    <span className="qz-level" title={`Difficulty: ${LEVELS[difficulty - 1]}`}>
      <span className="qz-pips" aria-hidden="true">{[1, 2, 3].map(level => <i key={level} className={level <= difficulty ? 'on' : ''} />)}</span>
      {LEVELS[difficulty - 1]}
    </span>
  </div>;
}

function Feedback({ feedback, sources }: { feedback: QuizAnswerResult; sources: (list?: QuizSource[]) => React.ReactNode }) {
  return <div className={`qz-step qz-result ${feedback.correct ? 'is-right' : 'is-wrong'}`}>
    <div className="qz-verdict" role="status">
      <span className="qz-verdict-mark" aria-hidden="true"><Icon name={feedback.correct ? 'check' : 'close'} size={18} /></span>
      <div><strong>{feedback.correct ? 'Correct' : 'Not quite'}</strong><span>{feedback.correct ? 'Nicely done.' : 'Here is what to take away.'}</span></div>
    </div>
    <Meta topic={feedback.topic} difficulty={feedback.difficulty} />
    <div role="heading" aria-level={4} className="qz-prompt is-recap"><RichMarkdown text={feedback.prompt} /></div>

    {feedback.choices ? <ol className="qz-review" aria-label="Answers and explanations">
      {feedback.choices.map((option, index) => <li key={index} className={`qz-option ${option.correct ? 'is-right' : option.selected ? 'is-wrong' : ''} ${option.selected ? 'is-picked' : ''}`}>
        <div className="qz-option-head">
          <span className="qz-key" aria-hidden="true">{option.correct ? <Icon name="check" size={12} /> : option.selected ? <Icon name="close" size={12} /> : letter(index)}</span>
          <div className="qz-choice-text"><RichMarkdown text={option.text} /></div>
          {(option.selected || option.correct) && <span className="qz-badge">{option.selected ? 'Your answer' : 'Answer'}</span>}
        </div>
        <div className="qz-why"><RichMarkdown text={option.explanation} />{sources(option.sources)}</div>
      </li>)}
    </ol> : <div className="qz-compare">
      <div className={`qz-compare-row ${feedback.correct ? 'is-right' : 'is-wrong'}`}><span className="qz-label">Your answer</span><RichMarkdown text={feedback.submitted} /></div>
      {!feedback.correct && <div className="qz-compare-row is-right"><span className="qz-label">Correct answer</span><RichMarkdown text={feedback.answer} /></div>}
    </div>}

    {(feedback.explanation || feedback.sources?.length) && <div className="qz-explain">
      <span className="qz-label">Why it matters</span>
      <RichMarkdown text={feedback.explanation} />
      {sources(feedback.sources)}
    </div>}
  </div>;
}

function Summary({ quiz }: { quiz: Quiz }) {
  const { stats } = quiz;
  const ratio = stats.answered ? stats.correct / stats.answered : 0;
  const radius = 44, circumference = 2 * Math.PI * radius;
  const message = !stats.answered ? 'No questions answered.' : ratio >= .9 ? 'Excellent work.' : ratio >= .7 ? 'Solid understanding.' : ratio >= .4 ? 'Getting there.' : 'Worth another pass.';
  const note = quiz.adaptive ? quiz.followUps ? 'Follow-ups are finished for this quiz. Ask for another quiz when you are ready.' : 'Adaptive practice can add questions when your answers or conversation suggest a useful next exercise.' : 'Ask for another quiz when you are ready.';
  return <div className="qz-step qz-summary">
    <div className="qz-score">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} className="qz-ring-bg" />
        <circle cx="50" cy="50" r={radius} className="qz-ring" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
      </svg>
      <div><strong>{Math.round(ratio * 100)}<small>%</small></strong><span>{stats.correct} of {stats.answered}</span></div>
    </div>
    <h4>{message}</h4>
    <p>{note}</p>
    <div className="qz-summary-stats">
      <Stat label="Best streak" value={String(stats.bestStreak)} />
      <Stat label="Avg. time" value={stats.averageSeconds === null ? '—' : `${Math.round(stats.averageSeconds)}s`} />
      <Stat label="Answered" value={String(stats.answered)} />
    </div>
    {stats.topics.length > 0 && <div className="qz-topics">
      <span className="qz-label">By topic</span>
      <ul aria-label="Performance by topic">{stats.topics.map(topic => <li key={topic.topic}>
        <div><span title={topic.topic}>{topic.topic}</span><strong>{topic.correct}/{topic.answered}</strong></div>
        <span className="qz-bar" aria-hidden="true"><span className={topic.accuracy >= 70 ? 'is-right' : topic.accuracy >= 40 ? 'is-mid' : 'is-wrong'} style={{ width: `${Math.max(topic.accuracy, 3)}%` }} /></span>
      </li>)}</ul>
    </div>}
  </div>;
}
