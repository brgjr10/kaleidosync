import { EventEmitter } from 'events';
import { spawn } from 'child_process';

class AudioCapture extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isCapturing = false;
    this.sources = [];
    this.selectedSource = null;
    
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

    // Node-state gating for app sources (Spotify, etc.):
    // Poll PipeWire node state; if not 'running', treat as silent.
    this.nodeState = 'unknown';
    this.nodeStateTimer = null;
    this.currentNodeId = null;

    // MPRIS "now playing" gating for app sources (Spotify):
    // Poll org.mpris.MediaPlayer2.<app> PlaybackStatus via gdbus;
    // treat as silent when Paused/Stopped.
    this.playing = false;
    this.playbackTimer = null;
    this.selectedSourceType = null;
    
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
    await this.enumerateSources();
  }

  // Re-run source enumeration. Used by the renderer when the auto-detect on
  // launch found nothing (e.g. Spotify's PipeWire node hadn't registered yet
  // because Spotify was opened after Kaleidosync started). Retries up to
  // `retries` times with a backoff so an app opened last still surfaces.
  async refreshSources(retries = 8, intervalMs = 500) {
    for (let i = 0; i < retries; i++) {
      await this.enumerateSources();
      if (this.sources.some(s => s.type === 'application')) return this.sources;
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    return this.sources;
  }
  
  async enumerateSources() {
    this.sources = [];
    
    // Get PipeWire application nodes (sink inputs) via pw-dump
    await this.enumeratePipeWireNodes();
    
    // Get PulseAudio monitor sources as fallback
    await this.enumerateMonitors();
    
    console.log('[AudioCapture] Available sources:', this.sources.map(s => `${s.name} (${s.type})`));
    return this.sources;
  }
  
  async enumeratePipeWireNodes() {
    return new Promise((resolve) => {
      const proc = spawn('pw-dump', ['-N']);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', () => {
        try {
          const objects = JSON.parse(output);
          for (const obj of objects) {
            if (obj.type === 'PipeWire:Interface:Node' && obj.info?.props) {
              const props = obj.info.props;
              const mediaClass = props['media.class'] || '';
              const nodeName = props['node.name'] || '';
              const appName = props['application.name'] || props['application.process.binary'] || props['node.description'] || '';
              const nodeNick = props['node nick'] || '';
              
              // Broaden the filter: any PipeWire Node that represents an
              // audio stream (application sink input, audio sink, or an
              // audio source) is a capture target. Flatpak/snap apps and
              // apps that expose a non-standard media.class used to be
              // silently skipped here, so Spotify never entered the source
              // list. Fall back to node.name/node.description for naming.
              const isAudioNode =
                mediaClass.includes('Stream/Output/Audio') ||
                mediaClass.includes('Audio/SinkInput') ||
                mediaClass.includes('Stream/Audio') ||
                mediaClass.includes('Audio/Sink') ||
                mediaClass.includes('Audio/Source') ||
                mediaClass.includes('Audio') ||
                mediaClass.includes('Stream');
              
              if (!isAudioNode) continue;
              
              // Skip pure monitor nodes (those are handled by enumerateMonitors)
              if (mediaClass.includes('Audio/Adapter') || mediaClass.includes('Device')) continue;
              
              this.sources.push({
                id: String(obj.id),
                name: appName || nodeName || nodeNick || `PipeWire Node ${obj.id}`,
                type: 'application',
                mediaClass,
                nodeName,
                hostAPI: 'pipewire',
                maxInputChannels: 2,
                defaultSampleRate: 48000
              });
            }
          }
        } catch (e) {
          console.warn('[AudioCapture] Failed to parse pw-dump:', e.message);
        }
        resolve();
      });
    });
  }
  
  async enumerateMonitors() {
    return new Promise((resolve) => {
      const proc = spawn('pactl', ['list', 'short', 'sources']);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', () => {
        const lines = output.trim().split('\n');
        for (const line of lines) {
          if (line.includes('.monitor')) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
              this.sources.push({
                id: parts[1],
                name: parts[1].replace('.monitor', '') + ' (System Monitor)',
                type: 'monitor',
                hostAPI: 'pulseaudio',
                maxInputChannels: 2,
                defaultSampleRate: 48000
              });
            }
          }
        }
        resolve();
      });
    });
  }
  
  // Alias for backward compatibility with IPC
  async enumerateDevices() {
    return this.enumerateSources();
  }

