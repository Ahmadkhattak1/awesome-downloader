import { createHash } from 'node:crypto';

// Torrent metadata is untrusted input: bound what a single .torrent may cost.
const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const MAX_TORRENT_FILES = 20000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const text = value => Buffer.isBuffer(value) ? value.toString('utf8').replace(/^\uFEFF/, '') : String(value ?? '');

// Minimal bencode decoder. It reports the byte range of the root `info`
// dictionary so the info hash is computed over the original bytes instead of a
// re-encoded copy, which would not match the magnet when key order differs.
function decodeValue(buffer, pos, depth, context) {
  if (depth > 64) throw new Error('Torrent metadata is nested too deeply.');
  const start = pos;
  const lead = buffer[pos];
  if (lead === 0x69) { // i<digits>e
    const end = buffer.indexOf(0x65, pos + 1);
    if (end < 0) throw new Error('Torrent metadata has an unterminated integer.');
    const digits = buffer.toString('utf8', pos + 1, end);
    if (!/^-?\d+$/.test(digits)) throw new Error('Torrent metadata has an invalid integer.');
    const value = Number(digits);
    if (!Number.isSafeInteger(value)) throw new Error('Torrent metadata integer is out of range.');
    return { value, start, end: end + 1 };
  }
  if (lead === 0x6c) { // l
    const value = [];
    let cursor = pos + 1;
    for (;;) {
      if (cursor >= buffer.length) throw new Error('Torrent metadata has an unterminated list.');
      if (buffer[cursor] === 0x65) { cursor += 1; break; }
      const item = decodeValue(buffer, cursor, depth + 1, context);
      value.push(item.value); cursor = item.end;
      if (value.length > MAX_TORRENT_FILES) throw new Error('Torrent metadata lists too many entries.');
    }
    return { value, start, end: cursor };
  }
  if (lead === 0x64) { // d
    const value = Object.create(null);
    let cursor = pos + 1;
    for (;;) {
      if (cursor >= buffer.length) throw new Error('Torrent metadata has an unterminated dictionary.');
      if (buffer[cursor] === 0x65) { cursor += 1; break; }
      const key = decodeValue(buffer, cursor, depth + 1, context);
      if (!Buffer.isBuffer(key.value)) throw new Error('Torrent metadata has a non-string dictionary key.');
      const name = text(key.value);
      const item = decodeValue(buffer, key.end, depth + 1, context);
      if (depth === 0 && name === 'info') { context.infoStart = item.start; context.infoEnd = item.end; }
      value[name] = item.value; cursor = item.end;
    }
    return { value, start, end: cursor };
  }
  // <length>:<bytes>
  const colon = buffer.indexOf(0x3a, pos);
  if (colon < 0) throw new Error('Torrent metadata has an unterminated string.');
  const digits = buffer.toString('utf8', pos, colon);
  if (!/^\d+$/.test(digits)) throw new Error('Torrent metadata has an invalid string length.');
  const length = Number(digits);
  const end = colon + 1 + length;
  if (!Number.isSafeInteger(length) || end > buffer.length) throw new Error('Torrent metadata is truncated.');
  return { value: buffer.subarray(colon + 1, end), start, end };
}

export function decodeBencode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buffer.length) throw new Error('That torrent file is empty.');
  if (buffer.length > MAX_TORRENT_BYTES) throw new Error('That torrent file is larger than 10 MiB.');
  const context = { infoStart: -1, infoEnd: -1 };
  const decoded = decodeValue(buffer, 0, 0, context);
  if (decoded.end !== buffer.length) throw new Error('That torrent file has trailing data.');
  return { ...decoded, infoStart: context.infoStart, infoEnd: context.infoEnd };
}

// Base32 (RFC 4648, no padding) is the other legal `btih` encoding.
function base32ToHex(value) {
  let bits = 0, accumulator = 0, hex = '';
  for (const character of value.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('Magnet link has an invalid info hash.');
    accumulator = (accumulator << 5) | index; bits += 5;
    while (bits >= 4) { bits -= 4; hex += ((accumulator >> bits) & 0xf).toString(16); }
    // Keep only the unconsumed low bits so the accumulator cannot overflow.
    accumulator &= (1 << bits) - 1;
  }
  return hex.slice(0, 40);
}

