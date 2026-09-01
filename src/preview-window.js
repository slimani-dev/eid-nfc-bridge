import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu } from 'electron';
import { showManualScanDialog } from './manual-scan-dialog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(__dirname, '..', 'preload.cjs');

// A real BrowserWindow backed by Electron's own bundled Chromium — no
// system WebView2/WebKitGTK dependency, no native-binding resolution to go
// wrong. Only ever opens on an explicit user action (the tray's "Preview"
// item), never automatically after a scan.
let win = null;

// Replaces Electron's bare default File/Edit/View/Window menu bar with the
// same two actions as the topbar's text links (Clear Scan, Manual Scan),
// inserted as their own "Scan" menu between File and Edit — Manual Scan
// opens parented to this window directly (no need to round-trip through
// electron-main.js for that, unlike Clear Scan, which touches server.js's
// scan state and stays a callback). win.setMenu is a no-op on macOS (one
// global app menu bar there), fine since this project targets Windows/Linux.
function buildPreviewMenu(port, onClearScan) {
  return Menu.buildFromTemplate([
    { role: 'fileMenu' },
    {
      label: 'Scan',
      submenu: [
        { label: 'Clear Scan', click: () => onClearScan?.() },
        { label: 'Manual Scan…', click: () => showManualScanDialog(win, port) },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

export function showPreviewWindow(url, { onClearScan } = {}) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    title: 'eID NFC Bridge — Card Preview',
    // 500×350 as both the default and the floor: the card's aspect-ratio-
    // locked .flip-scene scales cleanly with the window either way (see
    // id-card.html — %/cqi-based layout, container-type: inline-size on
    // .card-face), but this size in particular is the compact, well-
    // proportioned fit for the card without excess surrounding space.
    // useContentSize measures the web content area itself, not the OS
    // window frame/titlebar, so it comes out matching on screen.
    // resizable stays on — this is just where it starts.
    width: 500,
    height: 350,
    minWidth: 500,
    minHeight: 350,
    useContentSize: true,
    resizable: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(buildPreviewMenu(new URL(url).port, onClearScan));
  win.on('closed', () => {
    win = null;
  });
  win.loadURL(url);
}

// A scan can complete well after the window was opened — the fast/full-
// follow-up pair in particular resolves seconds apart — and a plain page
// load has no way to know new data showed up later. Pushed over the IPC
// bus (preload.cjs's window.nfcBridge.onScanUpdate) instead of reloading:
// no flash, and the page's own state (flip position, the manual-scan
// disclosure, focus) survives. Called from electron-main.js whenever
// server.js emits a 'result' event (fast scan, its follow-up full read, or
// a manual scan) or a clear-scan IPC request comes back from the page
// itself — a no-op if the window isn't currently open.
export function pushScanUpdate(data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('scan-update', data);
  }
}

// Lets electron-main.js parent the Manual Scan dialog to this window when
// it's opened via the topbar's text link (IPC, since only main can create
// windows) — the Scan-menu path above doesn't need this, it already has
// direct access to `win`. Null when the preview window isn't open.
export function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}
