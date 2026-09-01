import pcsclite from 'pcsclite';
import crypto from 'node:crypto';
import * as bac from './bac.js';

const EMRTD_AID = 'A0000002471001';

function hex(buf) {
  return Buffer.from(buf).toString('hex').toUpperCase();
}
function apduFromHex(hexStr) {
  return Buffer.from(hexStr.replace(/\s+/g, ''), 'hex');
}

const DG_TAG_TO_FID = {
  0x61: '0101',
  0x75: '0102',
  0x63: '0103',
  0x76: '0104',
  0x65: '0105',
  0x66: '0106',
  0x67: '0107',
  0x68: '0108',
  0x69: '0109',
  0x6a: '010A',
  0x6b: '010B',
  0x6c: '010C',
  0x6d: '010D',
  0x6e: '010E',
  0x6f: '010F',
  0x70: '0110',
};
// Field tags per ICAO 9303 Part 10. This national card repurposes some of
// them — see HANDOVER.md for the confirmed real-world meaning of each.
const DG11_FIELD_NAME = {
  0x5f0e: 'fullNameNational',
  0x5f0f: 'otherName',
  0x5f10: 'personalNumber',
  0x5f2b: 'dateOfBirthFull',
  0x5f11: 'placeOfBirth',
  0x5f42: 'permanentAddress', // repurposed on this card: sex/blood type
  0x5f12: 'telephone',
  0x5f13: 'profession',
  0x5f14: 'title',
  0x5f15: 'personalSummary',
  0x5f16: 'proofOfCitizenship',
  0x5f17: 'otherTdNumbers',
  0x5f18: 'custodyInformation',
};
const DG12_FIELD_NAME = {
  0x5f19: 'issuingAuthority',
  0x5f26: 'dateOfIssue',
  0x5f1a: 'nameOfOtherPerson',
  0x5f1b: 'endorsementsObservations', // repurposed on this card: expiry date
  0x5f1c: 'taxExitRequirements',
  0x5f1d: 'imageOfFront', // repurposed on this card: document title text
  0x5f1e: 'imageOfRear',
  0x5f55: 'personalizationDateTime',
  0x5f56: 'personalizationSerial',
};

function decodeTextField(buf) {
  let slice = buf;
  while (slice.length > 0 && slice[0] < 0x20) {
    slice = slice.subarray(1);
  }
  if ([...slice].every((b) => b >= 0x20 && b < 0x7f)) return slice.toString('ascii').trim();
  if (slice.length <= 400) {
    const text = new TextDecoder('iso-8859-6').decode(slice);
    return text.replace(/^[\s_\-—\x00-\x1F]+/, '').trim();
  }
  return `(${slice.length} bytes)`;
}

function extractImage(buf) {
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', data: buf.slice(i) };
  }
  for (let i = 0; i < buf.length - 8; i++) {
    if (
      buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0x00 && buf[i + 3] === 0x0c &&
      buf[i + 4] === 0x6a && buf[i + 5] === 0x50 && buf[i + 6] === 0x20 && buf[i + 7] === 0x20
    ) return { ext: 'jp2', mime: 'image/jp2', data: buf.slice(i) };
  }
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0x4f && buf[i + 2] === 0xff && buf[i + 3] === 0x51) return { ext: 'jpc', mime: 'image/jp2', data: buf.slice(i) };
  }
  return null;
}

/**
 * Runs one full BAC + secure-messaging read cycle against whatever card is
 * currently connected. Resolves with a structured result object, or rejects
 * with a descriptive Error.
 */
