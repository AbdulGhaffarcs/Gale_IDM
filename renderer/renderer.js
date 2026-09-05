'use strict';

const state = {
  downloads: [],
  category: '__all',
  search: '',
  selected: new Set(),
  sortKey: 'addedAt',
  sortDir: 'desc',
};

const el = (id) => document.getElementById(id);
const tableBody = el('table-body');
const emptyState = el('empty-state');
const popupState = {
  dismissed: false,
  minimized: false,
  knownIds: new Set(),
};

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  return `${fmtBytes(bps)}/s`;
}

function timeLeftSeconds(d) {
  if (d.status !== 'downloading' || !d.speed || !d.totalSize) return null;
  const remaining = d.totalSize - d.bytesDownloaded;
  const secs = remaining / d.speed;
  return Number.isFinite(secs) && secs >= 0 ? secs : null;
}

function fmtTimeLeft(d) {
  if (d.isStreaming && d._etaStr && d.status === 'downloading') return d._etaStr;
  const secs = timeLeftSeconds(d);
  if (secs == null) return '—';
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const CATEGORY_META = {
  Images: { label: 'Image', color: '#5eb2d1', icon: '<path fill="currentColor" d="M5 5h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zm2 12l4-5 3 3.5L17 10l3 7H7z"/>' },
  Music: { label: 'Music', color: '#f28cb0', icon: '<path fill="currentColor" d="M9 18a3 3 0 11-2-2.83V4l10-2v11.17A3 3 0 1115 16V6l-6 1.2z"/>' },
  Video: { label: 'Video', color: '#b48af0', icon: '<path fill="currentColor" d="M4 6a1 1 0 011-1h9a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6zm12 3.5l5-3v11l-5-3v-5z"/>' },
  Programs: { label: 'Program', color: '#7fd88f', icon: '<path fill="currentColor" d="M5 5h5v5H5V5zm9 0h5v5h-5V5zM5 14h5v5H5v-5zm9 0h5v5h-5v-5z"/>' },
  Documents: { label: 'Document', color: '#eec168', icon: '<path fill="currentColor" d="M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5z"/>' },
  Compressed: { label: 'Archive', color: '#d1a5f0', icon: '<path fill="currentColor" d="M12 2a2 2 0 012 2v1h-4V4a2 2 0 012-2zm-2 5h4v2h-4V7zm0 4h4v2h-4v-2zM6 13h12v7a2 2 0 01-2 2H8a2 2 0 01-2-2v-7z"/>' },
  Other: { label: 'Other', color: '#8a8f9c', icon: '<path fill="currentColor" d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5 8v8l7 3.7 7-3.7V8l-7-3.7z"/>' },
};

function categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.Other;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function matchesCategory(d, cat) {
  if (cat === '__all') return true;
  if (cat === '__finished') return d.status === 'completed';
  if (cat === '__unfinished') return d.status !== 'completed';
  return d.category === cat;
}

function updateCounts() {
  const counts = { __all: state.downloads.length, __finished: 0, __unfinished: 0 };
  for (const d of state.downloads) {
    if (d.status === 'completed') counts.__finished += 1;
    else counts.__unfinished += 1;
    counts[d.category] = (counts[d.category] || 0) + 1;
  }
  document.querySelectorAll('.nav-count').forEach((elm) => {
    const key = elm.dataset.count;
    elm.textContent = counts[key] || 0;
  });
  el('dash-total').textContent = counts.__all;
  el('dash-finished').textContent = counts.__finished;
}

function updateStatusBar() {
  const active = state.downloads.filter((d) => d.status === 'downloading').length;
  const queued = state.downloads.filter((d) => d.status === 'queued').length;
  const totalSpeed = state.downloads.reduce((s, d) => s + (d.status === 'downloading' ? d.speed : 0), 0);
  const speedText = fmtSpeed(totalSpeed) === '—' ? '0 KB/s' : fmtSpeed(totalSpeed);
  el('status-summary').textContent = `${active} active · ${queued} queued`;
  el('status-speed').lastChild.textContent = speedText;
  el('status-selected').lastChild.textContent = String(state.selected.size);
  el('dash-active').textContent = active;
  el('dash-queued').textContent = queued;
  el('dash-speed').textContent = speedText;
}

function sortValue(d, key) {
  if (key === 'eta') return timeLeftSeconds(d) ?? Infinity;
  if (key === 'speed') return d.status === 'downloading' ? d.speed || 0 : -1;
  if (key === 'filename') return (d.filename || '').toLowerCase();
  if (key === 'status') return d.status || '';
  return d[key] ?? 0;
}

function sortDownloads(list) {
  const { sortKey, sortDir } = state;
  const mult = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function statusText(status, pct) {
  if (status === 'downloading') return `Downloading ${pct}%`;
  if (status === 'paused') return `Paused ${pct}%`;
  if (status === 'probing') return 'Resolving…';
  if (status === 'queued') return 'Queued';
  if (status === 'completed') return 'Finished';
  if (status === 'error') return 'Error';
  return status;
}

function progressPercent(d) {
  return d.totalSize
    ? Math.min(100, Math.round((d.bytesDownloaded / d.totalSize) * 100))
    : (d.status === 'completed' ? 100 : 0);
}

function statusLabel(d, pct = progressPercent(d)) {
  return d._merging && d.status === 'downloading' ? 'Merging…' : statusText(d.status, pct);
}

function errorSummary(error) {
  return String(error || '')
    .replace(/^yt-dlp error:\s*/i, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || 'Download failed';
}

function isPopupActiveStatus(status) {
  return ['probing', 'queued', 'downloading', 'paused', 'error'].includes(status);
}

function shouldShowInPopup(d) {
  if (isPopupActiveStatus(d.status)) return true;
  return d.status === 'completed' && d.completedAt && Date.now() - d.completedAt < 12000;
}

function notePopupDownloads() {
  const nextIds = new Set();
  let hasNewDownload = false;
  for (const d of state.downloads) {
    nextIds.add(d.id);
    if (!popupState.knownIds.has(d.id) && ['probing', 'queued', 'downloading'].includes(d.status)) {
      hasNewDownload = true;
    }
  }
  popupState.knownIds = nextIds;
  if (hasNewDownload) popupState.dismissed = false;
}

function popupActionButtons(d) {
  if (d.status === 'downloading' || d.status === 'queued') {
    return `<button class="popup-icon-btn" data-popup-action="pause" data-id="${d.id}" title="Pause">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>`;
  }
  if (d.status === 'paused' || d.status === 'error') {
    return `<button class="popup-icon-btn" data-popup-action="resume" data-id="${d.id}" title="Resume">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
    </button>`;
  }
  if (d.status === 'completed') {
    return `<button class="popup-icon-btn" data-popup-action="show" data-id="${d.id}" title="Show in folder">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z"/></svg>
    </button>`;
  }
  return '';
}

function rowActionButtons(d) {
  if (d.status === 'downloading' || d.status === 'queued') {
    return `<button class="row-action-btn" data-row-action="pause" data-id="${d.id}" title="Pause">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>`;
  }
  if (d.status === 'paused' || d.status === 'error') {
    return `<button class="row-action-btn" data-row-action="resume" data-id="${d.id}" title="Resume">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
    </button>`;
  }
  if (d.status === 'completed') {
    return `
      <button class="row-action-btn" data-row-action="open" data-id="${d.id}" title="Open">
        <svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8 5h8l3 3v11H8V5zm7 0v4h4"/></svg>
      </button>
      <button class="row-action-btn" data-row-action="show" data-id="${d.id}" title="Show in folder">
        <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z"/></svg>
      </button>
    `;
  }
  return '<span class="row-action-empty">—</span>';
}

async function runDownloadAction(action, id) {
  if (action === 'pause') await window.gale.pause(id);
  if (action === 'resume') await window.gale.resume(id);
  if (action === 'show') await window.gale.showInFolder(id);
  if (action === 'open') await window.gale.openFile(id);
  refresh();
}

function renderDownloadPopup() {
  const popup = el('download-popup');
  const body = el('download-popup-body');
  if (!popup || !body) return;

  notePopupDownloads();
  const items = state.downloads
    .filter(shouldShowInPopup)
    .sort((a, b) => {
      const aActive = a.status === 'downloading' ? 1 : 0;
      const bActive = b.status === 'downloading' ? 1 : 0;
      return bActive - aActive || (b.addedAt || 0) - (a.addedAt || 0);
    })
    .slice(0, 4);
  const activeCount = state.downloads.filter((d) => d.status === 'downloading').length;

  popup.classList.toggle('hidden', popupState.dismissed || items.length === 0);
  popup.classList.toggle('is-minimized', popupState.minimized);
  el('download-popup-count').textContent = activeCount === 1 ? '1 active' : `${activeCount} active`;
  if (popupState.minimized) return;

  body.innerHTML = items.map((d) => {
    const pct = progressPercent(d);
    const speedText = d.isStreaming && d._speedStr ? d._speedStr : fmtSpeed(d.speed);
    const detail = d.status === 'downloading'
      ? `${speedText} · ${fmtTimeLeft(d)}`
      : statusLabel(d, pct);
    return `
      <div class="download-popup-item">
        <div class="download-popup-item-main">
          <div class="download-popup-name" title="${escapeHtml(d.filename || '')}">${escapeHtml(d.filename || 'resolving…')}</div>
          <div class="download-popup-detail">${escapeHtml(detail)}</div>
          <div class="download-popup-track"><div class="download-popup-fill status-${d.status}" style="width:${pct}%"></div></div>
        </div>
        <div class="download-popup-item-actions">${popupActionButtons(d)}</div>
      </div>
    `;
  }).join('');

  body.querySelectorAll('[data-popup-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const action = e.currentTarget.dataset.popupAction;
      await runDownloadAction(action, id);
    });
  });
}

