import { promises as fs } from 'node:fs';

// WebTorrent is loaded on first use so ordinary HTTP downloads never pay for it.
let sharedClient = null;
let loadingClient = null;

async function clientFor(provided) {
  if (provided) return provided;
  if (sharedClient) return sharedClient;
  loadingClient ||= (async () => {
    const { default: WebTorrent } = await import('webtorrent');
    const client = new WebTorrent({ dht: true, tracker: true, lsd: true });
    // Engine failures are surfaced per torrent; a swarm warning must not crash the app.
    client.on('error', () => {});
    return client;
  })();
  sharedClient = await loadingClient;
  loadingClient = null;
  return sharedClient;
}

export async function destroySharedTorrentClient() {
  const client = sharedClient;
  sharedClient = null;
  if (!client) return;
  await new Promise(resolve => {
    try { client.destroy(() => resolve()); } catch { resolve(); }
  });
}

const describe = torrent => ({
  name: torrent.name || '',
  infoHash: torrent.infoHash,
  length: torrent.length || 0,
  files: torrent.files.map(file => ({ path: file.path || file.name, length: file.length }))
});

export async function downloadTorrent({ source, directory, signal, client, onMetadata, onProgress, tickMs = 500 }) {
  const torrentClient = await clientFor(client);
  await fs.mkdir(directory, { recursive: true });
  if (signal?.aborted) throw Object.assign(new Error('Torrent download cancelled.'), { name: 'AbortError' });

  return new Promise((resolve, reject) => {
    let torrent = null, ticker = null, settled = false, lastBytes = 0, lastAt = Date.now(), speed = 0;
    const cleanup = () => {
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true; cleanup();
      resolve(describe(torrent));
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup();
      // Keep the downloaded pieces on disk so the next attempt can reuse them.
      try { torrent?.destroy({ destroyStore: false }, () => {}); } catch { /* already gone */ }
      reject(error);
    };
    const onAbort = () => fail(Object.assign(new Error('Torrent download cancelled.'), { name: 'AbortError' }));

    try {
      torrent = torrentClient.add(source, { path: directory });
    } catch (error) { fail(error); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const announce = () => {
      if (!torrent.length) return;
      try { onMetadata?.(describe(torrent)); } catch { /* observers must not break the transfer */ }
    };
    torrent.on('metadata', announce);
    torrent.on('ready', announce);
    torrent.on('error', fail);
    torrent.on('warning', () => {});
    torrent.on('done', finish);

    ticker = setInterval(() => {
      const now = Date.now();
      if (now > lastAt) {
        speed = Math.max(0, (torrent.downloaded - lastBytes) * 1000 / (now - lastAt));
        lastBytes = torrent.downloaded; lastAt = now;
      }
      try {
        onProgress?.({
          downloaded: torrent.downloaded,
          length: torrent.length || null,
          speed,
          peers: torrent.numPeers || 0,
          progress: torrent.progress || 0
        });
      } catch { /* observers must not break the transfer */ }
      if (torrent.done) finish();
    }, tickMs);
    // A seeded or already-complete torrent never emits a fresh 'done'.
    if (torrent.done) finish();
  });
}
