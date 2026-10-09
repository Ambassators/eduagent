import type { DesktopAPI } from '../shared';

export interface LiveEvent { type: string; item?: { id?: string; text?: string }; [key: string]: unknown }
interface Callbacks {
  event(event: LiveEvent): void;
  level(input: number, output: number): void;
  connected(): void;
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
      this.context.createMediaStreamSource(stream).connect(this.inputMeter);
      stream.getAudioTracks().forEach(track => {
        track.enabled = !this.inputMuted; peer.addTrack(track, stream);
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
      this.check(); this.callbacks.connected(); this.meter();
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
      this.callbacks.level(this.inputMuted ? 0 : rms(this.inputMeter, input), rms(this.outputMeter, output));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
  muteInput(muted: boolean) { this.inputMuted = muted; this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }
  muteOutput(muted: boolean) { this.outputMuted = muted; this.audio.muted = muted; }
  close() {
    this.closed = true; this.cancelWait?.(); this.cancelWait = undefined;
    clearTimeout(this.disconnectTimer); cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.peer?.close(); this.peer = null;
    this.audio.pause(); this.audio.srcObject = null;
    void this.context?.close().catch(() => {}); this.context = null;
    this.inputMeter = null; this.outputMeter = null;
  }
}
