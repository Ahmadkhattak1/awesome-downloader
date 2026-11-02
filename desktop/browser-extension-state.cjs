const fs = require('node:fs/promises');
const path = require('node:path');
const { EXTENSION_ID } = require('./extension-store.cjs');

function disabled(entry) {
  return entry?.state === 0 || (Array.isArray(entry?.disable_reasons)
    ? entry.disable_reasons.length > 0
    : typeof entry?.disable_reasons === 'number' && entry.disable_reasons !== 0);
}

function publishedState(settings, removed = []) {
  const entry = settings[EXTENSION_ID];
  const reasons = entry?.disable_reasons;
  const awaitingApproval = Array.isArray(reasons) ? reasons.some(value => (value & 8192) !== 0) : (reasons & 8192) !== 0;
  if (awaitingApproval) return 'approval';
  if (entry?.path || entry?.manifest?.version) {
    if (disabled(entry)) return 'disabled';
    // Current Chromium versions can omit the legacy state field entirely.
    if (entry.state === 1 || (entry.state === undefined && entry.manifest?.version)) return 'connected';
  }
  if (Array.isArray(removed) && removed.includes(EXTENSION_ID)) return 'removed';
  return 'missing';
}

async function readProfile(profile) {
  let settings = {}, removed = [];
  for (const file of ['Preferences', 'Secure Preferences']) {
    try {
      const extensions = JSON.parse(await fs.readFile(path.join(profile, file), 'utf8')).extensions || {};
      // Secure Preferences takes precedence, including empty removal tombstones.
      settings = { ...settings, ...extensions.settings };
      if (Array.isArray(extensions.external_uninstalls)) removed.push(...extensions.external_uninstalls);
    } catch { /* A running browser can replace its preference files between reads. */ }
  }
  return { settings, state: publishedState(settings, removed) };
}

module.exports = { disabled, publishedState, readProfile };
