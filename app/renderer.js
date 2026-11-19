/**
 * Main Renderer Process - Ties together renderer, sketch engine, audio, and UI
 */

import { Renderer } from './src/renderer/renderer.js';
import { SketchEngine } from './src/sketch-engine/sketch-engine.js';
import { KaleidoGLSL } from './src/glsl-utils.js';

// Global state
let renderer = null;
let sketchEngine = null;
let fps = 0;
let frameCount = 0;
let fpsUpdateTime = 0;

// UI elements
const overlay = document.getElementById('overlay');
const canvas = document.createElement('canvas');
document.getElementById('app').appendChild(canvas);

// UI controls
const sketchSelect = document.getElementById('sketch-select');
const variantSelect = document.getElementById('variant-select');
const audioDeviceSelect = document.getElementById('audio-device-select');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnRandom = document.getElementById('btn-random');
const btnMagic = document.getElementById('btn-magic');
const btnPrevVariant = document.getElementById('btn-prev-variant');
const btnNextVariant = document.getElementById('btn-next-variant');
const btnAudioStart = document.getElementById('btn-audio-start');
const btnAudioStop = document.getElementById('btn-audio-stop');
const btnMprisPrev = document.getElementById('btn-mpris-prev');
const btnMprisPlay = document.getElementById('btn-mpris-play');
const btnMprisNext = document.getElementById('btn-mpris-next');
const playbackControls = document.getElementById('playback-controls');
const trackTitle = document.getElementById('track-title-content');
const trackArtist = document.getElementById('track-artist-content');
const btnHiddenMprisPrev = document.getElementById('btn-hidden-mpris-prev');
const btnHiddenMprisPlay = document.getElementById('btn-hidden-mpris-play');
const btnHiddenMprisNext = document.getElementById('btn-hidden-mpris-next');
const hiddenModeControls = document.getElementById('hidden-mode-controls');
const hiddenTrackTitle = document.getElementById('hidden-track-title-content');
const hiddenTrackArtist = document.getElementById('hidden-track-artist-content');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnUIToggle = document.getElementById('btn-ui-toggle');
const meterVolume = document.getElementById('meter-volume');
const meterVolumeText = document.getElementById('meter-volume-text');
const meterBass = document.getElementById('meter-bass');
const meterBassText = document.getElementById('meter-bass-text');
const meterTreble = document.getElementById('meter-treble');
const meterTrebleText = document.getElementById('meter-treble-text');
const debugFPS = document.getElementById('debug-fps');
const debugSource = document.getElementById('debug-device');
const debugRes = document.getElementById('debug-res');
const debugDPR = document.getElementById('debug-dpr');
const debugBPM = document.getElementById('debug-bpm');

let uiVisible = true;
let audioCapturing = false;
let currentBPM = 0;
let hiddenPanelTimer = null;
let hiddenPanelPinned = false;

// Initialize
async function init() {
  console.log('[Kaleidosync] Initializing renderer...');

  // Initialize sketch engine
  sketchEngine = new SketchEngine();
  await sketchEngine.loadCatalog();
  console.log('[Kaleidosync] Sketch engine loaded, catalog:', sketchEngine.getCatalog()?.count);

  // Load first sketch BEFORE initializing renderer (so dropdown is populated even if WebGL fails)
  sketchEngine.selectSketch(0);
  updateSketchUI();
  console.log('[Kaleidosync] First sketch selected, UI updated');

  // Initialize renderer
  try {
    renderer = new Renderer(canvas);
    renderer.setGLSLUtils(KaleidoGLSL.all);
    applyCurrentSketch();
    console.log('[Kaleidosync] Renderer initialized');
  } catch (err) {
    console.error('[Kaleidosync] Renderer initialization failed:', err);
    // Continue without renderer - UI is still functional
  }

  // Load audio sources
  await loadAudioSources();

  // Surface capture-process crashes in the UI instead of dying silently. The
  // main process forwards AudioCapture 'error' events here; without this the
  // user sees frozen visuals with no explanation.
  if (window.kaleidosync.audio.onError) {
    window.kaleidosync.audio.onError(({ message }) => {
      console.error('[Kaleidosync] Audio capture error:', message);
      handleCaptureFailure(message);
    });
  }

  // Setup event listeners
  setupEventListeners();

  // Start render loop
  animate();

  console.log('[Kaleidosync] Ready');
}

