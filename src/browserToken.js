'use strict';
const crypto = require('crypto');

/** Returns the persisted pairing token, generating one on first run. */
function ensureBrowserToken(store) {
  let token = store.get('browserToken', null);
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    store.set('browserToken', token);
  }
  return token;
}

/** Generates a brand-new token, invalidating any previously paired extension. */
function regenerateBrowserToken(store) {
  const token = crypto.randomBytes(24).toString('hex');
  store.set('browserToken', token);
  return token;
}

module.exports = { ensureBrowserToken, regenerateBrowserToken };
