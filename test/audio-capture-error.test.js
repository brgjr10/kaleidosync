import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioCapture } from '../app/src/audio/audio-capture.js';

// --- Issue #88: an unhandled AudioCapture 'error' event used to crash the ---
// --- main process. The class must tolerate having no listener at the moment ---
// --- the backend emits, and still deliver the error to whoever subscribes. ---

function makeCapture() {
  const capture = new AudioCapture();
  capture.backend = {
    id: 'linux',
    label: 'PipeWire',
    supportsMetadata: false,
    status: { available: true, detail: '', hint: 'install pipewire' },
    enumerate: async () => [],
    // `sleep 60` stays alive long enough for the test to drive process events.
    buildCapture: () => ({ command: 'sleep', args: ['60'] }),
    startPolling: () => {},
    stopPolling: () => {}
  };
  capture.sources = [{ id: 'dev', name: 'Dev', type: 'monitor' }];
  return capture;
}

test('AudioCapture emits error when the capture process dies', async () => {
  const capture = makeCapture();
  const errors = [];
  capture.on('error', (err) => errors.push(err));

  await capture.startCapture('dev');
  assert.equal(capture.isCapturing, true);

  capture.process.emit('exit', 1, null);

  assert.equal(errors.length, 1, 'one error event should be emitted');
  assert.match(errors[0].message, /exited/);
  assert.match(errors[0].message, /pipewire/);
  assert.equal(capture.isCapturing, false);

  // Clean up the real `sleep` child and analytics interval so the runner exits.
  await capture.stopCapture();
});

test('an AudioCapture error without a main-process listener does not throw', async () => {
  const capture = makeCapture();
  await capture.startCapture('dev');

  // No 'error' listener on the AudioCapture instance itself (main.js wires
  // one in initializeAudioCapture). The class must still attach its own
  // handler to the child process so a process-level 'error' does not bubble
  // as an unhandled 'error' on the ChildProcess.
  assert.ok(capture.process.listenerCount('error') >= 1,
    'AudioCapture must attach its own error handler to the child process');
  assert.doesNotThrow(() => capture.process.emit('error', new Error('boom')));
  assert.equal(capture.listenerCount('error'), 0,
    'no listener was ever registered on the AudioCapture instance');

  // Clean up the real `sleep` child and analytics interval so the runner exits.
  await capture.stopCapture();
});