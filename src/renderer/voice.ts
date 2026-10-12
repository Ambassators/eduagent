import type { DesktopAPI } from '../shared';
import { MicVAD } from '@ricky0123/vad-web';
import { VoiceInput, VoiceInputControl } from './voice-input';
import { SampleRing, encodePCM16 } from './voice-audio';
import { isRenderActive } from './render-activity';

export interface LiveEvent { type: string; item?: { id?: string; text?: string }; [key: string]: unknown }
interface Callbacks {
  event(event: LiveEvent): void;
  level(input: number, output: number): void;
  connected(): void;
  /** Locally detected speech started (true) or ended (false). */
  speech?(started: boolean): void;
  /** The live connection closed to save usage (true), or speech is reconnecting it (false). */
  standby?(asleep: boolean): void;
  error(error: Error): void;
}

/** Pre-roll that keeps the beginning of a word while local VAD confirms speech. */
const PRE_ROLL = 0.25;
/** Longest reconnect whose speech can still be replayed from the delay line. */
const MAX_REPLAY = 20;
/** Faster catch-up shrinks the delay by this many seconds per second: 1.3× playback. */
const FAST_RATE = 0.3;
/** Samples per recorder block; the ring trails real time by about one block. */
const RECORDER_BLOCK = 4096;
export interface StandbyExperiments { catchUp: 'realtime' | 'fast' | 'burst'; wakeMs: number; falseWakeSeconds: number }

