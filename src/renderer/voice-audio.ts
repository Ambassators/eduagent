/** Rolling record of the last few seconds of microphone samples, addressed by total samples written. */
export class SampleRing {
  private buffer: Float32Array;
  readonly sampleRate: number;
  written = 0;
  constructor(sampleRate: number, seconds: number) { this.sampleRate = sampleRate; this.buffer = new Float32Array(Math.ceil(sampleRate * seconds)); }
  push(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) this.buffer[(this.written + i) % this.buffer.length] = samples[i];
    this.written += samples.length;
  }
  /** Samples from absolute position start (clamped to what is still held) up to the latest. */
  since(start: number): Float32Array {
    const from = Math.max(start, this.written - this.buffer.length, 0), out = new Float32Array(this.written - from);
    for (let i = 0; i < out.length; i++) out[i] = this.buffer[(from + i) % this.buffer.length];
    return out;
  }
}

/** Resamples by linear interpolation and encodes as base64 little-endian 16-bit PCM. */
export function encodePCM16(samples: Float32Array, fromRate: number, toRate: number): string {
  const length = Math.floor(samples.length * toRate / fromRate), view = new DataView(new ArrayBuffer(length * 2));
  for (let i = 0; i < length; i++) {
    const position = i * fromRate / toRate, index = Math.floor(position), next = Math.min(index + 1, samples.length - 1);
    const value = samples[index] + (samples[next] - samples[index]) * (position - index);
    view.setInt16(i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true);
  }
  const bytes = new Uint8Array(view.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
