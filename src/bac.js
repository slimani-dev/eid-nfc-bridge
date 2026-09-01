import crypto from 'node:crypto';

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest();
}

function adjustParity(byte) {
  let b = byte & 0xfe;
  let ones = 0;
  for (let i = 1; i < 8; i++) if ((b >> i) & 1) ones++;
  return ones % 2 === 0 ? b | 1 : b;
}

function adjustParityBuf(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = adjustParity(buf[i]);
  return out;
}

// Returns 16-byte key material Ka||Kb (parity-adjusted), per ICAO 9303 Appendix D KDF.
export function kdf(kseed, counter) {
  const d = Buffer.concat([kseed, Buffer.from([0, 0, 0, counter])]);
  const h = sha1(d);
  const ka = adjustParityBuf(h.slice(0, 8));
  const kb = adjustParityBuf(h.slice(8, 16));
  return Buffer.concat([ka, kb]);
}

// Expand 16-byte (Ka|Kb) into a 24-byte 3DES key (Ka|Kb|Ka) for Node's des-ede3-cbc.
function to3des(key16) {
  return Buffer.concat([key16.slice(0, 8), key16.slice(8, 16), key16.slice(0, 8)]);
}

function tripleDesCbc(key16, iv, data, encrypt) {
  const key24 = to3des(key16);
  const cipher = encrypt
    ? crypto.createCipheriv('des-ede3-cbc', key24, iv)
    : crypto.createDecipheriv('des-ede3-cbc', key24, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

const ZERO_IV = Buffer.alloc(8, 0);

export function tdesEncCbc(key16, data, iv = ZERO_IV) {
  return tripleDesCbc(key16, iv, data, true);
}
export function tdesDecCbc(key16, data, iv = ZERO_IV) {
  return tripleDesCbc(key16, iv, data, false);
}

// ISO/IEC 9797-1 padding method 2: append 0x80 then zero-pad to a multiple of 8.
export function isoPad(data) {
  const padLen = 8 - (data.length % 8);
  return Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc(padLen - 1, 0)]);
}

function singleDesEncryptBlock(ka8, block8) {
  const key16 = Buffer.concat([ka8, ka8]);
  return tdesEncCbc(key16, block8);
}

function singleDesDecryptBlock(k8, block8) {
  const key16 = Buffer.concat([k8, k8]);
  return tdesDecCbc(key16, block8);
}

// Retail MAC (ISO/IEC 9797-1 MAC algorithm 3). Finishing step is E_Ka(D_Kb(Hn)).
export function retailMac(key16, data) {
  const padded = isoPad(data);
  const ka = key16.slice(0, 8);
  const kb = key16.slice(8, 16);
  const singleDesKey16 = Buffer.concat([ka, ka]);
  const cbc = tdesEncCbc(singleDesKey16, padded);
  const hn = cbc.slice(cbc.length - 8);
  const decrypted = singleDesDecryptBlock(kb, hn);
  return singleDesEncryptBlock(ka, decrypted);
}

export function checkDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    let v;
    if (c === '<') v = 0;
    else if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
    else v = c.charCodeAt(0) - 65 + 10;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

export function mrzKseed({ docNum, dob, doe }) {
  const docNumPadded = docNum.padEnd(9, '<');
  const info =
    docNumPadded +
    String(checkDigit(docNumPadded)) +
    dob +
    String(checkDigit(dob)) +
    doe +
    String(checkDigit(doe));
  return sha1(Buffer.from(info, 'ascii')).slice(0, 16);
}

