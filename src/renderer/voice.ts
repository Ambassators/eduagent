import type { DesktopAPI } from '../shared';
import { MicVAD } from '@ricky0123/vad-web';
import { VoiceInput, VoiceInputControl } from './voice-input';

export interface LiveEvent { type: string; item?: { id?: string; text?: string }; [key: string]: unknown }
interface Callbacks {
  event(event: LiveEvent): void;
  level(input: number, output: number): void;
  connected(): void;
  /** Locally detected speech started (true) or ended (false). */
  speech?(started: boolean): void;
  error(error: Error): void;
}

/** The renderer owns audio; only SDP and session controls cross the IPC bridge. */
export class VoiceSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio = new Audio();
  private context: AudioContext | null = null;
  private frame = 0;
  private closed = false;
  private inputMuted = false;
  private outputMuted = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelWait: (() => void) | undefined;
  private inputMeter: AnalyserNode | null = null;
  private outputMeter: AnalyserNode | null = null;
  private input = new VoiceInput();
  private inputControl: VoiceInputControl | null = null;
  private inputGain: GainNode | null = null;
  private transmitted: MediaStream | null = null;
  private vad: MicVAD | null = null;
  private speechTail: ReturnType<typeof setTimeout> | undefined;
  private lastSpeechFrame = 0;
  constructor(private desktop: DesktopAPI, private callbacks: Callbacks) { this.audio.autoplay = true; }

  private check() { if (this.closed) throw new Error('Voice connection was cancelled.'); }
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
      const peer = this.peer = new RTCPeerConnection();
      this.context = new AudioContext();
      await this.context.resume(); this.check();
      this.inputMeter = this.context.createAnalyser(); this.inputMeter.fftSize = 256;
      const source = this.context.createMediaStreamSource(stream);
      source.connect(this.inputMeter);
      // A short delay preserves the beginning of a word while local VAD confirms speech.
      const delay = this.context.createDelay(1); delay.delayTime.value = 0.25;
      this.inputGain = this.context.createGain(); this.inputGain.gain.value = 0;
      const destination = this.context.createMediaStreamDestination();
      source.connect(delay).connect(this.inputGain).connect(destination);
      this.transmitted = destination.stream;
      destination.stream.getAudioTracks().forEach(track => peer.addTrack(track, destination.stream));
      stream.getAudioTracks().forEach(track => {
        track.enabled = !this.inputMuted;
        track.onended = () => { if (!this.closed) this.callbacks.error(new Error('The microphone disconnected. Reconnect your input device and start again.')); };
      });
      peer.ontrack = event => {
        if (this.closed) return;
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        this.audio.srcObject = remote; this.audio.muted = this.outputMuted;
        this.audio.play().catch(error => { if (!this.closed) this.callbacks.error(new Error(`Voice playback failed: ${error.message}`)); });
        if (this.context) {
          this.outputMeter = this.context.createAnalyser(); this.outputMeter.fftSize = 256;
          this.context.createMediaStreamSource(remote).connect(this.outputMeter);
        }
      };
      peer.onconnectionstatechange = () => {
        if (this.closed) return;
        clearTimeout(this.disconnectTimer);
        if (peer.connectionState === 'failed') this.callbacks.error(new Error('The live audio connection failed. Check your network and reconnect.'));
        if (peer.connectionState === 'disconnected') this.disconnectTimer = setTimeout(() => {
          if (!this.closed && peer.connectionState === 'disconnected') this.callbacks.error(new Error('The live audio connection was lost. Start again to reconnect.'));
        }, 10_000);
      };
      const channel = peer.createDataChannel('oai-events');
      channel.onclose = () => { if (!this.closed) this.callbacks.error(new Error('The live voice connection closed. Start again to reconnect.')); };
      channel.onmessage = event => {
        if (this.closed || typeof event.data !== 'string') return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'input_audio.paused') { this.inputControl?.acknowledge(true); return; }
          if (parsed.type === 'input_audio.resumed') { this.inputControl?.acknowledge(false); return; }
          if (parsed.type === 'input_transcript.added' && !this.input.accepts(parsed.item?.id, performance.now())) return;
          if (typeof parsed.type === 'string') this.callbacks.event(parsed);
        } catch { /* Unknown/binary protocol events do not affect media playback. */ }
      };
      const assets = new URL('./voice-assets/', window.location.href).href;
      const vad = await MicVAD.new({
        model: 'v5', startOnLoad: false, audioContext: this.context,
        baseAssetPath: assets, onnxWASMBasePath: assets,
        ortConfig: ort => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
        getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream,
        positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.4,
        minSpeechMs: 96, redemptionMs: 650,
        onFrameProcessed: () => { this.lastSpeechFrame = performance.now(); },
        onSpeechRealStart: () => {
          if (this.closed || !this.inputControl || !this.input.startSpeech()) return;
          clearTimeout(this.speechTail);
          this.inputControl.setPaused(false);
          this.inputGain!.gain.value = 1;
          this.callbacks.speech?.(true);
        },
        onSpeechEnd: () => this.finishSpeech(),
        onVADMisfire: () => this.finishSpeech()
      });
      if (this.closed) { await vad.destroy(); this.check(); }
      this.vad = vad;
      await peer.setLocalDescription(await peer.createOffer()); this.check();
      if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, 2000); peer.addEventListener('icegatheringstatechange', changed);
      });
      this.check();
      const answer = await this.desktop.startVoice(peer.localDescription!.sdp); this.check();
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
        () => { if (!this.closed) { this.close(); this.callbacks.error(new Error('The voice service did not pause microphone input. Start again to reconnect.')); } }
      );
      this.inputControl.setPaused(true);
      this.lastSpeechFrame = performance.now();
      await vad.start(); this.check();
      this.callbacks.connected(); this.meter();
    } catch (error) { this.close(); throw error; }
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
      this.callbacks.level(this.inputMuted ? 0 : rms(this.inputMeter, input), rms(this.outputMeter, output));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
  private finishSpeech() {
    if (this.closed || !this.input.speaking) return;
    clearTimeout(this.speechTail);
    // Let the delayed end of the utterance reach the peer before pausing input.
    this.speechTail = setTimeout(() => {
      this.input.endSpeech(performance.now());
      this.callbacks.speech?.(false);
      if (this.inputGain) this.inputGain.gain.value = 0;
      this.inputControl?.setPaused(true);
    }, 300);
  }
  muteInput(muted: boolean) {
    this.inputMuted = muted; this.input.mute(muted);
    clearTimeout(this.speechTail);
    if (this.inputGain) this.inputGain.gain.value = 0;
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
    this.closed = true; this.cancelWait?.(); this.cancelWait = undefined;
    clearTimeout(this.disconnectTimer); cancelAnimationFrame(this.frame);
    clearTimeout(this.speechTail); this.input.mute(true);
    this.inputControl?.close(); this.inputControl = null;
    if (this.inputGain) this.inputGain.gain.value = 0; this.inputGain = null;
    void this.vad?.destroy().catch(() => {}); this.vad = null;
    this.transmitted?.getTracks().forEach(track => track.stop()); this.transmitted = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.peer?.close(); this.peer = null;
    this.audio.pause(); this.audio.srcObject = null;
    void this.context?.close().catch(() => {}); this.context = null;
    this.inputMeter = null; this.outputMeter = null;
  }
}
