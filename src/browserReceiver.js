'use strict';

const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 47632;
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_HEADER = 'x-gale-token';

function isExtensionOrigin(origin) {
  // Do not let ordinary websites use the loopback server as a download trigger.
  // Note: this only checks the Origin header's *shape*, not a specific extension
  // ID - a raw local script can set any header it likes. The pairing token below
  // is the real access control; this is a shallow first filter on top of it.
  return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function sendJson(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Constant-time token comparison so a wrong guess can't be timed byte-by-byte. */
function tokensMatch(supplied, expected) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // keep roughly constant-time even on length mismatch
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {(url: string, opts: object) => Promise<string>} onDownload
 * @param {() => string|null} getToken - reads the current pairing token from the store
 */
function startBrowserReceiver(onDownload, getToken) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!isExtensionOrigin(origin)) return sendJson(res, 403, { error: 'Browser extension origin required' }, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || 'null',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
        Vary: 'Origin',
      });
      return res.end();
    }

    // Unauthenticated health/pairing check: only reveals that Gale is running and
    // whether the caller's current token (if any) is accepted - no download side
    // effects, so it's safe to leave open. Lets the extension's options page show
    // "Paired" / "Not paired" without risking a real download.
    if (req.method === 'GET' && req.url === '/status') {
      const expected = getToken();
      const supplied = req.headers[TOKEN_HEADER];
      return sendJson(res, 200, { running: true, paired: !!expected && tokensMatch(supplied, expected) }, origin);
    }

    if (req.method !== 'POST' || req.url !== '/download') return sendJson(res, 404, { error: 'Not found' }, origin);

    const expected = getToken();
    const supplied = req.headers[TOKEN_HEADER];
    if (!expected || !tokensMatch(supplied, expected)) {
      return sendJson(
        res,
        401,
        { error: 'Missing or invalid pairing code. Open the Gale extension options and pair it with the code shown in Gale > Settings.' },
        origin
      );
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('error', () => {});
    req.on('end', async () => {
      if (raw.length > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'Request is too large' }, origin);
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { return sendJson(res, 400, { error: 'Invalid JSON' }, origin); }
      if (!payload || typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)) {
        return sendJson(res, 400, { error: 'A valid http(s) URL is required' }, origin);
      }
      try {
        const id = await onDownload(payload.url, {
          filename: typeof payload.filename === 'string' ? payload.filename : undefined,
          quality: typeof payload.quality === 'string' ? payload.quality : undefined,
        });
        return sendJson(res, 202, { id }, origin);
      } catch (err) {
        return sendJson(res, 500, { error: err.message || 'Could not add download' }, origin);
      }
    });
  });

  server.listen(PORT, HOST);
  server.on('error', (err) => console.error(`Gale browser receiver: ${err.message}`));
  return server;
}

module.exports = { startBrowserReceiver, HOST, PORT };
