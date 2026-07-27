const { DownloadManager } = require('../src/downloadManager');
const { Store } = require('../src/store');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(__dirname, 'out3');
fs.rmSync(dir, { recursive: true, force: true });
const storePath = path.join(__dirname, 'test-store3.json');
fs.rmSync(storePath, { force: true });
const store = new Store(storePath, {});
const dm = new DownloadManager({ store, defaultDir: dir });
dm.saveSettings({ speedLimitKBs: 300 }); // throttle so we can actually catch it mid-flight

const url = 'https://registry.npmjs.org/typescript/-/typescript-5.5.4.tgz';
let pausedOnce = false;
let resumedAt = 0;

(async () => {
  const id = await dm.addDownload(url, { segments: 4 });
  const timer = setInterval(() => {
    const d = dm.list().find((x) => x.id === id);
    if (!d) return;
    console.log('status=%s bytes=%d/%s speed=%dKB/s', d.status, d.bytesDownloaded, d.totalSize, Math.round(d.speed/1024));
    if (!pausedOnce && d.status === 'downloading' && d.bytesDownloaded > (d.totalSize||0)*0.25) {
      pausedOnce = true;
      console.log('--- PAUSE at', d.bytesDownloaded, '---');
      dm.pause(id);
      setTimeout(() => { console.log('--- RESUME ---'); resumedAt = d.bytesDownloaded; dm.resume(id); }, 1000);
    }
    if (d.status === 'completed' || d.status === 'error') {
      clearInterval(timer);
      dm.destroy();
      if (d.status === 'completed') {
        const full = path.join(d.dir, d.filename);
        const stat = fs.statSync(full);
        const sha1 = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
        console.log('SEGMENTS', JSON.stringify(d.segments));
        console.log('DONE size=%d expected=%d sha1=%s pausedResumed=%s', stat.size, d.totalSize, sha1, pausedOnce);
        process.exit(stat.size === d.totalSize && sha1 === 'd9852d6c82bad2d2eda4fd74a5762a8f5909e9ba' ? 0 : 1);
      } else {
        console.log('FAILED:', d.error); process.exit(1);
      }
    }
  }, 200);
})();
