'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const DENO_BIN = path.join(os.homedir(), '.deno', 'bin');
const YTDLP_BIN = path.join(os.homedir(), '.local', 'bin');

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
  return YTDLP_URL_PATTERNS.some((re) => re.test(u));
}

function findYtDlp() {
  return ['yt-dlp', '/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp', path.join(YTDLP_BIN, 'yt-dlp')];
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
      return bin;
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function getVideoInfo(url) {
  const bin = await checkYtDlpAvailable();
  if (!bin) throw new Error('yt-dlp is not installed. Install it with: pip install yt-dlp');

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [
      '--no-warnings',
      '--dump-json',
      '--no-playlist',
      '--remote-components', 'ejs:github',
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
        return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
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
        reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run yt-dlp: ${err.message}`));
    });
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

    let formatSpec = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === 'audio') {
      formatSpec = 'bestaudio[ext=m4a]/bestaudio';
    } else if (quality && quality !== 'best') {
      const h = parseInt(quality, 10);
      if (Number.isFinite(h)) {
        formatSpec = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
      }
    }

    const safeName = outputFilename
      ? outputFilename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\- ]/g, '_')
      : '%(title)s';
    const outputTemplate = path.join(outputDir || '.', `${safeName}.%(ext)s`);

    const args = [
      '--no-warnings',
      '--no-playlist',
      '--newline',
      '--progress',
      '--remote-components', 'ejs:github',
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
        emitter.emit('error', new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (!cancelled) emitter.emit('error', err);
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
