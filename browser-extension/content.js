'use strict';

const BUTTON_CLASS = 'gale-dl-btn';
const POPUP_CLASS = 'gale-dl-popup';

let currentVideoId = null;
let popupOpen = false;

function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

function getVideoUrl() {
  return window.location.href;
}

function getVideoTitle() {
  const el =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('h1.title yt-formatted-string') ||
    document.querySelector('#title h1') ||
    document.querySelector('h1');
  return el ? el.textContent.trim() : document.title.replace(' - YouTube', '').trim();
}

function injectCSS() {
  if (document.getElementById('gale-content-css')) return;
  const link = document.createElement('link');
  link.id = 'gale-content-css';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content.css');
  document.head.appendChild(link);
}

function createDownloadButton() {
  if (document.querySelector('.' + BUTTON_CLASS)) return;

  const btn = document.createElement('button');
  btn.className = BUTTON_CLASS;
  btn.title = 'Download with Gale';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  `;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePopup();
  });

  document.body.appendChild(btn);
}

function createPopup() {
  if (document.querySelector('.' + POPUP_CLASS)) return;

  const popup = document.createElement('div');
  popup.className = POPUP_CLASS;
  popup.innerHTML = `
    <div class="gale-dl-header">
      <span class="gale-dl-title">Gale Download Manager</span>
      <button class="gale-dl-close" title="Close">&times;</button>
    </div>
    <div class="gale-dl-body">
      <div class="gale-dl-video-info">
        <div class="gale-dl-video-title" id="gale-video-title"></div>
        <div class="gale-dl-video-url" id="gale-video-url"></div>
      </div>
      <div class="gale-dl-options">
        <label class="gale-dl-label">Quality</label>
        <select id="gale-quality" class="gale-dl-select">
          <option value="best">Best quality</option>
          <option value="1080">1080p</option>
          <option value="720" selected>720p</option>
          <option value="480">480p</option>
          <option value="audio">Audio only</option>
        </select>
      </div>
      <button id="gale-dl-start" class="gale-dl-start-btn">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download with Gale
      </button>
      <div id="gale-dl-status" class="gale-dl-status"></div>
    </div>
  `;

  document.body.appendChild(popup);

  popup.querySelector('.gale-dl-close').addEventListener('click', () => {
    closePopup();
  });

  popup.querySelector('#gale-dl-start').addEventListener('click', () => {
    startDownload();
  });

  document.addEventListener('click', (e) => {
    if (
      popupOpen &&
      !popup.contains(e.target) &&
      !e.target.closest('.' + BUTTON_CLASS)
    ) {
      closePopup();
    }
  });
}

function togglePopup() {
  if (popupOpen) {
    closePopup();
  } else {
    openPopup();
  }
}

function openPopup() {
  const popup = document.querySelector('.' + POPUP_CLASS);
  const btn = document.querySelector('.' + BUTTON_CLASS);
  if (!popup || !btn) return;

  const url = getVideoUrl();
  const title = getVideoTitle();

  popup.querySelector('#gale-video-title').textContent = title;
  popup.querySelector('#gale-video-url').textContent = url;
  popup.querySelector('#gale-dl-status').textContent = '';
  popup.querySelector('#gale-dl-status').className = 'gale-dl-status';

  const btnRect = btn.getBoundingClientRect();
  popup.style.bottom = (window.innerHeight - btnRect.top + 10) + 'px';
  popup.style.right = (window.innerWidth - btnRect.right) + 'px';

  popup.classList.add('visible');
  popupOpen = true;
}

function closePopup() {
  const popup = document.querySelector('.' + POPUP_CLASS);
  if (popup) popup.classList.remove('visible');
  popupOpen = false;
}

async function startDownload() {
  const statusEl = document.querySelector('#gale-dl-status');
  const startBtn = document.querySelector('#gale-dl-start');
  const quality = document.querySelector('#gale-quality').value;
  const url = getVideoUrl();
  const title = getVideoTitle();

  statusEl.textContent = 'Sending to Gale...';
  statusEl.className = 'gale-dl-status loading';
  startBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'download',
      url: url,
      filename: title,
      quality: quality,
    });

    if (result && result.success) {
      statusEl.textContent = 'Download started!';
      statusEl.className = 'gale-dl-status success';
      setTimeout(() => closePopup(), 1500);
    } else {
      throw new Error((result && result.error) || 'Gale rejected the download');
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'gale-dl-status error';
  } finally {
    startBtn.disabled = false;
  }
}

function removeButton() {
  const btn = document.querySelector('.' + BUTTON_CLASS);
  if (btn) btn.remove();
  const popup = document.querySelector('.' + POPUP_CLASS);
  if (popup) popup.remove();
  popupOpen = false;
}

function handleNavigation() {
  const videoId = getVideoId();
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    injectCSS();
    setTimeout(() => {
      createDownloadButton();
      createPopup();
    }, 1000);
  } else if (!videoId) {
    currentVideoId = null;
    removeButton();
  }
}

handleNavigation();

const observer = new MutationObserver(() => {
  handleNavigation();
});
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('popstate', handleNavigation);
document.addEventListener('yt-navigate-finish', handleNavigation);
