import { spawn } from 'child_process';

// Linux backend: PipeWire (pw-dump / pw-record) with PulseAudio (pactl / parec)
// fallback, plus MPRIS (gdbus) for now-playing metadata and transport controls.
//
// This is the reference backend. Every other platform backend must expose the
// same surface so the analysis/DSP pipeline in audio-capture.js is shared
// verbatim and behaves identically everywhere:
//
//   id                  'linux'
//   label               human readable backend name
//   supportsMetadata    true when getMetadata()/sendCommand() are meaningful
//   supportsProcessAudio true when per-application capture is available
//   init()              detect tooling, populate this.status
//   enumerate()         -> [source]
//   buildCapture(src)   -> { command, args } | null
//   startPolling(src, cb) / stopPolling()
//   getMetadata(src)    -> metadata | null
//   sendCommand(src, cmd) -> bool
//
// A source is always: { id, name, type: 'application' | 'monitor', hostAPI, ... }
// `type: 'application'` means "audio produced by one app" and is the only type
// subject to play/pause gating; 'monitor' means "everything the OS is playing".

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

export class LinuxBackend {
  constructor() {
    this.id = 'linux';
    this.label = 'PipeWire / PulseAudio';
    this.supportsMetadata = true;
    this.supportsProcessAudio = true;
    this.status = { available: false, detail: '', hint: '' };
    this.playbackTimer = null;
    this.playing = false;
    this._mprisDestCache = {};
  }

  async init() {
    const havePwDump = await this._hasBinary('pw-dump');
    const havePwRecord = await this._hasBinary('pw-record');
    const havePactl = await this._hasBinary('pactl');
    const haveParec = await this._hasBinary('parec');
    const haveGdbus = await this._hasBinary('gdbus');

    const havePipeWire = havePwDump && havePwRecord;
    const havePulse = havePactl && haveParec;

    this.supportsMetadata = haveGdbus;
    this.supportsProcessAudio = havePipeWire || havePulse;

    if (havePipeWire) {
      this.status = {
        available: true,
        detail: 'PipeWire (pw-dump/pw-record)',
        hint: ''
      };
    } else if (havePulse) {
      this.status = {
        available: true,
        detail: 'PulseAudio (pactl/parec)',
        hint: ''
      };
    } else {
      this.status = {
        available: false,
        detail: 'no PipeWire or PulseAudio tooling found',
        hint: 'Install pipewire (provides pw-dump and pw-record) or pulseaudio-utils (provides pactl and parec).'
      };
    }

    if (!haveGdbus) {
      this.status.hint = [this.status.hint, 'Install glib2 for gdbus to get now-playing metadata.']
        .filter(Boolean)
        .join(' ');
    }

    return this.status;
  }

  _hasBinary(name) {
    return new Promise((resolve) => {
      const proc = spawn(name, ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(true));
    });
  }

  async enumerate() {
    const sources = [];
    await this._enumeratePipeWireNodes(sources);
    await this._enumerateMonitors(sources);
    return sources;
  }

