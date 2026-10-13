import { useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import './floating-card.css';

/** A nonmodal result window that leaves the document layout intact. */
export default function FloatingCard({ title, kind, actions, children }: {
  title: string; kind: 'quiz' | 'presentation'; actions?: ReactNode; children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const place = (left: number, top: number) => {
    const element = card.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(12, Math.min(left, window.innerWidth - bounds.width - 12))}px`;
    element.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
  };
  useLayoutEffect(() => {
    const element = card.current!;
    const width = element.getBoundingClientRect().width;
    place(kind === 'quiz' ? window.innerWidth - width - 24 : (window.innerWidth - width) / 2 - 100, kind === 'quiz' ? 64 : 100);
    const fit = () => { const bounds = element.getBoundingClientRect(); place(bounds.left, bounds.top); };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [kind]);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const bounds = card.current!.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = drag.current;
    if (origin?.id === event.pointerId) place(origin.left + event.clientX - origin.x, origin.top + event.clientY - origin.y);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  return <section ref={card} className={`floating-card floating-${kind}`} role="region" aria-label={title}>
    <div className="floating-card-heading" tabIndex={0} aria-label={`Move ${title}`} title="Drag to move · arrow keys to reposition"
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const bounds = card.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        place(bounds.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          bounds.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
      }}>
      <span className="floating-card-grip" aria-hidden="true">⠿</span><h2 title={title}>{title}</h2>
      <div className="floating-card-actions">{actions}</div>
    </div>
    <div className="floating-card-body">{children}</div>
  </section>;
}
