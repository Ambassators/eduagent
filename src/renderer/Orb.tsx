import { useEffect, useRef } from 'react';
import './orb.css';

export type OrbTone = 'idle' | 'on' | 'capturing' | 'speaking';

/** How fast the clouds move: a lazy drift when off, livelier in a session, fastest while it hears you. */
const SPEED: Record<OrbTone, number> = { idle: 1, on: 2, speaking: 2.5, capturing: 3.5 };
const RAMP_MS = 700;

/** The mic's gradient, cloudy face (see orb.css). Put it first in the button, before the glyph. */
export function Orb({ tone }: { tone: OrbTone }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Speeds the CSS animations up or down in place (no restart, so nothing jumps), easing between rates.
  useEffect(() => {
    const anims = ref.current?.getAnimations({ subtree: true }) ?? [];
    if (!anims.length) return;
    const from = anims[0]!.playbackRate;
    const to = SPEED[tone];
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / RAMP_MS);
      const rate = from + (to - from) * (1 - (1 - k) ** 3);
      for (const a of anims) a.updatePlaybackRate(rate);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tone]);
  return (
    <span className="orb" ref={ref} aria-hidden>
      <span className="swirl">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="mist" />
      <span className="mist" />
    </span>
  );
}
