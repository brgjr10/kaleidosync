import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackend } from '../app/src/audio/backends/index.js';
import { LinuxBackend } from '../app/src/audio/backends/linux.js';
import { WindowsBackend } from '../app/src/audio/backends/windows.js';
import { DarwinBackend } from '../app/src/audio/backends/darwin.js';
import { parseJsonLoose, which } from '../app/src/audio/backends/shared.js';
import { AudioCapture } from '../app/src/audio/audio-capture.js';

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

test('createBackend maps every platform to a backend', () => {
  assert.ok(createBackend('linux') instanceof LinuxBackend);
  assert.ok(createBackend('win32') instanceof WindowsBackend);
  assert.ok(createBackend('darwin') instanceof DarwinBackend);
});

test('linux backend exposes the PipeWire contract', () => {
  const backend = new LinuxBackend();
  assert.equal(backend.id, 'linux');
  assert.equal(backend.supportsMetadata, true);
  assert.equal(backend.supportsProcessAudio, true);

  const app = backend.buildCapture({
    id: '42',
    name: 'Spotify',
    type: 'application',
    nodeName: 'spotify'
  });
  assert.equal(app.command, 'pw-record');
  assert.deepEqual(app.args, [
    '--target', '42',
    '--rate', '48000',
    '--channels', '2',
    '--format', 'f32',
    '-'
  ]);
  assert.equal(backend.fallbackTarget({ nodeName: 'spotify' }), 'spotify');

  const monitor = backend.buildCapture({
    id: 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor',
    type: 'monitor',
    hostAPI: 'pulseaudio'
  });
  assert.equal(monitor.command, 'parec');
  assert.equal(monitor.args[1], 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor');
});

test('linux backend parses nested MPRIS metadata', () => {
  const backend = new LinuxBackend();
  const raw =
    "(<'spotify'>, <{'xesam:title': <'Track'>, " +
    "'xesam:artist': <['A', 'B']>, 'mpris:trackid': <objectpath '/item/0'>}>)\n";
  const metadata = backend.parseMprisMetadata(raw);
  assert.equal(metadata['xesam:title'], 'Track');
  assert.deepEqual(metadata['xesam:artist'], ['A', 'B']);
});

test('windows backend captures endpoints and process trees', () => {
  const backend = new WindowsBackend();
  backend.helper = '/native/windows/kaleidosync-wasapi.exe';
  assert.equal(backend.supportsProcessAudio, true);
  const spec = backend.buildCapture({ id: 'endpoint:3' });
  assert.equal(spec.command, backend.helper);
  assert.equal(spec.args[0], '--capture');
  assert.equal(spec.args[1], 'endpoint:3');
  assert.equal(backend.buildCapture({ id: 'pid:1234' }).args[1], 'pid:1234');
});

test('windows backend enumerates nothing without its helper', async () => {
  const backend = new WindowsBackend();
  backend.helper = null;
  assert.deepEqual(await backend.enumerate(), []);
  assert.equal(backend.buildCapture({ id: 'endpoint:0' }), null);
});

test('darwin backend falls back to ffmpeg avfoundation', () => {
  const backend = new DarwinBackend();
  backend.helper = null;
  backend.ffmpeg = true;
  const spec = backend.buildCapture({ id: 'avfoundation:0', avfoundationIndex: 0 });
  assert.equal(spec.command, 'ffmpeg');
  assert.equal(spec.args[spec.args.indexOf('-i') + 1], ':0');
  assert.equal(spec.args[spec.args.length - 1], '-');
});

test('darwin backend enumerates nothing without helper or ffmpeg', async () => {
  const backend = new DarwinBackend();
  backend.helper = null;
  backend.ffmpeg = false;
  assert.deepEqual(await backend.enumerate(), []);
});

test('parseJsonLoose tolerates banners before the payload', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('log line\n[{"a":1}]\ntrailing'), [{ a: 1 }]);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose('no json here'), null);
});

test('which resolves a real executable', () => {
  assert.ok(which('node'));
  assert.equal(which('definitely-not-a-real-binary-xyz'), null);
});

test('processAudioFrame turns f32le PCM into non-zero analytics', () => {
  const capture = new AudioCapture();
  capture.backend = createBackend('linux');
  const frame = F32LE_48K_STEREO(0.05, 0.5);
  for (let i = 0; i < 4; i++) capture.processAudioFrame(frame);

  const analytics = capture.getAnalytics();
  assert.ok(analytics.volume > 0, 'volume should be non-zero');
  assert.equal(analytics.tapped, true);
  assert.ok(analytics.bass >= 0 && analytics.bass <= 1);
  assert.ok(analytics.treble >= 0 && analytics.treble <= 1);
});