async function loadAudioSources() {
  try {
    const sources = await window.kaleidosync.audio.enumerateDevices();
    populateAudioSourceSelect(sources);

    if (sources.length === 0 && window.kaleidosync.audio.getBackend) {
      // Every platform can fail to find a source for a different reason
      // (PipeWire not running, no WASAPI output device, Screen Recording
      // permission denied). Surface the backend's own explanation instead of
      // leaving an empty dropdown.
      const backend = await window.kaleidosync.audio.getBackend();
      if (backend) {
        console.warn(
          '[Kaleidosync] No audio sources. Backend:',
          backend.label,
          '-',
          backend.detail,
          backend.hint || ''
        );
      }
    }
    // Prefer Spotify specifically, then any application source, then system monitor
    const spotifySource = sources.find(s => s.name.toLowerCase().includes('spotify'));
    const appSource = spotifySource || sources.find(s => s.type === 'application');
    if (appSource) {
      selectAudioSource(appSource.id, appSource.name);
      if (spotifySource) {
        console.log('[Kaleidosync] Spotify detected, auto-starting capture...');
        // Small delay to let the UI settle
        setTimeout(() => startAudioCapture(), 500);
      }
    } else {
      const monitorSource = sources.find(s => s.type === 'monitor');
      if (monitorSource) {
        selectAudioSource(monitorSource.id, monitorSource.name);
      }
      // No app source found yet. Spotify (and other MPRIS/PipeWire apps) is
      // often opened AFTER Kaleidosync starts, so its PipeWire node isn't
      // registered on the first enumeration. Retry in the background so the
      // source list populates as soon as the app comes up.
      retryAudioSourceDiscovery();
    }
  } catch (err) {
    console.error('[Kaleidosync] Failed to load audio sources:', err);
  }
}

// Select a source id in the dropdown, appending a matching <option> first when
// the id came from a retry enumeration that the current option list does not
// know about yet. Assigning select.value to an unknown id silently yields '',
// which made the retry/auto-recovery flow dead ("Please select an audio
// source first").
function selectAudioSource(sourceId, label) {
  if (!sourceId) return false;
  if (!Array.from(audioDeviceSelect.options).some(o => o.value === sourceId)) {
    const option = document.createElement('option');
    option.value = sourceId;
    option.textContent = label || sourceId;
    audioDeviceSelect.appendChild(option);
  }
  audioDeviceSelect.value = sourceId;
  return audioDeviceSelect.value === sourceId;
}

// Retry enumeration on a backoff when no application source was found on the
// first pass. This surfaces Spotify when it is opened after Kaleidosync.
let audioSourceRetryTimer = null;
function retryAudioSourceDiscovery() {
  if (audioSourceRetryTimer) return;
  let attempt = 0;
  const maxAttempts = 10;
  const schedule = () => {
    if (attempt >= maxAttempts) { audioSourceRetryTimer = null; return; }
    attempt++;
    const delay = Math.min(2000, 500 * attempt);
    audioSourceRetryTimer = setTimeout(async () => {
      try {
        const sources = await window.kaleidosync.audio.refreshDevices(maxAttempts - attempt, 500);
        const spotifySource = sources.find(s => s.name.toLowerCase().includes('spotify'));
        const appSource = spotifySource || sources.find(s => s.type === 'application');
        if (appSource) {
          selectAudioSource(appSource.id, appSource.name);
          if (spotifySource) {
            console.log('[Kaleidosync] Spotify detected on retry, auto-starting capture...');
            setTimeout(() => startAudioCapture(), 500);
          }
          audioSourceRetryTimer = null;
          return;
        }
        schedule();
      } catch (err) {
        console.warn('[Kaleidosync] Audio source retry failed:', err.message);
        schedule();
      }
    }, delay);
  };
  schedule();
}

function populateAudioSourceSelect(sources) {
  audioDeviceSelect.innerHTML = '<option value="">Select audio source...</option>';
  sources.forEach(source => {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = source.name;
    if (source.type === 'monitor') {
      option.textContent += ' (System Monitor)';
    } else if (source.type === 'application') {
      option.textContent += ' (App)';
    }
    audioDeviceSelect.appendChild(option);
  });
}

