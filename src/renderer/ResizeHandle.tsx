import type { PointerEvent as ReactPointerEvent } from 'react';

export type PaneSizes = { left?: number; right?: number; present?: number; tex?: number };
const SIZES_KEY = 'layout.paneSizes';
export const readPaneSizes = (): PaneSizes => { try { return JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') ?? {}; } catch { return {}; } };
export const writePaneSizes = (sizes: PaneSizes) => { try { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)); } catch {} };

/**
 * A grab strip on one edge of its parent pane. Dragging resizes the pane; `edge` is the side being dragged.
 * The pane takes space from `shrinks`, which always keeps at least `keep` px. Double-click restores the default size.
 */
export default function ResizeHandle({ edge, min, shrinks, keep, label, onResize }: { edge: 'left' | 'right' | 'top'; min: number; shrinks: string; keep: number; label: string; onResize: (size: number | undefined) => void }) {
  const vertical = edge === 'top';
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pane = event.currentTarget.parentElement, other = document.querySelector(shrinks);
    if (!pane) return;
    event.preventDefault();
    const handle = event.currentTarget, pointer = event.pointerId;
    const size = vertical ? pane.getBoundingClientRect().height : pane.getBoundingClientRect().width;
    const room = other ? Math.max(0, (vertical ? other.getBoundingClientRect().height : other.getBoundingClientRect().width) - keep) : 0;
    const origin = vertical ? event.clientY : event.clientX, direction = edge === 'right' ? 1 : -1;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const delta = ((vertical ? next.clientY : next.clientX) - origin) * direction;
      onResize(Math.round(Math.min(Math.max(size + delta, Math.min(min, size)), size + room)));
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing', 'resizing-x', 'resizing-y');
    };
    handle.setPointerCapture(pointer);
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    document.body.classList.add('resizing', vertical ? 'resizing-y' : 'resizing-x');
  };
  return <div className={`resize-handle ${edge}`} role="separator" aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-label={label} title="Drag to resize · double-click to reset" onPointerDown={start} onDoubleClick={() => onResize(undefined)} />;
}
