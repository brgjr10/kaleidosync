import { dirname, join } from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureCompiled, hasBinary, parseJsonLoose, preferUnpacked, runProcess } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// macOS backend: ScreenCaptureKit.
//
//   capture    native/macos/kaleidosync-sckit.swift, compiled at first run
//              with swiftc (Xcode Command Line Tools) and cached. Provides
//              system audio plus per-application audio without a virtual
//              device.
//   metadata   osascript, best effort for Spotify and Apple Music.
//
// If no Swift toolchain is available the backend falls back to ffmpeg +
// avfoundation, which can only see input devices (a virtual loopback device
// such as BlackHole must be installed for system audio).
//
// A source is always: { id, name, type: 'application' | 'monitor', hostAPI, ... }
//   system            system-wide audio
//   pid:<pid>         one application's audio
//   avfoundation:<n>  an avfoundation audio input device (fallback only)

const HELPER_SOURCE = 'kaleidosync-sckit.swift';
const HELPER_NAME = 'kaleidosync-sckit';

export class DarwinBackend {
  constructor() {
    this.id = 'darwin';
    this.label = 'ScreenCaptureKit';
    // Metadata/transport controls require the Swift helper: getMetadata() and
    // sendCommand() both need an AppleScript-mappable source (Spotify/Music),
    // which only the helper's source list provides. In the ffmpeg fallback
    // every source is an avfoundation input device, so this stays false and
    // the renderer hides the playback controls instead of showing dead ones.
    this.supportsMetadata = false;
    this.supportsProcessAudio = false;
    this.status = { available: false, detail: '', hint: '' };

    this.helper = null;
    this.ffmpeg = false;
    this.metadataTimer = null;
    this.metadata = null;
    this.playing = true;
    this._onPlayback = null;
    this._source = null;
  }

