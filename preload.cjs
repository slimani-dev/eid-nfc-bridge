// Preload script for the preview BrowserWindow (see src/preview-window.js).
// Named .cjs deliberately: the rest of this project is "type": "module",
// but Electron's preload context is its own thing — CommonJS keeps this
// unambiguous regardless of Electron version/sandbox quirks.
//
// contextIsolation is on (Electron's default, and left that way here), so
// the page can't just `require('electron')` itself — contextBridge is the
// supported way to hand it a narrow, safe API instead of the whole
// ipcRenderer/Node surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nfcBridge', {
  // fields/facePhotoSrc/signatureSrc/hasScan — see id-card-render.js's
  // computeCardValues(), which is exactly what electron-main.js sends here.
  onScanUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('scan-update', listener);
    return () => ipcRenderer.removeListener('scan-update', listener);
  },
  requestClear: () => ipcRenderer.send('clear-scan'),
  requestManualScan: () => ipcRenderer.send('open-manual-scan'),
});
