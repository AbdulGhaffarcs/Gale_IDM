'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { categorize } = require('./categorize');
const { isStreamingUrl, getVideoInfo, downloadVideo } = require('./ytDlp');

const MAX_REDIRECTS = 8;
const MAX_RETRIES = 4;
const DEFAULT_MAX_SEGMENTS = 8;
const MIN_SEGMENT_SIZE = 1024 * 1024; // don't split below 1MB per segment

function pickAgent(u) {
  return u.protocol === 'https:' ? https : http;
}

function contentDispositionFilename(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/["']/g, '')); } catch (_) { /* fallthrough */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain) return plain[1].trim();
  return null;
}

function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname);
    return base && base !== '/' ? decodeURIComponent(base) : 'download';
  } catch (_) {
    return 'download';
  }
}

function uniqueId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Simple token-bucket throttle shared across active transfers. */
class SpeedLimiter {
  constructor() {
    this.bytesPerSec = 0; // 0 = unlimited
    this.tokens = 0;
    this.lastRefill = Date.now();
  }
  setLimit(bytesPerSec) {
    this.bytesPerSec = bytesPerSec || 0;
    this.tokens = this.bytesPerSec;
    this.lastRefill = Date.now();
  }
  async consume(n) {
    if (!this.bytesPerSec) return; // unlimited
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      if (elapsed > 0) {
        this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsed * this.bytesPerSec);
        this.lastRefill = now;
      }
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const need = n - this.tokens;
      const waitMs = Math.max(10, Math.min(250, (need / this.bytesPerSec) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Low-level HTTP(S) request with manual redirect handling. Resolves with the response object. */
function rawRequest(urlStr, { method = 'GET', headers = {}, signal } = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    const agent = pickAgent(u);
    const req = agent.request(
      u,
      {
        method,
        // Never reuse a pooled keep-alive socket: after an abort() (pause), a stale
        // socket can be handed back to a later request and yield a silently
        // truncated response. A fresh connection per request avoids that entirely.
        agent: false,
        headers: {
          'User-Agent': 'Gale/1.0 (Linux; Download Manager)',
          ...headers,
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // discard body
          const next = new URL(res.headers.location, u).toString();
          resolve(rawRequest(next, { method, headers, signal }, redirectCount + 1));
          return;
        }
        resolve({ res, finalUrl: u.toString() });
      }
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}

/** Probe a URL for size / range support / filename without downloading the body. */
async function probeUrl(urlStr) {
  const { res, finalUrl } = await rawRequest(urlStr, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
  });
  res.destroy();
  const filename =
    contentDispositionFilename(res.headers['content-disposition']) || filenameFromUrl(finalUrl);
  let totalSize = null;
  let acceptsRanges = res.statusCode === 206;
  const cr = res.headers['content-range'];
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) totalSize = parseInt(m[1], 10);
  }
  if (totalSize == null && res.headers['content-length']) {
    totalSize = parseInt(res.headers['content-length'], 10);
    if (res.statusCode === 200) acceptsRanges = res.headers['accept-ranges'] === 'bytes';
  }
  return {
    finalUrl,
    filename,
    totalSize: Number.isFinite(totalSize) ? totalSize : null,
    acceptsRanges,
    contentType: res.headers['content-type'] || null,
  };
}

function computeSegmentCount(totalSize, requested, cap) {
  if (!totalSize) return 1;
  const byCap = Math.max(1, Math.min(cap, requested || DEFAULT_MAX_SEGMENTS));
  const bySize = Math.max(1, Math.floor(totalSize / MIN_SEGMENT_SIZE));
  return Math.max(1, Math.min(byCap, bySize));
}

class DownloadManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {string} opts.defaultDir
   */
  constructor({ store, defaultDir }) {
    super();
    this.store = store;
    this.defaultDir = defaultDir;
    this.downloads = new Map(); // id -> download record (serializable parts only, plus runtime handles)
    this.limiter = new SpeedLimiter();
    this.settings = Object.assign(
      {
        maxConcurrent: 3,
        maxSegments: DEFAULT_MAX_SEGMENTS,
        speedLimitKBs: 0,
        downloadDir: defaultDir,
        clipboardMonitor: true,
        askSaveLocation: false,
        ytdlpCookiesBrowser: '',
      },
      this.store.get('settings', {})
    );
    this.limiter.setLimit(this.settings.speedLimitKBs ? this.settings.speedLimitKBs * 1024 : 0);

    this._restore();
    this._tickTimer = setInterval(() => this._tick(), 500);
    this._autosaveTimer = setInterval(() => this.persist(), 2000);
  }

