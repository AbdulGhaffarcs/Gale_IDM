'use strict';

const STATUS_URL = 'http://127.0.0.1:47632/status';
const TOKEN_HEADER = 'x-gale-token';

const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

async function load() {
  const { galeToken } = await chrome.storage.local.get('galeToken');
  if (galeToken) tokenInput.value = galeToken;
}

async function save() {
  const value = tokenInput.value.trim();
  await chrome.storage.local.set({ galeToken: value });
  setStatus(value ? 'Saved.' : 'Cleared.', 'ok');
}

async function testConnection() {
  const value = tokenInput.value.trim();
  setStatus('Checking...', 'loading');
  try {
    const res = await fetch(STATUS_URL, { headers: value ? { [TOKEN_HEADER]: value } : {} });
    if (!res.ok) { setStatus('Gale did not respond as expected.', 'error'); return; }
    const data = await res.json();
    if (!data.running) { setStatus('Gale is not running.', 'error'); return; }
    setStatus(data.paired ? 'Connected and paired.' : 'Gale is running, but this code was not accepted.', data.paired ? 'ok' : 'error');
  } catch (_) {
    setStatus('Could not reach Gale. Make sure it is running.', 'error');
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', testConnection);

load();
