import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, nativeImage } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATUS_LABEL = {
  idle: 'Status: Idle',
  waiting: 'Status: Waiting for card…',
  reading: 'Status: Reading card…',
  done: 'Status: Idle',
  error: 'Status: Idle',
};

export function createTray({ port, onCancelScan, onPreview, onManualScan, onToggleAutoStart, autoStartSupported, autoStartEnabled, onQuit }) {
  const iconPath = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('eID NFC Bridge');

  const state = {
    status: 'idle',
    lastScanLabel: 'Last scan: none yet',
    autoStartEnabled: Boolean(autoStartEnabled),
    scanning: false,
  };

  function rebuildMenu() {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: STATUS_LABEL[state.status] ?? STATUS_LABEL.idle, enabled: false },
        { label: state.lastScanLabel, enabled: false },
        { label: `Listening on 127.0.0.1:${port}`, enabled: false },
        { type: 'separator' },
        { label: 'Cancel current scan', enabled: state.scanning, click: () => onCancelScan?.() },
        {
          label: 'Preview',
          click: () => onPreview?.(),
        },
        {
          label: 'Manual Scan…',
          click: () => onManualScan?.(),
        },
        { type: 'separator' },
        {
          label: 'Start on Login',
          type: 'checkbox',
          enabled: autoStartSupported,
          checked: state.autoStartEnabled,
          click: () => onToggleAutoStart?.(),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            onQuit?.();
          },
        },
      ]),
    );
  }

  rebuildMenu();

  return {
    // Electron's own app.whenReady() already gates when this module gets
    // constructed, so there's no separate readiness handshake to await
    // here (unlike systray2, which spawns a child process for the tray).
    ready: () => Promise.resolve(),
    setStatus(status) {
      state.status = status;
      state.scanning = status === 'waiting' || status === 'reading';
      rebuildMenu();
    },
    setLastScan({ ok, name, message }) {
      const at = new Date().toLocaleTimeString();
      state.lastScanLabel = ok ? `Last scan: ${name ?? 'success'} (${at})` : `Last scan failed: ${message} (${at})`;
      rebuildMenu();
    },
    setAutoStart(enabled) {
      state.autoStartEnabled = Boolean(enabled);
      rebuildMenu();
    },
  };
}
