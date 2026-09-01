import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCardAndRead } from './card-reader.js';
import { renderIdCardHtml } from './id-card-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

export const PORT = process.env.PORT ? Number(process.env.PORT) : 4319;

export const events = new EventEmitter();

let activeScan = null;
// The most recent *successful* scan, kept only in memory (cleared on
// restart) so GET /preview can re-render it on demand — this never opens
// anything by itself, a human has to actually hit the endpoint/tray item.
let lastScan = null;
// The MRZ params of the most recent scan *attempt*, success or failure —
// separate from lastScan because a failed/cancelled attempt should still
// be remembered (e.g. so the manual-scan form in id-card.html doesn't make
// you retype docNum/dob/doe after a typo caused the previous attempt to fail).
let lastAttemptedMrz = null;

function log(level, message, data = null) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = `[NFC-BRIDGE ${ts}] [${level}]`;
  if (data) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function withCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeDate(val) {
  if (typeof val !== 'string') return '';
  const clean = val.replace(/\D/g, '');
  if (clean.length === 8) return clean.slice(2);
  if (clean.length === 6) return clean;
  return val.trim();
}

function validateMrz({ docNum, dob, doe }) {
  if (typeof docNum !== 'string' || !docNum.trim()) return 'docNum is required';
  const cleanDob = normalizeDate(dob);
  const cleanDoe = normalizeDate(doe);
  if (!/^\d{6}$/.test(cleanDob)) return 'dob must be a 6-digit YYMMDD string (e.g. 010101 for 2001-01-01)';
  if (!/^\d{6}$/.test(cleanDoe)) return 'doe must be a 6-digit YYMMDD string (e.g. 301231 for 2030-12-31)';
  return null;
}

function nameFromMrzText(mrzText) {
  if (!mrzText) return null;
  const namePart = mrzText.split(/\r?\n/).pop() ?? mrzText;
  return namePart.replace(/</g, ' ').trim().replace(/\s+/g, ' ') || null;
}

const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// id-card.html's background/sample images are referenced as "../assets/..."
// — since the rendered page is served from /preview (no trailing slash),
// browsers resolve that to /assets/<file>, so /preview needs this static
// route to actually load anything.
async function serveAsset(req, res, url) {
  const requested = decodeURIComponent(url.slice('/assets/'.length));
  const resolved = path.join(ASSETS_DIR, requested);
  if (!resolved.startsWith(ASSETS_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) throw new Error('not a file');
    const mime = ASSET_MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stats.size });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

export function cancelActiveScan() {
  activeScan?.cancel();
}

// Lets electron-main.js read/clear scan state directly for the IPC push to
// an open preview window, instead of that window having to make an HTTP
// round-trip (and reload to show the response) just to talk to the same
// process it's already running inside.
export function getLastScan() {
  return lastScan;
}

export function clearLastScan() {
  lastScan = null;
}

// Fire-and-forget: only ever called right after a fast scan's HTTP
// response has already been sent, so nothing here can affect that caller.
// Best-effort — if the card's already been lifted off the reader by the
// time this starts, it just fails quietly and /preview keeps showing the
// fast scan's partial data instead.
function runFollowUpFullScan(fastMrz) {
  const fullMrz = { ...fastMrz, fast: false };
  log('INFO', `Fast scan complete — following up with a full read for /preview (docNum=${fullMrz.docNum})`);

  activeScan = waitForCardAndRead(
    fullMrz,
    (msg) => log('PROGRESS', `[follow-up] ${msg}`),
    (status) => {
      log('STATUS', `[follow-up] Reader State: ${status}`);
      events.emit('status', status === 'detected' ? 'reading' : status);
    },
  );

  activeScan.promise
    .then((result) => {
      activeScan = null;
      lastScan = { result, mrz: fullMrz };
      const extractedName = nameFromMrzText(result.mrzText) || result.personal?.fullNameNational || 'N/A';
      log('SUCCESS', `[follow-up] Full read complete — /preview now has complete data for "${extractedName}"`);
      events.emit('status', 'idle');
      events.emit('result', { ok: true, name: extractedName });
    })
    .catch((e) => {
      activeScan = null;
      log('WARN', `[follow-up] Full read failed (card likely already removed) — /preview still has the fast scan's partial data: ${e.message}`);
      events.emit('status', 'idle');
    });
}

