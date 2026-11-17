import { app, BrowserWindow, ipcMain, screen, systemPreferences } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fs from 'fs';
import { AudioCapture } from './src/audio/audio-capture.js';
import { generateVariant, interpolateVariants } from './src/sketch-engine/variant-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let audioCapture = null;

// Logging must never take the app down. When stdout is a pipe whose reader has
// gone away (a packaged app launched from a desktop entry, a background service)
// console.log writes raise EPIPE on process.stdout, which Node surfaces as an
// uncaught exception in the main process. Swallow stream errors instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {});
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  console.log('[Main] Creating window...', { width, height });
  
  mainWindow = new BrowserWindow({
    width: Math.min(1600, width),
    height: Math.min(900, height),
    minWidth: 800,
    minHeight: 600,
    title: 'Kaleidosync',
    webPreferences: {
      preload: join(__dirname, 'preload.bundle.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: join(__dirname, 'assets/icon.png')
  });

  // Log renderer console messages from the start
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });

  console.log('[Main] Loading index.html...');
  mainWindow.loadFile(join(__dirname, 'index.html'));
  
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded');
    
    // Log network requests
    mainWindow.webContents.session.webRequest.onCompleted((details) => {
      console.log(`[Network] ${details.method} ${details.url} - ${details.statusCode}`);
    });
  });
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });
  
  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    console.log('[Main] Window closed');
    mainWindow = null;
  });
}

async function initializeAudioCapture() {
  if (audioCapture) return;
  try {
    audioCapture = new AudioCapture();
    await audioCapture.init();

    audioCapture.on('error', (err) => {
      console.error('[AudioCapture] error:', err.message);
    });

    audioCapture.on('analytics', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:analytics-update', data);
      }
    });
  } catch (err) {
    audioCapture = null;
    console.error('[Main] Audio capture initialization failed:', err.message);
  }
}

app.whenReady().then(async () => {
  console.log('[Main] App ready, creating window...');

  // ScreenCaptureKit (macOS system audio) and WASAPI loopback both need the
  // user's consent; ask once at startup so the first capture does not fail
  // silently. Both platforms surface a clear error if consent is missing.
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status !== 'granted') {
        console.log('[Main] Requesting Screen Recording permission, status:', status);
        systemPreferences.askForMediaAccess('screen');
      }
    } catch (err) {
      console.warn('[Main] Could not query Screen Recording permission:', err.message);
    }
  }

  createWindow();

  // Initialize audio capture early
  await initializeAudioCapture();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers for audio capture
ipcMain.handle('audio:enumerate-devices', async () => {
  await initializeAudioCapture();
  return audioCapture.enumerateDevices();
});

// Re-run enumeration. Used by the renderer when the auto-detect on launch
// found nothing (e.g. Spotify's PipeWire node hadn't registered yet because
// Spotify was opened after Kaleidosync started). Retries up to `retries` times
// with a backoff so an app opened last still surfaces.
ipcMain.handle('audio:refresh-devices', async (event, retries, intervalMs) => {
  await initializeAudioCapture();
  return audioCapture.refreshSources(retries, intervalMs);
});

ipcMain.handle('audio:start-capture', async (event, deviceId) => {
  await initializeAudioCapture();
  return audioCapture.startCapture(deviceId);
});

ipcMain.handle('audio:stop-capture', async () => {
  if (audioCapture) {
    await audioCapture.stopCapture();
  }
  return { success: true };
});

ipcMain.handle('audio:get-analytics', async () => {
  if (audioCapture) {
    return audioCapture.getAnalytics();
  }
  return { volume: 0, stream: 0, level: 0 };
});

// Which audio backend is active and what it can do. The renderer uses this to
// explain a missing source list ("WASAPI: no output device enabled") instead of
// showing an empty dropdown.
ipcMain.handle('audio:get-backend', async () => {
  await initializeAudioCapture();
  if (!audioCapture) return null;
  return audioCapture.getBackendStatus();
});

// Now-playing metadata. Backends: MPRIS (Linux), SMTC (Windows), AppleScript
// (macOS). Returns metadata === null when the source is unknown to the OS.
ipcMain.handle('audio:get-metadata', async () => {
  await initializeAudioCapture();
  if (!audioCapture || !audioCapture.selectedSource) {
    return { status: 'idle', metadata: null, playing: false };
  }
  const metadata = await audioCapture.getMetadata();
  // Normalize status to lowercase so backends that return 'Playing' (SMTC)
  // and 'playing' (MPRIS) both match. Fall back to audioCapture.playing when
  // the backend exposes no status field (Linux MPRIS Metadata query omits
  // PlaybackStatus), so the play/pause icon still reflects reality.
  const rawStatus = metadata ? metadata.status : null;
  const playing = rawStatus
    ? String(rawStatus).toLowerCase() === 'playing'
    : audioCapture.playing;
  return {
    status: playing ? 'playing' : (rawStatus ? String(rawStatus).toLowerCase() : 'paused'),
    metadata,
    playing,
    // The renderer treats a non-null mprisId as "this source exposes media
    // controls". Base it on backend capability, not on whether metadata was
    // available this tick, so the playback panel stays visible while a source
    // is starting up.
    mprisId: audioCapture.backend.supportsMetadata ? audioCapture.backend.id : null,
    backend: audioCapture.backend.id
  };
});

// Transport control (play/pause, next, previous). Backends: MPRIS, SMTC,
// AppleScript. Returns false when the backend cannot control the source.
ipcMain.handle('audio:mpris-command', async (event, command) => {
  await initializeAudioCapture();
  if (!audioCapture) return false;
  const result = await audioCapture.sendCommand(command);
  console.log('[Main] transport command', command, '->', result);
  return result;
});

// IPC handlers for sketches
ipcMain.handle('sketches:get-catalog', async () => {
  const catalogPath = join(__dirname, '..', 'assets', 'sketches.json');
  return JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
});

ipcMain.handle('sketches:generate-variant', async (event, variant, temp) => {
  return generateVariant(variant, temp);
});

ipcMain.handle('sketches:interpolate-variants', async (event, from, to, progress) => {
  return interpolateVariants(from, to, progress);
});

// App lifecycle
ipcMain.handle('app:get-version', async () => {
  return app.getVersion();
});

ipcMain.handle('app:quit', async () => {
  app.quit();
});