import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fs from 'fs';
import { AudioCapture } from './src/audio/audio-capture.js';
import { generateVariant, interpolateVariants } from './src/sketch-engine/variant-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let audioCapture = null;

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
  audioCapture = new AudioCapture();
  await audioCapture.init();
  
  // Forward analytics events from AudioCapture to renderer
  audioCapture.on('analytics', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:analytics-update', data);
    }
  });
}

app.whenReady().then(async () => {
  console.log('[Main] App ready, creating window...');
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

ipcMain.handle('audio:get-metadata', async () => {
  if (!audioCapture || !audioCapture.selectedSource) {
    return { status: 'idle', metadata: null, playing: false };
  }
  const source = audioCapture.sources.find(s => s.id === audioCapture.selectedSource);
  if (!source) {
    return { status: 'idle', metadata: null, playing: false };
  }
  const mprisId = audioCapture.mprisIdentityFor(source);
  const playing = audioCapture.playing;
  if (!mprisId) {
    return { status: 'playing', metadata: null, playing };
  }
  const metadata = await audioCapture.queryMprisMetadata(mprisId);
  return { status: playing ? 'playing' : 'paused', metadata, playing, mprisId };
});

ipcMain.handle('audio:mpris-command', async (event, command) => {
  console.log('[Main] audio:mpris-command received:', command);
  if (!audioCapture || !audioCapture.selectedSource) {
    console.log('[Main] mpris-command: no audioCapture or selectedSource');
    return false;
  }
  const source = audioCapture.sources.find(s => s.id === audioCapture.selectedSource);
  if (!source) {
    console.log('[Main] mpris-command: selected source not found:', audioCapture.selectedSource);
    return false;
  }
  const mprisId = audioCapture.mprisIdentityFor(source);
  console.log('[Main] mpris-command: source', source.name, '-> mprisId', mprisId);
  if (!mprisId) {
    return false;
  }
  const result = await audioCapture.sendMprisCommand(mprisId, command);
  console.log('[Main] mpris-command result:', result);
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