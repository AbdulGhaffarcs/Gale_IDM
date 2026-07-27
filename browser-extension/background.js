'use strict';

const GALE_ORIGIN = 'http://127.0.0.1:47632';
const GALE_DOWNLOAD_URL = `${GALE_ORIGIN}/download`;
const GALE_STATUS_URL = `${GALE_ORIGIN}/status`;
const MENU_ID = 'download-with-gale';
const TOKEN_HEADER = 'x-gale-token';

async function getToken() {
  const { galeToken } = await chrome.storage.local.get('galeToken');
  return galeToken || '';
}

async function sendToGale(url, filename, quality) {
  const token = await getToken();
  const response = await fetch(GALE_DOWNLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
    body: JSON.stringify({ url, filename, quality }),
  });
  if (response.status === 401) {
    const err = new Error('Gale has not been paired with this extension yet. Click the extension icon, choose Options, and paste the pairing code from Gale > Settings.');
    err.notPaired = true;
    throw err;
  }
  if (!response.ok) throw new Error('Gale is not running.');
}

function notify(message) {
  chrome.notifications.create({ type: 'basic', title: 'Gale', message });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Download with Gale', contexts: ['link', 'audio', 'video'] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return notify('That item does not have an HTTP download link.');
  try {
    await sendToGale(url);
    notify('Download sent to Gale.');
  } catch (err) {
    if (err.notPaired) chrome.runtime.openOptionsPage();
    notify(err.message || 'Could not reach Gale. Start Gale, then try again.');
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download') {
    sendToGale(message.url, message.filename, message.quality)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message, notPaired: !!err.notPaired }));
    return true;
  }
  if (message.action === 'ping') {
    fetch(GALE_STATUS_URL)
      .then((r) => r.json())
      .then((data) => sendResponse({ running: !!data.running, paired: !!data.paired }))
      .catch(() => sendResponse({ running: false, paired: false }));
    return true;
  }
});

// For ordinary browser downloads, hand the link to Gale first, then cancel the
// browser copy after Gale accepts it. If Gale is closed, or hasn't been paired
// yet, the original browser download is left alone.
let notifiedNotPaired = false;
chrome.downloads.onCreated.addListener(async (item) => {
  const url = item.finalUrl || item.url;
  if (!url || !/^https?:/i.test(url)) return;
  try {
    await sendToGale(url, item.filename && item.filename.split(/[\\/]/).pop());
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
    notify('Browser download sent to Gale.');
  } catch (err) {
    if (err.notPaired && !notifiedNotPaired) {
      // Only nag once per session, not on every download attempt while unpaired.
      notifiedNotPaired = true;
      notify('Gale is running but not paired with this browser yet. Click the extension icon, then Options, to pair it.');
    }
    // Otherwise Gale simply isn't running: leave the browser's own download alone, silently.
  }
});
