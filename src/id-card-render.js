import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'id-card.html');

// Mirrors app/Support/IdCardParser.php's splitBilingual(): the chip stores
// many DG11/DG12 fields as "LATIN<<ARABIC" (ICAO filler-separated), or as
// plain Arabic/Latin text with no separator at all.
function splitBilingual(raw) {
  if (!raw) return { latin: null, arabic: null };
  const trimmed = raw.trim();
  if (trimmed.includes('<<')) {
    const [latinRaw, arabicRaw = ''] = trimmed.split('<<');
    const latin = latinRaw.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
    const arabic = arabicRaw.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
    return { latin: latin || null, arabic: arabic || null };
  }
  if (/\p{Script=Arabic}/u.test(trimmed)) {
    return { latin: null, arabic: trimmed };
  }
  return { latin: trimmed, arabic: null };
}

const latin = (raw) => splitBilingual(raw).latin;
const arabic = (raw) => splitBilingual(raw).arabic;

// Mirrors app/Enums/Gender.php::fromRaw() — the chip repurposes
// "permanentAddress" (DG11 5F42) to store "Sex<<Blood<<Type" instead.
function genderFromRaw(raw) {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper.startsWith('M') || raw.includes('ذكر')) return { label: 'ذكر' };
  if (upper.startsWith('F') || raw.includes('أنثى') || raw.includes('انثى')) return { label: 'أنثى' };
  return null;
}

// Mirrors app/Enums/BloodType.php::fromRaw().
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
function bloodTypeFromRaw(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase();
  return BLOOD_TYPES.find((bt) => clean.includes(bt)) ?? null;
}

// Standard 2-digit-year century pivot (the same convention PHP's
// Carbon::createFromFormat('y...', ...) uses by default): 00-68 -> 20XX,
// 69-99 -> 19XX. A 6-digit MRZ date can be a date of birth (usually last
// century) or an expiry (usually this one) — this one rule has to serve
// both, since nothing else in a bare YYMMDD says which.
function resolveFullYear(twoDigitYear) {
  return twoDigitYear >= 69 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
}

// The physical card prints dates as YYYY.MM.DD — this only feeds the
// visual replica, independent of whatever date format a calling app uses.
function formatCardDate(raw) {
  if (!raw) return '';
  const clean = raw.replace(/\D/g, '');
  if (clean.length === 8) return `${clean.slice(0, 4)}.${clean.slice(4, 6)}.${clean.slice(6, 8)}`;
  if (clean.length === 6) {
    const year = resolveFullYear(parseInt(clean.slice(0, 2), 10));
    return `${year}.${clean.slice(2, 4)}.${clean.slice(4, 6)}`;
  }
  return raw;
}

// Same input shapes as formatCardDate, just the 4-digit year alone — used
// for the back face's birth-year field. Deliberately not "first 4 chars of
// the raw string": for a 6-digit YYMMDD that's YY+MM concatenated, not a
// year at all (e.g. "010101".slice(0,4) is "0101", not a real year).
function fourDigitYear(raw) {
  if (!raw) return '';
  const clean = raw.replace(/\D/g, '');
  if (clean.length === 8) return clean.slice(0, 4);
  if (clean.length === 6) return String(resolveFullYear(parseInt(clean.slice(0, 2), 10)));
  return '';
}

// Mirrors ScanIdCardAction.php's fallback: Algerian national ID cards are
// valid for exactly 10 years, so when the chip doesn't expose 5F26
// (dateOfIssue) directly — some DG12 layouts and fast-mode reads don't
// carry it — derive it from the expiry date instead of leaving it blank.
function deriveIssueDateFromExpiry(expiry) {
  if (!expiry) return null;
  const clean = expiry.replace(/\D/g, '');
  if (clean.length === 8) {
    const year = parseInt(clean.slice(0, 4), 10) - 10;
    return `${year}${clean.slice(4, 8)}`;
  }
  if (clean.length === 6) {
    const year = ((parseInt(clean.slice(0, 2), 10) - 10) % 100 + 100) % 100;
    return `${String(year).padStart(2, '0')}${clean.slice(2, 6)}`;
  }
  return null;
}

