import { useEffect, useRef, useState } from 'react';
import type { ToolActivity } from '../shared';
import Icon from './Icon';
import { Orb } from './Orb';

export interface ThinkJob { id: string; message: string; startedAt: number }
type Stage = 'hidden' | 'working' | 'done' | 'leaving';

/** A mini orb the big orb spits out while Think works; click it to see the steps so far. */
export function ThinkOrb({ busy, delegating, compacting, queued, job, activities: allActivities, preview, onStop, onOpenThink, onSpit }: {
  busy: boolean; delegating: boolean; compacting: boolean; queued: number; job: ThinkJob | null; activities: ToolActivity[]; preview: string;
  onStop: () => void; onOpenThink: () => void; onSpit: () => void;
}) {
  // Voice requests start in the delegation bridge, which may run quiz/PDF tools itself without ever queuing Think.
  const working = busy || delegating || compacting;
  const [stage, setStage] = useState<Stage>(working ? 'working' : 'hidden');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const stageRef = useRef(stage); stageRef.current = stage;
  const [startedAt, setStartedAt] = useState(Date.now());
  // working → done (a brief check) → leaving (sucked back in) → hidden. An open card holds the check until it closes.
  useEffect(() => {
    if (working) { if (stageRef.current === 'hidden' || stageRef.current === 'leaving') { onSpit(); setStartedAt(Date.now()); } setStage('working'); }
    else if (stageRef.current === 'working') { setNow(Date.now()); setStage('done'); }
  }, [working, onSpit]);
  useEffect(() => {
    if (stage === 'done' && !open) { const timer = setTimeout(() => setStage('leaving'), 1100); return () => clearTimeout(timer); }
    if (stage === 'leaving') { const timer = setTimeout(() => setStage(old => old === 'leaving' ? 'hidden' : old), 380); return () => clearTimeout(timer); }
  }, [stage, open]);
  useEffect(() => { if (stage === 'hidden' || stage === 'leaving') setOpen(false); }, [stage]);
  useEffect(() => { if (!open || !working) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [open, working]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', away); window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  if (stage === 'hidden') return null;
  // Only this run's steps; a Think job counts if it started during it (a queued one may start a moment later).
  const activities = allActivities.filter(item => item.time >= startedAt - 500);
  const task = job && job.startedAt >= startedAt - 500 ? job.message : '';
  const running = [...activities].reverse().find(item => item.status === 'running');
  const step = running && `${running.name.replaceAll('_', ' ')}${running.detail ? ` · ${running.detail}` : ''}`;
  const current = compacting ? 'Compacting context' : step ? step.charAt(0).toUpperCase() + step.slice(1) : stage === 'done' ? 'Finished' : preview ? 'Writing a reply' : busy ? 'Reasoning' : 'Working on your request';
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const label = stage === 'done' ? 'Think finished' : `Think is working: ${current}. Show details`;
  return <div className="think-orb-root" ref={root}>
    <div className={`think-orb-anchor ${stage}`}><button type="button" className="think-orb" data-tone={stage === 'done' ? 'speaking' : 'on'} aria-label={label} title={current} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setNow(Date.now()); setOpen(value => !value); }}>
      <Orb tone="on" />
      {stage === 'done' ? <Icon name="check" size={14} /> : <span className="orb-spinner" />}
    </button></div>
    {open && <div className="think-orb-card" role="dialog" aria-label="What Think is doing">
      <header>
        <span className="section-label"><span>{stage === 'done' ? 'Done' : 'Thinking'}</span><span>{seconds}s</span></span>
        {working && busy && <button type="button" className="icon-button" title="Stop Think" onClick={onStop}><Icon name="stop" size={11} /></button>}
      </header>
      {task && <p className="think-orb-task" title={task}>{task}</p>}
      {/* A running tool is already the highlighted step below; otherwise say what it is doing in one line. */}
      {(!step || compacting) && <p className="think-orb-now" aria-live="polite">{stage !== 'done' && <i className="writing-dot" />}<span>{current}</span></p>}
      {!!activities.length && <ol className="think-orb-steps">{activities.slice(-4).map(item => <li key={item.id} className={item.status}>
        <i /><span>{item.name.replaceAll('_', ' ')}{item.detail && <small>{item.detail}</small>}</span>
      </li>)}</ol>}
      {preview && <p className="think-orb-preview"><span>{preview.length > 160 ? `…${preview.slice(-160)}` : preview}</span></p>}
      <footer>
        {queued > 0 && <span>{queued} more queued</span>}
        <button type="button" onClick={() => { setOpen(false); onOpenThink(); }}>Show in transcript <Icon name="arrow-right" size={10} /></button>
      </footer>
    </div>}
  </div>;
}
