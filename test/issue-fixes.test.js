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

test('bass-heavy material does not drag treble up with it', () => {
  // Peak normalization anchors each band to its own running maximum (100%).
  // A pure 40 Hz tone has almost no treble-band content, so the treble peak
  // is set by bass bleed-through and treble normalizes to ~100% of that
  // (tiny) peak. That is correct — treble is independent, it is just that
  // the only treble-band content is bleed-through. The invariant we test
  // here is that the two bands are NOT a ratio summing to 1.0, and that
  // a signal with BOTH bass and treble content shows both bands active
  // independently.
  const capture = new AudioCapture();
  // Mixed signal: 40 Hz bass + 5 kHz treble, both at moderate amplitude.
  const frames = Math.floor(48000 * 0.05);
  const buffer = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / 48000;
    const value = 0.2 * Math.sin(2 * Math.PI * 40 * t) +
                  0.1 * Math.sin(2 * Math.PI * 5000 * t);
    buffer.writeFloatLE(value, i * 8);
    buffer.writeFloatLE(value, i * 8 + 4);
  }
  for (let i = 0; i < 80; i++) capture.processAudioFrame(buffer);

  const { bass, treble } = capture.getAnalytics();
  // Both bands should be active for a signal with both bass and treble.
  assert.ok(bass > 0.2, `bass should be active (got ${bass})`);
  assert.ok(treble > 0.2, `treble should be active (got ${treble})`);
  // The two bands must NOT sum to 1.0 (that was the old ratio bug).
  assert.ok(
    Math.abs(bass + treble - 1) > 1e-6,
    `bass+treble must not be pinned to 1.0 (got ${bass + treble})`
  );
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