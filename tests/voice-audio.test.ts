import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleRing, encodePCM16 } from '../src/renderer/voice-audio.ts';
test('the ring returns samples since a position and keeps only its capacity', () => {
  const ring = new SampleRing(4, 2);
  ring.push(Float32Array.from([1, 2, 3, 4, 5]));
  assert.deepEqual([...ring.since(2)], [3, 4, 5]);
  ring.push(Float32Array.from([6, 7, 8, 9, 10]));
  assert.deepEqual([...ring.since(0)], [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(ring.since(10).length, 0);
});
test('PCM16 encoding resamples, clamps and is little-endian', () => {
  const bytes = Buffer.from(encodePCM16(Float32Array.from([0, 1, -1, 2, 0.5, 0.5]), 48000, 24000), 'base64');
  assert.equal(bytes.length, 6);
  assert.deepEqual([bytes.readInt16LE(0), bytes.readInt16LE(2), bytes.readInt16LE(4)], [0, -32767, 16383]);
});
