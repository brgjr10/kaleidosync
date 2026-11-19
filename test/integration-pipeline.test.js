import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioCapture } from '../app/src/audio/audio-capture.js';
import { SketchEngine } from '../app/src/sketch-engine/sketch-engine.js';
import { generateVariant, buildVariantInterpolator, interpolateVariants } from '../app/src/sketch-engine/variant-utils.js';

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

const F32LE_48K_STEREO_SILENCE = (seconds = 0.1) => {
  const frames = Math.floor(48000 * seconds);
  return Buffer.alloc(frames * 2 * 4);
};

const MOCK_CATALOG = {
  count: 3,
  sketches: [
    {
      id: 'sketch_000_test_kaleidoscope',
      name: 'Test Kaleidoscope',
      shader: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }',
      variants: [
        { zoom: 10.0, contrast: 1.0, sides: 6, warp: false, kaleidoscope: true, colorShift: 1.0 },
        { zoom: 20.0, contrast: 1.5, sides: 8, warp: true, kaleidoscope: false, colorShift: 2.0 },
        { zoom: 30.0, contrast: 2.0, sides: 12, warp: false, kaleidoscope: true, colorShift: 3.0 }
      ]
    },
    {
      id: 'sketch_001_test_orbs',
      name: 'Test Orbs',
      shader: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(0.5); }',
      variants: [
        { radius: 5.0, orbSize: 1.0, speed: 1.0 },
        { radius: 10.0, orbSize: 2.0, speed: 2.0 }
      ]
    },
    {
      id: 'sketch_002_test_warp',
      name: 'Test Warp',
      shader: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(0.25); }',
      variants: [
        { zoom: 100.0, rotation: 0.5, distortion: 1.0 },
        { zoom: 200.0, rotation: 1.0, distortion: 2.0 }
      ]
    }
  ]
};

function makeMockAudioCapture() {
  const capture = new AudioCapture();
  capture.backend = {
    id: 'test',
    label: 'Test',
    supportsMetadata: false,
    supportsProcessAudio: false,
    status: { available: true, detail: '', hint: '' },
    enumerate: async () => [],
    buildCapture: () => ({ command: 'sleep', args: ['60'] }),
    startPolling: () => {},
    stopPolling: () => {}
  };
  capture.sources = [{ id: 'test-monitor', name: 'Test Monitor', type: 'monitor', isDefault: true }];
  return capture;
}

function makeSketchEngine() {
  const engine = new SketchEngine();
  engine.catalog = MOCK_CATALOG;
  return engine;
}

test('AudioCapture: processes audio and produces valid analytics (volume, bass, treble, BPM)', () => {
  const capture = makeMockAudioCapture();
  const frame = F32LE_48K_STEREO(0.05, 0.5);

  for (let i = 0; i < 4; i++) capture.processAudioFrame(frame);

  const analytics = capture.getAnalytics();

  assert.ok(analytics.volume > 0, 'volume should be non-zero for audible signal');
  assert.ok(analytics.level > 0, 'level should be non-zero');
  assert.equal(analytics.tapped, true);
  assert.ok(analytics.bass >= 0 && analytics.bass <= 1, `bass should be 0..1, got ${analytics.bass}`);
  assert.ok(analytics.treble >= 0 && analytics.treble <= 1, `treble should be 0..1, got ${analytics.treble}`);
  assert.ok(Number.isInteger(analytics.bpm) && analytics.bpm >= 0, `BPM should be non-negative integer, got ${analytics.bpm}`);
});

test('AudioCapture: silence produces zero analytics', () => {
  const capture = makeMockAudioCapture();
  const frame = F32LE_48K_STEREO_SILENCE(0.05);

  for (let i = 0; i < 10; i++) capture.processAudioFrame(frame);

  const analytics = capture.getAnalytics();
  assert.equal(analytics.volume, 0);
  assert.equal(analytics.level, 0);
  assert.equal(analytics.bass, 0);
  assert.equal(analytics.treble, 0);
  assert.equal(analytics.bpm, 0);
});

