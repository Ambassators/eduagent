/**
 * Gemini API key pool: rotates requests across several keys and skips keys that are rate-limited,
 * out of quota, rejected, or failing. Ported from SpeakEasy's routing package (HealthTracker and the
 * Router's fallback walk), where the unit being balanced is a provider profile; here it is one key.
 */

export type GeminiErrorKind = 'rate-limited' | 'quota' | 'auth' | 'model' | 'unavailable' | 'timeout' | 'bad-request' | 'aborted' | 'unknown';

export class GeminiError extends Error {
  override name = 'GeminiError';
  readonly kind: GeminiErrorKind; readonly status?: number; readonly retryAfterMs?: number;
  constructor(message: string, kind: GeminiErrorKind, status?: number, retryAfterMs?: number) {
    super(message); this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs;
  }
  /** Errors another key or model may not hit: limits, rejected keys, missing models and outages. */
  get rotates() { return this.kind === 'rate-limited' || this.kind === 'quota' || this.kind === 'auth' || this.kind === 'model' || this.kind === 'unavailable'; }
}

interface GoogleErrorBody { error?: { code?: number; message?: string; status?: string; details?: Array<Record<string, any>> } }

function seconds(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value.trim()) : null;
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/** Classify a Gemini REST error from its status, google.rpc details and Retry-After header. */
export function classifyResponse(status: number, body: GoogleErrorBody, message: string, retryAfter?: string | null): GeminiError {
  const details = body.error?.details ?? [];
  const text = `${body.error?.status ?? ''} ${body.error?.message ?? ''}`;
  const reason = details.find(d => typeof d.reason === 'string')?.reason as string | undefined;
  const retry = seconds(details.find(d => String(d['@type'] ?? '').endsWith('RetryInfo'))?.retryDelay)
    ?? (retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined);
  const daily = details.some(d => (d.violations ?? []).some((v: any) => /PerDay/i.test(String(v.quotaId ?? ''))));
  if (status === 429) return new GeminiError(message, daily ? 'quota' : 'rate-limited', status, retry);
  if (status === 401 || status === 403 || reason === 'API_KEY_INVALID' || /API key (?:not valid|expired)/i.test(text)) return new GeminiError(message, 'auth', status);
  if (status === 404 || /is not (?:found|supported) for|model .* not found|unsupported model/i.test(text)) return new GeminiError(message, 'model', status);
  if (status >= 500 || status === 408) return new GeminiError(message, 'unavailable', status, retry);
  return new GeminiError(message, 'bad-request', status);
}

/** Best-effort classification of errors without an HTTP status (Live socket closes, network failures). */
export function classifyError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError') return new GeminiError(message, 'aborted');
  if (name === 'TimeoutError') return new GeminiError(message, 'timeout');
  if (/RESOURCE_EXHAUSTED|quota|rate limit|too many requests|\b429\b/i.test(message)) return new GeminiError(message, /per ?day|daily/i.test(message) ? 'quota' : 'rate-limited');
  if (/models\/\S+ is not found|is not supported for|model .* not found|unsupported model/i.test(message)) return new GeminiError(message, 'model');
  if (/API key|PERMISSION_DENIED|UNAUTHENTICATED|unauthori[sz]ed|\b40[13]\b/i.test(message)) return new GeminiError(message, 'auth');
  if (name === 'TypeError' || /fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|UNAVAILABLE|could not connect|\b50[0234]\b|\(1011\)|\(1006\)/i.test(message)) return new GeminiError(message, 'unavailable');
  return new GeminiError(message, 'unknown');
}

export type KeyState = 'ok' | 'open' | 'cooldown';
export interface KeyHealthOptions {
  windowMs: number; minSamples: number; failureRate: number; consecutiveFailures: number;
  /** How long a tripped breaker stays open; rejected keys, exhausted quotas and missing models stay open 10x longer. */
  openMs: number;
  /** Cooldown after a 429 without a retry delay. */
  defaultCooldownMs: number;
}
const DEFAULTS: KeyHealthOptions = { windowMs: 60_000, minSamples: 5, failureRate: 0.5, consecutiveFailures: 3, openMs: 30_000, defaultCooldownMs: 20_000 };
interface Health { outcomes: { at: number; ok: boolean }[]; consecutive: number; openUntil: number; cooldownUntil: number }