// Map app source name to MPRIS identity (e.g. Spotify -> spotify).
// Returns the player NAME suffix used to build the D-Bus destination
// `org.mpris.MediaPlayer2.<name>`. Flatpak/snap installs register as
// `org.mpris.MediaPlayer2.spotify.Spotify` etc., so we also try the base name
// (everything after the last dot) and fall back to scanning all MPRIS
// destinations via `gdbus list` in queryMprisMetadata()/queryMprisPlaying().
mprisIdentityFor(source) {
    const name = (source.name || '').toLowerCase();
    const id = (source.id || '').toLowerCase();
    const mediaClass = (source.mediaClass || '').toLowerCase();
    const combined = name + ' ' + id + ' ' + mediaClass;
    
    if (combined.includes('spotify')) return 'spotify';
    if (combined.includes('vlc')) return 'vlc';
    if (combined.includes('audacious')) return 'audacious';
    if (combined.includes('amarok')) return 'amarok';
    if (combined.includes('musicbrainz')) return 'musicbrainz';
    if (combined.includes('clementine')) return 'clementine';
    if (combined.includes('rhythmbox')) return 'rhythmbox';
    if (combined.includes('helix')) return 'helix';
    if (combined.includes('gnome-music')) return 'gnome-music';
    if (combined.includes('quodlibet')) return 'quodlibet';
    if (combined.includes('banshee')) return 'banshee';
    if (combined.includes('deezer')) return 'deezer';
    if (combined.includes('webaudio')) return 'webaudio';
    if (combined.includes('pianobar')) return 'pianobar';
    if (combined.includes('mopidy')) return 'mopidy';
    if (combined.includes('cmus')) return 'cmus';
    if (combined.includes('mpv')) return 'mpv';
    if (combined.includes('exaile')) return 'exaile';
    if (combined.includes('kodi')) return 'kodi';
    if (combined.includes('jriver')) return 'jriver';
    if (combined.includes('foobar')) return 'foobar';
    if (combined.includes('winamp')) return 'winamp';
    if (combined.includes('deadbeef')) return 'deadbeef';
    if (combined.includes('music')) return 'music';
    return null;
  }

  // Resolve an mprisId (which may be a base name like 'spotify' or a full
  // destination suffix like 'spotify.Spotify') to the exact D-Bus destination
  // that is actually registered. Falls back to scanning all MPRIS players.
  async resolveMprisDestination(mprisId) {
    // Cache the resolved destination. The D-Bus destination may not be
    // registered yet (Spotify just launched), so we retry until it appears.
    if (this._mprisDestCache && this._mprisDestCache[mprisId]) {
      return this._mprisDestCache[mprisId];
    }
    if (!this._mprisDestCache) this._mprisDestCache = {};

    const base = `org.mpris.MediaPlayer2.${mprisId}`;
    // Try the exact destination first.
    if (await this.mprisDestinationExists(base)) {
      this._mprisDestCache[mprisId] = base;
      return base;
    }
    // Flatpak/snap installs often append a suffix (e.g. spotify.Spotify).
    if (mprisId.includes('.')) {
      if (await this.mprisDestinationExists(base)) {
        this._mprisDestCache[mprisId] = base;
        return base;
      }
    }
    // Scan all MPRIS destinations and pick the one whose suffix matches.
    const match = await this.findMprisDestination(mprisId);
    if (match) this._mprisDestCache[mprisId] = match;
    return match;
  }

  mprisDestinationExists(dest) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player', 'PlaybackStatus'
      ]);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', (code) => {
        resolve(code === 0 && (output.includes('Playing') || output.includes('Paused') || output.includes('Stopped')));
      });
      proc.on('error', () => resolve(false));
    });
  }

  // List every org.mpris.MediaPlayer2.* destination on the session bus and
  // return the one whose player-name suffix matches mprisId (e.g. 'spotify'
  // matches 'org.mpris.MediaPlayer2.spotify.Spotify'). Uses `gdbus list
  // --session` (which lists all unique names) and filters client-side, because
  // `gdbus list --name <glob>` is not a valid invocation.
  async findMprisDestination(mprisId) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', ['list', '--session']);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', () => {
        const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
        const needle = mprisId.toLowerCase();
        const candidates = lines.filter(l => l.startsWith('org.mpris.MediaPlayer2.'));
        // Prefer an exact suffix match on the player name.
        for (const line of candidates) {
          const suffix = line.slice('org.mpris.MediaPlayer2.'.length);
          if (suffix.toLowerCase() === needle) return resolve(line);
        }
        // Then a contains match (e.g. 'spotify.Spotify' contains 'spotify').
        for (const line of candidates) {
          const suffix = line.slice('org.mpris.MediaPlayer2.'.length);
          if (suffix && suffix.toLowerCase().includes(needle)) return resolve(line);
        }
        resolve(null);
      });
      proc.on('error', () => resolve(null));
    });
  }

