import { useSyncExternalStore } from 'react';

// Native window focus stays authoritative when an embedded editor/browser has focus.
let focused = document.hasFocus();
let active = focused && !document.hidden;
const listeners = new Set<() => void>();
export const isRenderActive = () => active;
export function subscribeRenderActivity(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function updateDemo(frame: HTMLIFrameElement, value: boolean) {
  if (frame.src.startsWith('codex-presentation:')) frame.contentWindow?.postMessage({ channel: 'eduagent-render-activity', active: value }, '*');
}
function update() {
  const next = focused && !document.hidden;
  document.documentElement.dataset.renderActive = String(next);
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[src^='codex-presentation:']")) updateDemo(frame, next);
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}
export function initializeRenderActivity() {
  document.addEventListener('load', event => { if (event.target instanceof HTMLIFrameElement) updateDemo(event.target, active); }, true);
  document.addEventListener('visibilitychange', update);
  if (window.desktop?.onWindowActivity) {
    window.desktop.onWindowActivity(value => { focused = value; update(); });
  } else {
    window.addEventListener('focus', () => { focused = true; update(); });
    window.addEventListener('blur', () => { focused = false; update(); });
  }
  update();
}
export const useRenderActive = () => useSyncExternalStore(subscribeRenderActivity, isRenderActive);
