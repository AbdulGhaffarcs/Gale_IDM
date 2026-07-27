'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Minimal atomic JSON store. No native deps, no compile step -
 * keeps the app trivially installable on any Linux distro.
 */
class Store {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = defaults;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = { ...this.data, ...JSON.parse(raw) };
      }
    } catch (err) {
      // Corrupt store file - back it up and start fresh rather than crash the app.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch (_) { /* ignore */ }
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}

module.exports = { Store };