// Poll MPRIS PlaybackStatus; treat Paused/Stopped as silent.
    // Resolves the D-Bus destination lazily so flatpak/snap installs whose
    // destination has a suffix (e.g. org.mpris.MediaPlayer2.spotify.Spotify)
    // still match.
    startPlaybackPolling(source) {
      this.stopPlaybackPolling();
      this.selectedSourceType = source.type;
      this.playing = false;

      const mprisId = this.mprisIdentityFor(source);
      if (!mprisId) {
        // No MPRIS identity - fall back to node-state gating
        this.startNodeStatePolling(source.id);
        return;
      }

      const poll = async () => {
        let dest = await this.resolveMprisDestination(mprisId);
        // If the destination isn't registered yet (Spotify just launched), the
        // first poll returns false. Keep polling until it resolves so the
        // "paused" indicator flips to "playing" as soon as the app is up.
        if (!dest) { this.playing = false; return; }
        this.playing = await this._queryMprisPlayingAt(dest);
      };

      // Initial poll
      poll();

      // Poll every 500ms
      this.playbackTimer = setInterval(poll, 500);
    }

  stopPlaybackPolling() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.stopNodeStatePolling();
    this.playing = false;
    this.selectedSourceType = null;
  }

  queryMprisPlaying(mprisId) {
    return new Promise((resolve) => {
      this.resolveMprisDestination(mprisId).then((dest) => {
        if (!dest) return resolve(false);
        this._queryMprisPlayingAt(dest).then(resolve).catch(() => resolve(false));
      });
    });
  }

  // Query against an already-resolved destination (used by the polling loop
  // after resolveMprisDestination() has mapped a flatpak/snap suffix).
  _queryMprisPlayingAt(dest) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player', 'PlaybackStatus'
      ]);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', (code) => {
        if (code !== 0 || !output) {
          resolve(false);
          return;
        }
        // gdbus returns: (<'Playing'>,) or (<'Paused'>,) with single quotes
        const m = output.match(/<['"]([^'"]+)['"]>/);
        if (!m) { resolve(false); return; }
        const status = m[1].toLowerCase();
        resolve(status === 'playing');
      });
      proc.on('error', () => resolve(false));
    });
  }

// Query MPRIS Metadata dict for app sources.
    // Resolves the D-Bus destination lazily so flatpak/snap installs whose
    // destination has a suffix still match.
    async queryMprisMetadata(mprisId) {
      const dest = await this.resolveMprisDestination(mprisId);
      if (!dest) return null;
      return this._queryMprisMetadataAt(dest);
    }

    _queryMprisMetadataAt(dest) {
      return new Promise((resolve) => {
        const proc = spawn('gdbus', [
          'call', '--session', '--dest', dest,
          '--object-path', '/org/mpris/MediaPlayer2',
          '--method', 'org.freedesktop.DBus.Properties.Get',
          'org.mpris.MediaPlayer2.Player', 'Metadata'
        ]);
        let output = '';
        proc.stdout.on('data', (data) => output += data.toString());
        proc.on('close', (code) => {
          if (code !== 0 || !output) { resolve(null); return; }
          resolve(this.parseMprisMetadata(output));
        });
        proc.on('error', () => resolve(null));
      });
    }

  // Query MPRIS Position (microseconds)
  queryMprisPosition(mprisId) {
    return new Promise((resolve) => {
      const dest = `org.mpris.MediaPlayer2.${mprisId}`;
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player', 'Position'
      ]);
      let output = '';
      proc.stdout.on('data', (data) => output += data.toString());
      proc.on('close', (code) => {
        if (code !== 0 || !output) { resolve(null); return; }
        const m = output.match(/<(?:int64|uint64)\s+(\d+)>/);
        resolve(m ? parseInt(m[1], 10) / 1000000 : null);
      });
      proc.on('error', () => resolve(null));
    });
  }

