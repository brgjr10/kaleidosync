"use strict";

// app/preload.js
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("kaleidosync", {
  audio: {
    enumerateDevices: () => import_electron.ipcRenderer.invoke("audio:enumerate-devices"),
    startCapture: (deviceId) => import_electron.ipcRenderer.invoke("audio:start-capture", deviceId),
    stopCapture: () => import_electron.ipcRenderer.invoke("audio:stop-capture"),
    getAnalytics: () => import_electron.ipcRenderer.invoke("audio:get-analytics"),
    getMprisMetadata: () => import_electron.ipcRenderer.invoke("audio:get-metadata"),
    refreshDevices: () => import_electron.ipcRenderer.invoke("audio:refresh-devices"),
    getBackend: () => import_electron.ipcRenderer.invoke("audio:get-backend"),
    sendMprisCommand: (cmd) => import_electron.ipcRenderer.invoke("audio:mpris-command", cmd),
    onAnalyticsUpdate: (callback) => {
      const handler = (_, data) => callback(data);
      import_electron.ipcRenderer.on("audio:analytics-update", handler);
      return () => import_electron.ipcRenderer.off("audio:analytics-update", handler);
    }
  },
  sketches: {
    getCatalog: () => import_electron.ipcRenderer.invoke("sketches:get-catalog"),
    generateVariant: (variant, temp) => import_electron.ipcRenderer.invoke("sketches:generate-variant", variant, temp),
    interpolateVariants: (from, to, progress) => import_electron.ipcRenderer.invoke("sketches:interpolate-variants", from, to, progress)
  },
  app: {
    getVersion: () => import_electron.ipcRenderer.invoke("app:get-version"),
    quit: () => import_electron.ipcRenderer.invoke("app:quit")
  }
});
//# sourceMappingURL=preload.bundle.cjs.map
