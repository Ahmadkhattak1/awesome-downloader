import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { youtubeFormats } from './youtube.mjs';
import type { AddOptions, DownloadEngine } from './engine.mjs';

export interface BridgeDownload extends AddOptions {
  startNow: boolean;
}

export async function startBridge(
  engine: DownloadEngine,
  {
    dataDirectory,
    port = 17843,
    onDownload,
  }: {
    dataDirectory: string;
    port?: number;
    onDownload?: (payload: BridgeDownload) => Promise<string[]> | string[];
  },
) {
  const token = randomBytes(32).toString('hex');

  const server = http.createServer(async (req, res) => {
    const answer = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };

    // Browser pages cannot submit requests: no CORS and explicit origin rejection.
    if (
      req.headers.origin ||
      req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`
    ) {
      answer(403, { error: 'Forbidden origin or host.' });
      return;
    }

    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);

    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      answer(401, { error: 'Unauthorized.' });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      answer(200, { ok: true, version: '0.1.0' });
      return;
    }

    if (req.method !== 'POST' || !['/downloads', '/formats'].includes(req.url ?? '')) {
      answer(404, { error: 'Not found.' });
      return;
    }

    if (!String(req.headers['content-type']).startsWith('application/json')) {
      answer(415, { error: 'JSON required.' });
      return;
    }

    let size = 0;

    try {
      const chunks: Buffer[] = [];

      for await (const chunk of req) {
        size += chunk.length;

        if (size > 1024 * 1024) {
          answer(413, { error: 'Request too large.' });
          req.destroy();
          return;
        }

        chunks.push(chunk);
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (req.url === '/formats') {
        answer(200, { ok: true, items: await youtubeFormats(body.url) });
        return;
      }

      // Browser callers cannot select filesystem destinations or arbitrary app actions.
      const payload: BridgeDownload = {
        url: body.url,
        youtubeFormat: body.youtubeFormat,
        sabr: body.sabr,
        startNow: body.startNow === true,
        audioUrl: body.audioUrl,
        outputFormat: body.outputFormat,
        urls: body.urls,
        filename: body.filename,
        referer: body.referer,
        headers: body.headers,
      };

      const ids = await (onDownload ? onDownload(payload) : engine.add(payload));
      answer(201, { ok: true, ids });
    } catch (error) {
      const { statusCode, message } = error as Error & { statusCode?: number };

      if (!res.headersSent) {
        answer(statusCode === 429 || statusCode === 422 ? statusCode : 400, {
          error: message,
        });
      }
    }
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = (server.address() as AddressInfo).port;
  await fs.mkdir(dataDirectory, { recursive: true });
  const configPath = path.join(dataDirectory, 'bridge.json');

  try {
    await fs.writeFile(configPath, JSON.stringify({ port: actualPort, token }), { mode: 0o600 });
  } catch (error) {
    server.close();
    throw error;
  }

  return {
    port: actualPort,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });

      try {
        const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));

        if (saved.token === token) {
          await fs.unlink(configPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    },
  };
}