// Send MPRIS control command (PlayPause, Next, Previous, Play, Pause).
    // Resolves the D-Bus destination lazily so flatpak/snap installs whose
    // destination has a suffix still match.
    async sendMprisCommand(mprisId, command) {
      console.log('[AudioCapture] sendMprisCommand:', mprisId, command);
      const dest = await this.resolveMprisDestination(mprisId);
      if (!dest) {
        console.warn('[AudioCapture] No MPRIS destination for', mprisId);
        return false;
      }
      return new Promise((resolve) => {
        console.log('[AudioCapture] gdbus call:', ['call', '--session', '--dest', dest, '--object-path', '/org/mpris/MediaPlayer2', '--method', `org.mpris.MediaPlayer2.Player.${command}`]);
        const proc = spawn('gdbus', [
          'call', '--session', '--dest', dest,
          '--object-path', '/org/mpris/MediaPlayer2',
          '--method', `org.mpris.MediaPlayer2.Player.${command}`
        ]);
        proc.stdout.on('data', (data) => {
          console.log('[AudioCapture] gdbus stdout:', data.toString());
        });
        proc.stderr.on('data', (data) => {
          console.log('[AudioCapture] gdbus stderr:', data.toString());
        });
        proc.on('close', (code) => {
          console.log('[AudioCapture] gdbus close code:', code);
          resolve(code === 0);
        });
        proc.on('error', (err) => {
          console.error('[AudioCapture] gdbus error:', err);
          resolve(false);
        });
      });
    }

