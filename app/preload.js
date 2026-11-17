import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kaleidosync', {
    audio: {
      enumerateDevices: () => ipcRenderer.invoke('audio:enumerate-devices'),
      startCapture: (deviceId) => ipcRenderer.invoke('audio:start-capture', deviceId),
      stopCapture: () => ipcRenderer.invoke('audio:stop-capture'),
      getAnalytics: () => ipcRenderer.invoke('audio:get-analytics'),
      getMprisMetadata: () => ipcRenderer.invoke('audio:get-metadata'),
      refreshDevices: () => ipcRenderer.invoke('audio:refresh-devices'),
      sendMprisCommand: (cmd) => ipcRenderer.invoke('audio:mpris-command', cmd),
      onAnalyticsUpdate: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('audio:analytics-update', handler);
        return () => ipcRenderer.off('audio:analytics-update', handler);
      }
    },
  sketches: {
    getCatalog: () => ipcRenderer.invoke('sketches:get-catalog'),
    generateVariant: (variant, temp) => ipcRenderer.invoke('sketches:generate-variant', variant, temp),
    interpolateVariants: (from, to, progress) => ipcRenderer.invoke('sketches:interpolate-variants', from, to, progress)
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    quit: () => ipcRenderer.invoke('app:quit')
  }
});