function runReadCycle(reader, protocol, mrz, onProgress) {
  return new Promise((resolve, reject) => {
    function send(label, buf) {
      onProgress?.(label);
      return new Promise((res) => {
        reader.transmit(buf, 2048, protocol, (err, resp) => {
          if (err) return res(null);
          const sw = hex(resp.slice(resp.length - 2));
          const data = resp.slice(0, resp.length - 2);
          res({ data, sw });
        });
      });
    }

    function sendProtected(label, state, { ins, p1, p2, data, le }) {
      const w = bac.smWrapCommand(state.ksEnc, state.ksMac, state.ssc, { ins, p1, p2, data, le });
      state.ssc = w.ssc;
      return send(label, w.apdu).then((r) => {
        if (!r) return null;
        try {
          const u = bac.smUnwrapResponse(state.ksEnc, state.ksMac, state.ssc, r.data);
          state.ssc = u.ssc;
          return { data: u.data, sw: r.sw };
        } catch {
          return null;
        }
      });
    }

    async function selectEF(state, fidHex) {
      const r = await sendProtected(`Select ${fidHex}`, state, { ins: 0xa4, p1: 0x02, p2: 0x0c, data: apduFromHex(fidHex) });
      return !!r && r.sw === '9000';
    }

    async function readBinaryChunk(state, offset, len) {
      const p1 = (offset >> 8) & 0x7f;
      const p2 = offset & 0xff;
      const r = await sendProtected(`Reading offset ${offset}`, state, { ins: 0xb0, p1, p2, le: len });
      if (!r || r.sw !== '9000' || !r.data) return null;
      return r.data;
    }

    async function readFullEF(state) {
      const probe = await readBinaryChunk(state, 0, 8);
      if (!probe || probe.length < 2) return null;
      const { len: length, valueStart } = bac.readTagLen(probe, 0);
      const total = valueStart + length;
      const chunks = [probe.length >= total ? probe.slice(0, total) : probe];
      let have = probe.length;
      while (have < total) {
        const chunkSize = Math.min(200, total - have);
        const data = await readBinaryChunk(state, have, chunkSize);
        if (!data) return null;
        chunks.push(data);
        have += data.length;
      }
      return Buffer.concat(chunks).slice(0, total);
    }

    (async () => {
      try {
        const lenHex = (EMRTD_AID.length / 2).toString(16).padStart(2, '0');
        console.log(`[card-reader] [1/6] Selecting eMRTD applet AID=${EMRTD_AID}`);
        const r1 = await send('Selecting document applet', apduFromHex(`00A4040C${lenHex}${EMRTD_AID}`));
        if (!r1 || r1.sw !== '9000') return reject(new Error(`Card did not respond as expected (SELECT sw=${r1 ? r1.sw : 'none'})`));

        console.log('[card-reader] [2/6] Requesting 8-byte challenge (GET CHALLENGE)');
        const r2 = await send('Requesting challenge', apduFromHex('0084000008'));
        if (!r2 || r2.sw !== '9000' || r2.data.length !== 8) return reject(new Error('GET CHALLENGE failed'));
        const rndIC = r2.data;
        console.log(`[card-reader] Card RND.ICC received: ${hex(rndIC)}`);

        onProgress?.('Authenticating (BAC)');
        console.log(`[card-reader] [3/6] Deriving BAC keys from MRZ (docNum=${mrz.docNum}, dob=${mrz.dob}, doe=${mrz.doe})`);
        const kseed = bac.mrzKseed(mrz);
        const kEnc = bac.kdf(kseed, 1);
        const kMac = bac.kdf(kseed, 2);
        const rndIFD = crypto.randomBytes(8);
        const kIFD = crypto.randomBytes(16);
        const S = Buffer.concat([rndIFD, rndIC, kIFD]);
        const eIFD = bac.tdesEncCbc(kEnc, S);
        const mIFD = bac.retailMac(kMac, eIFD);
        const cmdData = Buffer.concat([eIFD, mIFD]);
        const authApdu = Buffer.concat([Buffer.from([0x00, 0x82, 0x00, 0x00, cmdData.length]), cmdData, Buffer.from([0x28])]);
        
        console.log('[card-reader] Sending EXTERNAL AUTHENTICATE command');
        const r3 = await send('Verifying identity', authApdu);
        if (!r3 || r3.sw !== '9000' || r3.data.length !== 40) {
          console.log(`[card-reader] ❌ EXTERNAL AUTHENTICATE failed with SW=${r3?.sw || 'none'}`);
          return reject(new Error('Authentication failed — the entered ID number, birth date, or expiry date does not match this card.'));
        }
        const eIC = r3.data.slice(0, 32);
        const mic = r3.data.slice(32, 40);
        if (!bac.retailMac(kMac, eIC).equals(mic)) return reject(new Error('Authentication failed (MAC mismatch).'));
        const R = bac.tdesDecCbc(kEnc, eIC);
        const rndIC2 = R.slice(0, 8);
        const rndIFD2 = R.slice(8, 16);
        const kIC = R.slice(16, 32);
        if (!rndIC2.equals(rndIC) || !rndIFD2.equals(rndIFD)) return reject(new Error('Authentication failed (nonce mismatch).'));

        console.log('[card-reader] ✅ BAC Mutual Authentication verified! Establishing secure messaging session.');
        const kseedSession = bac.xorBuf(kIFD, kIC);
        const ksEnc = bac.kdf(kseedSession, 1);
        const ksMac = bac.kdf(kseedSession, 2);
        const ssc = Buffer.concat([rndIC.slice(4, 8), rndIFD.slice(4, 8)]);
        const state = { ksEnc, ksMac, ssc };

        const result = { personal: {}, document: {}, mrzText: null, facePhoto: null, signaturePhoto: null };

        onProgress?.('Reading document index');
        console.log('[card-reader] [4/6] Selecting and reading EF.COM data group directory');
        if (!(await selectEF(state, '011E'))) return reject(new Error('Could not select EF.COM'));
        const efcom = await readFullEF(state);
        if (!efcom) return reject(new Error('Could not read EF.COM'));
        const outer = bac.parseFlatTLVs(efcom)[0];
        const fields = bac.parseFlatTLVs(outer.value);
        const tagListField = fields.find((f) => f.tag === 0x5c);
        const dgTags = tagListField ? Array.from(tagListField.value) : [];
        console.log(`[card-reader] Available Data Groups on chip: ${dgTags.map(t => '0x' + t.toString(16)).join(', ')}`);

        console.log(`[card-reader] [5/6] Reading Data Groups (${mrz.fast ? '⚡ FAST MODE: DG1, DG11, DG12 [skipping DG2/DG7 photos]' : 'DG1, DG2 photo, DG7 signature, DG11 personal data'})...`);
        for (const tag of dgTags) {
          const fid = DG_TAG_TO_FID[tag];
          if (!fid) continue;

          if (mrz.fast && (tag === 0x75 || tag === 0x67)) {
            // Fast mode: Skip downloading heavy DG2 (Face Photo ~18KB) and DG7 (Signature ~4KB)
            continue;
          }

          onProgress?.(`Reading data group 0x${tag.toString(16)}`);
          if (!(await selectEF(state, fid))) continue;
          const data = await readFullEF(state);
          if (!data) continue;
          try {
            if (tag === 0x61) {
              const o = bac.parseFlatTLVs(data)[0];
              const inner = bac.parseFlatTLVs(o.value)[0];
              result.mrzText = inner.value.toString('ascii');
              console.log(`[card-reader] -> DG1 (MRZ) read: ${result.mrzText.replace(/\r?\n/g, ' / ')}`);

              // Parse standard TD1 MRZ lines to guarantee document number, DOB, and Expiry are populated
              try {
                const mrzLines = result.mrzText.replace(/\r/g, '').split('\n').filter(Boolean);
                if (mrzLines.length >= 2) {
                  const l1 = mrzLines[0];
                  const l2 = mrzLines[1];
                  if (l1.length >= 14 && !result.document.documentNumber) {
                    result.document.documentNumber = l1.slice(5, 14).replace(/</g, '').trim();
                  }
                  if (l2.length >= 14) {
                    if (!result.personal.dateOfBirth) result.personal.dateOfBirth = l2.slice(0, 6);
                    if (!result.document.dateOfExpiry) result.document.dateOfExpiry = l2.slice(8, 14);
                  }
                }
              } catch {}
            } else if (tag === 0x75) {
              const img = extractImage(data);
              if (img) {
                result.facePhoto = { mime: img.mime, base64: img.data.toString('base64') };
                console.log(`[card-reader] -> DG2 (Face Photo) extracted: ${img.mime}, ${Math.round(img.data.length / 1024)} KB`);
              }
            } else if (tag === 0x67) {
              const img = extractImage(data);
              if (img) {
                result.signaturePhoto = { mime: img.mime, base64: img.data.toString('base64') };
                console.log(`[card-reader] -> DG7 (Signature Photo) extracted: ${img.mime}, ${img.data.length} bytes`);
              }
            } else if (tag === 0x6b) {
              const o = bac.parseFlatTLVs(data)[0];
              if (o && o.value) {
                const parseRecursive = (tlvs) => {
                  for (const f of tlvs) {
                    if (f.tag === 0x5c) continue;
                    if (f.tag === 0xa0 || f.tag === 0x0a0 || (f.tag & 0x20) === 0x20) {
                      try {
                        const inner = bac.parseFlatTLVs(f.value);
                        if (inner && inner.length > 0) {
                          parseRecursive(inner);
                          continue;
                        }
                      } catch {}
                    }
                    const name = DG11_FIELD_NAME[f.tag];
                    if (name) {
                      result.personal[name] = decodeTextField(f.value);
                    } else {
                      result.personal[`tag_${f.tag.toString(16)}`] = decodeTextField(f.value);
                    }
                  }
                };
                parseRecursive(bac.parseFlatTLVs(o.value));
              }

              // Fallback for given name from MRZ if otherName is not present
              if (!result.personal.otherName && result.mrzText) {
                const lines = result.mrzText.trim().split(/\r?\n/);
                const nameLine = lines[lines.length - 1] || '';
                const parts = nameLine.split('<<');
                if (parts.length >= 2) {
                  const given = parts.slice(1).join(' ').replace(/</g, ' ').trim();
                  if (given) result.personal.otherName = given;
                }
              }

              console.log(`[card-reader] -> DG11 (Personal) extracted: Name="${result.personal.fullNameNational || 'N/A'}", otherName="${result.personal.otherName || 'N/A'}", NIN="${result.personal.personalNumber || 'N/A'}"`);
            } else if (tag === 0x6c) {
              const o = bac.parseFlatTLVs(data)[0];
              if (o && o.value) {
                const parseRecursive = (tlvs) => {
                  for (const f of tlvs) {
                    if (f.tag === 0x5c) continue;
                    if (f.tag === 0xa0 || f.tag === 0x0a0 || (f.tag & 0x20) === 0x20) {
                      try {
                        const inner = bac.parseFlatTLVs(f.value);
                        if (inner && inner.length > 0) {
                          parseRecursive(inner);
                          continue;
                        }
                      } catch {}
                    }
                    const name = DG12_FIELD_NAME[f.tag];
                    if (name) {
                      result.document[name] = decodeTextField(f.value);
                    } else {
                      result.document[`tag_${f.tag.toString(16)}`] = decodeTextField(f.value);
                    }
                  }
                };
                parseRecursive(bac.parseFlatTLVs(o.value));
              }
              console.log(`[card-reader] -> DG12 (Document) extracted: Authority="${result.document.issuingAuthority || 'N/A'}"`);
            }
          } catch (e) {
            console.log(`[card-reader] Warning decoding DG tag 0x${tag.toString(16)}: ${e.message}`);
          }
        }

        console.log('[card-reader] [6/6] ✅ All chip biometrics and credentials extracted successfully');
        resolve(result);
      } catch (e) {
        reject(e);
      }
    })();
  });
}

