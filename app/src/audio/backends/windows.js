import { spawn } from 'child_process';
import * as fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Windows backend: WASAPI.
//
//   capture    native/windows/kaleidosync-wasapi.exe (prebuilt, no toolchain
//              needed). Provides WASAPI loopback of the default/all render
//              endpoints plus per-process loopback (Windows 10 2004+).
//   metadata   native/windows/smtc.ps1 (System Media Transport Controls),
//              the Windows counterpart of Linux MPRIS.
//
// A source is always: { id, name, type: 'application' | 'monitor', hostAPI, ... }
//   endpoint:<n>  loopback of the nth active render endpoint (system audio)
//   pid:<pid>     loopback of one application's audio

import { parseJsonLoose, preferUnpacked, runProcess, stopProcess } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const POWERSHELL = () =>
  process.env.SYSTEM_ROOT
    ? join(process.env.SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';

export class WindowsBackend {
  constructor() {
    this.id = 'win32';
    this.label = 'WASAPI';
    this.supportsMetadata = true;
    this.supportsProcessAudio = true;
    this.status = { available: false, detail: '', hint: '' };

    this.helper = null;
    this.smtcScript = null;
    this.playbackTimer = null;
    this.metadataProc = null;
    this.metadataBuffer = '';
    this.sessions = [];
    this.playing = false;
    this._onPlayback = null;
    this._source = null;
  }

  async init() {
    this.helper = this._resolveHelper();
    this.smtcScript = this._resolveScript('smtc.ps1');

    if (!this.helper) {
      this.status = {
        available: false,
        detail: 'kaleidosync-wasapi.exe is missing from the native/windows directory',
        hint: 'Run "npm run build:native" (needs mingw-w64) or reinstall the app.'
      };
      return this.status;
    }

    const result = await runProcess(this.helper, ['--check'], { timeoutMs: 15000 });
    if (result.error && result.error.code === 'ENOENT') {
      this.status = {
        available: false,
        detail: 'kaleidosync-wasapi.exe could not be executed',
        hint: 'Reinstall the app or run "npm run build:native".'
      };
      return this.status;
    }

    const check = parseJsonLoose(result.stdout) || {};
    if (check.ok) {
      this.status = {
        available: true,
        detail: 'WASAPI (loopback + per-app process loopback)',
        hint: ''
      };
      // Per-app loopback needs Windows 10 2004 (build 19041) or newer.
      if (!this.smtcScript) {
        this.status.hint = 'Now-playing metadata unavailable: smtc.ps1 is missing.';
      }
    } else {
      this.status = {
        available: false,
        detail: check.detail || 'WASAPI loopback unavailable',
        hint: 'Check that an output device is enabled in Windows Sound settings.'
      };
    }
    return this.status;
  }

  // Native helpers must live outside app.asar to be executable, so resolve the
  // unpacked copy when running from a packaged build.
  _resolve(relative) {
    const candidates = [];
    if (process.env.KALEIDOSYNC_NATIVE_DIR) {
      candidates.push(join(process.env.KALEIDOSYNC_NATIVE_DIR, 'windows', relative));
    }
    // app/src/audio/backends -> repo root
    candidates.push(join(__dirname, '..', '..', '..', 'native', 'windows', relative));
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'native', 'windows', relative));
      candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'native', 'windows', relative));
    }
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return preferUnpacked(candidate, fs.constants.X_OK);
      } catch {
        // keep looking
      }
    }
    return null;
  }

  _resolveHelper() {
    return this._resolve('kaleidosync-wasapi.exe');
  }

  _resolveScript(name) {
    // PowerShell scripts only need to be readable.
    const candidates = [];
    if (process.env.KALEIDOSYNC_NATIVE_DIR) {
      candidates.push(join(process.env.KALEIDOSYNC_NATIVE_DIR, 'windows', name));
    }
    candidates.push(join(__dirname, '..', '..', '..', 'native', 'windows', name));
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'native', 'windows', name));
      candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'native', 'windows', name));
    }
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return preferUnpacked(candidate, fs.constants.R_OK);
      } catch {
        // keep looking
      }
    }
    return null;
  }

  async enumerate() {
    if (!this.helper) return [];

    const result = await runProcess(this.helper, ['--list'], { timeoutMs: 15000 });
    const sources = parseJsonLoose(result.stdout);
    if (!Array.isArray(sources)) {
      console.warn('[AudioCapture:win32] could not list WASAPI endpoints:', result.stderr.trim());
      return [];
    }

    return sources.map((source) => ({
      id: String(source.id),
      name: String(source.name),
      type: source.type === 'application' ? 'application' : 'monitor',
      isDefault: Boolean(source.isDefault),
      pid: source.pid || null,
      hostAPI: 'wasapi',
      maxInputChannels: 2,
      defaultSampleRate: 48000
    }));
  }

  buildCapture(source) {
    if (!this.helper) return null;
    return {
      command: this.helper,
      args: ['--capture', String(source.id)]
    };
  }

  // ----------------------------------------------------------------- metadata

  startPolling(source, onPlayback) {
    this.stopPolling();
    this._source = source;
    this._onPlayback = onPlayback;
    this.sessions = [];

    if (!this.smtcScript || !this._hasPowerShell()) {
      // Without SMTC the app still captures audio; the play/pause gate simply
      // stays open so visuals react to whatever is playing.
      this.playing = true;
      onPlayback?.(true);
      return;
    }

    // semgrep-ignore-next-line: intentional spawn to watch SMTC playback status
    const proc = spawn(POWERSHELL(), [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.smtcScript,
      '-Mode', 'watch'
    ], { windowsHide: true });

    this.metadataProc = proc;
    this.metadataBuffer = '';

    proc.stdout.on('data', (data) => {
      this.metadataBuffer += data.toString();
      const lines = this.metadataBuffer.split(/\r?\n/);
      this.metadataBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const session = parseJsonLoose(line);
        if (session && session.status) this._ingestSession(session);
      }
    });

    proc.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) console.warn('[AudioCapture:win32] smtc:', message);
    });

    proc.on('error', (err) => {
      console.warn('[AudioCapture:win32] smtc spawn failed:', err.message);
      this.playing = true;
      this._onPlayback?.(true);
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[AudioCapture:win32] smtc watcher exited with code ${code}`);
      }
      this.metadataProc = null;
    });
  }

  _hasPowerShell() {
    const path = POWERSHELL();
    if (path !== 'powershell.exe') {
      try {
        fs.accessSync(path, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  _ingestSession(session) {
    if (session.status === 'unavailable') {
      this.sessions = [];
      return;
    }
    const index = this.sessions.findIndex((s) => s.pid === session.pid && s.appId === session.appId);
    if (index >= 0) this.sessions[index] = session;
    else this.sessions.push(session);

    const playing = this.sessions.some((s) => s.status === 'playing');
    if (playing !== this.playing) {
      this.playing = playing;
      this._onPlayback?.(playing);
    } else {
      // Status may have changed for the selected source without flipping the
      // global flag (e.g. app A paused while app B keeps playing).
      this._onPlayback?.(this.isSourcePlaying());
    }
  }

  _sessionForSource() {
    if (!this._source) return null;
    if (this._source.type === 'application' && this._source.pid) {
      return this.sessions.find((s) => s.pid === this._source.pid) || null;
    }
    return this.sessions.find((s) => s.status === 'playing') || this.sessions[0] || null;
  }

  isSourcePlaying() {
    if (this.sessions.length === 0) return true;
    const session = this._sessionForSource();
    if (!session) return false;
    return session.status === 'playing';
  }

  stopPolling() {
    if (this.metadataProc) {
      stopProcess(this.metadataProc);
      this.metadataProc = null;
    }
    this.metadataBuffer = '';
    this.sessions = [];
    this.playing = false;
    this._source = null;
    this._onPlayback = null;
  }

  async getMetadata() {
    if (this.sessions.length === 0) return null;
    const session = this._sessionForSource();
    if (!session) return null;
    return {
      status: session.status,
      title: session.title || '',
      artist: session.artist || '',
      album: session.album || '',
      appId: session.appId || '',
      pid: session.pid || 0
    };
  }

  async sendCommand(source, command) {
    if (!this.smtcScript) return false;
    const pid = source?.pid ? String(source.pid) : '0';
    const result = await runProcess(
      POWERSHELL(),
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.smtcScript,
        '-Mode', 'command',
        '-Pid', pid,
        '-Command', command
      ],
      { timeoutMs: 20000 }
    );
    return result.code === 0;
  }
}