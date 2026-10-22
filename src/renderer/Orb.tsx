import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import Icon from './Icon';
import { LowPowerContext } from './LowPowerContext';
import { useRenderActive } from './render-activity';
import './orb.css';

export type OrbTone = 'idle' | 'connecting' | 'on' | 'capturing' | 'speaking';

const PERIOD: Record<OrbTone, number> = { idle: 22, connecting: 22, on: 11, speaking: 10, capturing: 9 };
const surfaceStyle = (tone: OrbTone) => ({
  '--orb-texture': `url("${new URL(`./orb-video/texture-${tone === 'capturing' || tone === 'speaking' ? tone : 'on'}.png`, document.baseURI).href}")`
} as CSSProperties);

/** The mic's glass face (see orb.css). Put it first in the button, before the glyph. */
export function Orb({ tone }: { tone: OrbTone }) {
  const lowPower = useContext(LowPowerContext);
  const live = tone !== 'idle' && tone !== 'connecting';
  return live ? <VideoOrb tone={tone} lowPower={lowPower} /> : <GlassOrb tone={tone} />;
}

function GlassOrb({ tone }: { tone: OrbTone }) {
  return <span className="orb" style={surfaceStyle(tone)} aria-hidden><span className="swirl" /></span>;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(preference.matches);
    preference.addEventListener('change', changed); changed();
    return () => preference.removeEventListener('change', changed);
  }, []);
  return reduced;
}

function VideoOrb({ tone, lowPower }: { tone: OrbTone; lowPower: boolean }) {
  const active = useRenderActive();
  const reducedMotion = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const source = `./orb-video/${tone}${lowPower ? '' : '-smooth'}.mp4`;
  // Keyed to the source, so a tone change never shows the old video's state for a frame (a black flash on Windows).
  const [failedSource, setFailedSource] = useState('');
  const [loadedSource, setLoadedSource] = useState('');
  const failed = failedSource === source;
  const loaded = loadedSource === source;
  useEffect(() => {
    const element = video.current;
    if (!element || failed) return;
    let cancelled = false;
    element.playbackRate = 11 / PERIOD[tone];
    if (active && !reducedMotion) void element.play().catch(error => {
      // Changing tone or focus can interrupt a pending play; that is expected.
      if (!cancelled && error.name !== 'AbortError') setFailedSource(source);
    });
    else element.pause();
    return () => { cancelled = true; element.pause(); };
  }, [active, reducedMotion, source, tone, failed]);
  if (failed) return <GlassOrb tone={tone} />;
  return <span className="orb orb-video" style={surfaceStyle(tone)} aria-hidden>
    {!loaded && <span className="swirl" />}
    <video key={source} ref={video} src={source} muted loop playsInline preload="metadata" tabIndex={-1} onLoadedData={() => setLoadedSource(source)} onError={() => setFailedSource(source)} style={{ opacity: loaded ? 1 : 0 }} />
  </span>;
}

/** The glyph over the orb: a spinner while connecting, live bars once it's listening, else the mic. */
export function VoiceGlyph({ tone, muted = false, size }: { tone: OrbTone; muted?: boolean; size: number }) {
  if (tone === 'connecting') return <span className="orb-spinner" />;
  if (tone === 'idle' || muted) return <Icon name={muted ? 'mute' : 'mic'} size={size} />;
  return (
    <span className="orb-bars">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