  // ---------- persistence ----------

  _restore() {
    const saved = this.store.get('downloads', []);
    for (const d of saved) {
      // Anything that was mid-flight when the app last closed comes back as paused.
      if (d.status === 'downloading' || d.status === 'queued') d.status = 'paused';
      d.controllers = [];
      d.speed = 0;
      d._speedSamples = [];
      d.ytDlpApi = null;
      d._fd = null;
      d._merging = false;
      d._speedStr = '';
      d._etaStr = '';
      this.downloads.set(d.id, d);
    }
  }

  persist() {
    const serializable = [...this.downloads.values()].map((d) => this._strip(d));
    this.store.set('downloads', serializable);
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.store.set('settings', this.settings);
    if ('speedLimitKBs' in patch) {
      this.limiter.setLimit(this.settings.speedLimitKBs ? this.settings.speedLimitKBs * 1024 : 0);
    }
    if (this.settings.maxConcurrent) this._scheduleNext();
  }

  _strip(d) {
    const { controllers, _speedSamples, ytDlpApi, _fd, ...rest } = d;
    return rest;
  }

  list() {
    return [...this.downloads.values()].map((d) => this._strip(d));
  }

  // ---------- public API ----------

  async addDownload(url, opts = {}) {
    const id = uniqueId();
    const record = {
      id,
      url,
      filename: opts.filename || null,
      dir: opts.dir || this.settings.downloadDir,
      status: 'probing',
      totalSize: null,
      acceptsRanges: false,
      category: 'Other',
      segments: [],
      bytesDownloaded: 0,
      speed: 0,
      _speedSamples: [],
      error: null,
      addedAt: Date.now(),
      completedAt: null,
      requestedSegments: opts.segments || this.settings.maxSegments,
      controllers: [],
      isStreaming: false,
      ytDlpApi: null,
      quality: opts.quality || null,
      cookiesBrowser: opts.cookiesBrowser || null,
    };
    this.downloads.set(id, record);
    this.emit('update', id);

    if (isStreamingUrl(url)) {
      try {
        const info = await getVideoInfo(url, {
          cookiesBrowser: opts.cookiesBrowser || this.settings.ytdlpCookiesBrowser,
        });
        const filename = this._uniqueFilename(record.dir, opts.filename || `${info.title}.mp4`);
        record.filename = filename;
        record.totalSize = null;
        record.acceptsRanges = false;
        record.category = categorize(filename);
        record.isStreaming = true;
        record.title = info.title;
        record.status = 'queued';
      } catch (err) {
        record.status = 'error';
        record.error = `Could not get video info: ${err.message}`;
      }
    } else {
      try {
        const info = await probeUrl(url);
        record.filename = this._uniqueFilename(record.dir, opts.filename || info.filename);
        record.totalSize = info.totalSize;
        record.acceptsRanges = info.acceptsRanges && info.totalSize != null;
        record.category = categorize(record.filename);
        record.status = 'queued';
      } catch (err) {
        record.status = 'error';
        record.error = `Could not reach URL: ${err.message}`;
      }
    }

    this.emit('update', id);
    this.persist();
    this._scheduleNext();
    return id;
  }

  _safeFilename(filename) {
    // `filename` may come from a remote server's Content-Disposition header, or
    // from the browser-extension loopback receiver (which any local process can
    // reach). Neither is trusted: take the basename only, and drop any residual
    // ".." segments, so a crafted "../../etc/x" can never escape `dir`.
    return path.basename(String(filename || 'download').replace(/[\\/]+/g, '_'))
      .replace(/^\.+/, '')
      .trim() || 'download';
  }