function render() {
  let filtered = state.downloads
    .filter((d) => matchesCategory(d, state.category))
    .filter((d) => !state.search || d.filename?.toLowerCase().includes(state.search.toLowerCase()));
  filtered = sortDownloads(filtered);

  emptyState.classList.toggle('hidden', filtered.length > 0);
  tableBody.innerHTML = '';

  for (const d of filtered) {
    const tr = document.createElement('tr');
    tr.dataset.id = d.id;
    if (state.selected.has(d.id)) tr.classList.add('selected');

    const pct = progressPercent(d);
    const barClass = d.status === 'paused' ? 'paused' : d.status === 'error' ? 'error' : '';
    const showBar = d.status === 'downloading' || d.status === 'paused';
    const statusLabelText = statusLabel(d, pct);
    const speedText = d.isStreaming && d._speedStr ? d._speedStr : fmtSpeed(d.speed);
    const meta = categoryMeta(d.category);
    const statusDetail = d.status === 'error' && d.error
      ? `<div class="status-error-detail" title="${escapeHtml(d.error)}">${escapeHtml(errorSummary(d.error))}</div>`
      : '';

    tr.innerHTML = `
      <td><div class="accent-strip" style="background:${meta.color}"></div><input type="checkbox" class="row-check" ${state.selected.has(d.id) ? 'checked' : ''}/></td>
      <td>
        <div class="file-cell">
          <div class="file-icon-swatch" style="background:${hexToRgba(meta.color, 0.16)};color:${meta.color}">${meta.icon}</div>
          <div style="min-width:0">
            <div class="file-name" title="${escapeHtml(d.filename || '')}">${escapeHtml(d.filename || 'resolving…')}</div>
            <div class="file-category">${meta.label}</div>
          </div>
        </div>
      </td>
      <td class="mono">${d.isStreaming ? (d.title || '—') : fmtBytes(d.totalSize)}</td>
      <td>
        <div class="status-cell">
          <span class="status-badge status-${d.status}">${statusLabelText}</span>
          ${statusDetail}
          ${showBar ? `<div class="status-bar-track"><div class="status-bar-fill ${barClass}" style="width:${pct}%"></div></div>` : ''}
        </div>
      </td>
      <td class="mono">${d.status === 'downloading' ? speedText : '—'}</td>
      <td class="mono">${fmtTimeLeft(d)}</td>
      <td class="mono">${fmtRelative(d.addedAt)}</td>
      <td><div class="row-actions">${rowActionButtons(d)}</div></td>
    `;

    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-check')) return;
      toggleSelect(d.id, e.shiftKey || e.metaKey || e.ctrlKey);
    });
    tr.querySelectorAll('[data-row-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await runDownloadAction(e.currentTarget.dataset.rowAction, e.currentTarget.dataset.id);
      });
    });
    tr.querySelector('.row-check').addEventListener('change', () => toggleSelect(d.id, true));
    if (d.status === 'error' && d.error) tr.title = d.error;
    if (d.status === 'completed') {
      tr.addEventListener('dblclick', () => window.gale.openFile(d.id));
    }

    tableBody.appendChild(tr);
  }

  updateCounts();
  updateStatusBar();
  updateToolbarState();
  updateSortIndicators();
  renderDownloadPopup();
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function toggleSelect(id, additive) {
  if (!additive) state.selected.clear();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function updateToolbarState() {
  const any = state.selected.size > 0;
  el('btn-resume').disabled = !any;
  el('btn-pause').disabled = !any;
  el('btn-remove').disabled = !any;
}

function updateSortIndicators() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortKey) th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    render();
  });
});

