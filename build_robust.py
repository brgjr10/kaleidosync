import pathlib

audio = r'''/* kaleidosync — audio analyser (robust tap) */
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
    this.state = { volume: 0, stream: 0, source: null, tapped: false };
    this._patched = false;
    this._sourceNodes = new WeakMap();
  }

  AudioAnalyser.prototype._ensureBuffer = function () {
    if (!this.buffer) {
      this.buffer = new Uint8Array(CONFIG.bitDepth / 2);
      for (var i = 0; i < this.buffer.length; i++) this.buffer[i] = 0;
    }
  };

  AudioAnalyser.prototype.rawVolume = function () {
    this._ensureBuffer();
    if (!this.analyser) return 0;
    try { this.analyser.getByteFrequencyData(this.buffer); } catch (e) { return 0; }
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
    var count = 0;
    var min = Infinity;
    for (var i = start; i >= end; i--) {
      value += this.volumeBuffer[i];
      if (this.volumeBuffer[i] < min) min = this.volumeBuffer[i];
      count++;
    }
    if (count === 0) return [0, 0];
    if (min === Infinity) min = 0;
    return [value / count, min];
  };

  AudioAnalyser.prototype.tick = function (frameRate) {
    frameRate = frameRate || 60;
    if (!this.analyser) {
      // keep stream moving slowly so visuals aren't frozen when untapped
      this.state.stream = Number((this.state.stream + 0.01).toFixed(3));
      return { volume: this.state.volume, stream: this.state.stream, tapped: false };
    }
    var volume = this.rawVolume();
    this.volumeBuffer.push(volume);
    if (this.volumeBuffer.length > 600) this.volumeBuffer.shift();
    var frameDuration = 1000 / frameRate;
    var def = CONFIG.definitions;
    var ref = this._sampleVolume((def[0] * 1000) / frameDuration);
    var sample = this._sampleVolume((def[1] * 1000) / frameDuration);
    var r = ref[0], mn = ref[1], s = sample[0];
    var raw = Math.pow(this._scaleLinear([mn, r], [0, 1], s), 1.5);
    raw = Number(raw.toFixed(3));
    if (!isFinite(raw) || isNaN(raw)) raw = 0;
    this.state.volume = Math.max(0, Math.min(1, raw / 2));
    var stream = this.state.stream + Math.pow(raw, 0.75) / 10;
    if (isFinite(stream) && !isNaN(stream)) this.state.stream = Number(stream.toFixed(3));
    this.state.tapped = true;
    return { volume: this.state.volume, stream: this.state.stream, tapped: true };
  };

  AudioAnalyser.prototype._setupAnalyser = function (ctx, element, source) {
    try {
      if (this.tappedElement === element && this.analyser && this.ctx === ctx) return;
      this.ctx = ctx;
      this.tappedElement = element;
      this.tappedSource = source;

      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = CONFIG.lowpassFreq;
      this.filter.Q.value = CONFIG.lowpassQ;

      this.analyser = ctx.createAnalyser();
      this.analyser.smoothingTimeConstant = 0.2;
      this.analyser.fftSize = CONFIG.bitDepth;

      source.connect(this.filter);
      this.filter.connect(this.analyser);
      // do NOT connect analyser to destination to avoid double audio; source already routed by app
      this.state.source = element && element.tagName ? element.tagName.toLowerCase() : "source";
      this.state.tapped = true;
      console.log("[kaleidosync] tapped audio source", this.state.source, element && (element.src || element.currentSrc || ""));
    } catch (e) {
      console.warn("[kaleidosync] tap failed", e);
    }
  };

  AudioAnalyser.prototype.start = function () {
    var self = this;
    if (self._patched) return;
    self._patched = true;

    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) {
      console.warn("[kaleidosync] No AudioContext");
      return;
    }

    // Patch prototype so we catch calls on any context (existing or new)
    function patchProto(Ctor) {
      if (!Ctor || !Ctor.prototype || Ctor.prototype.__kaleidoPatched) return;
      var orig = Ctor.prototype.createMediaElementSource;
      if (typeof orig !== "function") return;
      Ctor.prototype.createMediaElementSource = function (element) {
        var source = orig.call(this, element);
        try { self._setupAnalyser(this, element, source); } catch (e) {}
        return source;
      };
      Ctor.prototype.__kaleidoPatched = true;
    }

    patchProto(global.AudioContext);
    patchProto(global.webkitAudioContext);

    // Also wrap constructors for contexts created later (belt & suspenders)
    function wrapCtor(name) {
      var Orig = global[name];
      if (!Orig || Orig.__kaleidoWrapped) return;
      function Wrapped() {
        var ctx = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
        return ctx;
      }
      Wrapped.prototype = Orig.prototype;
      try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
      Wrapped.__kaleidoWrapped = true;
      global[name] = Wrapped;
    }
    try { wrapCtor("AudioContext"); } catch (e) {}
    try { wrapCtor("webkitAudioContext"); } catch (e) {}

    // Try to resume any suspended contexts on user gesture
    function resumeOnGesture() {
      try {
        if (self.ctx && self.ctx.state === "suspended") self.ctx.resume();
      } catch (e) {}
    }
    ["click", "keydown", "touchstart", "pointerdown"].forEach(function (ev) {
      document.addEventListener(ev, resumeOnGesture, { passive: true });
    });
  };

  global.KaleidoAudio = AudioAnalyser;
})(typeof window !== "undefined" ? window : this);
'''

# read existing user script pieces to rebuild
base = pathlib.Path('/home/brgjr10/Projects/kaleidosync-tm')
full = (base / 'kaleidosync.user.js').read_text()

# replace the audio analyser block: from start of audio IIFE comment to start of GLSL block
start_marker = '/* kaleidosync — audio analyser (standalone, no deps)'
end_marker = "/* kaleidosync — GLSL utilities"
i = full.find(start_marker)
j = full.find(end_marker)
if i == -1 or j == -1:
    raise SystemExit('markers not found %s %s' % (i,j))

new_full = full[:i] + audio + '\n\n' + full[j:]

# also add debug/status to loop: show tap state in toggle title occasionally? and ensure analyser started before render
# bump version
new_full = new_full.replace('// @version      0.1.0', '// @version      0.2.0')
new_full = new_full.replace('@version      0.1.0', '@version      0.2.0', 1)

(base / 'audio.js').write_text(audio)
(base / 'kaleidosync.user.js').write_text(new_full)
print('written', len(audio), len(new_full))
