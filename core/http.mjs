import http from 'node:http';
import https from 'node:https';

export function validUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid download URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS downloads are supported.');
  if (url.username || url.password) throw new Error('Use request headers for authentication, not credentials in URLs.');
  return url.href;
}

export function cleanHeaders(input = {}) {
  const headers = { 'user-agent': 'AwesomeDownloader/0.1', 'accept-encoding': 'identity' };
  const allowed = new Set(['referer', 'cookie', 'authorization', 'origin', 'user-agent', 'accept']);
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key.toLowerCase()) && typeof value === 'string' && value.length <= 32768 && !/[\r\n]/.test(value)) headers[key.toLowerCase()] = value;
  }
  return headers;
}

export async function request(url, { method = 'GET', headers = {}, signal, redirects = 0 } = {}) {
  url = validUrl(url);
  if (redirects > 10) throw new Error('Too many redirects.');
  const response = await new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { method, headers, signal }, resolve);
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Connection timed out.')));
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    const target = validUrl(new URL(response.headers.location, url).href);
    const forwarded = { ...headers };
    if (new URL(target).origin !== new URL(url).origin) {
      delete forwarded.authorization;
      delete forwarded.cookie;
      delete forwarded.origin;
      // A Referer can contain private page paths or query parameters. Never
      // disclose the originating page to a different origin during redirects.
      delete forwarded.referer;
    }
    return request(target, { method, headers: forwarded, signal, redirects: redirects + 1 });
  }
  response.finalUrl = url;
  return response;
}

export async function probe(url, headers, signal) {
  let response = await request(url, { method: 'HEAD', headers, signal });
  const headStatus = response.statusCode;
  const headHasMetadata = response.headers['content-length'] || response.headers['content-range'] ||
    response.headers['accept-ranges'] === 'bytes';
  if (![200, 206].includes(response.statusCode) || !headHasMetadata) {
    response.resume();
    response = await request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      const status = headStatus >= 400 ? headStatus : response.statusCode;
      throw new Error(`Server returned HTTP ${status}.`);
    }
  }
  const info = { status: response.statusCode, headers: response.headers, url: response.finalUrl };
  response.destroy();
  if (info.status < 200 || info.status >= 300) throw new Error(`Server returned HTTP ${info.status}.`);
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(info.headers['content-range'] || '');
  const total = range ? Number(range[1]) : Number(info.headers['content-length']);
  return { ...info, total: Number.isSafeInteger(total) && total >= 0 ? total : null,
    ranges: info.headers['accept-ranges'] === 'bytes' || info.status === 206,
    validator: info.headers.etag && !info.headers.etag.startsWith('W/') ? info.headers.etag : info.headers['last-modified'] || null };
}

// Candidates for retrying the same GET; session/URL recovery is a separate concern.
export const transientStatus = status => status === 408 || status === 429 || (status >= 500 && status <= 599 && ![501, 505].includes(status));

// Preserve the requested cooldown; the caller decides whether to wait or stop.
export function retryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