// ---------- data refresh ----------

async function refresh() {
  state.downloads = await window.gale.listDownloads();
  render();
}

window.gale.onUpdate(() => refresh());
window.gale.onBulkUpdate(() => refresh());
window.gale.onTick((list) => {
  state.downloads = list;
  render();
});

// ---------- sidebar nav ----------

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => setCategory(btn.dataset.cat));
});

document.querySelectorAll('[data-dashboard-cat]').forEach((btn) => {
  btn.addEventListener('click', () => setCategory(btn.dataset.dashboardCat));
});

el('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  render();
});

function setCategory(cat) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
  document.querySelectorAll('[data-dashboard-cat]').forEach((b) => b.classList.toggle('is-active', b.dataset.dashboardCat === cat));
  state.category = cat;
  render();
}

// ---------- toolbar actions ----------

el('btn-resume').addEventListener('click', () => {
  for (const id of state.selected) window.gale.resume(id);
});
el('btn-pause').addEventListener('click', () => {
  for (const id of state.selected) window.gale.pause(id);
});
el('btn-remove').addEventListener('click', () => {
  for (const id of state.selected) window.gale.remove(id, false);
  state.selected.clear();
});
el('btn-clear-finished').addEventListener('click', () => window.gale.clearCompleted());

el('btn-start-queue').addEventListener('click', async () => {
  const list = await window.gale.listDownloads();
  for (const d of list) {
    if (d.status === 'paused' || d.status === 'error') window.gale.resume(d.id);
  }
});
el('btn-stop-queue').addEventListener('click', async () => {
  const list = await window.gale.listDownloads();
  for (const d of list) {
    if (d.status === 'downloading' || d.status === 'queued' || d.status === 'probing') window.gale.pause(d.id);
  }
});