  _uniqueFilename(dir, filename) {
    const safe = this._safeFilename(filename);
    let target = path.join(dir, safe);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(target)) return safe;
    const ext = path.extname(safe);
    const base = path.basename(safe, ext);
    let n = 1;
    while (fs.existsSync(path.join(dir, `${base} (${n})${ext}`))) n += 1;
    return `${base} (${n})${ext}`;
  }

  pause(id) {
    const d = this.downloads.get(id);
    if (!d || (d.status !== 'downloading' && d.status !== 'queued')) return;
    d.status = 'paused';
    if (d.isStreaming && d.ytDlpApi) {
      d.ytDlpApi.kill();
      d.ytDlpApi = null;
    } else {
      for (const c of d.controllers) c.abort();
      d.controllers = [];
    }
    d._merging = false;
    d._speedStr = '';
    d._etaStr = '';
    d.speed = 0;
    this.emit('update', id);
    this.persist();
    this._scheduleNext();
  }

  resume(id) {
    const d = this.downloads.get(id);
    if (!d || !['paused', 'error'].includes(d.status)) return;
    d.error = null;
    d.completedAt = null;
    d._merging = false;
    d._speedStr = '';
    d._etaStr = '';
    d.speed = 0;
    d._speedSamples = [];
    d.status = 'queued';
    this.emit('update', id);
    this.persist();
    this._scheduleNext();
  }

  remove(id, deleteFile = false) {
    const d = this.downloads.get(id);
    if (!d) return;
    if (d.isStreaming && d.ytDlpApi) {
      d.ytDlpApi.kill();
      d.ytDlpApi = null;
    } else {
      for (const c of d.controllers) c.abort();
    }
    if (deleteFile && d.filename) {
      const full = path.join(d.dir, d.filename);
      fs.rm(full, { force: true }, () => {});
    }
    this.downloads.delete(id);
    this.emit('update', id);
    this.persist();
    this._scheduleNext();
  }

  clearCompleted() {
    for (const [id, d] of this.downloads) {
      if (d.status === 'completed') this.downloads.delete(id);
    }
    this.emit('bulk-update');
    this.persist();
  }

  // ---------- scheduling ----------

  _scheduleNext() {
    const active = [...this.downloads.values()].filter((d) => d.status === 'downloading').length;
    const slots = this.settings.maxConcurrent - active;
    if (slots <= 0) return;
    const queued = [...this.downloads.values()]
      .filter((d) => d.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt)
      .slice(0, slots);
    for (const d of queued) this._start(d);
  }

  async _start(record) {
    record.status = 'downloading';
    this.emit('update', record.id);

    if (record.isStreaming) {
      this._startYtDlp(record);
      return;
    }

    const full = path.join(record.dir, record.filename);

    if (!record.segments.length) {
      const n = record.acceptsRanges
        ? computeSegmentCount(record.totalSize, record.requestedSegments, this.settings.maxSegments)
        : 1;
      record.segments = this._buildSegments(record.totalSize, n);
    }

    try {
      if (!fs.existsSync(record.dir)) fs.mkdirSync(record.dir, { recursive: true });
      if (!record.acceptsRanges && record.segments.some((seg) => seg.downloaded > 0 || seg.status === 'done')) {
        record.segments = this._buildSegments(record.totalSize, 1);
        record.bytesDownloaded = 0;
        record.speed = 0;
        record._speedSamples = [];
      }
      const openMode = record.acceptsRanges && fs.existsSync(full) ? 'r+' : 'w+';
      const fd = fs.openSync(full, openMode);
      if (record.totalSize) {
        try { fs.ftruncateSync(fd, record.totalSize); } catch (_) { /* some fs don't support sparse resize; ignore */ }
      }
      record._fd = fd;
    } catch (err) {
      record.status = 'error';
      record.error = `Cannot open file: ${err.message}`;
      this.emit('update', record.id);
      this._scheduleNext();
      return;
    }

    const jobs = record.segments.map((seg, idx) => this._downloadSegment(record, seg, idx));
    Promise.allSettled(jobs).then(() => this._finalize(record));
  }

  _startYtDlp(record) {
    record._merging = false;
    record._speedStr = '';
    record._etaStr = '';
    record._speedSamples = [];
    const { emitter, api } = downloadVideo(record.url, {
      format: 'best',
      outputDir: record.dir,
      outputFilename: record.filename ? path.parse(record.filename).name : undefined,
      quality: record.quality || 'best',
      cookiesBrowser: record.cookiesBrowser || this.settings.ytdlpCookiesBrowser,
    });
    record.ytDlpApi = api;

    emitter.on('progress', (p) => {
      if (record.status !== 'downloading') return;
      const pct = p.percent || 0;
      record.bytesDownloaded = pct;
      record.totalSize = 100;
      record.speed = 0;
      // Store speed string for display
      record._speedStr = p.speed || '';
      record._etaStr = p.eta || '';
      this.emit('update', record.id);
    });

    emitter.on('destination', (dest) => {
      const filename = path.basename(dest);
      record.filename = this._safeFilename(filename);
      record.category = categorize(record.filename);
      this.emit('update', record.id);
    });

    emitter.on('merging', () => {
      record._merging = true;
      this.emit('update', record.id);
    });

    emitter.on('done', () => {
      record.status = 'completed';
      record.completedAt = Date.now();
      record.speed = 0;
      record.bytesDownloaded = 100;
      record.totalSize = 100;
      record.ytDlpApi = null;
      record._merging = false;
      record._speedStr = '';
      record._etaStr = '';
      this.emit('update', record.id);
      this.persist();
      this._scheduleNext();
    });

    emitter.on('error', (err) => {
      if (record.status !== 'downloading') return;
      record.status = 'error';
      record.error = `yt-dlp error: ${err.message}`;
      record.ytDlpApi = null;
      record._merging = false;
      record._speedStr = '';
      record._etaStr = '';
      this.emit('update', record.id);
      this.persist();
      this._scheduleNext();
    });
  }

  _buildSegments(totalSize, n) {
    if (!totalSize || n <= 1) {
      return [{ start: 0, end: totalSize ? totalSize - 1 : null, downloaded: 0, status: 'pending' }];
    }
    const chunk = Math.floor(totalSize / n);
    const segs = [];
    for (let i = 0; i < n; i += 1) {
      const start = i * chunk;
      const end = i === n - 1 ? totalSize - 1 : start + chunk - 1;
      segs.push({ start, end, downloaded: 0, status: 'pending' });
    }
    return segs;
  }

  async _downloadSegment(record, seg, idx) {
    if (seg.status === 'done') return;
    let attempt = 0;
    for (;;) {
      if (record.status !== 'downloading') return; // paused/removed mid-flight
      const controller = new AbortController();
      record.controllers[idx] = controller;
      const useRange = record.acceptsRanges && seg.end != null;
      const startAt = useRange ? seg.start + seg.downloaded : seg.start;
      if (seg.end != null && startAt > seg.end) { seg.status = 'done'; return; }

      try {
        const headers = useRange ? { Range: `bytes=${startAt}-${seg.end}` } : {};
        const { res } = await rawRequest(record.url, { headers, signal: controller.signal });
        if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
        if (useRange && res.statusCode !== 206) throw new Error('Server did not honor the resume range request');

        let position = startAt;
        let received = 0;
        let writeError = null;
        let pendingWrites = 0;
        const contentLength = Number.parseInt(res.headers['content-length'], 10);
        const expected = useRange
          ? seg.end - startAt + 1
          : (Number.isFinite(contentLength) ? contentLength : record.totalSize);
        const writeAt = (chunk, at) =>
          new Promise((res2, rej2) => {
            fs.write(record._fd, chunk, 0, chunk.length, at, (err) => (err ? rej2(err) : res2()));
          });

        await new Promise((resolve, reject) => {
          let writeChain = Promise.resolve();
          let ended = false;

          const maybeFinish = () => {
            if (!ended || pendingWrites > 0) return;
            if (writeError) { reject(writeError); return; }
            if (expected != null && received !== expected) {
              seg.downloaded -= received;
              record.bytesDownloaded = record.segments.reduce((s, sg) => s + sg.downloaded, 0);
              reject(new Error(`Truncated response: got ${received} of ${expected} bytes`));
              return;
            }
            resolve();
          };

          res.on('data', (chunk) => {
            const chunkStart = position;
            position += chunk.length;
            received += chunk.length;
            pendingWrites += 1;

            // IMPORTANT: never pause the socket while a disk write is in flight -
            // fs writes go through libuv's thread pool and can lag noticeably
            // behind the network. Pausing the response for that long has been
            // observed to make the remote/proxy end the connection early,
            // producing a *silently* truncated response. Disk writes are instead
            // serialized off the network flow entirely via this chain.
            writeChain = writeChain
              .then(() => writeAt(chunk, chunkStart))
              .then(() => {
                seg.downloaded += chunk.length;
                record.bytesDownloaded = record.segments.reduce((s, sg) => s + sg.downloaded, 0);
              })
              .catch((err) => { writeError = writeError || err; })
              .finally(() => {
                pendingWrites -= 1;
                maybeFinish();
              });

            // Lightweight safety valve: only if the disk falls far behind the
            // network do we briefly pause, to bound memory - not on every chunk.
            if (pendingWrites > 64 && !res.isPaused()) {
              res.pause();
              writeChain.then(() => { if (pendingWrites <= 16) res.resume(); });
            }

            // Speed limiting is handled as a short, bounded pause based purely on
            // the token bucket - never on disk-write completion (see above).
            if (this.limiter.bytesPerSec > 0 && !res.isPaused()) {
              res.pause();
              this.limiter.consume(chunk.length).then(() => res.resume());
            }
          });
          res.on('end', () => { ended = true; maybeFinish(); });
          res.on('error', reject);
        });

        seg.status = 'done';
        return;
      } catch (err) {
        if (record.status !== 'downloading') return; // this was a deliberate pause/abort
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          record.status = 'error';
          record.error = `Segment failed after ${MAX_RETRIES} retries: ${err.message}`;
          this.emit('update', record.id);
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
  }

  _finalize(record) {
    if (record._fd != null) {
      try { fs.closeSync(record._fd); } catch (_) { /* noop */ }
      record._fd = null;
    }
    record.controllers = [];
    if (record.status !== 'downloading') {
      // Was paused, removed, or errored mid-flight; state already reflects that.
      this.persist();
      this._scheduleNext();
      return;
    }
    const allDone = record.segments.every((s) => s.status === 'done');
    if (allDone) {
      record.status = 'completed';
      record.completedAt = Date.now();
      record.speed = 0;
    } else {
      record.status = 'error';
      record.error = record.error || 'Download did not complete';
    }
    this.emit('update', record.id);
    this.persist();
    this._scheduleNext();
  }

  // ---------- speed / UI tick ----------

  _tick() {
    const now = Date.now();
    let changed = false;
    for (const d of this.downloads.values()) {
      if (d.status !== 'downloading') continue;
      d._speedSamples.push({ t: now, b: d.bytesDownloaded });
      d._speedSamples = d._speedSamples.filter((s) => now - s.t <= 3000);
      if (d._speedSamples.length >= 2) {
        const first = d._speedSamples[0];
        const last = d._speedSamples[d._speedSamples.length - 1];
        const dt = (last.t - first.t) / 1000;
        d.speed = dt > 0 ? (last.b - first.b) / dt : 0;
      }
      changed = true;
    }
    if (changed) this.emit('tick', this.list());
  }

  destroy() {
    clearInterval(this._tickTimer);
    clearInterval(this._autosaveTimer);
  }
}

module.exports = { DownloadManager, probeUrl, isStreamingUrl };