/** The renderer owns audio; only SDP and session controls cross the IPC bridge. */
export class VoiceSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio = new Audio();
  private context: AudioContext | null = null;
  private meterTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private inputMuted = false;
  private outputMuted = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelWait: (() => void) | undefined;
  private inputMeter: AnalyserNode | null = null;
  private outputMeter: AnalyserNode | null = null;
  private input = new VoiceInput();
  private inputControl: VoiceInputControl | null = null;
  private delay: DelayNode | null = null;
  private inputGain: GainNode | null = null;
  private transmitted: MediaStream | null = null;
  private vad: MicVAD | null = null;
  private speechTail: ReturnType<typeof setTimeout> | undefined;
  private lastSpeechFrame = 0;
  // Standby: after standbyMs of quiet the peer closes while the microphone and VAD keep running locally.
  private standbyMs = 0;
  private lastActivity = 0;
  private asleep = false;
  private waking = false;
  private sleeping: Promise<void> | null = null;
  private wakeStart = 0;
  /** When speech ended while reconnecting, so the replay knows where to stop. */
  private pendingEnd: number | null = null;
  private experiments: StandbyExperiments = { catchUp: 'realtime', wakeMs: 300, falseWakeSeconds: 10 };
  /** Speech heard during standby that has not yet lasted long enough to wake. */
  private wakeCandidate = false;
  private wakeVoicedMs = 0;
  private wakeSample = 0;
  private wokeAt = 0;
  private heardSinceWake = false;
  private ring: SampleRing | null = null;
  private recorder: ScriptProcessorNode | null = null;
  /** Current delay in seconds when steady, or the shrinking schedule during a faster catch-up. */
  private lag = PRE_ROLL;
  private ramp: { start: number; lag: number } | null = null;
  constructor(private desktop: DesktopAPI, private callbacks: Callbacks, private canSleep: () => boolean = () => true) { this.audio.autoplay = true; }

  private check() { if (this.closed) throw new Error('Voice connection was cancelled.'); }
  /** Seconds of quiet before standby; 0 keeps the connection open. */
  setStandby(seconds: number) { this.standbyMs = Math.max(0, seconds) * 1000; this.lastActivity = performance.now(); }
  setExperiments(experiments: StandbyExperiments) { this.experiments = experiments; }
  private log(label: string, detail?: string) { void this.desktop.voiceLog(label, detail).catch(() => {}); }
  async start(inputDevice: string): Promise<void> {
    try {
      if (!await this.desktop.microphoneAccess()) throw new Error('Microphone access was denied. Enable it in your system privacy settings.');
      this.check();
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(inputDevice ? { deviceId: { exact: inputDevice } } : {})
      } });
      this.stream = stream;
      this.check();
      this.context = new AudioContext();
      await this.context.resume(); this.check();
      this.inputMeter = this.context.createAnalyser(); this.inputMeter.fftSize = 256;
      const source = this.context.createMediaStreamSource(stream);
      source.connect(this.inputMeter);
      // The delay line always holds the last MAX_REPLAY seconds, so speech that wakes standby can be sent once reconnected.
      this.delay = this.context.createDelay(MAX_REPLAY + 1); this.delay.delayTime.value = PRE_ROLL;
      this.inputGain = this.context.createGain(); this.inputGain.gain.value = 0;
      const destination = this.context.createMediaStreamDestination();
      source.connect(this.delay).connect(this.inputGain).connect(destination);
      this.transmitted = destination.stream;
      // Raw samples for a burst catch-up; the processor writes no output, so the speakers stay silent.
      const ring = this.ring = new SampleRing(this.context.sampleRate, MAX_REPLAY);
      this.recorder = this.context.createScriptProcessor(RECORDER_BLOCK, 1, 1);
      this.recorder.onaudioprocess = event => ring.push(event.inputBuffer.getChannelData(0));
      source.connect(this.recorder).connect(this.context.destination);
      stream.getAudioTracks().forEach(track => {
        track.enabled = !this.inputMuted;
        track.onended = () => { if (!this.closed) this.callbacks.error(new Error('The microphone disconnected. Reconnect your input device and start again.')); };
      });
      const assets = new URL('./voice-assets/', window.location.href).href;
      const vad = await MicVAD.new({
        model: 'v5', startOnLoad: false, audioContext: this.context,
        baseAssetPath: assets, onnxWASMBasePath: assets,
        ortConfig: ort => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
        getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream,
        positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.4,
        minSpeechMs: 96, redemptionMs: 650,
        onFrameProcessed: (probabilities, frame) => {
          this.lastSpeechFrame = performance.now();
          if (this.wakeCandidate && probabilities.isSpeech > 0.5 && (this.wakeVoicedMs += frame.length / 16) >= this.experiments.wakeMs) this.confirmWake();
        },
        onSpeechRealStart: () => this.startSpeech(),
        onSpeechEnd: () => this.finishSpeech(),
        onVADMisfire: () => this.finishSpeech()
      });
      if (this.closed) { await vad.destroy(); this.check(); }
      this.vad = vad;
      await this.connect(false);
      this.lastSpeechFrame = performance.now(); this.lastActivity = performance.now();
      await vad.start(); this.check();
      this.callbacks.connected(); this.meter();
    } catch (error) { this.close(); throw error; }
  }
  /** Opens the peer connection and live session; resume reuses the bridge thread's existing context. */
  private async connect(resume: boolean) {
    if (resume && !await this.desktop.microphoneAccess()) throw new Error('Microphone access was denied. Enable it in your system privacy settings.');
    this.check();
    const peer = this.peer = new RTCPeerConnection();
    const live = () => !this.closed && this.peer === peer;
    this.transmitted!.getAudioTracks().forEach(track => peer.addTrack(track, this.transmitted!));
    peer.ontrack = event => {
      if (!live()) return;
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.audio.srcObject = remote; this.audio.muted = this.outputMuted;
      this.audio.play().catch(error => { if (live()) this.callbacks.error(new Error(`Voice playback failed: ${error.message}`)); });
      if (this.context) {
        this.outputMeter = this.context.createAnalyser(); this.outputMeter.fftSize = 256;
        this.context.createMediaStreamSource(remote).connect(this.outputMeter);
      }
    };
    peer.onconnectionstatechange = () => {
      if (!live()) return;
      clearTimeout(this.disconnectTimer);
      if (peer.connectionState === 'failed') this.callbacks.error(new Error('The live audio connection failed. Check your network and reconnect.'));
      if (peer.connectionState === 'disconnected') this.disconnectTimer = setTimeout(() => {
        if (live() && peer.connectionState === 'disconnected') this.callbacks.error(new Error('The live audio connection was lost. Start again to reconnect.'));
      }, 10_000);
    };
    const channel = peer.createDataChannel('oai-events');
    channel.onclose = () => { if (live()) this.callbacks.error(new Error('The live voice connection closed. Start again to reconnect.')); };
    channel.onmessage = event => {
      if (!live() || typeof event.data !== 'string') return;
      try {
        const parsed = JSON.parse(event.data);
        // Only conversation counts as activity; periodic service events must not hold off standby.
        if (typeof parsed.type === 'string' && parsed.type.includes('transcript')) this.lastActivity = performance.now();
        if (parsed.type === 'input_audio.paused') { this.inputControl?.acknowledge(true); return; }
        if (parsed.type === 'input_audio.resumed') { this.inputControl?.acknowledge(false); return; }
        if (parsed.type === 'input_transcript.added') {
          if (!this.input.accepts(parsed.item?.id, performance.now())) return;
          this.heardSinceWake = true;
        }
        if (typeof parsed.type === 'string') this.callbacks.event(parsed);
      } catch { /* Unknown/binary protocol events do not affect media playback. */ }
    };
    await peer.setLocalDescription(await peer.createOffer()); this.check();
    if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); };
      const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 2000); peer.addEventListener('icegatheringstatechange', changed);
    });
    this.check();
    const answer = await this.desktop.startVoice(peer.localDescription!.sdp, resume); this.check();
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp }); this.check();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); channel.removeEventListener('open', opened); channel.removeEventListener('close', failed);
        this.cancelWait = undefined; error ? reject(error) : resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('The voice event connection closed.'));
      const timer = setTimeout(() => finish(new Error('Live audio could not connect. Your network may be blocking WebRTC.')), 25_000);
      this.cancelWait = () => finish(new Error('Voice connection was cancelled.'));
      if (channel.readyState === 'open') finish();
      else { channel.addEventListener('open', opened); channel.addEventListener('close', failed); }
    });
    this.check();
    this.inputControl = new VoiceInputControl(
      type => channel.send(JSON.stringify({ type })),
      () => { if (live()) { this.close(); this.callbacks.error(new Error('The voice service did not pause microphone input. Start again to reconnect.')); } }
    );
    this.inputControl.setPaused(true);
  }
  private disconnectPeer() {
    clearTimeout(this.disconnectTimer); this.cancelWait?.(); this.cancelWait = undefined;
    this.inputControl?.close(); this.inputControl = null;
    if (this.inputGain) this.inputGain.gain.value = 0;
    const peer = this.peer; this.peer = null; peer?.close();
    this.audio.pause(); this.audio.srcObject = null; this.outputMeter = null;
  }
  /** Closes the live session while the microphone and VAD keep listening for speech. */
  private sleep() {
    if (this.closed || this.asleep || this.waking || !this.peer) return;
    this.asleep = true; this.wokeAt = 0; this.wakeCandidate = false; clearTimeout(this.speechTail);
    this.disconnectPeer();
    this.callbacks.standby?.(true);
    this.sleeping = this.desktop.stopVoice().catch(() => {}).finally(() => { this.sleeping = null; });
  }
  /** Speech in standby lasted long enough: reconnect from where it began. */
  private confirmWake() { this.wakeCandidate = false; void this.wake(); }
  /** Reconnects for speech that began during standby, then catches it up by the configured method. */
  private async wake() {
    this.asleep = false; this.waking = true; this.pendingEnd = null; this.lastActivity = performance.now();
    this.input.startSpeech();
    this.callbacks.standby?.(false); this.callbacks.speech?.(true);
    try {
      await this.sleeping; this.check();
      await this.connect(true);
    } catch (error) {
      this.waking = false;
      if (!this.closed) { this.close(); this.callbacks.error(error instanceof Error ? error : new Error(String(error))); }
      return;
    }
    // Muted while reconnecting: stay connected but keep the gate shut and drop the buffered speech.
    if (this.inputMuted) { this.waking = false; this.pendingEnd = null; this.callbacks.connected(); return; }
    const reconnected = performance.now() - this.wakeStart;
    this.inputControl!.setPaused(false);
    let mode = this.experiments.catchUp;
    if (mode === 'burst' && !await this.burst()) mode = 'realtime';
    if (this.closed || !this.inputControl) { this.waking = false; return; }
    if (mode !== 'burst') {
      const lag = (performance.now() - this.wakeStart) / 1000 + PRE_ROLL;
      if (lag > MAX_REPLAY) { this.setDelay(PRE_ROLL); this.log('Standby catch-up skipped', `reconnect took ${(lag - PRE_ROLL).toFixed(1)}s, longer than the ${MAX_REPLAY}s buffer`); }
      else if (mode === 'fast') this.rampDelay(lag);
      else this.setDelay(lag);
    }
    this.inputGain!.gain.value = 1;
    this.waking = false;
    this.callbacks.connected();
    this.log('Woke from standby', `reconnect ${Math.round(reconnected)}ms · catch-up ${mode} · ${mode === 'fast' ? `caught up in ${((this.lag - PRE_ROLL) / FAST_RATE).toFixed(1)}s` : `behind by ${this.lag.toFixed(2)}s`}`);
    this.wokeAt = performance.now(); this.heardSinceWake = false;
    if (this.pendingEnd !== null) {
      const replayEnds = this.emergesAt(this.pendingEnd);
      this.pendingEnd = null; this.closeGate(Math.max(0, replayEnds - performance.now()) + 50);
    }
  }
  /** Sends the buffered speech in one call, then resumes live audio where it ended. False if the service refused it. */
  private async burst() {
    const ring = this.ring!, samples = ring.since(this.wakeSample - Math.round(PRE_ROLL * ring.sampleRate)), cut = performance.now();
    try { await this.desktop.appendVoiceAudio(encodePCM16(samples, ring.sampleRate, 24000), 24000); }
    catch (error) { this.log('Burst catch-up failed; replaying in real time', error instanceof Error ? error.message : String(error)); return false; }
    this.log('Burst catch-up sent', `${(samples.length / ring.sampleRate).toFixed(1)}s of audio in ${Math.round(performance.now() - cut)}ms`);
    // Live audio picks up at the cut; the ring trails real time by about one recorder block, so overlap slightly.
    this.setDelay(Math.min(MAX_REPLAY, (performance.now() - cut) / 1000 + RECORDER_BLOCK / ring.sampleRate + 0.03));
    return true;
  }
  private setDelay(seconds: number) {
    this.lag = seconds; this.ramp = null;
    if (!this.delay || !this.context) return;
    const param = this.delay.delayTime, now = this.context.currentTime;
    param.cancelScheduledValues(now); param.setValueAtTime(seconds, now);
  }
  /** Shrinks the delay to the pre-roll so buffered speech plays at 1.3× until caught up. */
  private rampDelay(lag: number) {
    this.setDelay(lag);
    if (!this.delay || !this.context || lag <= PRE_ROLL) return;
    this.delay.delayTime.linearRampToValueAtTime(PRE_ROLL, this.context.currentTime + (lag - PRE_ROLL) / FAST_RATE);
    this.ramp = { start: performance.now(), lag };
  }
  /** When microphone audio captured at time captured (ms) leaves the delay line. */
  private emergesAt(captured: number) {
    if (!this.ramp) return captured + this.lag * 1000;
    const { start, lag } = this.ramp;
    if (captured + lag * 1000 <= start) return captured + lag * 1000;
    // While ramping, delay(t) = lag - FAST_RATE(t - start); solve t - delay(t) = captured.
    const t = (captured + lag * 1000 + FAST_RATE * start) / (1 + FAST_RATE);
    return lag * 1000 - FAST_RATE * (t - start) >= PRE_ROLL * 1000 ? t : captured + PRE_ROLL * 1000;
  }
  private startSpeech() {
    if (this.closed || this.inputMuted) return;
    this.lastActivity = performance.now();
    if (this.asleep) {
      // Wait until enough speech accumulates, but replay from when it began.
      if (!this.wakeCandidate) {
        this.wakeCandidate = true; this.wakeStart = performance.now(); this.wakeVoicedMs = 96;
        this.wakeSample = this.ring?.written ?? 0;
        if (this.wakeVoicedMs >= this.experiments.wakeMs) this.confirmWake();
      }
      return;
    }
    if (this.waking) { this.pendingEnd = null; return; }
    if (!this.inputControl || !this.input.startSpeech()) return;
    clearTimeout(this.speechTail);
    this.inputControl.setPaused(false);
    this.inputGain!.gain.value = 1;
    this.callbacks.speech?.(true);
  }
  private meter() {
    const input = new Float32Array(256), output = new Float32Array(256);
    const rms = (meter: AnalyserNode | null, buffer: Float32Array<ArrayBuffer>) => {
      if (!meter) return 0;
      meter.getFloatTimeDomainData(buffer);
      return Math.min(1, Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length) * 8);
    };
    const tick = () => {
      if (this.closed) return;
      if (this.vad?.errored || performance.now() - this.lastSpeechFrame > 3000) {
        const message = this.vad?.errored || 'the microphone speech detector stopped receiving audio'; this.close();
        this.callbacks.error(new Error(`Speech detection stopped: ${message}`)); return;
      }
      const heard = rms(this.outputMeter, output), now = performance.now();
      if (heard > 0.035 || this.input.speaking) this.lastActivity = now;
      if (this.standbyMs && this.peer && !this.waking && now - this.lastActivity > this.standbyMs && this.canSleep()) { this.log('Standby', `after ${Math.round(this.standbyMs / 1000)}s quiet`); this.sleep(); }
      else if (this.experiments.falseWakeSeconds && this.wokeAt && !this.heardSinceWake && !this.input.speaking && now - this.wokeAt > this.experiments.falseWakeSeconds * 1000 && this.canSleep()) {
        this.log('False wake', `no words recognized in ${this.experiments.falseWakeSeconds}s; back to standby`); this.sleep();
      }
      const active = isRenderActive();
      this.callbacks.level(this.inputMuted || !active ? 0 : rms(this.inputMeter, input), heard);
      // Session health/standby must continue when Chromium suspends animation frames.
      // Meter visuals need only 20 Hz; background session bookkeeping needs 4 Hz.
      if (!this.closed) this.meterTimer = setTimeout(tick, active ? 50 : 250);
    };
    tick();
  }
  private finishSpeech() {
    if (this.wakeCandidate) { this.wakeCandidate = false; this.log('Ignored short sound in standby', `${Math.round(this.wakeVoicedMs)}ms of speech`); return; }
    if (this.closed || !this.input.speaking) return;
    if (this.waking) { this.pendingEnd = performance.now(); return; }
    // Let the delayed end of the utterance reach the peer before pausing input.
    const now = performance.now();
    this.closeGate(this.emergesAt(now) - now + 50);
  }
  private closeGate(after: number) {
    clearTimeout(this.speechTail);
    this.speechTail = setTimeout(() => {
      this.input.endSpeech(performance.now());
      this.callbacks.speech?.(false);
      if (this.inputGain) this.inputGain.gain.value = 0;
      // The gate is shut, so dropping a replay lag back to the pre-roll is inaudible.
      this.setDelay(PRE_ROLL);
      this.inputControl?.setPaused(true);
      this.lastActivity = performance.now();
    }, after);
  }
  muteInput(muted: boolean) {
    this.inputMuted = muted; this.input.mute(muted);
    clearTimeout(this.speechTail); this.pendingEnd = null; this.wakeCandidate = false;
    if (this.inputGain) this.inputGain.gain.value = 0;
    this.setDelay(PRE_ROLL);
    this.inputControl?.setPaused(true);
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    // Reset detector state so speech from before mute cannot reopen the input gate.
    const vad = this.vad;
    if (vad) void vad.pause().then(() => { if (!this.closed) return vad.start(); }).catch(error => {
      if (!this.closed) { this.close(); this.callbacks.error(new Error(`Speech detection failed: ${error.message}`)); }
    });
  }
  muteOutput(muted: boolean) { this.outputMuted = muted; this.audio.muted = muted; }
  close() {
    this.closed = true; clearTimeout(this.meterTimer);
    clearTimeout(this.speechTail); this.input.mute(true);
    this.disconnectPeer();
    void this.vad?.destroy().catch(() => {}); this.vad = null;
    if (this.recorder) { this.recorder.onaudioprocess = null; this.recorder.disconnect(); this.recorder = null; } this.ring = null;
    this.transmitted?.getTracks().forEach(track => track.stop()); this.transmitted = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    void this.context?.close().catch(() => {}); this.context = null;
    this.inputMeter = null; this.inputGain = null; this.delay = null;
  }
}
