// Electron main process entry point. Runs as a background/tray-only app —
// there's no main window, just the HTTP server (server.js, plain Node APIs,
// runs fine inside Electron's main process) plus a tray icon and an
// on-demand preview BrowserWindow.
import { app, ipcMain } from 'electron';
import { events, PORT, cancelActiveScan, getLastScan, clearLastScan } from './src/server.js';
import { createTray } from './src/tray.js';
import { showPreviewWindow, pushScanUpdate, getWindow as getPreviewWindow } from './src/preview-window.js';
import { showManualScanDialog } from './src/manual-scan-dialog.js';
import { computeCardValues } from './src/id-card-render.js';
import * as autostart from './src/autostart.js';
import { loadConfig, saveConfig } from './src/config.js';

// The single source of truth for "what should the preview window be
// showing right now" — used for both the initial IPC push and the
// clear-scan round trip, so they can never compute it differently.
function pushCurrentScan() {
  const lastScan = getLastScan();
  const values = lastScan
    ? computeCardValues(lastScan.result, { docNum: lastScan.mrz.docNum, dob: lastScan.mrz.dob, doe: lastScan.mrz.doe })
    : computeCardValues(null);
  pushScanUpdate(values);
}

// Shared by both ways of triggering Clear Scan — the preview page's own
// topbar text link (over the IPC bus) and the window's Scan menu — so
// there's exactly one place that decides what "cleared" means.
function handleClearScan() {
  clearLastScan();
  pushCurrentScan();
}

// Only one bridge should ever hold the HTTP port / NFC reader / tray icon
// at once — without this, launching the app a second time (e.g. double-
// clicking the Desktop shortcut again) would crash on EADDRINUSE instead
// of just doing nothing.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // This app has no normal windows — the preview window is opt-in and
  // independent of app lifetime, so closing it must not quit the tray/server.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    const config = loadConfig();
    if (autostart.isSupported()) {
      try {
        autostart.syncTo(config.autoStart);
      } catch (err) {
        console.log(`[autostart] failed to sync login-item registration: ${err.message}`);
      }
    }

    const tray = createTray({
      port: PORT,
      onCancelScan: cancelActiveScan,
      onPreview: () => {
        try {
          showPreviewWindow(`http://127.0.0.1:${PORT}/preview`, { onClearScan: handleClearScan });
        } catch (err) {
          console.log(`[preview] failed to open: ${err.message}`);
        }
      },
      onManualScan: () => {
        try {
          showManualScanDialog(null, PORT);
        } catch (err) {
          console.log(`[manual-scan] failed to open: ${err.message}`);
        }
      },
      autoStartSupported: autostart.isSupported(),
      autoStartEnabled: config.autoStart,
      onToggleAutoStart: () => {
        const next = !loadConfig().autoStart;
        try {
          if (next) autostart.enable();
          else autostart.disable();
          saveConfig({ autoStart: next });
          tray.setAutoStart(next);
        } catch (err) {
          console.log(`[autostart] failed to toggle: ${err.message}`);
        }
      },
      onQuit: () => app.quit(),
    });

    events.on('status', (status) => tray.setStatus(status));
    events.on('result', (result) => {
      tray.setStatus('idle');
      tray.setLastScan(result);
      // Covers both the initial fast scan and the follow-up full read
      // (server.js emits 'result' for each) — an already-open preview
      // window picks up whichever one just finished over the IPC bus,
      // instead of being stuck showing whatever was current when it was
      // last loaded.
      pushCurrentScan();
    });

    // The page's Clear Scan text link (see preload.cjs / id-card.html) —
    // no HTTP round trip, no reload: clear server-side state and push the
    // resulting empty values back down the same bus used for scan results.
    ipcMain.on('clear-scan', handleClearScan);

    // The page's Manual Scan text link — parent the dialog to the preview
    // window itself, same as the Scan menu's own Manual Scan item does.
    ipcMain.on('open-manual-scan', () => {
      try {
        showManualScanDialog(getPreviewWindow(), PORT);
      } catch (err) {
        console.log(`[manual-scan] failed to open: ${err.message}`);
      }
    });
  });
}