export function xorBuf(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

// --- Secure Messaging (post-BAC) ---

export function incSSC(ssc) {
  const out = Buffer.from(ssc);
  for (let i = 7; i >= 0; i--) {
    out[i] = (out[i] + 1) & 0xff;
    if (out[i] !== 0) break;
  }
  return out;
}

function berReadLen(buf, offset) {
  const first = buf[offset];
  if (first < 0x80) return { length: first, headerLen: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i];
  return { length, headerLen: 1 + numBytes };
}

function berEncodeLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

export function readTagLen(buf, off) {
  let tag = buf[off];
  off += 1;
  if ((tag & 0x1f) === 0x1f) {
    let b;
    do {
      b = buf[off];
      tag = (tag << 8) | b;
      off += 1;
    } while (b & 0x80);
  }
  const first = buf[off];
  off += 1;
  let len;
  if (first < 0x80) {
    len = first;
  } else {
    const nb = first & 0x7f;
    len = 0;
    for (let i = 0; i < nb; i++) {
      len = (len << 8) | buf[off];
      off += 1;
    }
  }
  return { tag, len, valueStart: off };
}

export function parseFlatTLVs(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const { tag, len, valueStart } = readTagLen(buf, off);
    out.push({ tag, value: buf.slice(valueStart, valueStart + len) });
    off = valueStart + len;
  }
  return out;
}

function parseTLVs(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const tag = buf[off];
    off += 1;
    const { length, headerLen } = berReadLen(buf, off);
    off += headerLen;
    out.push({ tag, value: buf.slice(off, off + length) });
    off += length;
  }
  return out;
}

export function smWrapCommand(ksEnc, ksMac, ssc, { cla = 0x00, ins, p1, p2, data, le }) {
  const clam = cla | 0x0c;
  const header = isoPad(Buffer.from([clam, ins, p1, p2]));
  let do87 = Buffer.alloc(0);
  if (data && data.length) {
    const enc = tdesEncCbc(ksEnc, isoPad(data));
    const val = Buffer.concat([Buffer.from([0x01]), enc]);
    do87 = Buffer.concat([Buffer.from([0x87]), berEncodeLen(val.length), val]);
  }
  let do97 = Buffer.alloc(0);
  if (le !== undefined && le !== null) {
    do97 = Buffer.from([0x97, 0x01, le]);
  }
  const M = Buffer.concat([header, do87, do97]);
  const newSsc = incSSC(ssc);
  const N = Buffer.concat([newSsc, M]);
  const cc = retailMac(ksMac, N);
  const do8e = Buffer.concat([Buffer.from([0x8e, 0x08]), cc]);
  const body = Buffer.concat([do87, do97, do8e]);
  const apdu = Buffer.concat([Buffer.from([clam, ins, p1, p2, body.length]), body, Buffer.from([0x00])]);
  return { apdu, ssc: newSsc };
}

export function smUnwrapResponse(ksEnc, ksMac, ssc, respData) {
  const newSsc = incSSC(ssc);
  const tlvs = parseTLVs(respData);
  const do87 = tlvs.find((t) => t.tag === 0x87);
  const do99 = tlvs.find((t) => t.tag === 0x99);
  const do8e = tlvs.find((t) => t.tag === 0x8e);
  if (!do99 || !do8e) throw new Error('Malformed SM response (missing DO99/DO8E)');
  const macParts = [];
  if (do87) macParts.push(Buffer.concat([Buffer.from([0x87]), berEncodeLen(do87.value.length), do87.value]));
  macParts.push(Buffer.concat([Buffer.from([0x99]), berEncodeLen(do99.value.length), do99.value]));
  const K = Buffer.concat([newSsc, ...macParts]);
  const cc = retailMac(ksMac, K);
  if (!cc.equals(do8e.value)) throw new Error('SM MAC verification failed');
  let data = null;
  if (do87) {
    if (do87.value[0] !== 0x01) throw new Error(`Unexpected DO87 padding indicator 0x${do87.value[0].toString(16)}`);
    const dec = tdesDecCbc(ksEnc, do87.value.slice(1));
    let end = dec.length;
    while (end > 0 && dec[end - 1] === 0x00) end--;
    if (dec[end - 1] !== 0x80) throw new Error('Bad ISO padding on decrypted SM data');
    data = dec.slice(0, end - 1);
  }
  return { data, ssc: newSsc };
}