// Parse gdbus Metadata variant output into a plain object.
    // The old implementation used `/<\{([^}]*)\}>/` which is a non-greedy match
    // that stops at the first `}`. MPRIS Metadata is a nested variant dict
    // (`{...}` containing `<{...}>` entries and array variants `<["a","b"]>`),
    // so that regex truncated the body and xesam:title was never parsed. This
    // version uses recursive brace/bracket matching that respects strings and
    // nested variants.
    parseMprisMetadata(output) {
      const start = output.indexOf('<{');
      if (start === -1) return null;
      const bodyStart = start + 2;
      const bodyEnd = this._findMatchingClose(bodyStart, output, '{', '}');
      if (bodyEnd === -1) return null;
      const body = output.slice(bodyStart, bodyEnd);
      return this._parseVariantDict(body);
    }

    // Find the index of the matching closing bracket for the opening bracket
    // at `start`. Respects single/double quoted strings and nested brackets.
    _findMatchingClose(start, text, open, close) {
      let depth = 1;
      let i = start;
      let inString = null;
      while (i < text.length) {
        const ch = text[i];
        if (inString) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === inString) inString = null;
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") { inString = ch; i += 1; continue; }
        if (ch === open) { depth++; i += 1; continue; }
        if (ch === close) {
          depth--;
          if (depth === 0) return i;
          i += 1;
          continue;
        }
        i += 1;
      }
      return -1;
    }

    // Parse a gdbus variant dict body like:
    //   'xesam:title' : <'Track Name'>, 'xesam:artist' : <['A','B']>
    // into a plain object. Nested `<{...}>` dicts become nested objects.
    _parseVariantDict(body) {
      const meta = {};
      let i = 0;
      while (i < body.length) {
        // Skip whitespace and stray commas
        while (i < body.length && /\s|,/.test(body[i])) i += 1;
        if (i >= body.length) break;
        // Expect a quoted key
        const keyMatch = body.slice(i).match(/^['"]([^'"]+)['"]\s*:\s*/);
        if (!keyMatch) {
          // Skip until the next key to recover from a malformed entry.
          const next = body.indexOf("'", i);
          const nextDq = body.indexOf('"', i);
          const nxt = next === -1 ? nextDq : (nextDq === -1 ? next : Math.min(next, nextDq));
          i = nxt === -1 ? body.length : nxt;
          continue;
        }
        i += keyMatch[0].length;
        const key = keyMatch[1];
        // Expect a variant value: <...>
        if (body[i] !== '<') {
          // Skip until the next comma at this depth
          const next = body.indexOf(',', i);
          i = next === -1 ? body.length : next + 1;
          continue;
        }
        const valueStart = i + 1;
        const valueEnd = this._findMatchingClose(valueStart, body, '<', '>');
        if (valueEnd === -1) break;
        const raw = body.slice(valueStart, valueEnd);
        meta[key] = this._parseVariantValue(raw);
        i = valueEnd + 1;
      }
      return meta;
    }

    // Parse the inner content of a gdbus variant value.
    _parseVariantValue(raw) {
      const trimmed = raw.trim();
      // Nested dict: {...}
      if (trimmed.startsWith('{')) {
        const end = this._findMatchingClose(1, trimmed, '{', '}');
        if (end !== -1) return this._parseVariantDict(trimmed.slice(1, end));
      }
      // String: '...'
      const s = trimmed.match(/^'(.*)'$/);
      if (s) return s[1];
      // Array: [...] of strings or variants
      if (trimmed.startsWith('[')) {
        const end = this._findMatchingClose(1, trimmed, '[', ']');
        if (end === -1) return [];
        const inner = trimmed.slice(1, end);
        const result = [];
        let i = 0;
        while (i < inner.length) {
          while (i < inner.length && /\s|,/.test(inner[i])) i += 1;
          if (i >= inner.length) break;
          if (inner[i] === '<') {
            const vEnd = this._findMatchingClose(i + 1, inner, '<', '>');
            if (vEnd === -1) break;
            result.push(this._parseVariantValue(inner.slice(i + 1, vEnd)));
            i = vEnd + 1;
          } else {
            const m = inner.slice(i).match(/^'([^']*)'/);
            if (m) { result.push(m[1]); i += m[0].length; }
            else i += 1;
          }
        }
        return result;
      }
      // Number: uint64 N / int64 N
      const n = trimmed.match(/^(?:uint64|int64)\s+(\d+)$/);
      if (n) return parseInt(n[1], 10);
      // Fallback: return the raw text.
      return trimmed;
    }

  stopNodeStatePolling() {
    if (this.nodeStateTimer) {
      clearInterval(this.nodeStateTimer);
      this.nodeStateTimer = null;
    }
    this.currentNodeId = null;
    this.nodeState = 'unknown';
  }

  async startCapture(sourceId) {
    if (this.isCapturing) {
      await this.stopCapture();
    }
    
    const source = this.sources.find(s => s.id === sourceId) || this.sources[0];
    if (!source) {
      throw new Error('No audio source selected');
    }
    
    this.selectedSource = source.id;
    this.selectedSourceType = source.type;
    console.log('[AudioCapture] Starting capture on:', source.name, '(' + source.type + ')');
    
    // Gate on MPRIS play/pause for app sources; clear for monitors.
    if (source.type === 'application') {
      this.startPlaybackPolling(source);
    } else {
      this.stopPlaybackPolling();
    }
    
    return new Promise((resolve, reject) => {
      try {
        let proc;
        if (source.type === 'monitor') {
          // Use parec for PulseAudio monitor devices
          const deviceArg = source.id;
          proc = spawn('parec', [
            '-d', deviceArg,
            '--rate=48000',
            '--channels=2',
            '--format=float32le',
            '--raw'
          ]);
        } else {
          // Use pw-record for PipeWire application/node targets.
          // `source.id` is the PipeWire object id returned by pw-dump.
          // pw-record accepts a numeric object id directly as --target, but
          // some builds want the node name; if the numeric id fails we fall
          // back to --target with the node name. The spawn below is wrapped so
          // a bind failure doesn't reject the whole capture.
          proc = spawn('pw-record', this.buildPwRecordArgs(source, source.id));
          proc.on('error', (err) => {
            console.warn('[AudioCapture] pw-record target bind failed, retrying with node name:', err.message);
            try {
              const fallback = spawn('pw-record', this.buildPwRecordArgs(source, source.nodeName || source.name));
              this._replaceProcess(proc, fallback);
              proc = fallback;
              this._attachProcessHandlers(proc);
            } catch (e) {
              console.error('[AudioCapture] pw-record fallback failed:', e.message);
            }
          });
        }
        
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
        console.error('[AudioCapture] stderr:', msg);
      }
    });
    
    proc.on('error', (err) => {
      console.error('[AudioCapture] Process error:', err);
      this.emit('error', err);
    });
    
    proc.on('exit', (code, signal) => {
      console.log('[AudioCapture] Process exited:', code, signal);
      if (this.isCapturing) {
        this.isCapturing = false;
        this.emit('error', new Error(`Audio capture process exited: ${code} ${signal}`));
      }
    });
  }
  
  _replaceProcess(oldProc, newProc) {
    // Detach handlers from the old process and adopt the new one.
    try {
      if (oldProc) oldProc.kill('SIGKILL');
    } catch (e) {
      // Process may already be gone; ignore.
    }
    this.process = newProc;
  }
  
  buildPwRecordArgs(source, target) {
    // Build pw-record args. Prefer an explicit --target; fall back to a
    // --node-name / --property filter when the numeric id isn't accepted.
    const args = ['--target', String(target), '--rate', '48000', '--channels', '2', '--format', 'f32', '-'];
    return args;
  }
  
  async stopCapture() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.isCapturing = false;
    this.stopAnalyticsEmission();
    this.stopPlaybackPolling();
    this.stopNodeStatePolling();
    this.resetState();
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
    
    const samples = new Float32Array(frameBuffer.buffer, alignedOffset, Math.floor(alignedLength / 4));
    
    let sum = 0;
    const frameCount = samples.length / 2;
    if (frameCount === 0) return;

    // Gate: for app sources (Spotify, etc.), only treat audio as active
    // when MPRIS reports Playing; when Paused/Stopped, force silence.
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
  this.bassLpState = this.bassLpState + (1 - lpAlpha) * (cleanMono - this.bassLpState);
  bassTotal += this.bassLpState * this.bassLpState;
  // Treble: high-pass at 2000Hz
  const hpOutput = hpAlpha * (this.trebleHpState + cleanMono - this.trebleHpInput1);
  this.trebleHpInput1 = cleanMono;
  this.trebleHpState = hpOutput;
  trebleTotal += hpOutput * hpOutput;
}
const bassRms = Math.sqrt(bassTotal / frameCount);
const trebleRms = Math.sqrt(trebleTotal / frameCount);
// Proportional normalization: each band's share of total energy
const total = bassRms + trebleRms;
let bass = total > 0 ? bassRms / total : 0;
let treble = total > 0 ? trebleRms / total : 0;

