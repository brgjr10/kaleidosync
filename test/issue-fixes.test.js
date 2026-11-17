import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioCapture } from '../app/src/audio/audio-capture.js';
import { SketchEngine } from '../app/src/sketch-engine/sketch-engine.js';

const F32LE_48K_STEREO = (seconds = 0.1, amplitude = 0.5) => {
  const frames = Math.floor(48000 * seconds);
  const buffer = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * 220 * i) / 48000) * amplitude;
    buffer.writeFloatLE(value, i * 8);
    buffer.writeFloatLE(value, i * 8 + 4);
  }
  return buffer;
};

// --- Issue #101: bass/treble are absolute band energy, not a 0..1 balance ---

test('bass and treble report independent band energy, not a ratio summing to 1', () => {
  const capture = new AudioCapture();
  const frame = F32LE_48K_STEREO(0.05, 0.5);
  for (let i = 0; i < 4; i++) capture.processAudioFrame(frame);

  const { bass, treble } = capture.getAnalytics();
  // A 220 Hz tone sits between the 80 Hz low-pass and the 2 kHz high-pass, so
  // both bands carry real energy. Under the old normalized-ratio code these
  // two values summed to exactly 1.0 on every non-silent frame.
  assert.ok(bass > 0 && treble > 0, 'both bands should carry energy for a mid tone');
  assert.ok(
    Math.abs(bass + treble - 1) > 1e-6,
    `bass+treble must not be pinned to 1.0 (got ${bass + treble})`
  );
});

test('bass-heavy material does not pin bass to 1.0', () => {
  const capture = new AudioCapture();
  // 40 Hz tone: almost all energy is below the 80 Hz bass low-pass.
  const frames = Math.floor(48000 * 0.05);
  const buffer = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * 40 * i) / 48000) * 0.7;
    buffer.writeFloatLE(value, i * 8);
    buffer.writeFloatLE(value, i * 8 + 4);
  }
  for (let i = 0; i < 4; i++) capture.processAudioFrame(buffer);

  const { bass, treble } = capture.getAnalytics();
  assert.ok(bass > 0, 'bass should register for a bass-heavy tone');
  assert.ok(bass < 1, `bass must stay an absolute level, not pin to 1.0 (got ${bass})`);
  assert.ok(treble >= 0 && treble < 0.05, `treble should be small (got ${treble})`);
});

// --- Issue #92: tween helper keys do not accumulate on repeated tweens ---

function makeEngine() {
  const engine = new SketchEngine();
  engine.catalog = {
    count: 1,
    sketches: [
      {
        id: 'test',
        name: 'Test',
        shader: 'void main(){}',
        variants: [
          { warp: false, kaleidoscope: false, zoom: 1.0 },
          { warp: true, kaleidoscope: true, zoom: 2.0 }
        ]
      }
    ]
  };
  return engine;
}

test('tweenTo does not grow the uniform key set across repeated tweens', () => {
  const engine = makeEngine();
  engine.selectSketch(0);

  const firstCount = Object.keys(engine.currentUniforms).length;
  const firstKeys = [...Object.keys(engine.currentUniforms)];

  // Five successive tweens against the same variant, mirroring the bug
  // report's repro (12 -> 14 -> 16 -> 18 -> 20 -> 22 keys).
  for (let i = 0; i < 5; i++) {
    engine.tweenTo({ warp: false, kaleidoscope: false, zoom: 1.0 }, 1);
    // Run each tween to completion so updateTween's augmentation path runs too.
    engine.updateTween(engine.tweenStartTime + 10);
  }

  const finalKeys = Object.keys(engine.currentUniforms);
  assert.deepEqual(finalKeys, firstKeys, 'uniform key set must be stable across tweens');
  assert.equal(finalKeys.length, firstCount);
});

test('augmentUniformsWithTweens never generates *TweenTween helpers', () => {
  const engine = makeEngine();
  engine.selectSketch(0);

  for (let i = 0; i < 5; i++) {
    engine.currentUniforms.warp = i % 2 === 0;
    engine.augmentUniformsWithTweens();
  }

  const keys = Object.keys(engine.currentUniforms);
  assert.ok(!keys.some(k => /TweenTween/.test(k)), `no doubled tween keys: ${keys.join(', ')}`);
  assert.ok(!keys.some(k => /TweenProgressProgress/.test(k)), 'no doubled progress keys');
  assert.ok(keys.includes('warpTween') && keys.includes('warpTweenProgress'));
});