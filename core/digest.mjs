// Checksum helpers: user-supplied expectations and (advisory) digests announced by the server.
const HEX = { md5: 32, sha256: 64 };
const NAMES = { md5: 'md5', 'sha-256': 'sha256', sha256: 'sha256' };

// Accepts 'sha256:<hex>', 'md5:<hex>', { algorithm, value }, or bare hex (32 chars = MD5, 64 chars = SHA-256).
export function normalizeChecksum(input) {
  if (input === undefined || input === null || input === '') return null;
  let algorithm, value;
  if (typeof input === 'string') {
    const text = input.trim(), match = /^([a-z0-9-]+)\s*[:=]\s*([0-9a-f]+)$/i.exec(text);
    if (match) { algorithm = NAMES[match[1].toLowerCase()]; value = match[2]; }
    else { value = text; algorithm = value.length === 32 ? 'md5' : value.length === 64 ? 'sha256' : undefined; }
  } else if (typeof input === 'object') {
    algorithm = NAMES[String(input.algorithm || '').toLowerCase()]; value = String(input.value || '').trim();
  }
  if (!algorithm || !/^[0-9a-f]+$/i.test(value || '') || value.length !== HEX[algorithm]) throw new Error('Enter a checksum as sha256:<64 hex characters> or md5:<32 hex characters>.');
  return { algorithm, value: value.toLowerCase() };
}

const base64Hex = (text, bytes) => { try { const buffer = Buffer.from(text, 'base64'); return buffer.length === bytes ? buffer.toString('hex') : null; } catch { return null; } };

// Digests of the full file announced in response headers. Servers get these wrong now and then, so callers treat a
// mismatch against them as a warning, never as a reason to discard the download.
export function digestsFromHeaders(headers = {}) {
  const found = [];
  const md5 = base64Hex(String(headers['content-md5'] || '').trim(), 16);
  if (md5) found.push({ algorithm: 'md5', value: md5 });
  for (const name of ['digest', 'repr-digest']) {
    for (const part of String(headers[name] || '').split(',')) {
      const match = /^\s*([a-z0-9-]+)\s*=\s*:?([A-Za-z0-9+/=_-]+):?\s*$/i.exec(part);
      const algorithm = match && NAMES[match[1].toLowerCase()];
      if (!algorithm) continue;
      const value = base64Hex(match[2].replace(/-/g, '+').replace(/_/g, '/'), algorithm === 'md5' ? 16 : 32);
      if (value) found.push({ algorithm, value });
    }
  }
  return found;
}
