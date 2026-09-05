'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const DENO_BIN = path.join(os.homedir(), '.deno', 'bin');
const YTDLP_BIN = path.join(os.homedir(), '.local', 'bin');
const YTDLP_UPDATE_MARKER = path.join(os.homedir(), '.cache', 'gale', 'yt-dlp-update-check');
const YTDLP_UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
const COOKIE_BROWSERS = new Set(['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'vivaldi']);
let updatePromise = null;

function getEnhancedPath() {
  return [DENO_BIN, YTDLP_BIN, process.env.PATH].filter(Boolean).join(':');
}

const YTDLP_URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?youtube\.com\//i,
  /^https?:\/\/youtu\.be\//i,
  /^https?:\/\/(?:www\.)?vimeo\.com\//i,
  /^https?:\/\/(?:www\.)?dailymotion\.com\//i,
  /^https?:\/\/(?:www\.)?twitch\.tv\//i,
  /^https?:\/\/(?:www\.)?facebook\.com\/.*\/videos/i,
  /^https?:\/\/(?:www\.)?instagram\.com\//i,
  /^https?:\/\/(?:www\.)?tiktok\.com\//i,
  /^https?:\/\/(?:www\.)?twitter\.com\//i,
  /^https?:\/\/(?:www\.)?x\.com\//i,
  /^https?:\/\/(?:www\.)?reddit\.com\//i,
  /^https?:\/\/streamable\.com\//i,
  /^https?:\/\/(?:www\.)?nicovideo\.jp\//i,
  /^https?:\/\/(?:www\.)?bilibili\.com\//i,
  /^https?:\/\/(?:www\.)?soundcloud\.com\//i,
  /^https?:\/\/(?:www\.)?vine\.co\//i,
  /^https?:\/\/(?:www\.)?tumblr\.com\//i,
];

function isStreamingUrl(url) {
  if (!url) return false;
  const u = url.trim();
  const directFileRe = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|exe|msi|deb|rpm|appimage|dmg|pkg|apk|iso|mp4|mkv|mov|avi|webm|mp3|flac|wav|ogg|pdf|docx?|xlsx?|pptx?|epub|txt|csv|json|xml|html|css|js|py|java|c|cpp|rs|go)(\?[^]*)?$/i;
  if (directFileRe.test(u)) return false;
  try {
    const hostname = new URL(u).hostname.toLowerCase();
    if (hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) return true;
  } catch (_) {
    return false;
  }
  return YTDLP_URL_PATTERNS.some((re) => re.test(u));
}

function findYtDlp() {
  return [path.join(YTDLP_BIN, 'yt-dlp'), 'yt-dlp', '/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp'];
}

function readUpdateMarker() {
  try {
    return Number(fs.readFileSync(YTDLP_UPDATE_MARKER, 'utf8')) || 0;
  } catch (_) {
    return 0;
  }
}

function writeUpdateMarker() {
  try {
    fs.mkdirSync(path.dirname(YTDLP_UPDATE_MARKER), { recursive: true });
    fs.writeFileSync(YTDLP_UPDATE_MARKER, String(Date.now()));
  } catch (_) {
    // A failed marker only means the next request may check again.
  }
}

async function refreshYtDlp(bin) {
  if (bin !== path.join(YTDLP_BIN, 'yt-dlp') || Date.now() - readUpdateMarker() < YTDLP_UPDATE_INTERVAL) {
    return;
  }
  if (updatePromise) return updatePromise;

  updatePromise = new Promise((resolve) => {
    execFile(bin, ['-U'], {
      timeout: 60000,
      env: { ...process.env, PATH: getEnhancedPath() },
    }, () => {
      writeUpdateMarker();
      resolve();
    });
  }).finally(() => {
    updatePromise = null;
  });
  return updatePromise;
}

function normalizeCookiesBrowser(browser) {
  const value = String(browser || '').trim().toLowerCase();
  return COOKIE_BROWSERS.has(value) ? value : null;
}

function commonYtDlpArgs(opts = {}) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--remote-components', 'ejs:github',
    '--retries', '3',
    '--fragment-retries', '3',
  ];
  const cookiesBrowser = normalizeCookiesBrowser(opts.cookiesBrowser);
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
  return args;
}

function enhanceYtDlpError(message) {
  const text = String(message || '').trim() || 'yt-dlp failed';
  if (/sign in|not a bot|captcha|cookies|age[- ]restricted|private video|members-only|http error 403|po token/i.test(text)) {
    return `${text}\n\nYouTube blocked the request. Open Gale Settings and set "YouTube cookies" to the browser where YouTube works, then retry the download. Some YouTube videos may also require a PO Token in yt-dlp.`;
  }
  return text;
}

