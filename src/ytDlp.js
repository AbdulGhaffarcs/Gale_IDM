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

function hostnameOf(url) {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isYouTubeUrl(url) {
  const hostname = hostnameOf(url);
  return hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
}

function isStreamingUrl(url) {
  if (!url) return false;
  const u = url.trim();
  const directFileRe = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|exe|msi|deb|rpm|appimage|dmg|pkg|apk|iso|mp4|mkv|mov|avi|webm|mp3|flac|wav|ogg|pdf|docx?|xlsx?|pptx?|epub|txt|csv|json|xml|html|css|js|py|java|c|cpp|rs|go)(\?[^]*)?$/i;
  if (directFileRe.test(u)) return false;
  if (!hostnameOf(u)) return false;
  if (isYouTubeUrl(u)) return true;
  return YTDLP_URL_PATTERNS.some((re) => re.test(u));
}

/**
 * Ordered `player_client` values tried for YouTube downloads.
 *
 * YouTube's default (unqualified) client set frequently yields metadata fine but
 * hands back media URLs that are rejected with `HTTP Error 403: Forbidden`, so
 * relying on it makes every YouTube download fail. Naming a client explicitly
 * avoids that. Which clients work rotates over time - some get throttled, some
 * start requiring a PO token - so `downloadVideo` walks this list and retries on
 * the next entry whenever a run fails. `null` means "no --extractor-args", i.e.
 * let yt-dlp pick, which is kept as the last resort.
 *
 * The high-resolution clients (web_embedded / *_creator) are preferred because
 * they still expose 1080p+ streams, while mweb / tv_simply / web are the
 * dependable-but-360p-only fallbacks.
 */
const YOUTUBE_CLIENT_ATTEMPTS = [
  'web_embedded',
  'mweb',
  'tv_simply',
  'web',
  'android_vr',
  'android_creator',
  'ios_creator',
  null,
];

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

function commonYtDlpArgs(opts = {}) {
  const args = [
    '--no-warnings',
    '--remote-components', 'ejs:github',
    '--retries', '3',
    '--fragment-retries', '3',
  ];
  // Only YouTube needs a pinned player client; passing --extractor-args for
  // other extractors can break sites that do not define that option.
  const { url, playerClient, noPlaylist = true } = opts;
  if (noPlaylist) args.splice(1, 0, '--no-playlist');
  if (playerClient && isYouTubeUrl(url)) {
    args.push('--extractor-args', `youtube:player_client=${playerClient}`);
  }
  return args;
}

function enhanceYtDlpError(message) {
  const text = String(message || '').trim() || 'yt-dlp failed';
  if (/sign in|not a bot|captcha|age[- ]restricted|private video|members-only|http error 403|po token/i.test(text)) {
    return `${text}\n\nYouTube blocked this request. Try updating yt-dlp and verify that the video is public and available in your region.`;
  }
  return text;
}

/**
 * Failures that another player client cannot fix, so retrying them would just
 * make the user wait through every client before seeing the real reason.
 * Deliberately narrow: 403s, bot checks and throttling are all retryable.
 */
function isPermanentYtDlpError(text) {
  return /private video|this video has been removed|video unavailable|account associated with this video has been terminated|unsupported url|incomplete youtube id|not available in your country|geo[- ]?restricted|drm|paid member|members[- ]only|confirm your age|age[- ]restricted/i.test(
    String(text || '')
  );
}

