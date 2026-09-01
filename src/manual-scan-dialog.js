import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_PATH = path.join(__dirname, 'manual-scan-dialog.html');

let dialogWin = null;

// A real modal dialog window (parented to the preview window when one's
// open) instead of the cramped inline <details> form that used to live in
// id-card.html's empty state — same purpose (POST /scan with typed
// docNum/dob/doe for testing without a physical card), properly sized. No preload
// needed: the dialog only ever does fetch() and window.close(), both plain
// web APIs, so nodeIntegration/contextIsolation stay at their safe
// defaults with nothing extra exposed.
export function showManualScanDialog(parentWindow, port) {
  if (dialogWin && !dialogWin.isDestroyed()) {
    dialogWin.show();
    dialogWin.focus();
    return;
  }

  dialogWin = new BrowserWindow({
    title: 'Manual Scan',
    // Sized to the actual compact layout (no page heading — the window's
    // own titlebar already says "Manual Scan" — and tight native-dialog
    // spacing), not a rough guess: verified no scrollbar appears at this
    // exact size.
    width: 300,
    height: 280,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dialogWin.setMenuBarVisibility(false);
  dialogWin.on('closed', () => {
    dialogWin = null;
  });
  dialogWin.loadFile(DIALOG_PATH, { query: { port: String(port) } });
}
