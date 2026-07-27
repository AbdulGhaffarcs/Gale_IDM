'use strict';
const path = require('path');

const CATEGORY_MAP = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
  Programs: ['exe', 'msi', 'deb', 'rpm', 'appimage', 'run', 'sh', 'apk', 'dmg', 'pkg'],
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'],
  Music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'odt'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff'],
};

function categorize(filename) {
  const ext = path.extname(filename || '').replace('.', '').toLowerCase();
  for (const [category, exts] of Object.entries(CATEGORY_MAP)) {
    if (exts.includes(ext)) return category;
  }
  return 'Other';
}

module.exports = { categorize, CATEGORY_MAP };