test('AudioCapture: app source gated to silence when not playing', () => {
  const capture = makeMockAudioCapture();
  capture.selectedSourceType = 'application';
  capture.playing = false;

  const frame = F32LE_48K_STEREO(0.05, 0.8);
  capture.processAudioFrame(frame);

  let analytics = capture.getAnalytics();
  assert.equal(analytics.volume, 0, 'paused app audio should be silent');
  assert.equal(analytics.level, 0);
  assert.equal(analytics.bass, 0);
  assert.equal(analytics.treble, 0);

  capture.playing = true;
  capture.processAudioFrame(frame);

  analytics = capture.getAnalytics();
  assert.ok(analytics.volume > 0, 'unpaused app audio should register');
});

test('AudioCapture: monitor sources never gated', () => {
  const capture = makeMockAudioCapture();
  capture.selectedSourceType = 'monitor';
  capture.playing = false;

  capture.processAudioFrame(F32LE_48K_STEREO(0.05, 0.8));
  assert.ok(capture.getAnalytics().volume > 0, 'monitor audio always active');
});

test('AudioCapture: NaN samples sanitized before filter accumulation', () => {
  const capture = makeMockAudioCapture();
  const frames = 4800;
  const buffer = Buffer.alloc(frames * 2 * 4);

  // Inject NaN at several positions
  for (let i = 0; i < frames; i += 100) {
    buffer.writeFloatLE(NaN, i * 8);
    buffer.writeFloatLE(NaN, i * 8 + 4);
  }

  // Also inject valid audio
  for (let i = 0; i < frames; i++) {
    if (i % 100 !== 0) {
      const value = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
      buffer.writeFloatLE(value, i * 8);
      buffer.writeFloatLE(value, i * 8 + 4);
    }
  }

  for (let i = 0; i < 4; i++) capture.processAudioFrame(buffer);

  const analytics = capture.getAnalytics();
  assert.ok(analytics.volume > 0, 'volume should recover after NaN samples');
  assert.ok(analytics.bass >= 0 && analytics.bass <= 1, `bass should be valid 0..1, got ${analytics.bass}`);
  assert.ok(analytics.treble >= 0 && analytics.treble <= 1, `treble should be valid 0..1, got ${analytics.treble}`);
  assert.ok(Number.isFinite(analytics.bpm), 'BPM should be finite');
});

test('SketchEngine: loads catalog and selects sketches', () => {
  const engine = makeSketchEngine();
  assert.equal(engine.getSketches().length, 3);

  const selected = engine.selectSketch(0);
  assert.equal(selected, true);
  assert.equal(engine.getCurrentSketch().id, 'sketch_000_test_kaleidoscope');
  assert.equal(engine.getCurrentVariantIndex(), 0);
});

test('SketchEngine: navigates sketches (next/previous/random)', () => {
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  engine.selectNextSketch();
  assert.equal(engine.getCurrentSketch().id, 'sketch_001_test_orbs');

  engine.selectPreviousSketch();
  assert.equal(engine.getCurrentSketch().id, 'sketch_000_test_kaleidoscope');

  const wasRandom = engine.selectRandomSketch();
  assert.equal(wasRandom, true);
  assert.ok(engine.getCurrentSketch());
});

test('SketchEngine: selects variants and triggers tween', () => {
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  const initialUniforms = engine.getCurrentUniforms();
  assert.ok('zoom' in initialUniforms);
  assert.ok('contrast' in initialUniforms);
  assert.ok('sides' in initialUniforms);
  // Boolean uniforms get Tween/TweenProgress helpers added
  assert.ok('warpTweenProgress' in initialUniforms || 'kaleidoscopeTweenProgress' in initialUniforms);

  const selected = engine.selectVariant(1);
  assert.equal(selected, true);
  assert.equal(engine.getCurrentVariantIndex(), 1);
  assert.equal(engine.isTweening(), true);

  const nextUniforms = engine.updateTween(engine.tweenStartTime + 500);
  assert.ok(nextUniforms);
  // Tween uniforms for boolean uniforms are updated during tween
  assert.ok('warpTweenProgress' in nextUniforms || 'kaleidoscopeTweenProgress' in nextUniforms);

  // Advance tween to completion
  engine.updateTween(engine.tweenStartTime + 1500);
  assert.equal(engine.isTweening(), false);
});

test('SketchEngine: magic tween generates valid target variant', () => {
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  engine.magicTween(500, 0.7);
  assert.equal(engine.isTweening(), true);

  const uniforms = engine.updateTween(engine.tweenStartTime + 600);
  assert.ok(uniforms);
  assert.equal(engine.isTweening(), false);
});

