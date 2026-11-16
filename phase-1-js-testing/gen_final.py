import os
os.chdir('/home/brgjr10/Projects/kaleidosync-tm')

with open('audio.js') as f: audio = f.read()
with open('glsl-utils.js') as f: glsl = f.read()
with open('renderer.js') as f: renderer = f.read()
with open('shader-source.frag.glsl') as f: shader_src = f.read()

user = '''// ==UserScript==
// @name         Kaleidosync for open.spotify.com
// @namespace    local.kaleidosync
// @version      0.1.0
// @description  WebGL kaleidoscope visualizer driven by the audio Spotify's web player is actually playing. No API, no backend — taps the real <audio> element.
// @author       Brodie
// @match        https://open.spotify.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

'''
# Each lib is a self-contained IIFE — concatenate verbatim.
user += audio + '\n\n'
user += glsl + '\n\n'
user += renderer + '\n\n'

user += 'window.KALEIDO_SHADER = ' + repr(shader_src) + ';\n\n'

user += r'''
  // ====================== KALEIDOSYNC CORE ======================
  (function () {
    'use strict';

  var CFG = {
    enabled: false,
    keyToggle: 'k',
  };

  var state = {
    running: false,
    analyser: null,
    renderer: null,
    canvas: null,
    rafId: 0,
    lastFrame: 0,
    stream: 0,
    volume: 1,
  };

  function ensureToggle() {
    if (document.getElementById('kaleidosync-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'kaleidosync-toggle';
    btn.textContent = 'K';
    btn.title = 'Kaleidosync visualizer (press K)';
    btn.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
      'width:36px', 'height:36px', 'border-radius:50%',
      'border:1px solid #1db954', 'background:#111418', 'color:#1db954',
      'font-weight:700', 'font-size:16px', 'cursor:pointer',
      'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    updateToggleUI();
  }

  function updateToggleUI() {
    var btn = document.getElementById('kaleidosync-toggle');
    if (!btn) return;
    if (state.running) {
      btn.style.background = '#1db954';
      btn.style.color = '#000';
      btn.textContent = 'ON';
    } else {
      btn.style.background = '#111418';
      btn.style.color = '#1db954';
      btn.textContent = 'K';
    }
  }

  function ensureCanvas() {
    if (state.canvas) return;
    var c = document.createElement('canvas');
    c.id = 'kaleidosync-canvas';
    c.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'width:100%', 'height:100%', 'display:none'
    ].join(';');
    document.body.appendChild(c);
    state.canvas = c;
  }

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = cb; s.onerror = function () { console.warn('[kaleidosync] failed to load', src); cb(); };
    document.head.appendChild(s);
  }

  function start() {
    if (state.running) return;
    ensureCanvas();
    ensureToggle();
    if (typeof THREE === 'undefined') {
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', bootRenderer);
    } else {
      bootRenderer();
    }
  }

  function bootRenderer() {
    if (typeof THREE === 'undefined') { console.warn('[kaleidosync] THREE not available'); return; }
    if (typeof KaleidoRenderer === 'undefined') { console.warn('[kaleidosync] renderer lib missing'); return; }

    state.analyser = new KaleidoAudio();
    state.analyser.start();

    state.renderer = new KaleidoRenderer({
      canvas: state.canvas,
      shader: window.KALEIDO_SHADER || '',
      utils: (window.KaleidoGLSL ? window.KaleidoGLSL.all : ''),
    });

    state.running = true;
    updateToggleUI();
    loop();
  }

  function stop() {
    state.running = false;
    cancelAnimationFrame(state.rafId);
    if (state.canvas) state.canvas.style.display = 'none';
    updateToggleUI();
  }

  function toggle() {
    if (state.running) stop(); else start();
  }

  function loop() {
    if (!state.running) return;
    var now = performance.now();
    if (state.lastFrame === 0) state.lastFrame = now;
    var dt = now - state.lastFrame;
    state.lastFrame = now;
    var fps = dt > 0 ? 1000 / dt : 60;

    if (state.analyser) {
      var a = state.analyser.tick(fps);
      state.volume = a.volume;
      state.stream = a.stream;
    }

    if (state.renderer) {
      state.canvas.style.display = 'block';
      state.renderer.update(now, state.stream, state.volume);
    }

    state.rafId = requestAnimationFrame(loop);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === CFG.keyToggle && !e.repeat) toggle();
  });

  function boot() {
    ensureToggle();
    if (CFG.enabled) start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  })();
'''

with open('kaleidosync.user.js', 'w') as f:
    f.write(user)
print('wrote kaleidosync.user.js', len(user.splitlines()), 'lines')