"use strict";

// app/preload.js
var import_electron = require("electron");
console.log("[Preload] Preload script running, Electron version:", process.versions.electron);
try {
  import_electron.contextBridge.exposeInMainWorld("kaleidosync", {
    audio: {
      enumerateDevices: () => import_electron.ipcRenderer.invoke("audio:enumerate-devices"),
      startCapture: (deviceId) => import_electron.ipcRenderer.invoke("audio:start-capture", deviceId),
      stopCapture: () => import_electron.ipcRenderer.invoke("audio:stop-capture"),
      getAnalytics: () => import_electron.ipcRenderer.invoke("audio:get-analytics"),
      getMprisMetadata: () => import_electron.ipcRenderer.invoke("audio:get-metadata"),
      // Forward the retry/backoff context so the main process can re-run
      // enumeration with the caller's pacing (see audio:refresh-devices).
      refreshDevices: (retries, intervalMs) => import_electron.ipcRenderer.invoke("audio:refresh-devices", retries, intervalMs),
      getBackend: () => import_electron.ipcRenderer.invoke("audio:get-backend"),
      sendMprisCommand: (cmd) => import_electron.ipcRenderer.invoke("audio:mpris-command", cmd),
      onAnalyticsUpdate: (callback) => {
        const handler = (_, data) => callback(data);
        import_electron.ipcRenderer.on("audio:analytics-update", handler);
        return () => import_electron.ipcRenderer.off("audio:analytics-update", handler);
      },
      onError: (callback) => {
        const handler = (_, data) => callback(data);
        import_electron.ipcRenderer.on("audio:error", handler);
        return () => import_electron.ipcRenderer.off("audio:error", handler);
      }
    },
    sketches: {
      getCatalog: () => import_electron.ipcRenderer.invoke("sketches:get-catalog")
    }
  });
  console.log("[Preload] Successfully exposed kaleidosync API");
} catch (err) {
  console.error("[Preload] Failed to expose API:", err);
}
