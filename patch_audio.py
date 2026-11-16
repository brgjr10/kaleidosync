import os
os.chdir('/home/brgjr10/Projects/kaleidosync-tm')

# Patch audio.js: add DOM-scan fallback + debug overlay
with open('audio.js') as f:
    src = f.read()

# Insert scan logic right after the _tap method's closing, before the prototype.close
scan = r'''
  // ---- DOM scan fallback: tap any <audio> element that exists already ----
  AudioAnalyser.prototype.scanDOM = function () {
    var self = this;
    var els = document.querySelectorAll('audio');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (self.tappedElement === el) continue;
      // If the element already has a connected source, we can't re-tap it
      // (createMediaElementSource can only be called once per element). So
      // instead we just grab its volume/progress and use it as a fallback
      // signal when our analyser isn't producing data.
      self._listenElement(el);
    }
    // Keep scanning until we have a working analyser
    if (!self._scanTimer) {
      self._scanTimer = setInterval(function () {
        if (self.analyser) { clearInterval(self._scanTimer); self._scanTimer = 0; return; }
        self.scanDOM();
      }, 2000);
    }
  };

  AudioAnalyser.prototype._listenElement = function (el) {
    if (el._kaleidoBound) return;
    el._kaleidoBound = true;
    var self = this;
    el.addEventListener('play', function () {
      self.state.elementPlaying = true;
    });
    el.addEventListener('pause', function () {
      self.state.elementPlaying = false;
    });
  };

  // Fallback signal when analyser data is flat (element not tapped)
  AudioAnalyser.prototype.fallbackSignal = function () {
    var els = document.querySelectorAll('audio');
    var best = null;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.paused && el.currentTime > 0) { best = el; break; }
    }
    if (!best) return { volume: 0, stream: 0, playing: false };
    var vol = best.volume || 1;
    var prog = best.duration ? best.currentTime / best.duration : 0;
    return { volume: vol, stream: prog * 10, playing: true };
  };
'''
src = src.replace('  global.KaleidoAudio = AudioAnalyser;', scan + '\n\n  global.KaleidoAudio = AudioAnalyser;')

# Add a debug overlay to the constructor's start path
src = src.replace(
    'AudioAnalyser.prototype.start = function () {',
    'AudioAnalyser.prototype.start = function (opts) {\n    opts = opts || {};\n    this.debug = !!opts.debug;'
)

# In tick(), if analyser missing, use fallback
src = src.replace(
    '  AudioAnalyser.prototype.tick = function (frameRate) {\n    if (!this.analyser) {',
    '  AudioAnalyser.prototype.tick = function (frameRate) {\n    if (!this.analyser) {\n      var fb = this.fallbackSignal();\n      if (fb.playing) {\n        this.state.volume = fb.volume;\n        this.state.stream = fb.stream;\n        return { volume: this.state.volume, stream: this.state.stream };\n      }'
)
# close the extra brace
src = src.replace(
    '      return { volume: this.state.volume, stream: this.state.stream };\n    }',
    '      return { volume: this.state.volume, stream: this.state.stream };\n      }\n    }'
)

with open('audio.js', 'w') as f:
    f.write(src)
print('patched audio.js')