test('silence produces zero volume', () => {
  const capture = new AudioCapture();
  const frames = 4800;
  const buffer = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < 10; i++) capture.processAudioFrame(buffer);
  const analytics = capture.getAnalytics();
  assert.equal(analytics.volume, 0);
  assert.equal(analytics.level, 0);
});

test('app sources are gated to silence while paused', () => {
  const capture = new AudioCapture();
  capture.selectedSourceType = 'application';
  capture.playing = false;

  const frame = F32LE_48K_STEREO(0.05, 0.8);
  capture.processAudioFrame(frame);
  let analytics = capture.getAnalytics();
  assert.equal(analytics.volume, 0);
  assert.equal(analytics.level, 0);
  assert.equal(analytics.tapped, true);

  capture.playing = true;
  capture.processAudioFrame(frame);
  analytics = capture.getAnalytics();
  assert.ok(analytics.volume > 0, 'unpaused app audio should register');
});

test('monitor sources are never gated', () => {
  const capture = new AudioCapture();
  capture.selectedSourceType = 'monitor';
  capture.playing = false;
  capture.processAudioFrame(F32LE_48K_STEREO(0.05, 0.8));
  assert.ok(capture.getAnalytics().volume > 0);
});

test('startCapture explains a missing source with backend detail', async () => {
  const capture = new AudioCapture();
  capture.sources = [];
  capture.backend = {
    id: 'win32',
    label: 'WASAPI',
    supportsMetadata: false,
    status: { available: false, detail: 'no output device', hint: 'Enable one.' },
    enumerate: async () => [],
    buildCapture: () => null,
    startPolling: () => {},
    stopPolling: () => {}
  };
  await assert.rejects(() => capture.startCapture('anything'), /WASAPI/);
  await assert.rejects(() => capture.startCapture('anything'), /no output device/);
});

test('stopCapture tears down polling and state', async () => {
  const capture = new AudioCapture();
  capture.backend = createBackend('linux');
  capture.isCapturing = true;
  capture.playing = true;
  capture.selectedSourceType = 'application';
  capture.startAnalyticsEmission();
  await capture.stopCapture();

  assert.equal(capture.isCapturing, false);
  assert.equal(capture.playing, false);
  assert.equal(capture.analyticsInterval, null);
  assert.deepEqual(capture.getAnalytics().volume, 0);
});
test('getMetadata normalises every backend to MPRIS property names', async () => {
  const capture = new AudioCapture();
  capture.backend = {
    id: 'win32',
    supportsMetadata: true,
    getMetadata: async () => ({
      status: 'playing',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      appId: 'SpotifyAB.SpotifyMusic',
      pid: 42
    }),
    sendCommand: async (source, command) => command
  };
  capture.selectedSourceObject = { id: 'pid:42' };

  const metadata = await capture.getMetadata();
  assert.equal(metadata['xesam:title'], 'Song');
  assert.deepEqual(metadata['xesam:artist'], ['Artist']);
  assert.equal(metadata['xesam:album'], 'Album');
  assert.equal(metadata.status, 'playing');
  assert.equal(metadata.backend, 'win32');

  // The renderer sends MPRIS method names; backends take lowercase verbs.
  assert.equal(await capture.sendCommand('PlayPause'), 'playpause');
  assert.equal(await capture.sendCommand('Next'), 'next');
});

test('getMetadata passes raw MPRIS metadata through untouched', async () => {
  const capture = new AudioCapture();
  capture.backend = {
    id: 'linux',
    supportsMetadata: true,
    getMetadata: async () => ({
      'xesam:title': 'Track',
      'xesam:artist': ['A', 'B'],
      'xesam:album': 'Record',
      'mpris:trackid': '/org/mpris/MediaPlayer2/spotify/track/1'
    }),
    sendCommand: async () => true
  };
  capture.selectedSourceObject = { id: '9' };

  const metadata = await capture.getMetadata();
  assert.equal(metadata['xesam:title'], 'Track');
  assert.deepEqual(metadata['xesam:artist'], ['A', 'B']);
  assert.equal(metadata['mpris:trackid'], '/org/mpris/MediaPlayer2/spotify/track/1');
});
