/** Only locally detected speech can authorize an incoming microphone transcript. */
export class VoiceInput {
  muted = false;
  speaking = false;
  private transcriptUntil = -Infinity;
  private items = new Map<string, boolean>();

  startSpeech() {
    if (this.muted) return false;
    this.speaking = true;
    return true;
  }
  endSpeech(now: number) {
    if (!this.speaking) return;
    this.speaking = false;
    // Allow captions already in flight after the last audio packet.
    this.transcriptUntil = now + 3500;
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.speaking = false;
    this.transcriptUntil = -Infinity;
    // Old items must not resume appending text after unmute.
    for (const id of this.items.keys()) this.items.set(id, false);
  }
  accepts(id: string | undefined, now: number) {
    if (!id) return false;
    const allowed = !this.muted && (this.speaking || now <= this.transcriptUntil) && this.items.get(id) !== false;
    this.items.set(id, allowed);
    if (this.items.size > 2000) this.items.delete(this.items.keys().next().value!);
    return allowed;
  }
}

/** Serialize v3 pause/resume commands, including mute during an in-flight resume. */
export class VoiceInputControl {
  private paused = true;
  private confirmed: boolean | undefined;
  private pending: boolean | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private send: (type: string) => void;
  private fail: () => void;
  constructor(send: (type: string) => void, fail: () => void) { this.send = send; this.fail = fail; }
  setPaused(paused: boolean) { this.paused = paused; this.flush(); }
  acknowledge(paused: boolean) {
    if (paused !== this.pending) return;
    clearTimeout(this.timer);
    this.pending = undefined;
    this.confirmed = paused;
    this.flush();
  }
  private flush() {
    if (this.pending !== undefined || this.confirmed === this.paused) return;
    this.pending = this.paused;
    this.timer = setTimeout(() => { this.close(); this.fail(); }, 4000);
    this.send(this.paused ? 'input_audio.pause' : 'input_audio.resume');
  }
  close() { clearTimeout(this.timer); this.pending = undefined; }
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim();

/** Rejects user captions that repeat what the assistant just said, whatever path the text took back into the input. */
export class EchoFilter {
  private spoken = new Map<string, { text: string; time: number }>();
  private windowMs = 30_000;
  private minWords = 4;
  heard(id: string, text: string, now: number) {
    this.spoken.delete(id);
    this.spoken.set(id, { text: words(text), time: now });
    for (const [key, value] of this.spoken) if (now - value.time > this.windowMs) this.spoken.delete(key); else break;
  }
  isEcho(text: string, now: number) {
    const caption = words(text);
    if (caption.split(' ').length < this.minWords) return false;
    for (const value of this.spoken.values()) if (now - value.time <= this.windowMs && value.text.includes(caption)) return true;
    return false;
  }
  clear() { this.spoken.clear(); }
}

type Speaker = 'user' | 'assistant';
/** Assigns live caption segments to bubbles, keeping one bubble per speaker while both talk over each other. */
export class CaptionGroups {
  last = 0;
  private open: Partial<Record<Speaker, { id: string; time: number }>> = {};
  private latest: Speaker | null = null;
  private turnGapMs = 5000;
  private overlapMs = 2000;
  pick(role: Speaker, time: number, newId: () => string) {
    const own = this.open[role];
    // The other speaker's bubble is newer: keep this one only if it was still active, i.e. they overlapped.
    const reuse = own && time - own.time < this.turnGapMs && (this.latest === role || time - own.time < this.overlapMs);
    if (!reuse) { this.open[role] = { id: newId(), time }; this.latest = role; }
    this.open[role]!.time = this.last = time;
    return this.open[role]!.id;
  }
  /** Further text for a segment already placed keeps its bubble active. */
  touch(role: Speaker, id: string, time: number) {
    if (this.open[role]?.id === id) this.open[role]!.time = time;
    this.last = time;
  }
  reset() { this.open = {}; this.latest = null; this.last = 0; }
}