export interface KeySnapshot { label: string; state: KeyState; until?: number; /** Models this key is limited on, when the limit is not key-wide. */ models?: string[] }
export interface Route { key: string; model: string }
export type Clock = () => number;
/** Key-wide health (rejected keys) is stored under this model name. */
const ANY = '*';

/**
 * Routes requests over key × model pairs, like SpeakEasy's Router walks a profile chain: the first model
 * on every healthy key (least recently used first), then each fallback model. Gemini quotas apply per
 * project and model, so rate limits are tracked per pair; a rejected key is paused for every model.
 */
export class KeyPool {
  private keys: string[] = [];
  private readonly health = new Map<string, Health>();
  private readonly used = new Map<string, number>();
  private readonly opts: KeyHealthOptions;
  private tick = 0;
  private readonly now: Clock;

  constructor(keys: string[] = [], now: Clock = Date.now, opts: Partial<KeyHealthOptions> = {}) {
    this.now = now; this.opts = { ...DEFAULTS, ...opts };
    this.setKeys(keys);
  }

  /** Replace the key list; keys that stay keep their health. */
  setKeys(keys: string[]) {
    this.keys = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
    for (const id of [...this.health.keys()]) if (!this.keys.includes(id.slice(0, id.lastIndexOf('\n')))) this.health.delete(id);
    for (const key of [...this.used.keys()]) if (!this.keys.includes(key)) this.used.delete(key);
  }
  get size() { return this.keys.length; }
  get all(): readonly string[] { return this.keys; }

  private get(key: string, model: string): Health {
    const id = `${key}\n${model}`;
    let h = this.health.get(id);
    if (!h) this.health.set(id, h = { outcomes: [], consecutive: 0, openUntil: 0, cooldownUntil: 0 });
    return h;
  }
  private prune(h: Health) {
    const cutoff = this.now() - this.opts.windowMs;
    while (h.outcomes.length && h.outcomes[0].at < cutoff) h.outcomes.shift();
  }
  private own(key: string, model: string): { state: KeyState; until?: number } {
    const h = this.health.get(`${key}\n${model}`), now = this.now();
    if (h && h.openUntil > now) return { state: 'open', until: h.openUntil };
    if (h && h.cooldownUntil > now) return { state: 'cooldown', until: h.cooldownUntil };
    return { state: 'ok' };
  }

  /** A pair is unavailable when the key is paused for every model, or this model is limited on the key. */
  state(key: string, model = ''): { state: KeyState; until?: number } {
    const wide = this.own(key, ANY);
    return wide.state !== 'ok' ? wide : this.own(key, model);
  }

