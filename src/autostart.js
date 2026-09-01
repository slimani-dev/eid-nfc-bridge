import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE = 'eID NFC Bridge';

// A packaged Electron app *is* the native executable — process.execPath
// correctly points at e.g. "C:\Program Files\eID NFC Bridge\eID NFC
// Bridge.exe" (Windows) once built by electron-builder, no separate
// launcher script needed. AppImage sets $APPIMAGE to the original
// .AppImage file's path when running from inside one, which is the right
// thing to point a Linux autostart entry at instead. In dev (running
// straight from the repo via `npm start`/`electron .`) neither applies, so
// fall back to launching electron.exe against this project's directory,
// same as `electron .` does.
function launchCommand() {
  if (process.env.APPIMAGE) {
    return `"${process.env.APPIMAGE}"`;
  }
  if (process.platform === 'win32') {
    return `"${process.execPath}"`;
  }
  return `"${process.execPath}" "${APP_ROOT}"`;
}

function linuxAutostartDesktopPath() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  return path.join(dir, 'eid-nfc-bridge.desktop');
}

export function isSupported() {
  return process.platform === 'win32' || process.platform === 'linux';
}

export function isEnabled() {
  if (process.platform === 'win32') {
    try {
      execFileSync('reg', ['query', REG_KEY, '/v', REG_VALUE], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'linux') {
    return existsSync(linuxAutostartDesktopPath());
  }
  return false;
}

export function enable() {
  if (process.platform === 'win32') {
    execFileSync('reg', ['add', REG_KEY, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', launchCommand(), '/f'], {
      stdio: 'pipe',
    });
    return;
  }
  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartDesktopPath();
    mkdirSync(path.dirname(desktopPath), { recursive: true });
    writeFileSync(
      desktopPath,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=eID NFC Bridge',
        `Exec=${launchCommand()}`,
        'X-GNOME-Autostart-enabled=true',
        'NoDisplay=true',
        '',
      ].join('\n'),
    );
    return;
  }
  throw new Error(`Auto-start is not supported on ${process.platform}`);
}

export function disable() {
  if (process.platform === 'win32') {
    try {
      execFileSync('reg', ['delete', REG_KEY, '/v', REG_VALUE, '/f'], { stdio: 'pipe' });
    } catch {
      // Already absent — nothing to do.
    }
    return;
  }
  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartDesktopPath();
    if (existsSync(desktopPath)) {
      unlinkSync(desktopPath);
    }
    return;
  }
  throw new Error(`Auto-start is not supported on ${process.platform}`);
}

// Makes the OS-level registration match the desired state. Called on every
// startup so a stale registration (e.g. left over after a manual config
// edit, or from before this feature existed) self-heals to match config.json
// instead of silently drifting.
export function syncTo(wantEnabled) {
  if (!isSupported()) return;
  const currentlyEnabled = isEnabled();
  if (wantEnabled && !currentlyEnabled) enable();
  if (!wantEnabled && currentlyEnabled) disable();
}