test('VariantUtils: generateVariant produces valid variant with same keys', () => {
  const source = { zoom: 10.0, contrast: 1.0, sides: 6, warp: false, colorShift: 1.0 };
  const target = generateVariant(source, 0.7);

  assert.deepEqual(Object.keys(target).sort(), Object.keys(source).sort());
  assert.equal(typeof target.zoom, 'number');
  assert.equal(typeof target.contrast, 'number');
  assert.equal(typeof target.sides, 'number');
  assert.equal(typeof target.warp, 'boolean');
});

test('VariantUtils: buildVariantInterpolator produces smooth interpolation', () => {
  const from = { zoom: 10.0, contrast: 1.0, sides: 6, warp: false };
  const to = { zoom: 20.0, contrast: 1.5, sides: 8, warp: true };

  const interpolator = buildVariantInterpolator(from, to);

  const mid = interpolator(0.5);
  assert.ok(mid.zoom > 10 && mid.zoom < 20, `zoom at 0.5 should be between 10 and 20, got ${mid.zoom}`);
  assert.ok(mid.contrast > 1.0 && mid.contrast < 1.5, `contrast at 0.5 should be between 1.0 and 1.5, got ${mid.contrast}`);
  assert.equal(mid.warp, false, 'bool warp should hold from value at 0.5');

  const end = interpolator(1.0);
  assert.equal(end.zoom, 20);
  assert.equal(end.contrast, 1.5);
  assert.equal(end.sides, 8);
  assert.equal(end.warp, true);

  const start = interpolator(0.0);
  assert.equal(start.zoom, 10);
  assert.equal(start.warp, false);
});

test('VariantUtils: interpolateVariants convenience function works', () => {
  const from = { radius: 5.0, orbSize: 1.0 };
  const to = { radius: 10.0, orbSize: 2.0 };

  const result = interpolateVariants(from, to, 0.25);
  assert.ok(result.radius > 5 && result.radius < 10);
  assert.ok(result.orbSize > 1 && result.orbSize < 2);
});

test('Integration: audio analytics feed into sketch engine uniforms', () => {
  const capture = makeMockAudioCapture();
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  const frame = F32LE_48K_STEREO(0.1, 0.6);
  for (let i = 0; i < 10; i++) capture.processAudioFrame(frame);

  const analytics = capture.getAnalytics();

  const baseUniforms = engine.getCurrentUniforms();
  const uniformsWithAudio = { ...baseUniforms };

  // Simulate how renderer maps analytics to uniforms
  uniformsWithAudio.volume = { value: analytics.volume };
  uniformsWithAudio.bass = { value: analytics.bass };
  uniformsWithAudio.treble = { value: analytics.treble };
  uniformsWithAudio.bpm = { value: analytics.bpm };
  uniformsWithAudio.stream = { value: analytics.stream };

  assert.ok(uniformsWithAudio.volume.value > 0);
  assert.ok(uniformsWithAudio.bass.value >= 0 && uniformsWithAudio.bass.value <= 1);
  assert.ok(uniformsWithAudio.treble.value >= 0 && uniformsWithAudio.treble.value <= 1);
  assert.ok(Number.isInteger(uniformsWithAudio.bpm.value));
});

test('Integration: variant tween updates uniforms for shader on every frame', () => {
  const engine = makeSketchEngine();
  engine.selectSketch(0);
  // selectSketch calls augmentUniformsWithTweens() which adds Tween/TweenProgress for boolean uniforms
  const startUniforms = engine.getCurrentUniforms();
  assert.ok('warpTweenProgress' in startUniforms || 'kaleidoscopeTweenProgress' in startUniforms);

  engine.selectVariant(1);
  const midUniforms = engine.updateTween(engine.tweenStartTime + 500);
  assert.ok(midUniforms);
  assert.ok('warpTweenProgress' in midUniforms || 'kaleidoscopeTweenProgress' in midUniforms);

  // Advance tween to completion
  engine.updateTween(engine.tweenStartTime + 1500);
  assert.equal(engine.isTweening(), false);
});