function applyCurrentSketch() {
  if (!sketchEngine.currentSketch) return;

  // Defer the actual material mutation to the next render() call so we never
  // race a Three.js ShaderMaterial recompilation that runs async on the GL
  // thread (see renderer.js requestRebuild/applyCachedShader).
  renderer.setShader(sketchEngine.getCurrentShader());
  renderer.setUniforms(sketchEngine.getCurrentUniforms());
}

function updateSketchUI() {
  if (!sketchEngine.currentSketch) return;

  // Update sketch select
  const sketches = sketchEngine.getSketches();
  sketchSelect.innerHTML = '';
  sketches.forEach((s, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `${i + 1}. ${s.name || s.id} (${s.variants.length} variants)`;
    sketchSelect.appendChild(option);
  });
  sketchSelect.value = sketches.findIndex(s => s.id === sketchEngine.currentSketch.id);

  // Update variant select
  const variants = sketchEngine.getVariantList();
  variantSelect.innerHTML = '';
  variants.forEach((v, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `Variant ${i + 1}`;
    variantSelect.appendChild(option);
  });
  variantSelect.value = sketchEngine.currentVariantIndex;
}

// Reset the capture UI after a failure (start failure or the process dying
// mid-capture). Shared by startAudioCapture's catch and the audio:error path.
function handleCaptureFailure(message) {
  audioCapturing = false;
  stopMprisMetadataPolling();
  playbackControls.classList.add('hidden');
  hiddenModeControls.classList.add('hidden');
  audioDeviceSelect.classList.remove('hidden');
  btnAudioStart.classList.remove('hidden');
  btnAudioStop.classList.add('hidden');
  btnAudioStart.disabled = false;
  alert('Audio capture failed: ' + message);
}

async function startAudioCapture() {
  const sourceId = audioDeviceSelect.value;
  if (!sourceId) {
    alert('Please select an audio source first');
    return;
  }

  try {
    btnAudioStart.classList.add('hidden');
    btnAudioStop.classList.remove('hidden');
    btnAudioStart.disabled = true;
    // While capturing, replace source selection with playback controls
    audioDeviceSelect.classList.add('hidden');

    const result = await window.kaleidosync.audio.startCapture(sourceId);

    // Listen for analytics updates
    window.kaleidosync.audio.onAnalyticsUpdate((data) => {
      updateAudioUI(data);
    });

    // Poll MPRIS metadata while capturing
    startMprisMetadataPolling();
    audioCapturing = true;
    debugSource.textContent = result.source?.name || 'Unknown';
  } catch (err) {
    console.error('[Kaleidosync] Failed to start audio capture:', err);
    handleCaptureFailure(err.message);
  }
}

let mprisMetadataInterval = null;
let mprisMetadataRetryCount = 0;
const MPRIS_MAX_RETRIES = 12;

function startMprisMetadataPolling() {
  stopMprisMetadataPolling();
  mprisMetadataRetryCount = 0;
  mprisMetadataInterval = setInterval(() => {
    window.kaleidosync.audio.getMprisMetadata().then(({ status, metadata, playing, mprisId }) => {
      if (!audioCapturing) return;
      // Keep polling while the source is capturing. The MPRIS player may not be
      // registered yet (Spotify just launched), or the metadata dict may not
      // have parsed on a transient gdbus hiccup. Stopping on the first null
      // permanently killed the now-playing title display.
      if (!metadata) {
        mprisMetadataRetryCount++;
        if (mprisMetadataRetryCount >= MPRIS_MAX_RETRIES) {
          console.warn('[Kaleidosync] MPRIS metadata not available after retries; continuing to poll');
          mprisMetadataRetryCount = 0;
        }
        // Leave the previous title/artist on screen while we wait.
        return;
      }
      mprisMetadataRetryCount = 0;
      updateMprisUI(status, metadata, playing, mprisId);
    });
  }, 1000);
}

function stopMprisMetadataPolling() {
  if (mprisMetadataInterval) {
    clearInterval(mprisMetadataInterval);
    mprisMetadataInterval = null;
  }
}

