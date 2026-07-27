const { DownloadManager } = require('../src/downloadManager');
const { Store } = require('../src/store');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(__dirname, 'out2');
fs.rmSync(dir, { recursive: true, force: true });
const storePath = path.join(__dirname, 'test-store2.json');
fs.rmSync(storePath, { force: true });
const store = new Store(storePath, {});
const dm = new DownloadManager({ store, defaultDir: dir });

const url = 'https://registry.npmjs.org/typescript/-/typescript-5.5.4.tgz';
let pausedOnce = false;

(async () => {
  const id = await dm.addDownload(url, { segments: 4 });

  const timer = setInterval(() => {
    const d = dm.list().find((x) => x.id === id);
    if (!d) return;
    console.log(
      'status=%s bytes=%d/%s segsDone=%d speed=%dKB/s',
      d.status,
      d.bytesDownloaded,
      d.totalSize,
      d.segments.filter((s) => s.status === 'done').length,
      Math.round(d.speed / 1024)
    );

    // Pause partway through, then resume shortly after, to exercise resume-from-offset.
    if (!pausedOnce && d.status === 'downloading' && d.bytesDownloaded > (d.totalSize || 0) * 0.3) {
      pausedOnce = true;
      console.log('--- pausing ---');
      dm.pause(id);
      setTimeout(() => {
        console.log('--- resuming ---');
        dm.resume(id);
      }, 800);
    }

    if (d.status === 'completed' || d.status === 'error') {
      clearInterval(timer);
      dm.destroy();
      if (d.status === 'completed') {
        const full = path.join(d.dir, d.filename);
        const stat = fs.statSync(full);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        console.log('DONE size=%d expected=%d sha256=%s', stat.size, d.totalSize, hash);
        process.exit(stat.size === d.totalSize ? 0 : 1);
      } else {
        console.log('FAILED:', d.error);
        process.exit(1);
      }
    }
  }, 250);
})();
