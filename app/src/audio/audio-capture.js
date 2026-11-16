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
              // Look for sink-input nodes (application audio streams)
              const mediaClass = props['media.class'] || '';
              const nodeName = props['node.name'] || '';
              const appName = props['application.name'] || props['application.process.binary'] || '';
              
              if (mediaClass.includes('Stream/Output/Audio') || mediaClass.includes('Audio/SinkInput')) {
                this.sources.push({
                  id: String(obj.id),
                  name: appName || nodeName || `PipeWire Node ${obj.id}`,
                  type: 'application',
                  mediaClass,
                  nodeName,
                  hostAPI: 'pipewire',
                  maxInputChannels: 2,
                  defaultSampleRate: 48000
                });
              }
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

  // Map app source name to MPRIS identity (e.g. Spotify -> org.mpris.MediaPlayer2.spotify)
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
    if (combined.includes('amarok')) return 'amarok';
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
    if (combined.includes('audacious')) return 'audacious';
    if (combined.includes('exaile')) return 'exaile';
    if (combined.includes('kodi')) return 'kodi';
    if (combined.includes('jriver')) return 'jriver';
    if (combined.includes('foobar')) return 'foobar';
    if (combined.includes('winamp')) return 'winamp';
    if (combined.includes('deadbeef')) return 'deadbeef';
    if (combined.includes('music')) return 'music';
    return null;
  }

  // Poll MPRIS PlaybackStatus; treat Paused/Stopped as silent.
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
      this.playing = await this.queryMprisPlaying(mprisId);
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
      const dest = `org.mpris.MediaPlayer2.${mprisId}`;
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

  // Query MPRIS Metadata dict for app sources
  queryMprisMetadata(mprisId) {
    return new Promise((resolve) => {
      const dest = `org.mpris.MediaPlayer2.${mprisId}`;
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

  // Send MPRIS control command (PlayPause, Next, Previous, Play, Pause)
  sendMprisCommand(mprisId, command) {
    console.log('[AudioCapture] sendMprisCommand:', mprisId, command);
    return new Promise((resolve) => {
      const dest = `org.mpris.MediaPlayer2.${mprisId}`;
      console.log('[AudioCapture] gdbus call:', ['call', '--session', '--dest', dest, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.mpris.MediaPlayer2.Player', command]);
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

  // Parse gdbus Metadata variant output into a plain object
  parseMprisMetadata(output) {
    const m = output.match(/<\{([^}]*)\}>/);
    if (!m) return null;
    const body = m[1];
    const entries = body.split(',').filter(p => p.includes('<'));
    const meta = {};
    for (const entry of entries) {
      const kv = entry.match(/'([^']+)'\s*:\s*<([^>]+)>/);
      if (!kv) continue;
      const key = kv[1];
      let val = kv[2].trim();
      // Handle single string '<...>' -> '...'
      const s = val.match(/^<'(.*)'>$/);
      if (s) { meta[key] = s[1]; continue; }
      // Handle uint64/int64 '<uint64 N>' -> number
      const n = val.match(/^(?:uint64|int64)\s+(\d+)$/);
      if (n) { meta[key] = parseInt(n[1], 10); continue; }
      // Handle arrays '<["a","b"]>' or '<[...]>'
      const a = val.match(/^\[(.*)\]$/);
      if (a) {
        meta[key] = a[1].split(',').
          map(x => x.trim().match(/^<'(.*)'>$/)?.[1] || x.trim());
        continue;
      }
      meta[key] = val;
    }
    return meta;
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
          // Use pw-record for PipeWire application/node targets
          proc = spawn('pw-record', [
            '--target', source.id,
            '--rate', '48000',
            '--channels', '2',
            '--format', 'f32',
            '-'
          ]);
        }
        
        this.process = proc;
        let buffer = Buffer.alloc(0);
        const chunkSize = 4096; // bytes = 1024 float32 samples (stereo = 512 frames)
        
        proc.stdout.on('data', (data) => {
          buffer = Buffer.concat([buffer, data]);
          
          while (buffer.length >= chunkSize) {
            const frame = buffer.subarray(0, chunkSize);
            buffer = buffer.subarray(chunkSize);
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
        
        this.isCapturing = true;
        this.startAnalyticsEmission();
        
        // Wait a bit for the process to start producing data
        setTimeout(() => resolve({ success: true, source }), 200);
      } catch (err) {
        reject(err);
      }
    });
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