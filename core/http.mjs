import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { lookup } from './dns.mjs';

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

const H2_STREAM_WINDOW = 8 * 1024 * 1024, H2_SESSION_WINDOW = 64 * 1024 * 1024;
const config = { ca: undefined, http2: true, maxH2Sessions: 2 };
let agents = null;
const h2Origins = new Map(), h2Pools = new Map();
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });

export function transportConfig() { return { ca: config.ca, http2: config.http2, maxH2Sessions: config.maxH2Sessions }; }
export function configureTransport(next = {}) {
  for (const key of ['ca', 'http2', 'maxH2Sessions']) if (next[key] !== undefined) config[key] = next[key];
  agents = null; h2Origins.clear();
  for (const pool of h2Pools.values()) for (const e of pool.sessions) e.session.close();
  h2Pools.clear();
}
function getAgents() {
  // Keep-alive pools reuse TCP/TLS connections across segments; lookup() is the cached resolver.
  return agents ||= {
    http: new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxFreeSockets: 128, scheduling: 'lifo', lookup }),
    https: new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxFreeSockets: 128, scheduling: 'lifo', lookup, ca: config.ca })
  };
}

function openH2(origin) {
  return new Promise(resolve => {
    const u = new URL(origin);
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: isIP(u.hostname) ? undefined : u.hostname, ALPNProtocols: ['h2', 'http/1.1'], lookup, ca: config.ca });
    socket.setNoDelay(true);
    const fail = () => { socket.destroy(); resolve(null); };
    socket.setTimeout(15000, fail);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      if (socket.alpnProtocol !== 'h2') { socket.destroy(); return resolve('http/1.1'); }
      socket.removeListener('error', fail);
      const session = http2.connect(origin, { createConnection: () => socket, maxSessionMemory: 512,
        settings: { initialWindowSize: H2_STREAM_WINDOW, enablePush: false } });
      const tune = () => { try { session.setLocalWindowSize(H2_SESSION_WINDOW); } catch {} };
      if (session.connecting) session.once('connect', tune); else tune();
      session.on('error', () => {});
      session.unref();
      resolve(session);
    });
  });
}

// Returns a pooled HTTP/2 session entry, or null when the origin only speaks HTTP/1.1.
async function acquireH2(origin) {
  const known = h2Origins.get(origin);
  if (known && known.expires > Date.now() && known.protocol === 'http/1.1') return null;
  let pool = h2Pools.get(origin);
  if (!pool) h2Pools.set(origin, pool = { sessions: [], opening: [] });
  for (;;) {
    pool.sessions = pool.sessions.filter(e => !e.session.closed && !e.session.destroyed);
    if (pool.sessions.length + pool.opening.length < config.maxH2Sessions) {
      const attempt = openH2(origin).then(result => {
        pool.opening = pool.opening.filter(x => x !== attempt);
        if (result && typeof result === 'object') {
          const entry = { session: result, active: 0 };
          const drop = () => { pool.sessions = pool.sessions.filter(e => e !== entry); };
          result.on('close', drop); result.on('goaway', drop);
          result.setTimeout(45000, () => { if (!entry.active) result.close(); });
          pool.sessions.push(entry);
          h2Origins.set(origin, { protocol: 'h2', expires: Date.now() + 600000 });
        } else h2Origins.set(origin, { protocol: 'http/1.1', expires: Date.now() + (result ? 600000 : 30000) });
        return result;
      });
      pool.opening.push(attempt);
      if (!pool.sessions.length) { await attempt; if (!pool.sessions.length) return null; }
    }
    if (pool.sessions.length) return pool.sessions.reduce((a, e) => e.active < a.active ? e : a);
    if (!pool.opening.length) return null;
    await Promise.allSettled(pool.opening);
  }
}

function requestH2(entry, url, { method, headers, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const out = { ':method': method, ':path': u.pathname + u.search, ':scheme': 'https', ':authority': u.host };
    for (const [key, value] of Object.entries(headers)) {
      const name = key.toLowerCase();
      if (!['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'].includes(name)) out[name] = value;
    }
    let stream;
    try { stream = entry.session.request(out, { endStream: true }); } catch (error) { return reject(error); }
    entry.active++;
    stream.once('close', () => { entry.active--; });
    stream.on('error', () => {});
    const cancel = () => stream.close(http2.constants.NGHTTP2_CANCEL);
    if (signal) signal.addEventListener('abort', () => { cancel(); reject(abortError()); }, { once: true });
    stream.setTimeout(30000, () => stream.destroy(new Error('Connection timed out.')));
    stream.once('error', reject);
    stream.once('response', raw => {
      const headersOut = {};
      for (const [key, value] of Object.entries(raw)) if (!key.startsWith(':')) headersOut[key] = value;
      stream.statusCode = Number(raw[':status']); stream.headers = headersOut; stream.protocol = 'h2';
      stream.removeListener('error', reject);
      resolve(stream);
    });
  });
}

function requestH1(url, { method, headers, signal }) {
  return new Promise((resolve, reject) => {
    const secure = url.startsWith('https:');
    const req = (secure ? https : http).request(url, { method, headers, signal, agent: secure ? getAgents().https : getAgents().http }, res => { res.protocol = 'http/1.1'; resolve(res); });
    req.on('socket', socket => { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Connection timed out.')));
    req.end();
  });
}

export async function request(url, { method = 'GET', headers = {}, signal, redirects = 0, protocol } = {}) {
  url = validUrl(url);
  if (redirects > 10) throw new Error('Too many redirects.');
  if (signal?.aborted) throw abortError();
  let response;
  {
    const entry = config.http2 && protocol !== 'http/1.1' && url.startsWith('https:') ? await acquireH2(new URL(url).origin) : null;
    response = entry ? await requestH2(entry, url, { method, headers, signal }) : await requestH1(url, { method, headers, signal });
  }
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    const target = validUrl(new URL(response.headers.location, url).href);
    const forwarded = { ...headers };
    if (new URL(target).origin !== new URL(url).origin) {
      delete forwarded.authorization;
      delete forwarded.cookie;
      delete forwarded.origin;
    }
    return request(target, { method, headers: forwarded, signal, redirects: redirects + 1, protocol });
  }
  response.finalUrl = url;
  return response;
}

export async function probe(url, headers, signal) {
  let response = await request(url, { method: 'HEAD', headers, signal }), head = true;
  if ([405, 501].includes(response.statusCode)) {
    head = false; response.resume();
    response = await request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
  }
  const info = { status: response.statusCode, headers: response.headers, url: response.finalUrl, protocol: response.protocol || 'http/1.1' };
  // A HEAD reply has no body, so draining it lets the pooled connection be reused by the transfer.
  if (head) response.resume(); else response.destroy();
  if (info.status < 200 || info.status >= 300) throw new Error(`Server returned HTTP ${info.status}.`);
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(info.headers['content-range'] || '');
  const total = range ? Number(range[1]) : Number(info.headers['content-length']);
  return { ...info, total: Number.isSafeInteger(total) && total >= 0 ? total : null,
    ranges: info.headers['accept-ranges'] === 'bytes' || info.status === 206,
    validator: info.headers.etag && !info.headers.etag.startsWith('W/') ? info.headers.etag : info.headers['last-modified'] || null };
}