this.state.bass = bass;
this.state.treble = treble;

// BPM / beat detection: track bass energy envelope
this.updateBpm(bassRms);
    
    this.volumeBuffer.push(volume);
    if (this.volumeBuffer.length > 600) this.volumeBuffer.shift();
    if (this.framesProcessed % 60 === 0) console.log('[AudioCapture] frames=' + this.framesProcessed + ' rms=' + rms.toFixed(4) + ' volume=' + volume.toFixed(3) + ' bpm=' + this.bpm.toFixed(1) + ' bass=' + (this.state.bass || 0).toFixed(3) + ' beat=' + this.state.beat);
    
    const frameDuration = 1000 / this.config.frameRate;
    const refSamples = Math.max(1, Math.floor((this.config.definitions[0] * 1000) / frameDuration));
    const sampleSamples = Math.max(1, Math.floor((this.config.definitions[1] * 1000) / frameDuration));
    
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
    
    const instant = Math.pow(Math.min(1, volume * 10 / 1.2), 0.9);
    
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
      this.emit('analytics', {
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
      });
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
    this.state = { volume: 0, stream: 0, level: 0, tapped: false, bass: 0, treble: 0 };
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
      if (this.lastBeatTimeMs > 0 && (now - this.lastBeatTimeMs) > minBeatInterval) {
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
    if (this.lastBeatTimeMs > 0 && (now - this.lastBeatTimeMs) > 3000) {
      this.bpm = 0;
      this.lastBeatTimeMs = 0;
      this.beatCount = 0;
    }
    
// Store for external access
    this.state.bpm = Math.round(this.bpm);
    this.state.beat = isBeat ? 1 : 0;
    this.state.beatProgress = this.lastBeatTimeMs > 0 ? (now - this.lastBeatTimeMs) / 1000 : 0;
  }
  
  debugLog() {
    console.log('[AudioCapture] debug bpm=', this.bpm, 'bassRms=', this.state.bass, 'bass=', this.state.bass, 'treble=', this.state.treble, 'beat=', this.state.beat, 'beatProgress=', this.state.beatProgress);
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