function formatSpecForQuality(quality) {
  if (quality === 'audio') {
    return 'bestaudio[ext=m4a]/bestaudio';
  }

  const height = quality && quality !== 'best' ? parseInt(quality, 10) : 1080;
  if (Number.isFinite(height)) {
    return [
      `best[height<=${height}][ext=mp4]`,
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${height}]+bestaudio`,
      `best[height<=${height}]`,
      'best[ext=mp4]',
      'best',
    ].join('/');
  }

  return 'best[height<=1080][ext=mp4]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best[ext=mp4]/best';
}

async function checkYtDlpAvailable() {
  const candidates = findYtDlp();
  for (const bin of candidates) {
    try {
      await new Promise((resolve, reject) => {
        execFile(bin, ['--version'], { timeout: 5000, env: { ...process.env, PATH: getEnhancedPath() } }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      await refreshYtDlp(bin);
      return bin;
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function getVideoInfo(url, opts = {}) {
  const bin = await checkYtDlpAvailable();
  if (!bin) throw new Error('yt-dlp is not installed. Install it with: pip install yt-dlp');

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [
      ...commonYtDlpArgs({ ...opts, url }),
      '--dump-json',
      url,
    ], {
      timeout: 60000,
      env: { ...process.env, PATH: getEnhancedPath() },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(enhanceYtDlpError(stderr || `yt-dlp exited with code ${code}`)));
      }
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || []).map((f) => ({
          formatId: f.format_id,
          ext: f.ext,
          resolution: f.resolution || 'audio only',
          fps: f.fps || null,
          vcodec: f.vcodec || 'none',
          acodec: f.acodec || 'none',
          filesize: f.filesize || f.filesize_approx || null,
          tbr: f.tbr || null,
          note: f.format_note || '',
          quality: f.quality || '',
          hasVideo: f.vcodec !== 'none',
          hasAudio: f.acodec !== 'none',
        }));

        resolve({
          title: info.title || 'Untitled',
          thumbnail: info.thumbnail || null,
          duration: info.duration || null,
          uploader: info.uploader || null,
          webpageUrl: info.webpage_url || url,
          formats,
        });
      } catch (e) {
        reject(new Error(enhanceYtDlpError(`Failed to parse yt-dlp output: ${e.message}`)));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(enhanceYtDlpError(`Failed to run yt-dlp: ${err.message}`)));
    });
  });
}

function downloadVideo(url, opts = {}) {
  const {
    outputDir,
    outputFilename,
    quality,
    cookiesBrowser,
  } = opts;

  const emitter = new EventEmitter();
  let proc = null;
  let cancelled = false;

  const emitter_api = {
    kill: () => {
      cancelled = true;
      if (proc) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (proc) proc.kill('SIGKILL'); }, 3000);
      }
    },
    process: null,
  };

  (async () => {
    const bin = await checkYtDlpAvailable();
    if (!bin) {
      emitter.emit('error', new Error('yt-dlp is not installed. Install it with: pip install yt-dlp'));
      return;
    }

    const formatSpec = formatSpecForQuality(quality);

    const safeName = outputFilename
      ? outputFilename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\- ]/g, '_')
      : '%(title)s';
    const outputTemplate = path.join(outputDir || '.', `${safeName}.%(ext)s`);

    const args = [
      ...commonYtDlpArgs({ cookiesBrowser, url }),
      '--newline',
      '--progress',
      '-f', formatSpec,
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      '--continue',
      '--part',
      '--no-overwrites',
      url,
    ];

    proc = spawn(bin, args, {
      timeout: 0,
      env: { ...process.env, PATH: getEnhancedPath() },
    });
    emitter_api.process = proc;

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      if (cancelled) return;
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
        if (destMatch) {
          emitter.emit('destination', destMatch[1].trim());
          continue;
        }

        const alreadyMatch = line.match(/\[download\]\s+(.+)\s+has already been downloaded/);
        if (alreadyMatch) {
          emitter.emit('destination', alreadyMatch[1].trim());
          continue;
        }

        if (line.includes('[Merger]') || line.includes('Merging')) {
          emitter.emit('merging', true);
          continue;
        }

        const pctMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (pctMatch) {
          const percent = parseFloat(pctMatch[1]);
          const speedMatch = line.match(/at\s+([\d.]+\S*\/s)/);
          const etaMatch = line.match(/ETA\s+(\S+)/);
          const sizeMatch = line.match(/of\s+~?([\d.]+\S*)/);
          emitter.emit('progress', {
            percent,
            speed: speedMatch ? speedMatch[1] : '',
            eta: etaMatch ? etaMatch[1] : '',
            totalSize: sizeMatch ? sizeMatch[1] : '',
          });
          continue;
        }

        if (line.includes('[download] 100%')) {
          emitter.emit('progress', {
            percent: 100,
            speed: '',
            eta: '',
            totalSize: '',
          });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (cancelled) return;
      if (code === 0) {
        emitter.emit('done', { success: true });
      } else {
        emitter.emit('error', new Error(enhanceYtDlpError(stderr || `yt-dlp exited with code ${code}`)));
      }
    });

    proc.on('error', (err) => {
      if (!cancelled) emitter.emit('error', new Error(enhanceYtDlpError(err.message)));
    });
  })();

  return { emitter, api: emitter_api };
}

module.exports = {
  isStreamingUrl,
  checkYtDlpAvailable,
  getVideoInfo,
  downloadVideo,
};
