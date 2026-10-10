import { randomUUID } from 'node:crypto';
import type { DebugLog } from '../shared.js';
/** Latency trace for the voice → bridge → Think pipeline. Enable console output with CODEX_VOICE_TRACE=1. */
const enabled = process.env.CODEX_VOICE_TRACE === '1';
const start = Date.now();
let last = start;
const streaming = new Set<string>();
let sink: ((log: DebugLog) => void) | null = null;
/** Receives every debug log line, independent of CODEX_VOICE_TRACE. */
export function onDebugLog(handler: (log: DebugLog) => void) { sink = handler; }
export function debugLog(entry: Omit<DebugLog, 'id' | 'time'> & { id?: string }) {
  sink?.({ ...entry, id: entry.id ?? randomUUID(), time: Date.now() });
}
export function trace(label: string, detail = '') {
  if (!enabled) return;
  const now = Date.now();
  console.log(`[trace] ${((now - start) / 1000).toFixed(2).padStart(8)}s  +${String(now - last).padStart(5)}ms  ${label}${detail ? '  ' + detail : ''}`);
  last = now;
}
/** Logs only the first of a run of streaming events, so deltas do not flood the trace. */
export function traceFirst(key: string, label: string, detail = '') {
  if (streaming.has(key)) return false;
  streaming.add(key); trace(label, detail); return true;
}
export function traceReset(key: string) { streaming.delete(key); }