// TD1 MRZ is exactly 3 lines of 30 characters. card-reader.js may hand back
// mrzText either pre-split (real newlines) or as one 90-char string —
// normalize both to a fixed 3x30 layout so the monospace grid always lines
// up (short/blank input pads with '<' filler rather than leaving gaps).
function splitMrzLines(mrzText) {
  const pad30 = (s) => (s ?? '').padEnd(30, '<').slice(0, 30);
  if (!mrzText) return [pad30(''), pad30(''), pad30('')];
  const trimmed = mrzText.trim();
  if (trimmed.includes('\n')) {
    const lines = trimmed.split(/\r?\n/);
    return [pad30(lines[0]), pad30(lines[1]), pad30(lines[2])];
  }
  return [pad30(trimmed.slice(0, 30)), pad30(trimmed.slice(30, 60)), pad30(trimmed.slice(60, 90))];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function toDataUri(photo) {
  if (!photo?.base64) return null;
  const mime = photo.mime || 'image/jpeg';
  return `data:${mime};base64,${photo.base64}`;
}

/**
 * Derives every display value id-card.html needs from a raw scan result —
 * shared by the initial server-rendered HTML (renderIdCardHtml, below) and
 * the live IPC push electron-main.js sends to an already-open preview
 * window, so both paths always agree on what a given scan actually looks
 * like on the card.
 *
 * @param {object} scanResult - the JSON body returned by POST /scan (same
 *   shape as card-reader.js's runReadCycle result), or null/undefined for
 *   the empty (no scan yet) state.
 * @param {{docNum?: string, dob?: string, doe?: string}} [context] - the
 *   MRZ params the scan was made with (docNum/dob/doe, all YYMMDD or
 *   YYYYMMDD for dob/doe), used as a fallback wherever the chip doesn't
 *   expose the equivalent field itself — the dob used to BAC-authenticate
 *   this exact card is always known regardless of what DG11 contains.
 */
export function computeCardValues(scanResult, context = {}) {
  const personal = scanResult?.personal ?? {};
  const doc = scanResult?.document ?? {};

  const surnameRaw = personal.fullNameNational ?? null;
  const otherNameRaw = personal.otherName ?? null;
  const addressRaw = personal.permanentAddress ?? null;

  const dob = personal.dateOfBirthFull ?? personal.dateOfBirth ?? context.dob ?? null;
  const expiry = doc.endorsementsObservations ?? doc.dateOfExpiry ?? context.doe ?? null;
  const cardNumber = doc.documentNumber ?? context.docNum ?? '';
  const dateOfIssue = doc.dateOfIssue ?? deriveIssueDateFromExpiry(expiry);

  const fields = {
    CARD_NUMBER: cardNumber,
    ISSUING_AUTH: arabic(doc.issuingAuthority) ?? '',
    DATE_ISSUE: formatCardDate(dateOfIssue),
    DATE_EXPIRY: formatCardDate(expiry),
    NIN: personal.personalNumber ?? '',
    SURNAME_AR: arabic(surnameRaw) ?? '',
    FIRSTNAME_AR: arabic(otherNameRaw) ?? '',
    DOB: formatCardDate(dob),
    POB: arabic(personal.placeOfBirth) ?? '',
    GENDER_AR: genderFromRaw(addressRaw)?.label ?? '',
    BLOOD_TYPE: bloodTypeFromRaw(addressRaw) ?? '',
    SURNAME_LATIN: latin(surnameRaw) ?? '',
    FIRSTNAME_LATIN: latin(otherNameRaw) ?? '',
    BIRTH_YEAR: fourDigitYear(dob),
  };

  const [mrz1, mrz2, mrz3] = splitMrzLines(scanResult?.mrzText);
  fields.MRZ_LINE1 = mrz1;
  fields.MRZ_LINE2 = mrz2;
  fields.MRZ_LINE3 = mrz3;

  // An empty string src="" is a real pitfall on <img> — some browsers treat
  // it as "reload the current document" rather than a normal failed load,
  // so it wouldn't reliably fall through to the onerror sample-image
  // fallback. Point straight at the sample asset instead when there's no
  // real photo; onerror stays as a defensive fallback for a *malformed*
  // real data URI.
  const facePhotoSrc = toDataUri(scanResult?.facePhoto) ?? '../assets/sample-photo.png';
  const signatureSrc = toDataUri(scanResult?.signaturePhoto) ?? '../assets/sample-signature.png';

  return {
    fields,
    facePhotoSrc,
    signatureSrc,
    hasScan: Boolean(scanResult),
  };
}

/**
 * Renders id-card.html with real scan data substituted for every
 * {{PLACEHOLDER}} token — used for the page's one and only HTTP load.
 * Once loaded, further updates travel over the IPC bus (see
 * computeCardValues) instead of another render+navigation.
 */
export function renderIdCardHtml(scanResult, context = {}) {
  const { fields, facePhotoSrc, signatureSrc, hasScan } = computeCardValues(scanResult, context);

  let html = readFileSync(TEMPLATE_PATH, 'utf8');
  for (const [token, value] of Object.entries(fields)) {
    html = html.replaceAll(`{{${token}}}`, escapeHtml(value));
  }

  html = html.replaceAll('{{FACE_PHOTO_SRC}}', facePhotoSrc);
  html = html.replaceAll('{{SIGNATURE_SRC}}', signatureSrc);
  html = html.replaceAll('{{EMPTY_STATE_CLASS}}', hasScan ? '' : 'empty');

  return html;
}