  async init() {
    const swiftSource = this._resolveSource();
    this.helper = swiftSource ? this._resolveHelper() : null;

    if (swiftSource && !this.helper) {
      const swiftc = await hasBinary('swiftc') ? 'swiftc' : null;
      if (swiftc) {
        const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`;
        let swiftText = '';
        try {
          swiftText = fs.readFileSync(swiftSource, 'utf8');
        } catch (err) {
          console.warn('[AudioCapture:darwin] could not read Swift helper:', err.message);
        }
        this.helper = await ensureCompiled({
          name: HELPER_NAME,
          source: swiftText,
          sources: [target, swiftSource],
          onLog: (message) => console.warn(`[AudioCapture:darwin] ${message}`),
          build: (outPath) => ({
            command: swiftc,
            args: [
              '-O',
              '-target', target,
              '-framework', 'ScreenCaptureKit',
              '-framework', 'CoreMedia',
              '-framework', 'CoreGraphics',
              '-framework', 'AppKit',
              '-framework', 'AVFAudio',
              '-o', outPath,
              swiftSource
            ]
          })
        });
      }
    }

    this.ffmpeg = await hasBinary('ffmpeg');
    this.supportsProcessAudio = Boolean(this.helper);

    if (this.helper) {
      const check = await runProcess(this.helper, ['--check'], { timeoutMs: 20000 });
      const info = parseJsonLoose(check.stdout) || {};
      if (info.ok) {
        // The helper can list sources and mediate playback, so now-playing
        // metadata and transport controls are only real when this succeeds.
        this.supportsMetadata = true;
        this.status = {
          available: true,
          detail: 'ScreenCaptureKit (system + per-app audio)',
          hint: ''
        };
      } else {
        this.status = {
          available: false,
          detail: info.detail || 'ScreenCaptureKit reported it cannot capture',
          hint: 'Grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording, then restart Kaleidosync.'
        };
      }
      return this.status;
    }

    if (this.ffmpeg) {
      this.status = {
        available: true,
        detail: 'ffmpeg avfoundation (input devices only)',
        hint: 'Install Xcode Command Line Tools (xcode-select --install) for system audio without a virtual device.'
      };
      return this.status;
    }

    this.status = {
      available: false,
      detail: 'no ScreenCaptureKit helper and no ffmpeg',
      hint: 'Install Xcode Command Line Tools (xcode-select --install) or install ffmpeg.'
    };
    return this.status;
  }

  _resolveSource() {
    return this._candidates(HELPER_SOURCE, fs.constants.R_OK);
  }

  _resolveHelper() {
    return this._candidates(HELPER_NAME, fs.constants.X_OK);
  }

  _candidates(name, mode) {
    const found = [];
    if (process.env.KALEIDOSYNC_NATIVE_DIR) {
      // semgrep-ignore-next-line: KALEIDOSYNC_NATIVE_DIR is an admin-configured path
      found.push(join(process.env.KALEIDOSYNC_NATIVE_DIR, 'macos', name));
    }
    // semgrep-ignore-next-line: __dirname-relative path to bundled native helper
    found.push(join(__dirname, '..', '..', '..', 'native', 'macos', name));
    if (process.resourcesPath) {
      // semgrep-ignore-next-line: process.resourcesPath is Electron-controlled
      found.push(join(process.resourcesPath, 'native', 'macos', name));
      // semgrep-ignore-next-line: process.resourcesPath is Electron-controlled
      found.push(join(process.resourcesPath, 'app.asar.unpacked', 'native', 'macos', name));
    }
    for (const candidate of found) {
      try {
        fs.accessSync(candidate, mode);
        return preferUnpacked(candidate, mode);
      } catch {
        // keep looking
      }
    }
    return null;
  }

  async enumerate() {
    if (this.helper) {
      const result = await runProcess(this.helper, ['--list'], { timeoutMs: 20000 });
      const sources = parseJsonLoose(result.stdout);
      if (Array.isArray(sources)) {
        return sources.map((source) => ({
          id: String(source.id),
          name: String(source.name),
          type: source.type === 'application' ? 'application' : 'monitor',
          isDefault: source.isDefault !== false,
          pid: source.pid || null,
          bundleId: source.bundleId || null,
          hostAPI: 'screencapturekit',
          maxInputChannels: 2,
          defaultSampleRate: 48000
        }));
      }
      console.warn('[AudioCapture:darwin] helper listing failed:', result.stderr.trim());
    }

    if (this.ffmpeg) {
      return this._enumerateAvFoundation();
    }
    return [];
  }

  async _enumerateAvFoundation() {
    const result = await runProcess(
      'ffmpeg',
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeoutMs: 15000 }
    );
    const text = result.stderr || '';
    const marker = text.indexOf('AVFoundation audio devices');
    if (marker === -1) return [];

    const sources = [];
    for (const line of text.slice(marker).split('\n')) {
      const match = line.match(/\[(\d+)\]\s+(.*)/);
      if (!match) continue;
      const index = Number(match[1]);
      sources.push({
        id: `avfoundation:${index}`,
        name: `${match[2].trim()} (Input Device)`,
        type: 'monitor',
        isDefault: sources.length === 0,
        hostAPI: 'avfoundation',
        avfoundationIndex: index,
        maxInputChannels: 2,
        defaultSampleRate: 48000
      });
    }
    return sources;
  }

  buildCapture(source) {
    if (this.helper) {
      return { command: this.helper, args: ['--capture', String(source.id)] };
    }
    if (this.ffmpeg && source.avfoundationIndex !== undefined) {
      return {
        command: 'ffmpeg',
        args: [
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 'avfoundation',
          '-i', `:${source.avfoundationIndex}`,
          '-ar', '48000',
          '-ac', '2',
          '-f', 'f32le',
          '-'
        ]
      };
    }
    return null;
  }

  // ----------------------------------------------------------------- metadata

  startPolling(source, onPlayback) {
    this.stopPolling();
    this._source = source;
    this._onPlayback = onPlayback;

    const target = appleScriptApp(source);
    if (!target) {
      this.playing = true;
      onPlayback?.(true);
      return;
    }

    const poll = async () => {
      const metadata = await this._queryAppleScript(target);
      if (!this._source || !this._onPlayback) return;
      this.metadata = metadata;
      const playing = Boolean(metadata && metadata.status === 'playing');
      this.playing = playing;
      this._onPlayback(playing);
    };

    poll();
    this.metadataTimer = setInterval(poll, 1000);
  }

  async _queryAppleScript(app) {
    const script = `
tell application "${app}"
  if player state is stopped then return "stopped|"
  set trackName to name of current track
  set trackArtist to artist of current track
  set trackAlbum to album of current track
  return (player state as text) & "|" & trackName & "|" & trackArtist & "|" & trackAlbum
end tell`;
    const result = await runProcess('osascript', ['-e', script], { timeoutMs: 8000 });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    const [status, title, artist, album] = result.stdout.trim().split('|');
    return {
      status: status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'stopped',
      title: title || '',
      artist: artist || '',
      album: album || '',
      appId: app,
      pid: 0
    };
  }

  stopPolling() {
    if (this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = null;
    }
    this.metadata = null;
    this._source = null;
    this._onPlayback = null;
    this.playing = true;
  }

  async getMetadata() {
    return this.metadata;
  }

  async sendCommand(source, command) {
    const app = appleScriptApp(source);
    if (!app) return false;

    const commands = {
      playpause: 'playpause',
      next: 'next track',
      previous: 'previous track'
    };
    const phrase = commands[command];
    if (!phrase) return false;

    const result = await runProcess('osascript', ['-e', `tell application "${app}" to ${phrase}`], {
      timeoutMs: 8000
    });
    return result.code === 0;
  }
}

function appleScriptApp(source) {
  if (!source) return null;
  const name = (source.name || '').toLowerCase();
  const bundle = (source.bundleId || '').toLowerCase();
  if (bundle.includes('spotify') || name.includes('spotify')) return 'Spotify';
  if (bundle === 'com.apple.music' || bundle.includes('apple.music') || name === 'music') {
    return 'Music';
  }
  return null;
}