export function parseMagnet(value) {
  if (typeof value !== 'string' || !/^magnet:\?/i.test(value.trim())) throw new Error('Magnet links must start with magnet:?.');
  const uri = value.trim();
  if (uri.length > 8192) throw new Error('Magnet link is too long.');
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  const xt = params.getAll('xt').find(entry => /^urn:btih:/i.test(entry));
  if (!xt) throw new Error('Magnet link has no BitTorrent info hash.');
  const raw = /^urn:btih:(.+)$/i.exec(xt)?.[1] || '';
  let infoHash;
  if (/^[a-f0-9]{40}$/i.test(raw)) infoHash = raw.toLowerCase();
  else if (/^[a-z2-7]{32}$/i.test(raw)) infoHash = base32ToHex(raw);
  else throw new Error('Magnet link has an invalid info hash.');
  const name = text(params.get('dn') || '').trim();
  const trackers = params.getAll('tr').map(entry => entry.trim()).filter(Boolean).slice(0, 64);
  const declaredSize = Number(params.get('xl'));
  return {
    type: 'torrent',
    infoHash,
    name: name || `torrent-${infoHash.slice(0, 8)}`,
    trackers,
    length: Number.isSafeInteger(declaredSize) && declaredSize > 0 ? declaredSize : null,
    magnet: uri
  };
}

export function parseTorrentFile(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const decoded = decodeBencode(buffer);
  const root = decoded.value;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('That file is not a torrent.');
  const info = root.info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Torrent file is missing its info dictionary.');
  if (!Buffer.isBuffer(info.pieces) || !info.pieces.length || info.pieces.length % 20) throw new Error('Torrent file has invalid piece hashes.');
  if (!Number.isSafeInteger(info['piece length']) || info['piece length'] <= 0) throw new Error('Torrent file has an invalid piece length.');
  const name = text(info.name).trim();
  if (!name) throw new Error('Torrent file has no name.');
  const files = [];
  if (Array.isArray(info.files)) {
    if (info.files.length > MAX_TORRENT_FILES) throw new Error('Torrent file lists too many files.');
    for (const entry of info.files) {
      if (!Array.isArray(entry?.path) || !entry.path.length || !Number.isSafeInteger(entry.length) || entry.length < 0) {
        throw new Error('Torrent file has an invalid file entry.');
      }
      const filePath = entry.path.map(text).join('/');
      if (!filePath || filePath.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Torrent file has an unsafe path.');
      files.push({ path: filePath, length: entry.length });
    }
  } else if (Number.isSafeInteger(info.length) && info.length >= 0) files.push({ path: name, length: info.length });
  else throw new Error('Torrent file has no file sizes.');
  const infoHash = createHash('sha1').update(buffer.subarray(decoded.infoStart, decoded.infoEnd)).digest('hex');
  const trackers = [...new Set([
    ...(root.announce ? [text(root.announce)] : []),
    ...(Array.isArray(root['announce-list']) ? root['announce-list'].flat().map(text) : [])
  ])].filter(entry => /^https?:\/\//i.test(entry)).slice(0, 64);
  return {
    type: 'torrent',
    infoHash,
    name,
    files,
    length: files.reduce((total, file) => total + file.length, 0),
    trackers,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackers.map(tracker => `&tr=${encodeURIComponent(tracker)}`).join('')}`
  };
}

// Accepts every source shape the desktop app and MDXP-style clients can send:
// a magnet link, or a .torrent file as a data URL, base64 file, or Buffer.
export function torrentSource(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return parseTorrentFile(Buffer.from(value));
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (/^magnet:\?/i.test(source)) return parseMagnet(source);
  if (/^data:application\/x-bittorrent[;,]/i.test(source)) {
    const payload = source.replace(/^data:application\/x-bittorrent[^,]*,/i, '');
    if (!payload.trim()) throw new Error('That torrent file is empty.');
    return parseTorrentFile(Buffer.from(payload, 'base64'));
  }
  return null;
}