// ---------- Add Download modal ----------

let defaultDir = '';
let isStreamingUrlDetected = false;
let detectUrlRequest = 0;
let addRequestInFlight = false;

async function openAddModal(prefillUrl) {
  const settings = await window.gale.getSettings();
  defaultDir = settings.downloadDir;
  el('add-url').value = prefillUrl || (await window.gale.readClipboard()) || '';
  el('add-dir').value = defaultDir;
  el('add-segments').value = settings.maxSegments;
  el('add-error').classList.add('hidden');
  el('add-modal').classList.remove('hidden');
  el('add-url').focus();
  await detectUrlType(el('add-url').value);
}

async function detectUrlType(url) {
  const requestId = ++detectUrlRequest;
  if (!url) {
    isStreamingUrlDetected = false;
    el('add-quality-row').classList.add('hidden');
    el('add-segments-row').classList.remove('hidden');
    return;
  }
  try {
    const streaming = await window.gale.isStreamingUrl(url);
    if (requestId !== detectUrlRequest) return streaming;
    isStreamingUrlDetected = streaming;
    if (streaming) {
      el('add-quality-row').classList.remove('hidden');
      el('add-segments-row').classList.add('hidden');
    } else {
      el('add-quality-row').classList.add('hidden');
      el('add-segments-row').classList.remove('hidden');
    }
  } catch (_) {
    if (requestId !== detectUrlRequest) return false;
    isStreamingUrlDetected = false;
    el('add-quality-row').classList.add('hidden');
    el('add-segments-row').classList.remove('hidden');
  }
}

