# Gale — a Download Manager for Linux

A fast, segmented, IDM-style download manager, built with Electron. No native
compiled dependencies (no `better-sqlite3`, no `sharp`) — just Electron itself,
so `npm install` works on any Linux distro without a build toolchain.

## Features

- **Segmented (multi-connection) downloads** — splits a file into up to 16
  parallel byte-range requests and reassembles it with zero merge step
  (each segment writes directly into its own region of the final file).
- **Pause / resume** — resumes from the exact byte offset, including after
  fully quitting the app (in-progress downloads come back as "Paused").
- **Queueing** — cap on simultaneous downloads; extra adds wait in the queue.
- **Speed limiting** — an optional global cap in KB/s (token-bucket).
- **Clipboard link detection** — copy a link to an installer, archive, video,
  etc. anywhere on your system, and Gale offers to grab it.
- **Browser integration** — a bundled Chromium extension can send downloads
  straight to Gale, including via a right-click "Download with Gale" action.
- **Categories** — Compressed / Programs / Video / Music / Documents / Images.
- **Auto-retry** — a segment that errors or gets truncated (e.g. a flaky
  network, a stale keep-alive socket) is retried with backoff, and byte counts
  are verified against the expected `Content-Length` before a segment is
  ever marked done.
- **System tray** — keeps running in the background like IDM does.
- **Automatic updates** — installed releases check GitHub for new versions,
  notify the user, and offer to download and install the update.

## Requirements

- Linux, with a desktop environment (X11 or Wayland via XWayland).
- Node.js 18+ and npm.
- `yt-dlp` on your `PATH` (or in `~/.local/bin`) if you want to download from
  YouTube/Vimeo/etc. — install with `pip install --user yt-dlp`. Gale checks the
  user-local copy for updates once per day so YouTube extractor changes do not
  leave the app stuck on an old version.
  Plain HTTP(S) file downloads don't need it.

## Setup

```bash
cd gale-download-manager
npm install
npm start
```

## Building a distributable (AppImage / .deb)

```bash
npm run dist
```

Output lands in `dist/`. This uses `electron-builder`, which will download
Electron's prebuilt Linux binaries the first time you run it — make sure
you're online.

## Installing and updating Gale

The `.deb` file is Gale's system installer for Ubuntu, Debian, Linux Mint, and
other Debian-based distributions. Install it once using your desktop software
installer or:

```bash
sudo apt install ./dist/gale-download-manager_1.0.3_amd64.deb
```

After the first installed release, Gale checks the project's GitHub Releases
at startup. When a newer version is available, it shows a desktop notification,
downloads the update in the background, and offers **Restart and install**.
The final installation may request the administrator password; users do not
need to run `dpkg` manually for later updates.

### Publishing an update

The repository includes a GitHub Actions workflow that publishes a release
whenever a version tag is pushed. Update the version, commit it, and push a
matching tag:

```bash
npm version patch
git push origin main --follow-tags
```

GitHub Actions builds the AppImage and `.deb`, creates the GitHub Release, and
uploads the update metadata used by installed copies of Gale. The first
release should be tagged `v1.0.1` for this version.

## Browser integration (Chrome, Chromium, Brave, Edge)

1. Start Gale and open **Settings**.
2. Select **Open extension folder**.
3. In your browser, open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked**, then select that folder.
4. Right-click the Gale icon in your browser toolbar → **Options**.
5. Back in Gale's Settings, copy the **pairing code** and paste it into the
   options page, then **Save**. Use **Test connection** on that page to
   confirm it's paired.

The extension adds **Download with Gale** to the right-click menu for links,
audio, and video. It also sends ordinary HTTP(S) browser downloads to Gale and
cancels the browser copy only after Gale accepts the link. Logged-in or
cookie-protected downloads may still need a future cookie-aware integration.

Every request the extension makes to Gale must include the pairing code as an
`X-Gale-Token` header — Gale rejects anything else with `401`. This exists
because the loopback port (`127.0.0.1:47632`) is, on its own, reachable by any
local process, not just your browser: an `Origin` header is not something a
raw script is prevented from spoofing the way a real browser enforces it. If
you ever suspect the code has leaked, hit **Regenerate code** in Settings —
this immediately invalidates the old one, and you'll need to re-paste the new
code into the extension's options page.

## Project layout

```
main.js                 Electron main process: window, tray, IPC, clipboard watcher, updater
preload.js               contextBridge — the only surface the renderer can call into main
src/downloadManager.js   The actual download engine (segmenting, pause/resume, retries)
src/store.js             Tiny atomic JSON persistence layer (no native deps)
src/categorize.js        Extension → category mapping
renderer/                UI: index.html, styles.css, renderer.js
assets/                  App icon + tray icon (generated with scripts/make_icons.py)
test/smoke*.js           Standalone engine tests you can run with plain `node`,
                         no Electron needed — good for sanity-checking after edits
```

## How the download engine works

1. **Probe** — a ranged GET (`Range: bytes=0-0`) reveals whether the server
   supports byte ranges, the total size, and the real filename (from
   `Content-Disposition` if present).
2. **Segment** — if ranges are supported, the file is split into N
   contiguous byte ranges (N scales with file size, capped by your settings).
   The destination file is pre-sized with `ftruncate` so every segment can
   write directly to its own offset with no separate merge/concat step.
3. **Download** — each segment runs its own HTTP(S) request. Disk writes are
   serialized independently of the network socket (see the comment above
   `_downloadSegment` in `downloadManager.js`) — pausing a socket while
   waiting on a disk write turned out, during testing, to make some servers/
   proxies silently truncate the connection. Segments never share a
   keep-alive connection across a pause/resume boundary, to avoid handing a
   stale socket to a fresh request.
4. **Verify** — every segment's received byte count is checked against its
   expected range size before being marked `done`. A short read is treated
   as an error and retried, not silently accepted.
5. **Resume** — `pause()` aborts in-flight requests but keeps each segment's
   `downloaded` byte count. `resume()` (or an app restart) restarts each
   unfinished segment from `start + downloaded`.

## Notes / next steps you might want

- Segments-per-file and simultaneous-download limits are both editable from
  Settings in the app.
- The clipboard watcher polls every 1.5s and matches common download file
  extensions — tune the regex in `main.js` (`DOWNLOADABLE_RE`) if you want it
  to catch more or fewer link types.
- Browser integration works with Chromium-based browsers. Firefox support
  would need a separately packaged extension.

## Contributing

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution guidelines.
