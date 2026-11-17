import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kaleidosync', {
    audio: {
      enumerateDevices: () => ipcRenderer.invoke('audio:enumerate-devices'),
      startCapture: (deviceId) => ipcRenderer.invoke('audio:start-capture', deviceId),
      stopCapture: () => ipcRenderer.invoke('audio:stop-capture'),
      getAnalytics: () => ipcRenderer.invoke('audio:get-analytics'),
      getMprisMetadata: () => ipcRenderer.invoke('audio:get-metadata'),
      // Forward the retry/backoff context so the main process can re-run
      // enumeration with the caller's pacing (see audio:refresh-devices).
      refreshDevices: (retries, intervalMs) =>
        ipcRenderer.invoke('audio:refresh-devices', retries, intervalMs),
      getBackend: () => ipcRenderer.invoke('audio:get-backend'),
      sendMprisCommand: (cmd) => ipcRenderer.invoke('audio:mpris-command', cmd),
      onAnalyticsUpdate: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('audio:analytics-update', handler);
        return () => ipcRenderer.off('audio:analytics-update', handler);
      },
      onError: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('audio:error', handler);
        return () => ipcRenderer.off('audio:error', handler);
      }
    },
  sketches: {
    getCatalog: () => ipcRenderer.invoke('sketches:get-catalog')
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version')
  }
});