  /**
   * Pairs to try, in order: each model in turn on its healthy keys, least recently used first. When none
   * are healthy, only the pair that recovers soonest, so a single-key setup still retries.
   */
  candidates(models: string[] = ['']): Route[] {
    const list = [...new Set(models.length ? models : [''])];
    const byUse = (a: string, b: string) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0);
    const healthy = list.flatMap(model => this.keys.filter(key => this.state(key, model).state === 'ok').sort(byUse).map(key => ({ key, model })));
    if (healthy.length) return healthy;
    const all = list.flatMap(model => this.keys.map(key => ({ key, model })));
    const soonest = all.sort((a, b) => (this.state(a.key, a.model).until ?? 0) - (this.state(b.key, b.model).until ?? 0))[0];
    return soonest ? [soonest] : [];
  }

  recordSuccess(key: string, model = '') {
    const h = this.get(key, model);
    h.outcomes.push({ at: this.now(), ok: true }); h.consecutive = 0; h.openUntil = 0; this.prune(h);
    const wide = this.health.get(`${key}\n${ANY}`);
    if (wide) wide.openUntil = 0;
  }

  recordFailure(key: string, error: unknown, model = '') {
    const err = classifyError(error), now = this.now();
    // Our own cancellations and malformed requests say nothing about the key's health.
    if (err.kind === 'aborted' || err.kind === 'bad-request') return;
    const h = this.get(key, err.kind === 'auth' ? ANY : model);
    if (err.kind === 'rate-limited') {
      // A second in-flight response must not shorten an existing retry delay.
      h.cooldownUntil = Math.max(h.cooldownUntil, now + Math.max(0, err.retryAfterMs ?? this.opts.defaultCooldownMs));
      return;
    }
    h.outcomes.push({ at: now, ok: false }); h.consecutive += 1; this.prune(h);
    const failures = h.outcomes.filter(o => !o.ok).length;
    const rateTripped = h.outcomes.length >= this.opts.minSamples && failures / h.outcomes.length >= this.opts.failureRate;
    // A rejected key, exhausted daily quota or missing model won't recover within the window; open immediately.
    const hard = err.kind === 'auth' || err.kind === 'quota' || err.kind === 'model';
    if (hard || rateTripped || h.consecutive >= this.opts.consecutiveFailures) h.openUntil = Math.max(h.openUntil, now + this.opts.openMs * (hard ? 10 : 1));
  }

  /**
   * Run one request, falling back to the next key, then the next model, on rate limits, rejected keys,
   * missing models and outages. Other errors (bad requests, cancellation, timeouts) are thrown at once.
   * Only wrap work that has not produced output yet: retrying after partial output would duplicate it.
   */
  async run<T>(attempt: (key: string, model: string) => Promise<T>, options: { models?: string[]; signal?: AbortSignal } | AbortSignal = {}): Promise<T> {
    const { models, signal } = options instanceof AbortSignal ? { models: undefined, signal: options } : options;
    const queue = this.candidates(models);
    if (!queue.length) throw new GeminiError('Add your Gemini API key in Preferences → Gemini API.', 'auth');
    let last: GeminiError | undefined, tried = 0;
    const skipped = new Set<string>();
    for (const { key, model } of queue) {
      if (skipped.has(model)) continue;
      signal?.throwIfAborted();
      this.used.set(key, ++this.tick); tried++;
      try {
        const value = await attempt(key, model);
        this.recordSuccess(key, model);
        return value;
      } catch (error) {
        if (signal?.aborted) throw error;
        const err = classifyError(error);
        this.recordFailure(key, err, model);
        if (!err.rotates) throw error;
        // A missing model is missing on every key; move straight to the next model.
        if (err.kind === 'model') skipped.add(model);
        last = err;
      }
    }
    const note = tried > 1 ? ` (tried ${tried} key/model combinations)` : '';
    throw new GeminiError(this.redact(`${last!.message}${note}`), last!.kind, last!.status, last!.retryAfterMs);
  }

  redact(text: string) {
    let out = text;
    for (const key of this.keys) out = out.split(key).join('[redacted]');
    return out;
  }

  /** Masked per-key status for the settings page. */
  snapshot(): KeySnapshot[] {
    return this.keys.map(key => {
      const wide = this.own(key, ANY);
      if (wide.state !== 'ok') return { label: `…${key.slice(-4)}`, ...wide };
      const limited = [...this.health.keys()].filter(id => id.startsWith(`${key}\n`)).map(id => id.slice(key.length + 1))
        .filter(model => model !== ANY && this.own(key, model).state !== 'ok');
      if (!limited.length) return { label: `…${key.slice(-4)}`, state: 'ok' as const };
      const states = limited.map(model => this.own(key, model));
      return { label: `…${key.slice(-4)}`, state: states.some(s => s.state === 'open') ? 'open' as const : 'cooldown' as const,
        until: Math.min(...states.map(s => s.until ?? Infinity)), models: limited.filter(Boolean) };
    });
  }
}

/** Split stored or pasted text into keys: one per line, or separated by commas or spaces. */
export function parseKeys(text: string, limit = 20): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(key => key.trim()).filter(Boolean))].slice(0, limit);
}