function formatSpecForQuality(quality) {
  if (quality === 'audio') {
    return 'bestaudio[ext=m4a]/bestaudio';
  }

  const height = quality && quality !== 'best' ? parseInt(quality, 10) : null;
  if (Number.isFinite(height)) {
    return [
      `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
      `best[height<=${height}]`,
      'best',
    ].join('/');
  }

  return 'bestvideo+bestaudio/best';
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

/**
 * Resolve a YouTube playlist without fetching media.  The returned entries use
 * plain watch URLs so each queued item is downloaded as one video, rather than
 * re-expanding the playlist when its turn begins.
 */
async function getPlaylistInfo(url) {
  if (!isYouTubeUrl(url)) throw new Error('Playlist downloads are available for YouTube URLs only.');
  const bin = await checkYtDlpAvailable();
  if (!bin) throw new Error('yt-dlp is not installed. Install it with: pip install yt-dlp');

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [
      ...commonYtDlpArgs({ url, noPlaylist: false }),
      '--flat-playlist',
      '--dump-single-json',
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
      if (code !== 0) return reject(new Error(enhanceYtDlpError(stderr || `yt-dlp exited with code ${code}`)));
      try {
        const info = JSON.parse(stdout);
        const entries = (info.entries || []).map((entry, index) => {
          const id = entry.id || '';
          const watchUrl = entry.webpage_url || (id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : null);
          return { index: entry.playlist_index || index + 1, title: entry.title || `Video ${index + 1}`, url: watchUrl };
        }).filter((entry) => entry.url);
        if (!entries.length) throw new Error('This playlist has no downloadable videos.');
        resolve({ title: info.title || 'YouTube Playlist', entries });
      } catch (err) {
        reject(new Error(enhanceYtDlpError(`Failed to parse playlist information: ${err.message}`)));
      }
    });
    proc.on('error', (err) => reject(new Error(enhanceYtDlpError(`Failed to run yt-dlp: ${err.message}`))));
  });
}

function downloadVideo(url, opts = {}) {
  const {
    outputDir,
    outputFilename,
    quality,
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

    // Non-YouTube extractors keep yt-dlp's own client selection.
    const attempts = isYouTubeUrl(url) ? YOUTUBE_CLIENT_ATTEMPTS : [null];

    /** Spawn one yt-dlp run and resolve with its exit code. */
    const runOnce = (playerClient) => new Promise((resolve) => {
      const args = [
        ...commonYtDlpArgs({ url, playerClient }),
        '--newline',
        '--progress',
        '-f', formatSpec,
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
      let settled = false;
      let spawnFailed = false;

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
            // When yt-dlp downloads a video-only and an audio-only stream it
            // first reports each *intermediate* file as the destination, then
            // merges them into the real output and deletes the intermediates.
            // The merge target is the only path that survives on disk, so it has
            // to be the destination we report last - otherwise the download row
            // points at a file that no longer exists.
            const mergeMatch = line.match(/^\[Merger\]\s*Merging formats into\s+"(.+)"\s*$/);
            if (mergeMatch) emitter.emit('destination', mergeMatch[1].trim());
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

      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (proc && !proc.killed) proc = null;
        emitter_api.process = null;
        resolve({ code, stderr, spawnFailed });
      };

      proc.on('close', (code) => finish(code));
      proc.on('error', (err) => {
        stderr += err.message;
        // The binary vanished or is not executable - no client choice helps.
        spawnFailed = true;
        finish(null);
      });
    });

    let lastError = null;
    for (const playerClient of attempts) {
      if (cancelled) return;
      const { code, stderr, spawnFailed } = await runOnce(playerClient);
      if (cancelled) return;
      if (code === 0) {
        emitter.emit('done', { success: true });
        return;
      }
      lastError = new Error(enhanceYtDlpError(stderr || `yt-dlp exited with code ${code}`));
      if (spawnFailed) break;
      if (isPermanentYtDlpError(stderr)) break;
      // Retry the next client. --continue resumes any bytes already fetched, and
      // the destination is fixed by the output template, so retrying is cheap.
    }
    emitter.emit('error', lastError || new Error('yt-dlp failed'));
  })();

  return { emitter, api: emitter_api };
}

module.exports = {
  isStreamingUrl,
  isYouTubeUrl,
  checkYtDlpAvailable,
  getVideoInfo,
  getPlaylistInfo,
  downloadVideo,
};
