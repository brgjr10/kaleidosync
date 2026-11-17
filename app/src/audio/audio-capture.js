import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { createBackend } from './backends/index.js';
import { stopProcess } from './backends/shared.js';

// AudioCapture is the platform-independent analysis core.
//
// It owns the DSP (volume / adaptive stream / bass / treble / BPM) and the
// analytics stream consumed by the renderer. Everything platform specific -
// which tool captures audio, how sources are enumerated, how now-playing
// metadata and transport controls are obtained - lives behind a backend from
// ./backends/. All backends emit the same PCM format on stdout:
//
//   32-bit float little-endian, 48000 Hz, 2 channels interleaved
//
// so a capture on Linux, Windows or macOS feeds exactly the same code path and
// produces exactly the same uniforms.

class AudioCapture extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isCapturing = false;
    this.sources = [];
    this.selectedSource = null;
    this.selectedSourceObject = null;

    this.backend = createBackend(process.platform);
    this.backendStatus = this.backend.status;

    // Analysis state (matching Phase 1 algorithm)
    this.volumeBuffer = [];
    this.state = {
      volume: 0,
      stream: 0,
      level: 0,
      tapped: false,
      bass: 0,
      treble: 0
    };

    // Analysis config
    this.config = {
      bitDepth: 1024,
      lowpassFreq: 7500,
      lowpassQ: 0.75,
      definitions: [2.5, 0.09],
      frameRate: 60,
      sampleRate: 48000,
      channels: 2
    };

    // Silence threshold - idle PipeWire nodes emit a noise floor;
    // below this RMS we treat the frame as silent (volume = 0).
    this.SILENCE_THRESHOLD = 0.001;

    // Playback gating for app sources (Spotify, etc.): the backend reports
    // play/pause state and the frame is forced silent when not playing.
    this.playing = false;

    // Persistent per-frame bass/treble filter state (no growing buffer)
    this.bassLpState = 0;
    this.bassLpAlpha = 0;
    this.trebleHpState = 0;
    this.trebleHpInput1 = 0;
    this.trebleHpAlpha = 0;

    // Frequency analysis buffer - accumulate frames for adequate sample size
    this.freqBuffer = [];
    this.FREQ_MIN_FRAMES = 128;

    // BPM / beat detection
    this.bpm = 0;
    this.lastBeatTime = 0;
    this.lastBeatEnergy = 0;
    this.beatCount = 0;
    this.lastBeatTimeMs = 0;
  }

  async init() {
    await this.backend.init();
    this.backendStatus = this.backend.status;
    await this.enumerateSources();
  }

  getBackendStatus() {
    return {
      id: this.backend.id,
      label: this.backend.label,
      supportsMetadata: this.backend.supportsMetadata,
      supportsProcessAudio: this.backend.supportsProcessAudio,
      ...this.backend.status
    };
  }

  // Re-run source enumeration. Used by the renderer when the auto-detect on
  // launch found nothing (e.g. Spotify's PipeWire node hadn't registered yet
  // because Spotify was opened after Kaleidosync started). Retries up to
  // `retries` times with a backoff so an app opened last still surfaces.
  //
  // Only the Linux backend has a meaningful "node appears later" behaviour,
  // so the other platforms enumerate once and let the renderer drive retries.
  async refreshSources(retries = 8, intervalMs = 500) {
    const passes = this.backend.id === 'linux' ? Math.max(1, retries) : 1;
    for (let i = 0; i < passes; i++) {
      await this.enumerateSources();
      if (this.sources.some(s => s.type === 'application')) return this.sources;
      if (i < passes - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    return this.sources;
  }

  async enumerateSources() {
    this.sources = await this.backend.enumerate();
    this._sortSources();

    console.log(
      `[AudioCapture:${this.backend.id}] Available sources:`,
      this.sources.map(s => `${s.name} (${s.type})`)
    );
    return this.sources;
  }

  // The renderer auto-selects the first 'application' source, or the first
  // 'monitor' source when no app is available. Put the default system output
  // first so that choice lands on the device the user actually hears.
  _sortSources() {
    this.sources.sort((a, b) => {
      const rank = (source) => {
        if (source.type === 'application') return 2;
        return source.isDefault ? 0 : 1;
      };
      return rank(a) - rank(b);
    });
  }

  // Alias for backward compatibility with IPC
  async enumerateDevices() {
    return this.enumerateSources();
  }

  async startCapture(sourceId) {
    if (this.isCapturing) {
      await this.stopCapture();
    }

    const source = this.sources.find(s => s.id === sourceId) || this.sources[0];
    if (!source) {
      throw new Error(this._noSourceMessage());
    }

    this.selectedSource = source.id;
    this.selectedSourceObject = source;
    const sourceType = source.type;
    this.selectedSourceType = sourceType;
    console.log(
      `[AudioCapture:${this.backend.id}] Starting capture on:`,
      source.name,
      '(' + sourceType + ')'
    );

    // Gate on play/pause for app sources. Backends without metadata support
    // leave the gate open so the visuals still react to the system mix.
    this.playing = false;
    if (this.backend.supportsMetadata) {
      this.backend.startPolling(source, (playing) => {
        this.playing = playing;
      });
    } else {
      this.playing = true;
    }

    const spec = this.backend.buildCapture(source);
    if (!spec) {
      this.backend.stopPolling();
      throw new Error(
        `Audio capture is not available for source "${source.name}" on ${this.backend.label}.`
      );
    }

    return new Promise((resolve, reject) => {
      try {
        let proc = spawn(spec.command, spec.args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.on('error', (err) => {
          console.warn(
            `[AudioCapture:${this.backend.id}] capture target bind failed:`,
            err.message
          );
          // Linux pw-record sometimes rejects a numeric object id and needs the
          // node name instead. Backends that have no alternative target simply
          // surface the error through the process 'exit'/'error' handlers.
          const fallback = this.backend.fallbackTarget?.(source);
          if (!fallback) return;
          try {
            const fallbackProc = spawn(
              spec.command,
              spec.args.map((arg) => (arg === String(source.id) ? fallback : arg))
            );
            this._replaceProcess(proc, fallbackProc);
            proc = fallbackProc;
            this._attachProcessHandlers(proc);
          } catch (fallbackErr) {
            console.error(
              `[AudioCapture:${this.backend.id}] fallback capture failed:`,
              fallbackErr.message
            );
          }
        });

        this.process = proc;
        this._attachProcessHandlers(proc);
        this.isCapturing = true;
        this.startAnalyticsEmission();

        // Wait a bit for the process to start producing data
        setTimeout(() => resolve({ success: true, source }), 200);
      } catch (err) {
        reject(err);
      }
    });
  }

  _noSourceMessage() {
    const status = this.backend.status || {};
    const detail = status.detail ? ` (${status.detail})` : '';
    const hint = status.hint ? ` ${status.hint}` : '';
    return `No audio sources found on ${this.backend.label}${detail}.${hint}`;
  }

  _attachProcessHandlers(proc) {
    // Hook the data/error/exit handlers for a (possibly replaced) capture
    // process. Idempotent: handlers are attached to the specific proc object.
    if (proc.__kaleidoAttached) return;
    proc.__kaleidoAttached = true;

    proc.stdout.on('data', (data) => {
      if (!this._buffer) this._buffer = Buffer.alloc(0);
      this._buffer = Buffer.concat([this._buffer, data]);
      const chunkSize = 4096;
      while (this._buffer.length >= chunkSize) {
        const frame = this._buffer.subarray(0, chunkSize);
        this._buffer = this._buffer.subarray(chunkSize);
        this.processAudioFrame(frame);
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error') || msg.includes('FAIL')) {
        console.error(`[AudioCapture:${this.backend.id}] stderr:`, msg.trim());
      }
    });

    proc.on('error', (err) => {
      console.error('[AudioCapture] Process error:', err.message);
      this.emit('error', err);
    });

    proc.on('exit', (code, signal) => {
      console.log(
        `[AudioCapture:${this.backend.id}] Process exited:`,
        code,
        signal
      );
      if (this.isCapturing) {
        this.isCapturing = false;
        const hint = this.backend.status?.hint || '';
        this.emit(
          'error',
          new Error(
            `Audio capture process exited (${code ?? 'signal ' + signal}). ${hint}`.trim()
          )
        );
      }
    });
  }

  _replaceProcess(oldProc, newProc) {
    // Detach handlers from the old process and adopt the new one.
    try {
      if (oldProc) stopProcess(oldProc);
    } catch {
      // Process may already be gone; ignore.
    }
    this.process = newProc;
  }

  async stopCapture() {
    if (this.process) {
      stopProcess(this.process);
      this.process = null;
    }
    this._buffer = Buffer.alloc(0);
    this.isCapturing = false;
    this.stopAnalyticsEmission();
    this.backend.stopPolling();
    this.playing = false;
    this.resetState();
  }

  // Metadata and transport control are delegated to the active backend.
  // (MPRIS on Linux, SMTC on Windows, MediaPlayer/AppleScript on macOS.)
  //
  // Backends return a neutral { status, title, artist, album } shape (the Linux
  // backend returns raw MPRIS metadata). Both are normalised to the MPRIS
  // property names the renderer already understands, so the now-playing display
  // and transport controls behave identically on every platform.
  async getMetadata() {
    if (!this.backend.supportsMetadata || !this.selectedSourceObject) return null;
    const meta = await this.backend.getMetadata(this.selectedSourceObject);
    if (!meta) return null;

    const artist = Array.isArray(meta['xesam:artist'])
      ? meta['xesam:artist']
      : meta.artist
        ? [meta.artist]
        : [];
    const albumArtist = Array.isArray(meta['xesam:albumArtist'])
      ? meta['xesam:albumArtist']
      : meta.albumArtist
        ? [meta.albumArtist]
        : [];

    return {
      'xesam:title': meta['xesam:title'] ?? meta.title ?? '',
      'xesam:artist': artist,
      'xesam:album': meta['xesam:album'] ?? meta.album ?? '',
      'xesam:albumArtist': albumArtist,
      'mpris:trackid': meta['mpris:trackid'] ?? (meta.appId ? `/org/kaleidosync/${meta.appId}` : ''),
      status: meta.status,
      pid: meta.pid || 0,
      backend: this.backend.id
    };
  }

  async sendCommand(command) {
    if (!this.backend.supportsMetadata || !this.selectedSourceObject) return false;
    // The renderer sends MPRIS method names (PlayPause/Next/Previous); every
    // backend expects the lowercase verbs.
    const normalized = String(command || '').toLowerCase();
    return this.backend.sendCommand(this.selectedSourceObject, normalized);
  }

  // Backwards-compatible alias: the Linux backend maps a source to MPRIS.
  mprisIdentityFor(source) {
    if (typeof this.backend.mprisIdentityFor === 'function') {
      return this.backend.mprisIdentityFor(source);
    }
    return null;
  }

  processAudioFrame(frameBuffer) {
    if (!this.framesProcessed) this.framesProcessed = 0;
    this.framesProcessed++;

    // Ensure proper alignment for Float32Array
    const offset = frameBuffer.byteOffset;
    const length = frameBuffer.length;
    const alignedOffset = Math.floor(offset / 4) * 4;
    const alignedLength = length - (offset - alignedOffset);

    if (alignedLength < 4) return;

    const samples = new Float32Array(
      frameBuffer.buffer,
      alignedOffset,
      Math.floor(alignedLength / 4)
    );

    let sum = 0;
    const frameCount = samples.length / 2;
    if (frameCount === 0) return;

    // Gate: for app sources (Spotify, etc.), only treat audio as active
    // when the backend reports Playing; when Paused/Stopped, force silence.
    if (this.selectedSourceType === 'application' && !this.playing) {
      this.state.volume = 0;
      this.state.stream = 0;
      this.state.level = 0;
      this.state.tapped = true;
      this.state.bass = 0;
      this.state.treble = 0;
      return;
    }

    for (let i = 0; i < frameCount; i++) {
      const left = samples[i * 2];
      const right = samples[i * 2 + 1];
      const mono = (left + right) * 0.5;
      const cleanMono = isNaN(mono) ? 0 : mono;
      sum += cleanMono * cleanMono;
    }
    const rms = Math.sqrt(sum / frameCount);
    const volume = rms < this.SILENCE_THRESHOLD ? 0 : Math.min(1, rms * 10);

    // Frequency band analysis (bass/treble split) — real-time per-frame filtering
    const sampleRate = this.config.sampleRate || 48000;
    const lpAlpha = Math.exp(-2 * Math.PI * 80 / sampleRate);
    const hpAlpha = Math.exp(-2 * Math.PI * 2000 / sampleRate);
    let bassTotal = 0;
    let trebleTotal = 0;
    for (let i = 0; i < frameCount; i++) {
      const left = samples[i * 2];
      const right = samples[i * 2 + 1];
      const mono = (left + right) * 0.5;
      const cleanMono = isNaN(mono) ? 0 : mono;
      // Bass: low-pass at 80Hz
      this.bassLpState =
        this.bassLpState + (1 - lpAlpha) * (cleanMono - this.bassLpState);
      bassTotal += this.bassLpState * this.bassLpState;
      // Treble: high-pass at 2000Hz
      const hpOutput =
        hpAlpha * (this.trebleHpState + cleanMono - this.trebleHpInput1);
      this.trebleHpInput1 = cleanMono;
      this.trebleHpState = hpOutput;
      trebleTotal += hpOutput * hpOutput;
    }
    const bassRms = Math.sqrt(bassTotal / frameCount);
    const trebleRms = Math.sqrt(trebleTotal / frameCount);

    // Proportional normalization: each band's share of total energy
    const total = bassRms + trebleRms;
    const bass = total > 0 ? bassRms / total : 0;
    const treble = total > 0 ? trebleRms / total : 0;

    this.state.bass = bass;
    this.state.treble = treble;

    // BPM / beat detection: track bass energy envelope
    this.updateBpm(bassRms);

    this.volumeBuffer.push(volume);
    if (this.volumeBuffer.length > 600) this.volumeBuffer.shift();

    // Opt-in trace. This used to log unconditionally every 60 frames, which
    // crashed the main process with an unhandled EPIPE whenever stdout was a
    // pipe whose reader had gone away (e.g. a packaged app launched from a
    // desktop entry).
    if (process.env.KALEIDOSYNC_TRACE_AUDIO === '1' && this.framesProcessed % 60 === 0) {
      console.log(
        '[AudioCapture] frames=' + this.framesProcessed +
        ' rms=' + rms.toFixed(4) +
        ' volume=' + volume.toFixed(3) +
        ' bpm=' + this.bpm.toFixed(1) +
        ' bass=' + this.state.bass.toFixed(3) +
        ' beat=' + this.state.beat
      );
    }

    const frameDuration = 1000 / this.config.frameRate;
    const refSamples = Math.max(
      1,
      Math.floor((this.config.definitions[0] * 1000) / frameDuration)
    );
    const sampleSamples = Math.max(
      1,
      Math.floor((this.config.definitions[1] * 1000) / frameDuration)
    );

    const ref = this.sampleVolume(refSamples);
    const sample = this.sampleVolume(sampleSamples);

    const r = ref.avg;
    const mn = ref.min;
    const sAvg = sample.avg;

    let adaptive = 0;
    if (r > mn) {
      adaptive = Math.pow((sAvg - mn) / (r - mn), 1.4);
    }
    adaptive = Math.max(0, Math.min(1, adaptive));

    const instant = Math.pow(Math.min(1, (volume * 10) / 1.2), 0.9);

    const raw = 0.45 * adaptive + 0.55 * instant;
    const clampedRaw = Math.max(0, Math.min(1, isFinite(raw) ? raw : 0));

    this.state.volume = this.state.volume * 0.55 + clampedRaw * 0.45;

    this.state.stream += Math.pow(clampedRaw, 0.75) / 10;
    this.state.stream = Number(this.state.stream.toFixed(3));

    this.state.level = volume;
    this.state.tapped = true;
    this.state.bass = bass;
    this.state.treble = treble;
  }

  sampleVolume(windowSize) {
    if (this.volumeBuffer.length === 0) return { avg: 0, min: 0 };
    const start = Math.max(this.volumeBuffer.length - 1, 0);
    const end = Math.max(start - windowSize, 0);
    let sum = 0;
    let min = Infinity;
    let count = 0;
    for (let i = start; i >= end; i--) {
      const v = this.volumeBuffer[i];
      sum += v;
      if (v < min) min = v;
      count++;
    }
    return { avg: count > 0 ? sum / count : 0, min: min === Infinity ? 0 : min };
  }

  startAnalyticsEmission() {
    if (this.analyticsInterval) return;
    this.analyticsInterval = setInterval(() => {
      this.emit('analytics', this.getAnalytics());
    }, 1000 / this.config.frameRate);
  }

  stopAnalyticsEmission() {
    if (this.analyticsInterval) {
      clearInterval(this.analyticsInterval);
      this.analyticsInterval = null;
    }
  }

  resetState() {
    this.volumeBuffer = [];
    this.state = {
      volume: 0,
      stream: 0,
      level: 0,
      tapped: false,
      bass: 0,
      treble: 0,
      bpm: 0,
      beat: 0,
      beatProgress: 0
    };
    this.bassLpState = 0;
    this.trebleHpState = 0;
    this.trebleHpInput1 = 0;
    this.bpm = 0;
    this.lastBeatTime = 0;
    this.lastBeatEnergy = 0;
    this.beatCount = 0;
    this.lastBeatTimeMs = 0;
  }

  // BPM / beat detection using bass energy envelope
  // Returns detected BPM or 0 if not enough data
  updateBpm(bassEnergy) {
    const now = Date.now();
    const minBeatInterval = 250; // ms (240 BPM max)
    const maxBeatInterval = 2000; // ms (30 BPM min)

    // Exponential moving average of bass energy
    const alpha = 0.95;
    if (this.lastBeatEnergy === 0) {
      this.lastBeatEnergy = bassEnergy;
    } else {
      this.lastBeatEnergy = this.lastBeatEnergy * alpha + bassEnergy * (1 - alpha);
    }

    // Beat threshold: current bass energy exceeds running average
    const threshold = this.lastBeatEnergy * 1.4;
    const isBeat = bassEnergy > threshold && bassEnergy > 0.005;

    if (isBeat) {
      if (this.lastBeatTimeMs > 0 && now - this.lastBeatTimeMs > minBeatInterval) {
        const interval = now - this.lastBeatTimeMs;
        if (interval > minBeatInterval && interval < maxBeatInterval) {
          const instantBpm = 60000 / interval;
          if (this.bpm === 0) {
            this.bpm = instantBpm;
          } else {
            this.bpm = this.bpm * 0.8 + instantBpm * 0.2;
          }
          this.beatCount++;
          this.lastBeatTime = this.lastBeatTimeMs;
          this.lastBeatTimeMs = now;
        }
      }
      // First detected beat: initialize timestamp
      if (this.lastBeatTimeMs === 0) {
        this.lastBeatTimeMs = now;
      }
    }

    // Decay BPM if no beats for a while
    if (this.lastBeatTimeMs > 0 && now - this.lastBeatTimeMs > 3000) {
      this.bpm = 0;
      this.lastBeatTimeMs = 0;
      this.beatCount = 0;
    }

    // Store for external access
    this.state.bpm = Math.round(this.bpm);
    this.state.beat = isBeat ? 1 : 0;
    this.state.beatProgress =
      this.lastBeatTimeMs > 0 ? (now - this.lastBeatTimeMs) / 1000 : 0;
  }

  debugLog() {
    console.log(
      '[AudioCapture] debug bpm=', this.bpm,
      'bass=', this.state.bass,
      'treble=', this.state.treble,
      'beat=', this.state.beat,
      'beatProgress=', this.state.beatProgress
    );
  }

  getAnalytics() {
    return {
      volume: this.state.volume,
      stream: this.state.stream,
      level: this.state.level,
      tapped: this.state.tapped,
      source: this.selectedSource,
      bass: this.state.bass || 0,
      treble: this.state.treble || 0,
      bpm: this.bpm || 0,
      beat: this.state.beat || 0,
      beatProgress: this.state.beatProgress || 0
    };
  }
}

export { AudioCapture };