function closeAddModal() { el('add-modal').classList.add('hidden'); }

el('btn-add').addEventListener('click', () => openAddModal());
el('add-url').addEventListener('input', (e) => detectUrlType(e.target.value));
el('add-cancel').addEventListener('click', closeAddModal);
el('add-browse').addEventListener('click', async () => {
  const dir = await window.gale.chooseDir();
  if (dir) el('add-dir').value = dir;
});
el('add-confirm').addEventListener('click', async () => {
  if (addRequestInFlight) return;
  const url = el('add-url').value.trim();
  const dir = el('add-dir').value.trim() || defaultDir;
  const segments = parseInt(el('add-segments').value, 10) || 8;
  const quality = el('add-quality').value;
  if (!url) {
    el('add-error').textContent = 'Enter a URL first.';
    el('add-error').classList.remove('hidden');
    return;
  }
  addRequestInFlight = true;
  el('add-confirm').disabled = true;
  el('add-error').classList.add('hidden');
  try {
    await detectUrlType(url);
    const opts = { dir, segments };
    if (isStreamingUrlDetected) {
      opts.quality = quality;
    }
    await window.gale.addDownload(url, opts);
    closeAddModal();
    refresh();
  } catch (err) {
    el('add-error').textContent = err.message || 'Could not add that URL.';
    el('add-error').classList.remove('hidden');
  } finally {
    addRequestInFlight = false;
    el('add-confirm').disabled = false;
  }
});

// ---------- Settings modal ----------

function renderUpdateStatus(status) {
  if (!status) return;
  el('update-current-version').textContent = status.currentVersion || '';
  el('update-status').textContent = status.message || 'Updates are checked automatically.';
  const checking = status.state === 'checking' || status.state === 'downloading';
  el('check-for-updates').disabled = checking || status.state === 'unavailable';
}

async function openSettingsModal() {
  const s = await window.gale.getSettings();
  el('set-dir').value = s.downloadDir;
  el('set-maxconc').value = s.maxConcurrent;
  el('set-maxseg').value = s.maxSegments;
  el('set-speed').value = s.speedLimitKBs;
  el('set-clipboard').checked = s.clipboardMonitor;
  el('set-ytdlp-cookies-browser').value = s.ytdlpCookiesBrowser || '';
  el('set-token-warning').classList.add('hidden');
  el('set-token').value = await window.gale.getBrowserToken();
  renderUpdateStatus(await window.gale.getUpdateStatus());
  el('settings-modal').classList.remove('hidden');
}
function closeSettingsModal() { el('settings-modal').classList.add('hidden'); }