function cleanMetadataText(text) {
  if (!text) return '';
  const cleaned = text.replace(/^['"]+/, '').replace(/['"]+$/, '').trim();
  // Defensive: if stripping quotes produced an empty string but the input
  // was non-empty, the quotes were probably part of the title. Return the
  // original trimmed text so we don't blank a legitimate track name.
  if (!cleaned && text.trim()) return text.trim();
  return cleaned;
}

function marquee(el) {
  let inner = el.firstElementChild;
  if (!inner || inner.getAttribute('data-marquee-inner') !== 'true') {
    inner = document.createElement('span');
    inner.setAttribute('data-marquee-inner', 'true');
    inner.textContent = el.textContent;
    el.textContent = '';
    el.appendChild(inner);
  } else if (inner.textContent !== el.textContent) {
    inner.textContent = el.textContent;
  }
  // If content overflows, trigger marquee animation
  if (el.scrollWidth > el.clientWidth) {
    el.classList.add('scrolling');
  } else {
    el.classList.remove('scrolling');
  }
}

function updateMprisUI(status, metadata, playing, mprisId) {
  const isMprisApp = mprisId !== null;
  if (!isMprisApp) {
    playbackControls.classList.add('hidden');
    hiddenModeControls.classList.add('hidden');
    return;
  }

  const rawTitle = metadata['xesam:title'] || metadata['mpris:title'] || '';
  const rawArtist = (metadata['xesam:artist'] || metadata['xesam:albumArtist'] || []).join(', ');
  const title = cleanMetadataText(rawTitle);
  const artist = cleanMetadataText(rawArtist);
  trackTitle.textContent = title;
  trackArtist.textContent = artist;

  marquee(trackTitle);
  marquee(trackArtist);

  // Hidden-mode panel mirror
  if (hiddenTrackTitle) {
    hiddenTrackTitle.textContent = title || 'No track';
    marquee(hiddenTrackTitle);
  }
  if (hiddenTrackArtist) {
    hiddenTrackArtist.textContent = artist;
    marquee(hiddenTrackArtist);
  }

  // Play/pause button state
  const isPlaying = playing && String(status || '').toLowerCase() === 'playing';
  btnMprisPlay.textContent = isPlaying ? '⏸' : '▶';
  btnMprisPlay.title = isPlaying ? 'Pause (Ctrl+Space)' : 'Play (Ctrl+Space)';
  if (btnHiddenMprisPlay) btnHiddenMprisPlay.textContent = isPlaying ? '⏸' : '▶';

  // Show playback controls when a source is selected and metadata is available
  if (audioCapturing) {
    playbackControls.classList.remove('hidden');
    // Replace source selection with playback controls (Stop stays available)
    audioDeviceSelect.classList.add('hidden');
    btnAudioStart.classList.add('hidden');
  }
}

async function stopAudioCapture() {
  stopMprisMetadataPolling();
  try {
    await window.kaleidosync.audio.stopCapture();
    audioCapturing = false;
    playbackControls.classList.add('hidden');
    hiddenModeControls.classList.add('hidden');
    if (hiddenPanelTimer) clearTimeout(hiddenPanelTimer);
    audioDeviceSelect.classList.remove('hidden');
    btnAudioStart.classList.remove('hidden');
    btnAudioStop.classList.add('hidden');
    btnAudioStart.disabled = false;

    // Reset meters
    meterVolume.style.width = '0%';
    meterVolumeText.textContent = '0%';
    meterBass.style.width = '0%';
    meterBassText.textContent = '0%';
    meterTreble.style.width = '0%';
    meterTrebleText.textContent = '0%';
  } catch (err) {
    console.error('[Kaleidosync] Failed to stop audio capture:', err);
  }
}

function updateAudioUI(data) {
  const volume = Math.round(data.volume * 100);
  const bass = Math.round((data.bass || 0) * 100);
  const treble = Math.round((data.treble || 0) * 100);
  const bpm = Math.round(data.bpm || 0);
  currentBPM = bpm;

  meterVolume.style.width = `${Math.min(100, volume)}%`;
  meterVolumeText.textContent = `${volume}%`;
  meterBass.style.width = `${Math.min(100, bass)}%`;
  meterBassText.textContent = `${bass}%`;
  meterTreble.style.width = `${Math.min(100, treble)}%`;
  meterTrebleText.textContent = `${treble}%`;

  // Update renderer uniforms with audio data
  if (renderer) {
    renderer.setExternalUniforms({
      stream: data.stream,
      volume: data.volume,
      iStream: data.stream,
      iVolume: data.volume,
      bass: data.bass || 0,
      treble: data.treble || 0,
      iBass: data.bass || 0,
      iTreble: data.treble || 0,
      iBpm: data.bpm || 0,
      iBeat: data.beat || 0,
      iSpeed: data.bpm ? data.bpm / 60 : 0  // beats per second -> visual speed
    });
  }
}

function animate(now = performance.now()) {
  requestAnimationFrame(animate);
  // Update tweening
  if (sketchEngine) {
    const tweenUniforms = sketchEngine.updateTween(now);
    if (renderer && tweenUniforms) {
      // Push interpolated tween uniforms to the material every frame WITHOUT
      // rebuilding shaders. This fixes the race where applyCurrentSketch()
      // used to flash pre-tween uniform values to the GPU mid-switch.
      renderer.onTweenUniforms = () => tweenUniforms;
    } else if (renderer) {
      renderer.onTweenUniforms = null;
    }
  }

  // Calculate FPS
  frameCount++;
  if (now - fpsUpdateTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    fpsUpdateTime = now;
    debugFPS.textContent = fps;
    debugRes.textContent = `${canvas.width}x${canvas.height}`;
    debugDPR.textContent = window.devicePixelRatio.toFixed(2);
    debugBPM.textContent = currentBPM;
  }

  // Render
  if (renderer) {
    renderer.render(now);
  }
}

function setupEventListeners() {
  // Sketch selection
  sketchSelect.addEventListener('change', (e) => {
    const index = parseInt(e.target.value);
    sketchEngine.selectSketch(index);
    updateSketchUI();
    applyCurrentSketch();
  });

  variantSelect.addEventListener('change', (e) => {
    const index = parseInt(e.target.value);
    sketchEngine.selectVariant(index);
    applyCurrentSketch();
  });

  btnPrev.addEventListener('click', () => {
    sketchEngine.selectPreviousSketch();
    updateSketchUI();
    applyCurrentSketch();
  });

  btnNext.addEventListener('click', () => {
    sketchEngine.selectNextSketch();
    updateSketchUI();
    applyCurrentSketch();
  });

  btnRandom.addEventListener('click', () => {
    sketchEngine.selectRandomSketch();
    updateSketchUI();
    applyCurrentSketch();
  });

  btnMagic.addEventListener('click', () => {
    sketchEngine.magicTween(500, 0.7);
  });

  btnPrevVariant.addEventListener('click', () => {
    sketchEngine.selectPreviousVariant();
    variantSelect.value = sketchEngine.currentVariantIndex;
    applyCurrentSketch();
  });

  btnNextVariant.addEventListener('click', () => {
    sketchEngine.selectNextVariant();
    variantSelect.value = sketchEngine.currentVariantIndex;
    applyCurrentSketch();
  });

  btnAudioStart.addEventListener('click', startAudioCapture);
  btnAudioStop.addEventListener('click', stopAudioCapture);

  // MPRIS playback controls
  btnMprisPlay.addEventListener('click', () => {
    console.log('[Kaleidosync] MPRIS PlayPause clicked');
    window.kaleidosync.audio.sendMprisCommand('PlayPause');
  });
  btnMprisNext.addEventListener('click', () => {
    console.log('[Kaleidosync] MPRIS Next clicked');
    window.kaleidosync.audio.sendMprisCommand('Next');
  });
  btnMprisPrev.addEventListener('click', () => {
    console.log('[Kaleidosync] MPRIS Previous clicked');
    window.kaleidosync.audio.sendMprisCommand('Previous');
  });

  // Keyboard shortcuts for playback (Ctrl/Cmd + arrows/space). These MUST NOT
  // also reach the plain-navigation handler below, so that handler bails on
  // modifier keys.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case ' ': case 'Spacebar':
          e.preventDefault();
          window.kaleidosync.audio.sendMprisCommand('PlayPause');
          break;
        case 'ArrowRight':
          e.preventDefault();
          window.kaleidosync.audio.sendMprisCommand('Next');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          window.kaleidosync.audio.sendMprisCommand('Previous');
          break;
      }
    }
  });

  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  // Hidden-mode panel helpers
  function showHiddenPanel(autoHide = true) {
    if (!hiddenModeControls) return;
    if (uiVisible) { hiddenModeControls.classList.add('hidden'); return; }
    if (!audioCapturing) { hiddenModeControls.classList.add('hidden'); return; }
    hiddenModeControls.classList.remove('hidden');
    if (autoHide) resetHiddenPanelTimer();
  }
  function resetHiddenPanelTimer() {
    if (hiddenPanelTimer) clearTimeout(hiddenPanelTimer);
    hiddenPanelTimer = setTimeout(() => {
      if (!uiVisible && !hiddenPanelPinned) hiddenModeControls.classList.add('hidden');
    }, 3000);
  }

  // UI toggle
  btnUIToggle.addEventListener('click', () => {
    uiVisible = !uiVisible;
    overlay.classList.toggle('hidden', !uiVisible);
    if (uiVisible) {
      hiddenModeControls.classList.add('hidden');
      if (hiddenPanelTimer) clearTimeout(hiddenPanelTimer);
    } else {
      showHiddenPanel();
    }
  });

  // Auto-show hidden panel on mouse move when UI hidden
  document.addEventListener('mousemove', () => {
    if (!uiVisible && audioCapturing) showHiddenPanel();
  });

  // Pin hidden panel on hover
  if (hiddenModeControls) {
    hiddenModeControls.addEventListener('mouseenter', () => { hiddenPanelPinned = true; });
    hiddenModeControls.addEventListener('mouseleave', () => { hiddenPanelPinned = false; resetHiddenPanelTimer(); });
  }

  // Hidden-mode playback buttons
  if (btnHiddenMprisPlay) {
    btnHiddenMprisPlay.addEventListener('click', () => {
      console.log('[Kaleidosync] Hidden MPRIS PlayPause clicked');
      window.kaleidosync.audio.sendMprisCommand('PlayPause');
    });
  }
  if (btnHiddenMprisNext) {
    btnHiddenMprisNext.addEventListener('click', () => {
      console.log('[Kaleidosync] Hidden MPRIS Next clicked');
      window.kaleidosync.audio.sendMprisCommand('Next');
    });
  }
  if (btnHiddenMprisPrev) {
    btnHiddenMprisPrev.addEventListener('click', () => {
      console.log('[Kaleidosync] Hidden MPRIS Previous clicked');
      window.kaleidosync.audio.sendMprisCommand('Previous');
    });
  }

  // Keyboard shortcuts (plain navigation). Ctrl/Cmd is reserved for the MPRIS
  // transport handler above, so ignore modified keystrokes here.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Guard: renderer may not be initialized yet (e.g. WebGL failure on CI)
    const canApplySketch = () => renderer && sketchEngine;
    switch (e.key) {
      case 'ArrowLeft':
        sketchEngine.selectPreviousSketch();
        updateSketchUI();
        if (canApplySketch()) applyCurrentSketch();
        break;
      case 'ArrowRight':
        sketchEngine.selectNextSketch();
        updateSketchUI();
        if (canApplySketch()) applyCurrentSketch();
        break;
      case 'ArrowUp':
        sketchEngine.selectPreviousVariant();
        variantSelect.value = sketchEngine.currentVariantIndex;
        if (canApplySketch()) applyCurrentSketch();
        break;
      case 'ArrowDown':
        sketchEngine.selectNextVariant();
        variantSelect.value = sketchEngine.currentVariantIndex;
        if (canApplySketch()) applyCurrentSketch();
        break;
      case 'r':
      case 'R':
        sketchEngine.selectRandomSketch();
        updateSketchUI();
        if (canApplySketch()) applyCurrentSketch();
        break;
      case 'm':
      case 'M':
        sketchEngine.magicTween(500, 0.7);
        break;
      case 'f':
      case 'F':
        btnFullscreen.click();
        break;
      case 'u':
      case 'U':
        btnUIToggle.click();
        break;
    }
  });

  // Handle resize
  window.addEventListener('resize', () => {
    if (renderer) {
      renderer.handleResize();
    }
  });
}

// Start
init().catch(err => {
  console.error('[Kaleidosync] Fatal error:', err);
});