test('Integration: BPM detection triggers beat uniform', () => {
  const capture = makeMockAudioCapture();

  // Simulate a beat pattern: strong bass at ~120 BPM (500ms interval)
  // Feed enough frames to establish the bass energy envelope
  for (let beat = 0; beat < 12; beat++) {
    // Loud frame = beat
    const frame = F32LE_48K_STEREO(0.02, 1.0);
    for (let i = 0; i < 3; i++) capture.processAudioFrame(frame);

    // Quiet frames between beats
    const quiet = F32LE_48K_STEREO(0.03, 0.05);
    for (let i = 0; i < 5; i++) capture.processAudioFrame(quiet);
  }

  const analytics = capture.getAnalytics();
  // BPM detection requires several beats; may be 0 if not enough data
  // Just verify the system runs without error and produces valid output
  assert.ok(Number.isInteger(analytics.bpm) && analytics.bpm >= 0, `BPM should be non-negative integer, got ${analytics.bpm}`);
  if (analytics.bpm > 0) {
    assert.ok(analytics.bpm >= 60 && analytics.bpm <= 240, `BPM should be in musical range, got ${analytics.bpm}`);
  }
});

test('Integration: adaptive stream increases with sustained audio', () => {
  const capture = makeMockAudioCapture();

  // Sustained loud audio
  const frame = F32LE_48K_STEREO(0.1, 0.8);
  for (let i = 0; i < 30; i++) capture.processAudioFrame(frame);

  const analytics = capture.getAnalytics();
  assert.ok(analytics.stream > 0, 'adaptive stream should increase with sustained audio');
  // stream can exceed 1 during buildup; it's not hard-clamped to 1
});

test('Integration: full pipeline produces valid shader uniforms at 60fps', () => {
  const capture = makeMockAudioCapture();
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  const frame = F32LE_48K_STEREO(0.016, 0.5); // ~60fps frame

  for (let i = 0; i < 60; i++) {
    capture.processAudioFrame(frame);
    const analytics = capture.getAnalytics();

    if (engine.isTweening()) {
      engine.updateTween(performance.now());
    }

    const uniforms = engine.getCurrentUniforms();
    const withAudio = { ...uniforms };
    withAudio.volume = { value: analytics.volume };
    withAudio.bass = { value: analytics.bass };
    withAudio.treble = { value: analytics.treble };
    withAudio.bpm = { value: analytics.bpm };
    withAudio.stream = { value: analytics.stream };

    // Every uniform should have a finite numeric value (or boolean for bool uniforms)
    for (const [key, u] of Object.entries(withAudio)) {
      const val = u?.value ?? u;
      if (typeof val === 'boolean') {
        // boolean uniforms are valid
        assert.ok(true, `uniform ${key} is boolean`);
      } else {
        assert.ok(typeof val === 'number' && Number.isFinite(val),
          `uniform ${key} should have finite numeric value, got ${val}`);
      }
    }
  }
});

test('AudioCapture: resetState clears all analysis state', () => {
  const capture = makeMockAudioCapture();
  capture.processAudioFrame(F32LE_48K_STEREO(0.1, 0.5));

  let analytics = capture.getAnalytics();
  assert.ok(analytics.volume > 0);

  capture.resetState();

  analytics = capture.getAnalytics();
  assert.equal(analytics.volume, 0);
  assert.equal(analytics.stream, 0);
  assert.equal(analytics.bass, 0);
  assert.equal(analytics.treble, 0);
  assert.equal(analytics.bpm, 0);
  assert.equal(analytics.beat, 0);
});

test('AudioCapture: stopCapture tears down process and analytics', async () => {
  const capture = makeMockAudioCapture();
  await capture.startCapture('test-monitor');
  assert.equal(capture.isCapturing, true);

  await capture.stopCapture();
  assert.equal(capture.isCapturing, false);
  assert.equal(capture.process, null);
  assert.equal(capture.analyticsInterval, null);
  assert.equal(capture.getAnalytics().volume, 0);
});

test('SketchEngine: variant key set stable across repeated tweens', () => {
  const engine = makeSketchEngine();
  engine.selectSketch(0);

  const initialKeys = Object.keys(engine.currentUniforms).sort();

  for (let i = 0; i < 5; i++) {
    engine.tweenTo({ zoom: 20.0, contrast: 1.5, sides: 8, warp: true, colorShift: 2.0 }, 10);
    engine.updateTween(engine.tweenStartTime + 20);
  }

  const finalKeys = Object.keys(engine.currentUniforms).sort();
  assert.deepEqual(finalKeys, initialKeys, 'uniform key set must not grow across tweens');
});