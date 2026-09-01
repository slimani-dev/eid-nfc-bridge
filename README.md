# eID NFC Bridge

A small desktop app that reads an ICAO 9303 biometric identity card (eMRTD chip — the kind used in modern national ID cards and passports) over a USB contactless/NFC reader, performs BAC (Basic Access Control) authentication against the MRZ printed on the card, and exposes the decrypted chip data to a local client application over HTTP.

It exists to bridge the gap between PC/SC smart card hardware and browser-based or web-backed applications, which have no direct way to talk to a card reader.

## This app does not store your data

**eID NFC Bridge does not save, log, or transmit anywhere any personal data read from a card.** Everything a scan produces (name, date of birth, ID number, face photo, signature, MRZ, etc.) lives only in memory for the duration of the app's process and is discarded the moment you close it, clear the scan, or restart the app. There is no database, no file written to disk containing card data, and no network call other than the one you point the app at yourself (a local client on `127.0.0.1`). The only thing this app ever writes to disk is a tiny local preferences file (whether it should start automatically with your system) — never anything from a scanned card.

This matters under Algerian law: **Loi n° 18-07 du 10 juin 2018 relative à la protection des personnes physiques dans le traitement des données à caractère personnel** (Law No. 18-07 of 10 June 2018 on the protection of individuals with regard to the processing of personal data) governs how personal data — including biometric and identity-document data — may be collected, processed, and retained in Algeria. This tool is built to stay out of scope of that obligation entirely by never retaining the data it reads in the first place.

## How it works

1. The app runs quietly in the system tray and starts a local HTTP server on `http://127.0.0.1:4319`.
2. A client application (yours) sends the card's printed MRZ credentials (document number, date of birth, date of expiry) to `POST /scan`.
3. The app waits for a card to be placed on the reader, performs BAC authentication using those credentials, and reads the requested data groups from the chip (MRZ, personal data, portrait, signature).
4. The decrypted result is returned directly in the HTTP response — and nowhere else.
5. An optional preview window (opened manually from the tray menu) can show a live visual replica of the card as it's read, purely for the person operating the reader to see what was scanned.

No data is queued, cached to disk, or kept once the response has been sent and the preview window is closed.

## Requirements

- Windows or Linux
- A PC/SC-compatible USB contactless smart card reader (e.g. ACR122U, ACR1252U, or similar)
- The physical ID card to be scanned must support BAC (ICAO 9303 eMRTD)

## Install

Download the latest installer for your platform from the [Releases](../../releases) page:

- **Windows** — `eID NFC Bridge Setup.exe`
- **Linux (Debian/Ubuntu-based)** — the `.deb` package (`sudo apt install ./eid-nfc-bridge_*.deb` or double-click in your file manager)

On first launch the app adds a tray icon and starts listening on `127.0.0.1:4319`. Right-click the tray icon for Preview, Manual Scan, and start-on-login options.

## HTTP API

All endpoints are served from `http://127.0.0.1:4319` and are only reachable from the local machine.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check and current scan status |
| `POST` | `/scan` | Start a scan; body: `{ "docNum", "dob", "doe", "fast"? }` (dates as `YYMMDD`) |
| `DELETE` | `/scan` | Cancel an in-progress scan |
| `GET` | `/scan/last-mrz` | Returns the MRZ credentials from the most recent scan attempt (for pre-filling a retry) |
| `GET` | `/preview` | HTML visual replica of the most recent successful scan |
| `POST` | `/preview/clear` | Clears the in-memory scan the preview is showing |

## Building from source

```bash
npm install
npm start          # run the Electron app
npm run start:headless   # run just the HTTP server (no Electron/tray), useful for development
npm run dist:win   # build the Windows installer (electron-builder)
npm run dist:linux # build the Linux .deb package (electron-builder)
```

A physical PC/SC reader and `pcsclite` are required for real scans; `electron-rebuild` runs automatically before `npm start` to rebuild the native `pcsclite` binding against Electron's Node ABI.
