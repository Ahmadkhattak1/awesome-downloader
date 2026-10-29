import dns from 'node:dns';
import net from 'node:net';

// Process-wide DNS cache: stale-while-revalidate, in-flight de-duplication and
// round-robin over every resolved address so parallel connections spread across CDN nodes.
const FRESH = 5 * 60 * 1000, STALE = 60 * 60 * 1000;
const cache = new Map(), inflight = new Map();

function fetchList(host) {
  if (inflight.has(host)) return inflight.get(host);
  const p = dns.promises.lookup(host, { all: true }).then(list => {
    const previous = cache.get(host);
    cache.set(host, { list, at: Date.now(), rr: previous ? previous.rr : 0 });
    return list;
  }).finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}

export function seed(host, list) {
  if (Array.isArray(list) && list.length) cache.set(host, { list, at: Date.now(), rr: 0 });
}
export function peek(host) { return cache.get(host)?.list || null; }
export function clearDnsCache() { cache.clear(); }

export async function resolveHost(host) {
  const hit = cache.get(host), age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FRESH) return hit.list;
  if (hit && age < STALE) { fetchList(host).catch(() => {}); return hit.list; }
  try { return await fetchList(host); }
  catch (error) { if (hit) return hit.list; throw error; }
}

// Drop-in replacement for dns.lookup used by the HTTP agents.
export function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  if (net.isIP(hostname)) {
    const family = net.isIP(hostname);
    return options.all ? callback(null, [{ address: hostname, family }]) : callback(null, hostname, family);
  }
  resolveHost(hostname).then(list => {
    let pick = list;
    if (options.family === 4 || options.family === 6) pick = list.filter(a => a.family === options.family);
    if (!pick.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
    const entry = cache.get(hostname), n = entry ? entry.rr++ % pick.length : 0;
    if (n) pick = [...pick.slice(n), ...pick.slice(0, n)];
    if (options.all) callback(null, pick.map(a => ({ address: a.address, family: a.family })));
    else callback(null, pick[0].address, pick[0].family);
  }).catch(error => callback(error));
}

// Resolve hostnames ahead of use; never throws.
export function prefetch(urls) {
  const hosts = new Set();
  for (const value of urls) { try { const u = new URL(value); if (/^https?:$/.test(u.protocol)) hosts.add(u.hostname); } catch {} }
  return Promise.allSettled([...hosts].filter(h => !net.isIP(h)).map(resolveHost));
}
