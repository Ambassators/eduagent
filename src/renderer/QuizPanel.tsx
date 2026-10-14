import { Component, createRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { QuizAnswerInput, QuizAnswerResult, QuizQuestionView, QuizSource, QuizState } from '../quiz';
import Icon from './Icon';
import { RichMarkdown } from './RichText';
import './quiz.css';

export interface QuizPanelProps {
  state: QuizState;
  onSetMaxQuestions: (count: number) => Promise<unknown>;
  onAnswer: (input: QuizAnswerInput) => Promise<unknown>;
  onClose: () => Promise<unknown>;
  onOpenSource: (source: QuizSource) => Promise<unknown>;
}

type Quiz = NonNullable<QuizState['quiz']>;
const CHOICE_KEYS = ['A', 'S', 'D', 'F', 'G', 'H'];
const choiceKey = (index: number) => CHOICE_KEYS[index];


function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
}
function message(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
}

function AnswerText({ text }: { text: string }) {
  // A standalone numeric answer such as "100." is text, not an empty Markdown list.
  const markdown = text.replace(/^(\s*\d+)([.)])(\s*)$/, '$1\\$2$3');
  return <RichMarkdown text={markdown} />;
}

/** One column for the whole quiz: the question stays in place while it is checked, explained, and replaced. */
export default function QuizPanel({ state, onAnswer, onSetMaxQuestions, onClose, onOpenSource }: QuizPanelProps) {
  const quiz = state.quiz;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  /** Outcomes seen in this session, so each progress segment can show right or wrong. */
  const [history, setHistory] = useState<{ quizId: string; results: boolean[] }>({ quizId: '', results: [] });
  /** The question as it was asked; once answered the engine has already moved `current` on. */
  const asked = useRef<QuizQuestionView | null>(null);
  const busyRef = useRef(false), scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { setDismissed(null); }, [quiz?.id]);
  useEffect(() => {
    const result = quiz?.lastResult;
    if (!quiz || !result) return;
    setHistory(old => {
      const results = old.quizId === quiz.id ? old.results.slice() : [];
      results[quiz.answered - 1] = result.correct;
      return { quizId: quiz.id, results };
    });
  }, [quiz?.id, quiz?.lastResult?.questionId, quiz?.answered]);

  const feedback = quiz?.lastResult && quiz.lastResult.questionId !== dismissed ? quiz.lastResult : null;
  if (quiz?.current && !feedback) asked.current = quiz.current;
  const question = feedback ? asked.current?.id === feedback.questionId ? asked.current : fromResult(feedback) : quiz?.current ?? null;
  const view = !quiz ? null : question ? 'question' : 'summary';

  useEffect(() => { setError(''); scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }); }, [question?.id, view]);

  async function act(operation: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { setError(message(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  if (!quiz) return null;
  const results = history.quizId === quiz.id ? history.results : [];
  return <div className="qz-shell"><div className="qz-scroll" ref={scroller}><div className="qz-stage">
    <Column label={`Quiz: ${quiz.title}`} busy={busy}><Swap id={view!}>
      {view === 'question' && question ? <Question quiz={quiz} question={question} feedback={feedback} results={results} busy={busy} error={error} onSetMaxQuestions={onSetMaxQuestions}
        onCheck={answer => void act(() => onAnswer({ quizId: quiz.id, questionId: question.id, ...answer }))}
        onNext={() => setDismissed(feedback!.questionId)}
        onOpenSource={source => void act(() => onOpenSource(source))} />
        : <Summary quiz={quiz} busy={busy} error={error} onClose={() => void act(onClose)} />}
    </Swap></Column>
  </div></div><GenerationStatus quiz={quiz}/></div>;
}

function fromResult(result: QuizAnswerResult): QuizQuestionView {
  return { id: result.questionId, kind: result.choices ? 'choice' : 'short', prompt: result.prompt, topic: result.topic, difficulty: result.difficulty, choices: result.choices?.map(choice => choice.text) };
}

/**
 * One persistent shell whose height glides to fit its content (after NearKey's login card). Setting a new height
 * mid-transition lets CSS retarget from the current size, so interrupted changes never jump or flash auto height.
 * The first view, fonts included, renders at its final size; motion is enabled only after that.
 */
function Column({ label, busy, children }: { label: string; busy: boolean; children: ReactNode }) {
  const shell = useRef<HTMLElement>(null), inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = shell.current!, content = inner.current!;
    let height: number | null = null, frame = 0, live = true;
    const measure = () => {
      const target = content.getBoundingClientRect().height;
      if (height !== null && Math.abs(target - height) < .5) return;
      height = target;
      element.style.height = `${target}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (live) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { element.dataset.motion = 'ready'; }); });
    });
    return () => { live = false; observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <section ref={shell} className="qz-column" aria-label={label} aria-busy={busy}>
    <div ref={inner}>{children}</div>
  </section>;
}

/**
 * Replaces content without a blank frame. When `id` changes, a still copy of the outgoing view fades out in place
 * (out of layout, so the column can already glide to the new height) before the incoming view fades in.
 * Content whose `id` stays the same updates in place.
 */
class Swap extends Component<{ id: string; children: ReactNode }> {
  private live = createRef<HTMLDivElement>();
  private ghosts = createRef<HTMLDivElement>();
  private timer = 0;
  getSnapshotBeforeUpdate(previous: { id: string }) {
    const live = this.live.current;
    if (previous.id === this.props.id || !live || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const copy = live.cloneNode(true) as HTMLElement;
    // Start from what is on screen now, even when the previous swap is still fading in.
    copy.style.opacity = getComputedStyle(live).opacity;
    return copy;
  }
  componentDidUpdate(_props: unknown, _state: unknown, copy: HTMLElement | null) {
    if (!copy) return;
    const live = this.live.current!, layer = this.ghosts.current!;
    clearTimeout(this.timer);
    copy.className = 'qz-ghost';
    copy.inert = true;
    layer.replaceChildren(copy);
    live.classList.remove('is-entering');
    void live.offsetWidth;
    live.classList.add('is-entering');
    this.timer = window.setTimeout(() => { layer.replaceChildren(); live.classList.remove('is-entering'); }, 1200);
  }
  componentWillUnmount() { clearTimeout(this.timer); }
  render() {
    return <div className="qz-swap">
      <div ref={this.ghosts} className="qz-ghosts" aria-hidden="true" />
      <div ref={this.live}>{this.props.children}</div>
    </div>;
  }
}

function QuestionCount({quiz,position,onSetMaxQuestions}:{quiz:Quiz;position:number;onSetMaxQuestions:(count:number)=>Promise<unknown>}) {
  const [editing,setEditing]=useState(false),[value,setValue]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const begin=()=>{setValue(String(quiz.maxQuestions??quiz.total));setError('');setEditing(true);};
  const save=async()=>{setSaving(true);setError('');try{await onSetMaxQuestions(Number(value));setEditing(false);}catch(e){setError(message(e));}finally{setSaving(false);}};
  if(editing)return <form className="qz-count-editor" onSubmit={event=>{event.preventDefault();void save();}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();setEditing(false);}}}>
    <label>Maximum <input aria-label="Maximum questions" type="number" min={quiz.total} max={100} value={value} disabled={saving} autoFocus onChange={event=>setValue(event.target.value)}/></label>
    <button type="submit" disabled={saving||!value} aria-label="Save maximum questions"><Icon name="check" size={14}/></button>
    <button type="button" aria-label="Cancel editing maximum" onClick={()=>setEditing(false)}><Icon name="close" size={14}/></button>
    {error&&<span role="alert">{error}</span>}
  </form>;
  return <button type="button" className="qz-count" title="Double-click to edit the maximum questions" onDoubleClick={begin} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();begin();}}}>Question {position} <span>of {quiz.maxQuestions??quiz.total}</span></button>;
}

function Progress({ quiz, results, position }: { quiz: Quiz; results: boolean[]; position: number }) {
  const total=quiz.maxQuestions??quiz.total;
  const aria = { role: 'progressbar', 'aria-label': 'Questions answered', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': quiz.answered, 'aria-valuetext': `${quiz.answered} answered, ${quiz.total} generated, ${total} maximum` } as const;
  return <div className="qz-progress" {...aria}>{Array.from({ length: total }, (_, index) =>
    <span key={index} title={`Question ${index+1}: ${index<quiz.answered?'answered':index<quiz.total?'generated':'not generated yet'}`} className={index < quiz.answered ? results[index] === true ? 'is-right' : results[index] === false ? 'is-wrong' : 'is-done' : index === position-1 ? 'is-now' : index<quiz.total?'is-ready':'is-unready'} />)}
  </div>;
}

interface QuestionProps {
  quiz: Quiz; question: QuizQuestionView; feedback: QuizAnswerResult | null; results: boolean[]; busy: boolean; error: string;
  onSetMaxQuestions: (count:number)=>Promise<unknown>;
  onCheck: (answer: { choiceIndex: number } | { text: string }) => void;
  onNext: () => void; onOpenSource: (source: QuizSource) => void;
}

function Question({ quiz, question, feedback, results, busy, error, onSetMaxQuestions, onCheck, onNext, onOpenSource }: QuestionProps) {
  const [choice, setChoice] = useState<number | null>(null), [text, setText] = useState('');
  // The component persists between questions so the header and actions never blink; only per-question input resets.
  const [shown, setShown] = useState(question.id);
  if (shown !== question.id) { setShown(question.id); setChoice(null); setText(''); }
  const prompt = useRef<HTMLDivElement>(null), next = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  const answered = !!feedback;
  const position = answered ? quiz.answered : quiz.answered + 1;
  const ready = question.kind === 'choice' ? choice !== null : !!text.trim();

  const check = () => {
    if (answered || busy || !ready) return;
    onCheck(question.kind === 'choice' ? { choiceIndex: choice! } : { text });
  };
  useEffect(() => { (question.kind === 'short' ? input.current : prompt.current)?.focus({ preventScroll: true }); }, [question.id]);
  useEffect(() => { if (answered) next.current?.focus({ preventScroll: true }); }, [answered]);

  // A/S/D/F/G/H or 1–6 select a choice, Enter checks it and then moves on. Typing elsewhere in the app is left alone.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [popover]:popover-open') || event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTyping(event.target)) return;
      const target = event.target as HTMLElement | null;
      if (event.key === 'Enter') {
        if (target?.tagName === 'BUTTON' && !target.dataset.option && target !== next.current) return;
        if (!answered && ready) { event.preventDefault(); check(); }
        else if (answered) { event.preventDefault(); onNext(); }
        return;
      }
      if (answered || busy || question.kind !== 'choice') return;
      const key = event.key.toUpperCase();
      const index = /^[1-9]$/.test(key) ? Number(key) - 1 : CHOICE_KEYS.indexOf(key);
      if (index >= 0 && index < question.choices!.length) { event.preventDefault(); setChoice(index); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const nextLabel = quiz.current ? 'Next question' : 'See results';
  return <div className={`qz-step ${answered ? feedback.correct ? 'is-right' : 'is-wrong' : ''}`}>
    <header className="qz-top">
      <QuestionCount quiz={quiz} position={position} onSetMaxQuestions={onSetMaxQuestions}/>
      <span className="qz-topic" title={question.topic}>{question.topic}</span>
    </header>
    <Progress quiz={quiz} results={results} position={position} />

    <Swap id={question.id}>
    <div ref={prompt} className="qz-prompt qz-inline" role="heading" aria-level={2} tabIndex={-1}>
      <RichMarkdown text={question.prompt} />
      {answered && <Footnotes list={feedback.sources} start={1} busy={busy} onOpen={onOpenSource} />}
    </div>

    {question.kind === 'choice'
      ? answered ? <Review feedback={feedback} onOpenSource={onOpenSource} busy={busy} />
        : <div className="qz-options" role="radiogroup" aria-label="Answers">
          {question.choices!.map((option, index) => <button key={index} type="button" role="radio" aria-checked={choice === index} data-option="true" aria-keyshortcuts={choiceKey(index)}
            className={`qz-option ${choice === index ? 'is-selected' : ''}`} disabled={busy} onClick={() => setChoice(index)}>
            <span className="qz-key" aria-hidden="true">{choiceKey(index)}</span>
            <span className="qz-option-text"><AnswerText text={option} /></span>
          </button>)}
        </div>
      : answered ? <ShortReview feedback={feedback} />
        : <form className="qz-short" onSubmit={event => { event.preventDefault(); check(); }}>
          <label htmlFor={`qz-answer-${question.id}`}>Your answer</label>
          <input ref={input} id={`qz-answer-${question.id}`} type="text" value={text} maxLength={2000} disabled={busy} autoComplete="off" spellCheck={false}
            placeholder="Type a word or short phrase" onChange={event => setText(event.target.value)} />
        </form>}
    </Swap>

    <footer className="qz-actions">
      {error && <p className="qz-error" role="alert"><Icon name="close" size={14} />{error}</p>}
      <div className="qz-action-row">
        <Swap id={answered ? `verdict:${question.id}` : 'hint'}>{answered
          ? <p className="qz-verdict" role="status"><span aria-hidden="true"><Icon name={feedback.correct ? 'check' : 'close'} size={14} /></span>{feedback.correct ? 'Correct' : 'Not quite'}</p>
          : <p className="qz-hint">{question.kind === 'choice'
            ? <>Press {question.choices!.map((_, index) => <span key={index}>{index > 0 && "/"}<kbd>{choiceKey(index)}</kbd></span>)} then <kbd>Enter</kbd></>
            : <>Press <kbd>Enter</kbd> to check</>}</p>}</Swap>
        {answered
          ? <button ref={next} type="button" className="qz-button is-primary" onClick={onNext}>{nextLabel}<Icon name="arrow-right" size={16} /></button>
          : <button type="button" className="qz-button is-primary" disabled={busy || !ready} onClick={check}>{busy ? <><span className="loading-ring" aria-hidden="true" />Checking</> : 'Check'}</button>}
      </div>
    </footer>
  </div>;
}

/** The asked options, now marked: a green check on the answer, a red X on a wrong pick. */
function Review({ feedback, busy, onOpenSource }: { feedback: QuizAnswerResult; busy: boolean; onOpenSource: (source: QuizSource) => void }) {
  const [others, setOthers] = useState(false);
  const choices = feedback.choices!;
  const hidden = choices.filter(option => !option.correct && !option.selected && option.explanation).length;
  // Footnotes number on from the question's own markers, in reading order.
  const starts = choices.reduce<number[]>((list, _option, index) => [...list, index ? list[index - 1] + (choices[index - 1].sources?.length ?? 0) : 1 + (feedback.sources?.length ?? 0)], []);
  return <>
    <ul className="qz-options is-review" aria-label="Answers and explanations">
      {choices.map((option, index) => {
        const status = option.correct ? 'is-right' : option.selected ? 'is-wrong' : '';
        const explain = option.correct || option.selected || others;
        return <li key={index} className={`qz-option ${status}`}>
          <span className="qz-key" aria-hidden="true">{option.correct ? <Icon name="check" size={13} /> : option.selected ? <Icon name="close" size={13} /> : choiceKey(index)}</span>
          <div className="qz-option-text">
            <AnswerText text={option.text} />
            {(option.correct || option.selected) && <span className="qz-badge">{option.correct && option.selected ? 'Your answer · correct' : option.selected ? 'Your answer' : 'Correct answer'}</span>}
            {explain && (option.explanation || option.correct && feedback.explanation) && <div className="qz-why qz-inline">
              <RichMarkdown text={option.correct ? merge(option.explanation, feedback.explanation) : option.explanation} />
              <Footnotes list={option.sources} start={starts[index]} busy={busy} onOpen={onOpenSource} />
            </div>}
          </div>
        </li>;
      })}
    </ul>
    {hidden > 0 && <button type="button" className="qz-more" aria-expanded={others} onClick={() => setOthers(open => !open)}>
      {others ? 'Hide the other explanations' : `Why the other ${hidden === 1 ? 'option is' : 'options are'} wrong`}
      <span className={`qz-chevron ${others ? 'is-open' : ''}`} aria-hidden="true"><Icon name="right" size={14} /></span>
    </button>}
  </>;
}

/** The explanation sits with the correct answer, as it does for choice questions. */
function ShortReview({ feedback }: { feedback: QuizAnswerResult }) {
  const why = feedback.explanation ? <div className="qz-why"><RichMarkdown text={feedback.explanation} /></div> : null;
  return <div className="qz-options is-review">
    <div className={`qz-option ${feedback.correct ? 'is-right' : 'is-wrong'}`}>
      <span className="qz-key" aria-hidden="true"><Icon name={feedback.correct ? 'check' : 'close'} size={13} /></span>
      <div className="qz-option-text"><AnswerText text={feedback.submitted} /><span className="qz-badge">Your answer</span>{feedback.correct && why}</div>
    </div>
    {!feedback.correct && <div className="qz-option is-right">
      <span className="qz-key" aria-hidden="true"><Icon name="check" size={13} /></span>
      <div className="qz-option-text"><AnswerText text={feedback.answer} /><span className="qz-badge">Correct answer</span>{why}</div>
    </div>}
  </div>;
}

/** Adds the overall explanation to an option's rationale unless it only repeats it. */
function merge(rationale: string, explanation: string) {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!explanation.trim() || plain(rationale).includes(plain(explanation))) return rationale;
  return rationale.trim() ? `${rationale}\n\n${explanation}` : explanation;
}

/** Numbered superscript markers that open the teaching passage, in place of a separate sources block. */
function Footnotes({ list, start, busy, onOpen }: { list?: QuizSource[]; start: number; busy: boolean; onOpen: (source: QuizSource) => void }) {
  if (!list?.length) return null;
  return <sup className="qz-footnotes">{list.map((source, index) =>
    <button type="button" key={`${source.fileId}:${source.page}:${index}`} className="qz-fn" disabled={busy} onClick={() => onOpen(source)}
      aria-label={`Source ${start + index}: ${source.label}, page ${source.page}`} title={`${source.label} · p. ${source.page}${source.quote ? `\n“${source.quote}”` : ''}`}>{start + index}</button>)}
  </sup>;
}

function GenerationStatus({quiz}:{quiz:Quiz}) {
  const [details,setDetails]=useState(false);
  if(!quiz.adaptive||quiz.adaptiveMode!=='ai'||!quiz.coachBusy)return null;
  return <div className="qz-generation" data-details={details} onMouseEnter={()=>setDetails(true)} onMouseLeave={()=>setDetails(false)} onFocus={()=>setDetails(true)} onBlur={()=>setDetails(false)} tabIndex={0} aria-describedby="quiz-generation-details">
    <span className="qz-generation-label" role="status" aria-live="polite"><span className="qz-generation-dot" aria-hidden="true"/>Preparing questions…</span>
    <span id="quiz-generation-details" className="qz-generation-details" role="tooltip">The AI coach is reviewing your answers and discussion. {quiz.remaining} questions ready; it keeps 2–3 ahead and can replace future questions.</span>
  </div>;
}

function Summary({ quiz, busy, error, onClose }: { quiz: Quiz; busy: boolean; error: string; onClose: () => void }) {
  const { stats } = quiz;
  const ratio = stats.answered ? stats.correct / stats.answered : 0;
  const percent = Math.round(ratio * 100);
  const title = !stats.answered ? 'No questions answered' : ratio >= .9 ? 'Excellent work' : ratio >= .7 ? 'Solid understanding' : ratio >= .4 ? 'Getting there' : 'Worth another pass';
  const radius = 34, circumference = 2 * Math.PI * radius;
  const details = [stats.bestStreak > 1 && `Best streak ${stats.bestStreak}`, stats.averageSeconds !== null && `${Math.round(stats.averageSeconds)}s per question`].filter(Boolean).join(' · ');
  return <div className="qz-step qz-summary">
    <div className="qz-score">
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={radius} className="qz-ring-track" />
        <circle cx="40" cy="40" r={radius} className="qz-ring" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} style={{ ['--qz-ring-from' as string]: circumference }} />
      </svg>
      <strong>{percent}<small>%</small></strong>
    </div>
    <h2>{title}</h2>
    <p className="qz-summary-score">{stats.correct} of {stats.answered} correct</p>
    {details && <p className="qz-summary-details">{details}</p>}

    {stats.topics.length > 1 && <ul className="qz-topics" aria-label="Results by topic">{stats.topics.map(topic =>
      <li key={topic.topic}>
        <div><span title={topic.topic}>{topic.topic}</span><strong>{topic.correct}/{topic.answered}</strong></div>
        <span className="qz-bar" aria-hidden="true"><span className={topic.accuracy >= 70 ? 'is-right' : topic.accuracy >= 40 ? 'is-mid' : 'is-wrong'} style={{ width: `${Math.max(topic.accuracy, 3)}%` }} /></span>
      </li>)}
    </ul>}

    <footer className="qz-actions">
      {error && <p className="qz-error" role="alert"><Icon name="close" size={14} />{error}</p>}
      <div className="qz-action-row">
        <p className="qz-hint">{quiz.adaptive ? 'Adaptive practice may add questions here.' : ''}</p>
        <button type="button" className="qz-button" disabled={busy} onClick={onClose}>Close quiz</button>
      </div>
    </footer>
  </div>;
}
