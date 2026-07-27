const { DownloadManager } = require('../src/downloadManager');
const { Store } = require('../src/store');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(__dirname, 'out4');
fs.rmSync(dir, { recursive: true, force: true });
const storePath = path.join(__dirname, 'test-store4.json');
fs.rmSync(storePath, { force: true });
const store = new Store(storePath, {});
const dm = new DownloadManager({ store, defaultDir: dir });
// no throttling this time - test pure pause/resume correctness without long-lived slow sockets

const url = 'https://registry.npmjs.org/typescript/-/typescript-5.5.4.tgz';
let pauseCount = 0;

(async () => {
  const id = await dm.addDownload(url, { segments: 4 });
  const timer = setInterval(() => {
    const d = dm.list().find((x) => x.id === id);
    if (!d) return;
    if (pauseCount < 3 && d.status === 'downloading' && d.bytesDownloaded > 50000 * (pauseCount+1)) {
      pauseCount++;
      dm.pause(id);
      setTimeout(() => dm.resume(id), 150);
    }
    if (d.status === 'completed' || d.status === 'error') {
      clearInterval(timer);
      dm.destroy();
      if (d.status === 'completed') {
        const full = path.join(d.dir, d.filename);
        const stat = fs.statSync(full);
        const sha1 = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
        console.log('pauseCount=%d DONE size=%d expected=%d sha1=%s match=%s', pauseCount, stat.size, d.totalSize, sha1, sha1 === 'd9852d6c82bad2d2eda4fd74a5762a8f5909e9ba');
        process.exit(sha1 === 'd9852d6c82bad2d2eda4fd74a5762a8f5909e9ba' ? 0 : 1);
      } else {
        console.log('FAILED:', d.error); process.exit(1);
      }
    }
  }, 100);
})();