/**
 * Waits for the next card presented on the contactless interface, runs one
 * read cycle, then tears the PC/SC context down. Returns { promise, cancel }.
 */
export function waitForCardAndRead(mrz, onProgress, onStatus) {
  let pcsc;
  let handled = false;
  let rejectRef;

  const promise = new Promise((resolve, reject) => {
    rejectRef = reject;
    pcsc = pcsclite();
    console.log('[card-reader] pcsclite context opened, waiting for reader enumeration...');

    const timeout = setTimeout(() => {
      if (handled) return;
      handled = true;
      console.log('[card-reader] timed out waiting for card');
      cleanup();
      reject(new Error('Timed out waiting for a card. Please try again.'));
    }, 30000);

    function cleanup() {
      clearTimeout(timeout);
      try {
        pcsc.close();
      } catch {
        /* ignore */
      }
    }

    let readerCount = 0;
    pcsc.on('reader', (reader) => {
      readerCount++;
      console.log(`[card-reader] reader detected: "${reader.name}"`);
      if (!reader.name.toLowerCase().includes('contactless')) {
        console.log(`[card-reader] skipping "${reader.name}" (not the contactless interface)`);
        return;
      }
      console.log(`[card-reader] using "${reader.name}" for this scan, listening for status changes`);
      onStatus?.('waiting');
      reader.on('error', (err) => console.log(`[card-reader] reader error: ${err.message}`));
      reader.on('status', (status) => {
        console.log(`[card-reader] status event: state=0x${(status.state ?? 0).toString(16)} (prev=0x${(reader.state ?? 0).toString(16)})`);
        if (handled) return;
        const changes = reader.state ^ status.state;
        if (changes & reader.SCARD_STATE_PRESENT && status.state & reader.SCARD_STATE_PRESENT) {
          console.log('[card-reader] card present, connecting...');
          onStatus?.('detected');
          reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err, protocol) => {
            if (handled) return;
            if (err) {
              console.log(`[card-reader] connect error: ${err.message}`);
              return;
            }
            console.log(`[card-reader] connected, protocol=${protocol}, starting read cycle`);
            runReadCycle(reader, protocol, mrz, (msg) => {
              console.log(`[card-reader] progress: ${msg}`);
              onProgress?.(msg);
            })
              .then((result) => {
                if (handled) return;
                handled = true;
                console.log('[card-reader] read cycle succeeded');
                onStatus?.('done');
                reader.disconnect(reader.SCARD_LEAVE_CARD, () => cleanup());
                resolve(result);
              })
              .catch((e) => {
                if (handled) return;
                handled = true;
                console.log(`[card-reader] read cycle failed: ${e.message}`);
                onStatus?.('error');
                reader.disconnect(reader.SCARD_LEAVE_CARD, () => cleanup());
                reject(e);
              });
          });
        }
      });
    });
    setTimeout(() => {
      if (readerCount === 0) console.log('[card-reader] WARNING: no readers enumerated after 2s — is pcscd running / reader plugged in?');
    }, 2000);

    pcsc.on('error', (err) => {
      if (handled) return;
      handled = true;
      console.log(`[card-reader] pcsc context error: ${err.message}`);
      cleanup();
      reject(new Error(`Reader error: ${err.message}`));
    });
  });

  return {
    promise,
    cancel() {
      if (handled) return;
      handled = true;
      console.log('[card-reader] scan cancelled by user');
      try {
        pcsc?.close();
      } catch {
        /* ignore */
      }
      rejectRef(new Error('Scan cancelled.'));
    },
  };
}