const server = createServer(async (req, res) => {
  withCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const startMs = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      scanning: activeScan !== null,
      timestamp: new Date().toISOString(),
    });
  }

  // Lets id-card.html's manual-scan form pre-fill from whatever was last
  // tried this session, instead of always starting blank.
  if (req.method === 'GET' && req.url === '/scan/last-mrz') {
    return sendJson(res, 200, lastAttemptedMrz ?? {});
  }

  if (req.method === 'POST' && req.url === '/scan') {
    log('INFO', `>>> Incoming POST /scan request from ${req.headers.origin || 'unknown origin'}`);

    if (activeScan) {
      log('WARN', 'Conflict: A scan is already in progress');
      return sendJson(res, 409, { error: 'A scan is already in progress.' });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      log('ERROR', `Malformed JSON request body: ${e.message}`);
      return sendJson(res, 400, { error: e.message });
    }

    const validationError = validateMrz(body);
    if (validationError) {
      log('WARN', `MRZ Validation failed: ${validationError}`, body);
      return sendJson(res, 422, { error: validationError });
    }

    const mrz = {
      docNum: body.docNum.trim(),
      dob: normalizeDate(body.dob),
      doe: normalizeDate(body.doe),
      fast: Boolean(body.fast),
    };

    log('INFO', `Starting scan with BAC parameters: docNum=${mrz.docNum}, dob=${mrz.dob}, doe=${mrz.doe}, fast=${mrz.fast}`);
    lastAttemptedMrz = mrz;
    events.emit('status', 'waiting');

    activeScan = waitForCardAndRead(
      mrz,
      (msg) => log('PROGRESS', msg),
      (status) => {
        log('STATUS', `Reader State: ${status}`);
        events.emit('status', status === 'detected' ? 'reading' : status);
      },
    );

    try {
      const result = await activeScan.promise;
      const duration = Date.now() - startMs;
      activeScan = null;

      const extractedName = nameFromMrzText(result.mrzText) || result.personal?.fullNameNational || 'N/A';
      const photoSize = result.facePhoto?.base64 ? `${Math.round(result.facePhoto.base64.length * 0.75 / 1024)} KB` : 'None';

      log('SUCCESS', `<<< Scan succeeded in ${duration}ms | Name: "${extractedName}" | Photo: ${photoSize} | NIN: ${result.personal?.personalNumber || 'N/A'}`);
      lastScan = { result, mrz };
      events.emit('result', { ok: true, name: extractedName });

      sendJson(res, 200, result);

      // A fast scan deliberately skips DG2/DG7 (photo/signature) to stay
      // quick for the caller's own workflow — the calling app may already
      // have that data cached from an earlier scan of this same card. But
      // /preview has no access to the caller's own data store at all, so a
      // fast scan alone would leave it showing an incomplete card. Follow up with one
      // full read, purely to fill in /preview — this never delays or
      // otherwise affects the response the caller already got above.
      if (mrz.fast) {
        runFollowUpFullScan(mrz);
      }

      return;
    } catch (e) {
      const duration = Date.now() - startMs;
      activeScan = null;
      log('ERROR', `<<< Scan failed after ${duration}ms: ${e.message}`);
      events.emit('result', { ok: false, message: e.message });
      return sendJson(res, 422, { error: e.message });
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/assets/')) {
    return serveAsset(req, res, req.url);
  }

  if (req.method === 'GET' && req.url === '/preview') {
    // With no scan loaded, renderIdCardHtml(null, ...) still renders a
    // valid page — every field just comes back blank and the photo/
    // signature fall back to their placeholder sample images — so this
    // always resolves the "empty" view rather than a dead end.
    const html = lastScan
      ? renderIdCardHtml(lastScan.result, { docNum: lastScan.mrz.docNum, dob: lastScan.mrz.dob, doe: lastScan.mrz.doe })
      : renderIdCardHtml(null);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'POST' && req.url === '/preview/clear') {
    log('INFO', '>>> Incoming POST /preview/clear (reset preview to empty state)');
    lastScan = null;
    return sendJson(res, 200, { status: 'cleared' });
  }

  if (req.method === 'DELETE' && req.url === '/scan') {
    log('INFO', '>>> Incoming DELETE /scan request (cancel scan)');
    if (!activeScan) return sendJson(res, 404, { error: 'No scan is in progress.' });
    activeScan.cancel();
    activeScan = null;
    events.emit('status', 'idle');
    log('INFO', '<<< Active scan cancelled');
    return sendJson(res, 200, { status: 'cancelled' });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log('INFO', `🚀 eID NFC Bridge HTTP server listening on http://127.0.0.1:${PORT}`);
});
