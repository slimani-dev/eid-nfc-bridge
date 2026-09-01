import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'eID NFC Bridge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'eid-nfc-bridge');
}

const CONFIG_PATH = path.join(configDir(), 'config.json');

const DEFAULTS = {
  autoStart: true,
};

export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export function configExists() {
  return existsSync(CONFIG_PATH);
}