  _enumeratePipeWireNodes(sources) {
    return new Promise((resolve) => {
      const proc = spawn('pw-dump', ['-N']);
      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.on('error', (err) => {
        console.warn('[AudioCapture:linux] pw-dump spawn failed:', err.message);
        resolve();
      });
      proc.on('close', () => {
        try {
          const objects = JSON.parse(output);
          for (const obj of objects) {
            if (obj.type !== 'PipeWire:Interface:Node' || !obj.info?.props) continue;
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

            // Skip pure monitor nodes (those are handled by _enumerateMonitors)
            if (mediaClass.includes('Audio/Adapter') || mediaClass.includes('Device')) continue;

            sources.push({
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
        } catch (e) {
          console.warn('[AudioCapture:linux] Failed to parse pw-dump:', e.message);
        }
        resolve();
      });
    });
  }

  _enumerateMonitors(sources) {
    return new Promise((resolve) => {
      const proc = spawn('pactl', ['list', 'short', 'sources']);
      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.on('error', (err) => {
        console.warn('[AudioCapture:linux] pactl spawn failed:', err.message);
        resolve();
      });
      proc.on('close', () => {
        const lines = output.trim().split('\n');
        for (const line of lines) {
          if (!line.includes('.monitor')) continue;
          const parts = line.split('\t');
          if (parts.length < 2) continue;
          sources.push({
            id: parts[1],
            name: parts[1].replace('.monitor', '') + ' (System Monitor)',
            type: 'monitor',
            hostAPI: 'pulseaudio',
            maxInputChannels: 2,
            defaultSampleRate: 48000
          });
        }
        resolve();
      });
    });
  }

  buildCapture(source) {
    // PulseAudio monitor devices are captured with parec; PipeWire nodes
    // (application sink inputs, adapter nodes) with pw-record.
    if (source.type === 'monitor' && source.hostAPI === 'pulseaudio') {
      return {
        command: 'parec',
        args: [
          '-d', source.id,
          '--rate=48000',
          '--channels=2',
          '--format=float32le',
          '--raw'
        ]
      };
    }

    // pw-record accepts a numeric object id directly as --target, but some
    // builds want the node name; audio-capture.js retries with the node name
    // if the numeric id fails to bind.
    return {
      command: 'pw-record',
      args: ['--target', String(source.id), '--rate', '48000', '--channels', '2', '--format', 'f32', '-']
    };
  }

  // Fallback target for pw-record when the numeric object id is rejected.
  fallbackTarget(source) {
    return source.nodeName || source.name;
  }

  startPolling(source, onPlayback) {
    this.stopPolling();
    this.playing = false;

    const mprisId = this.mprisIdentityFor(source);
    if (!mprisId) {
      // No MPRIS identity for this source - nothing to gate on. Report
      // "playing" so the capture is not silenced by the play/pause gate.
      this.playing = true;
      onPlayback?.(true);
      return;
    }

    const poll = async () => {
      const dest = await this.resolveMprisDestination(mprisId);
      // If the destination isn't registered yet (Spotify just launched), the
      // first poll returns false. Keep polling until it resolves so the
      // "paused" indicator flips to "playing" as soon as the app is up.
      if (!dest) {
        if (this.playing !== false) { this.playing = false; onPlayback?.(false); }
        return;
      }
      const playing = await this._queryMprisPlayingAt(dest);
      if (playing !== this.playing) { this.playing = playing; onPlayback?.(playing); }
    };

    poll();
    this.playbackTimer = setInterval(poll, 500);
  }

  stopPolling() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.playing = false;
  }

  // Map app source name to MPRIS identity (e.g. Spotify -> spotify).
  // Returns the player NAME suffix used to build the D-Bus destination
  // `org.mpris.MediaPlayer2.<name>`. Flatpak/snap installs register as
  // `org.mpris.MediaPlayer2.spotify.Spotify` etc., so we also try the base name
  // (everything after the last dot) and fall back to scanning all MPRIS
  // destinations via `gdbus list` in findMprisDestination().
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
    if (this._mprisDestCache[mprisId]) return this._mprisDestCache[mprisId];

    const base = `${MPRIS_PREFIX}${mprisId}`;
    if (await this._mprisDestinationExists(base)) {
      this._mprisDestCache[mprisId] = base;
      return base;
    }
    // Flatpak/snap installs often append a suffix (e.g. spotify.Spotify).
    const match = await this._findMprisDestination(mprisId);
    if (match) this._mprisDestCache[mprisId] = match;
    return match;
  }

  _mprisDestinationExists(dest) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player', 'PlaybackStatus'
      ]);
      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
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
  _findMprisDestination(mprisId) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', ['list', '--session']);
      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.on('close', () => {
        const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
        const needle = mprisId.toLowerCase();
        const candidates = lines.filter(l => l.startsWith(MPRIS_PREFIX));
        // Prefer an exact suffix match on the player name.
        for (const line of candidates) {
          const suffix = line.slice(MPRIS_PREFIX.length);
          if (suffix.toLowerCase() === needle) return resolve(line);
        }
        // Then a contains match (e.g. 'spotify.Spotify' contains 'spotify').
        for (const line of candidates) {
          const suffix = line.slice(MPRIS_PREFIX.length);
          if (suffix && suffix.toLowerCase().includes(needle)) return resolve(line);
        }
        resolve(null);
      });
      proc.on('error', () => resolve(null));
    });
  }

  async _queryMprisPlayingAt(dest) {
    return new Promise((resolve) => {
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player', 'PlaybackStatus'
      ]);
      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 || !output) { resolve(false); return; }
        // gdbus returns: (<'Playing'>,) or (<'Paused'>,) with single quotes
        const m = output.match(/<['"]([^'"]+)['"]>/);
        if (!m) { resolve(false); return; }
        resolve(m[1].toLowerCase() === 'playing');
      });
      proc.on('error', () => resolve(false));
    });
  }

  async getMetadata(source) {
    const mprisId = this.mprisIdentityFor(source);
    if (!mprisId) return null;
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
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 || !output) { resolve(null); return; }
        resolve(this.parseMprisMetadata(output));
      });
      proc.on('error', () => resolve(null));
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
    return this._parseVariantDict(output.slice(bodyStart, bodyEnd));
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
      while (i < body.length && /\s|,/.test(body[i])) i += 1;
      if (i >= body.length) break;
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
      if (body[i] !== '<') {
        const next = body.indexOf(',', i);
        i = next === -1 ? body.length : next + 1;
        continue;
      }
      const valueStart = i + 1;
      const valueEnd = this._findMatchingClose(valueStart, body, '<', '>');
      if (valueEnd === -1) break;
      meta[key] = this._parseVariantValue(body.slice(valueStart, valueEnd));
      i = valueEnd + 1;
    }
    return meta;
  }

  // Parse the inner content of a gdbus variant value.
  _parseVariantValue(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      const end = this._findMatchingClose(1, trimmed, '{', '}');
      if (end !== -1) return this._parseVariantDict(trimmed.slice(1, end));
    }
    const s = trimmed.match(/^'(.*)'$/);
    if (s) return s[1];
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
    const n = trimmed.match(/^(?:uint64|int64)\s+(\d+)$/);
    if (n) return parseInt(n[1], 10);
    return trimmed;
  }

  async sendCommand(source, command) {
    const mprisId = this.mprisIdentityFor(source);
    if (!mprisId) return false;
    const dest = await this.resolveMprisDestination(mprisId);
    if (!dest) return false;

    // MPRIS uses PlayPause where every other backend uses a single toggle.
    const method = command === 'playpause' ? 'PlayPause' : command;
    return new Promise((resolve) => {
      const proc = spawn('gdbus', [
        'call', '--session', '--dest', dest,
        '--object-path', '/org/mpris/MediaPlayer2',
        '--method', `org.mpris.MediaPlayer2.Player.${method}`
      ]);
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', (data) => {
        console.warn('[AudioCapture:linux] gdbus stderr:', data.toString().trim());
      });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', (err) => {
        console.error('[AudioCapture:linux] gdbus error:', err.message);
        resolve(false);
      });
    });
  }
}