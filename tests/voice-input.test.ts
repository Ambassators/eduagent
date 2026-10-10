import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionGroups, EchoFilter, VoiceInput, VoiceInputControl } from '../src/renderer/voice-input.ts';

test('silence and muted input never authorize transcripts, including repeats after unmute', () => {
  const input = new VoiceInput();
  assert.equal(input.accepts('silence', 0), false);
  assert.equal(input.startSpeech(), true);
  assert.equal(input.accepts('speech', 100), true);
  assert.equal(input.accepts('silence', 100), false);
  input.mute(true);
  assert.equal(input.startSpeech(), false);
  assert.equal(input.accepts('muted', 150), false);
  input.mute(false);
  assert.equal(input.accepts('new-silence', 200), false);
  input.startSpeech();
  assert.equal(input.accepts('speech', 250), false);
  assert.equal(input.accepts('muted', 250), false);
  assert.equal(input.accepts('new-speech', 250), true);
});

test('delayed speech captions have a bounded grace period', () => {
  const input = new VoiceInput();
  input.startSpeech(); input.endSpeech(1000);
  assert.equal(input.accepts('caption', 2000), true);
  assert.equal(input.accepts('caption', 4501), false);
  assert.equal(input.accepts('phantom', 5000), false);
});

test('service input starts paused and a mute during resume is applied after its acknowledgment', () => {
  const commands: string[] = [];
  const control = new VoiceInputControl(type => commands.push(type), () => assert.fail('unexpected timeout'));
  try {
    control.setPaused(true);
    assert.deepEqual(commands, ['input_audio.pause']);
    control.acknowledge(true);
    control.setPaused(false);
    control.setPaused(true);
    assert.deepEqual(commands, ['input_audio.pause', 'input_audio.resume']);
    control.acknowledge(false);
    assert.deepEqual(commands, ['input_audio.pause', 'input_audio.resume', 'input_audio.pause']);
    control.acknowledge(true);
    control.setPaused(true);
    assert.equal(commands.length, 3);
  } finally { control.close(); }
});

test('missing service acknowledgment closes input instead of leaving it running', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failures = 0;
  const commands: string[] = [];
  const control = new VoiceInputControl(type => commands.push(type), () => failures++);
  control.setPaused(true);
  t.mock.timers.tick(4000);
  assert.equal(failures, 1);
  assert.deepEqual(commands, ['input_audio.pause']);
  control.close();
});

test('captions repeating recent assistant speech are echoes, short or stale ones are not', () => {
  const echo = new EchoFilter();
  echo.heard('a1', 'Sure! The mitochondria is the powerhouse of the cell.', 1000);
  assert.equal(echo.isEcho('the Mitochondria is the powerhouse', 2000), true);
  assert.equal(echo.isEcho('powerhouse of the cell', 2000), true);
  assert.equal(echo.isEcho('the cell', 2000), false);
  assert.equal(echo.isEcho('what is a ribosome then', 2000), false);
  assert.equal(echo.isEcho('the mitochondria is the powerhouse', 40_000), false);
});

test('overlapping speech keeps one bubble per speaker; later turns start new bubbles', () => {
  const groups = new CaptionGroups();
  let n = 0; const id = () => `b${++n}`;
  const a = groups.pick('assistant', 0, id);
  const u = groups.pick('user', 300, id);
  assert.notEqual(a, u);
  for (let t = 600; t < 4000; t += 600) {
    assert.equal(groups.pick('assistant', t, id), a);
    assert.equal(groups.pick('user', t + 300, id), u);
  }
  // The assistant stopped; the user kept talking, so the next reply goes below in a new bubble.
  assert.equal(groups.pick('user', 5000, id), u);
  const reply = groups.pick('assistant', 6500, id);
  assert.notEqual(reply, a);
  assert.equal(groups.pick('user', 13000, id) === u, false);
});
