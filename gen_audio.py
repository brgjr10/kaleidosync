import os
os.chdir('/home/brgjr10/Projects/kaleidosync-tm')

audio = r'''/* kaleidosync — audio analyser (standalone, no deps)
 *
 * Ports the AudioSystemManager + SpotifyAudioAnalyser tick() algorithm from
 * @wearesage/vue. Taps the audio element Spotify's web player uses by patching
 * AudioContext.createMediaElementSource, runs an adaptive volume/stream
 * estimator off the AnalyserNode frequency data, and exposes volume/stream.
 */
(function (global) {
  "use strict";

  var CONFIG = {
    bitDepth: 1024,
    lowpassFreq: 7500,
    lowpassQ: 0.75,
    definitions: [2.5, 0.09],
  };

  function AudioAnalyser() {
    this.ctx = null;
    this.analyser = null;
    this.filter = null;
    this.tappedElement = null;
    this.tappedSource = null;
    this.buffer = null;
    this.volumeBuffer = [];
    this.state = { volume: 1, stream: 0, source: null };
    this._patched = false;
  }

  AudioAnalyser.prototype._ensureBuffer = function () {
    if (!this.buffer) {
      this.buffer = new Uint8Array(CONFIG.bitDepth / 2);
      for (var i = 0; i < this.buffer.length; i++) this.buffer[i] = 0;
    }
  };

  AudioAnalyser.prototype.rawVolume = function () {
    this._ensureBuffer();
    if (!this.analyser) return 1;
    this.analyser.getByteFrequencyData(this.buffer);
    var len = this.buffer.length;
    var val = 0;
    for (var i = 0; i < len; i++) val += this.buffer[i];
    return val / len;
  };

  AudioAnalyser.prototype._scaleLinear = function (domain, range, value) {
    var d0 = domain[0], d1 = domain[1];
    var r0 = range[0], r1 = range[1];
    if (d1 === d0) return r0;
    var t = (value - d0) / (d1 - d0);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return r0 + (r1 - r0) * t;
  };

  AudioAnalyser.prototype._sampleVolume = function (totalSamples) {
    var value = 0;
    var start = Math.max(this.volumeBuffer.length - 1, 0);
    var end = Math.max(start - totalSamples, 0);
    var min = Infinity;
    for (var i = start; i >= end; i--) {
      value += this.volumeBuffer[i];
      if (this.volumeBuffer[i] < min) min = this.volumeBuffer[i];
    }
    return [value / totalSamples, min];
  };

  AudioAnalyser.prototype.tick = function (frameRate) {
    if (!this.analyser) {
      return { volume: this.state.volume, stream: this.state.stream };
    }
    var volume = this.rawVolume();
    this.volumeBuffer.push(volume);
    var frameDuration = 1000 / frameRate;
    var def = CONFIG.definitions;
    var ref = this._sampleVolume((def[0] * 1000) / frameDuration);
    var sample = this._sampleVolume((def[1] * 1000) / frameDuration);
    var r = ref[0], mn = ref[1];
    var s = sample[0];
    var raw = Math.pow(this._scaleLinear([mn, r], [0, 1], s), 1.5);
    raw = Number(raw.toFixed(3));

    if (!isNaN(raw)) {
      this.state.volume = raw / 2;
      var stream = this.state.stream + Math.pow(raw, 0.75) / 10;
      if (!isNaN(stream)) this.state.stream = Number(stream.toFixed(3));
    }
    return { volume: this.state.volume, stream: this.state.stream };
  };

  AudioAnalyser.prototype.start = function () {
    var self = this;
    if (self._patched) return;
    self._patched = true;

    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) {
      console.warn("[kaleidosync] No AudioContext constructor available");
      return;
    }

    var OrigContext = AC;
    function HookedContext() {
      var ctx = new OrigContext();
      var origCreate = ctx.createMediaElementSource.bind(ctx);
      ctx.createMediaElementSource = function (element) {
        var source = origCreate(element);
        self._tap(ctx, element, source);
        return source;
      };
      return ctx;
    }
    HookedContext.prototype = OrigContext.prototype;
    HookedContext.prototype.constructor = HookedContext;
    global.AudioContext = HookedContext;
    if (global.webkitAudioContext) global.webkitAudioContext = HookedContext;
  };

  AudioAnalyser.prototype._tap = function (ctx, element, source) {
    if (this.tappedElement === element && this.analyser) return;
    this.ctx = ctx;
    this.tappedElement = element;
    this.tappedSource = source;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = CONFIG.lowpassFreq;
    this.filter.Q.value = CONFIG.lowpassQ;

    this.analyser = ctx.createAnalyser();
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.fftSize = CONFIG.bitDepth;

    source.connect(this.filter);
    this.filter.connect(this.analyser);
    this.state.source = "spotify-element";
  };

  global.KaleidoAudio = AudioAnalyser;
})(typeof window !== "undefined" ? window : this);
'''
with open('audio.js', 'w') as f: f.write(audio)
print('wrote audio.js', len(audio.splitlines()), 'lines')