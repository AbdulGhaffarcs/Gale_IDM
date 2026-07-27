const { DownloadManager } = require('../src/downloadManager');
const { Store } = require('../src/store');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, 'out');
fs.rmSync(dir, { recursive: true, force: true });
const store = new Store(path.join(__dirname, 'test-store.json'), {});
const dm = new DownloadManager({ store, defaultDir: dir });

dm.on('update', (id) => {
  const d = dm.list().find((x) => x.id === id);
  console.log('[update]', id, d.status, d.totalSize, d.acceptsRanges, d.segments.length, d.error || '');
});

(async () => {
  const url = 'https://raw.githubusercontent.com/torvalds/linux/master/README';
  const id = await dm.addDownload(url, { segments: 4 });

  const timer = setInterval(() => {
    const d = dm.list().find((x) => x.id === id);
    if (!d) return;
    console.log('progress', d.bytesDownloaded, '/', d.totalSize, 'speed', Math.round(d.speed), 'status', d.status);
    if (d.status === 'completed' || d.status === 'error') {
      clearInterval(timer);
      dm.destroy();
      if (d.status === 'completed') {
        const full = path.join(d.dir, d.filename);
        const stat = fs.statSync(full);
        console.log('DONE. file size on disk =', stat.size, 'expected =', d.totalSize);
        process.exit(stat.size === d.totalSize ? 0 : 1);
      } else {
        console.log('FAILED:', d.error);
        process.exit(1);
      }
    }
  }, 300);
})();