el('open-settings').addEventListener('click', openSettingsModal);
el('set-cancel').addEventListener('click', closeSettingsModal);
el('open-browser-extension').addEventListener('click', () => window.gale.openBrowserExtensionFolder());
el('set-browse').addEventListener('click', async () => {
  const dir = await window.gale.chooseDir();
  if (dir) el('set-dir').value = dir;
});
el('set-token-copy').addEventListener('click', async () => {
  const tokenInput = el('set-token');
  try {
    await navigator.clipboard.writeText(tokenInput.value);
  } catch (_) {
    tokenInput.select();
    document.execCommand('copy');
  }
});
el('set-token-regen').addEventListener('click', async () => {
  const ok = window.confirm('This invalidates the current pairing code. Any browser extension paired with the old code will need to be re-paired. Continue?');
  if (!ok) return;
  el('set-token').value = await window.gale.regenerateBrowserToken();
  el('set-token-warning').classList.remove('hidden');
});
el('check-for-updates').addEventListener('click', async () => {
  renderUpdateStatus({ state: 'checking', message: 'Checking for updates…' });
  renderUpdateStatus(await window.gale.checkForUpdates());
});
window.gale.onAppUpdateStatus(renderUpdateStatus);
el('set-save').addEventListener('click', async () => {
  await window.gale.saveSettings({
    downloadDir: el('set-dir').value.trim(),
    maxConcurrent: parseInt(el('set-maxconc').value, 10) || 3,
    maxSegments: parseInt(el('set-maxseg').value, 10) || 8,
    speedLimitKBs: parseInt(el('set-speed').value, 10) || 0,
    clipboardMonitor: el('set-clipboard').checked,
    ytdlpCookiesBrowser: el('set-ytdlp-cookies-browser').value,
  });
  closeSettingsModal();
});

// ---------- Clipboard detection toast ----------

let lastToastUrl = null;
window.gale.onClipboardDetected((url) => {
  if (url === lastToastUrl) return;
  lastToastUrl = url;
  el('toast-text').textContent = url;
  el('clipboard-toast').classList.remove('hidden');
  el('add-badge').classList.remove('hidden');
});
el('toast-add').addEventListener('click', () => {
  el('clipboard-toast').classList.add('hidden');
  el('add-badge').classList.add('hidden');
  openAddModal(lastToastUrl);
});
el('toast-dismiss').addEventListener('click', () => {
  el('clipboard-toast').classList.add('hidden');
});

// ---------- Update toast listener ----------

window.gale.onAppUpdateToast((data) => {
  if (data.type === 'ready') {
    showUpdateToast('Update ready', data.version, () => {
      // Trigger the quit and install
      window.gale.checkForUpdates().then(() => {
        // The quitAndInstall is handled by main.js
      });
    });
  }
});

// ---------- Update toast ----------

let updateToastAction = null;
function showUpdateToast(message, version, onInstall) {
  el('update-toast-text').textContent = `Gale ${version} is ready — click Install to restart and update.`;
  updateToastAction = onInstall;
  el('update-toast').classList.remove('hidden');
}
function hideUpdateToast() {
  el('update-toast').classList.add('hidden');
  updateToastAction = null;
}
el('update-toast-install').addEventListener('click', () => {
  if (updateToastAction) updateToastAction();
  hideUpdateToast();
});
el('update-toast-dismiss').addEventListener('click', hideUpdateToast);

// ---------- select-all ----------

el('select-all').addEventListener('change', (e) => {
  if (e.target.checked) {
    state.downloads
      .filter((d) => matchesCategory(d, state.category))
      .forEach((d) => state.selected.add(d.id));
  } else {
    state.selected.clear();
  }
  render();
});

el('download-popup-close').addEventListener('click', () => {
  popupState.dismissed = true;
  renderDownloadPopup();
});
el('download-popup-minimize').addEventListener('click', () => {
  popupState.minimized = !popupState.minimized;
  el('download-popup-minimize').title = popupState.minimized ? 'Expand' : 'Minimize';
  renderDownloadPopup();
});

setCategory(state.category);
refresh();
setInterval(refresh, 4000); // safety-net poll in case an event was missed
