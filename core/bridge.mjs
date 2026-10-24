import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {youtubeFormats} from './youtube.mjs';

export async function startBridge(engine, { dataDirectory, port = 17843, onDownload } = {}) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const answer = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    // Browser pages cannot submit requests: no CORS and explicit origin rejection.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}`) return answer(403, { error: 'Forbidden origin or host.' });
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return answer(401, { error: 'Unauthorized.' });
    if (req.method === 'GET' && req.url === '/health') return answer(200, { ok: true, version: '0.1.0' });
    if (req.method !== 'POST' || !['/downloads','/formats'].includes(req.url)) return answer(404, { error: 'Not found.' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return answer(415, { error: 'JSON required.' });
    let size = 0;
    try {
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { answer(413, { error: 'Request too large.' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.url==='/formats')return answer(200,{ok:true,items:await youtubeFormats(body.url)});
      // Browser callers cannot select filesystem destinations or arbitrary app actions.
      const payload = { url: body.url, youtubeFormat:body.youtubeFormat, sabr:body.sabr, startNow: body.startNow === true, audioUrl: body.audioUrl, outputFormat:body.outputFormat, urls: body.urls, filename: body.filename, referer: body.referer, headers: body.headers };
      const ids = await (onDownload ? onDownload(payload) : engine.add(payload));
      answer(201, { ok: true, ids });
    } catch (error) { if (!res.headersSent) answer([429,422].includes(error.statusCode)?error.statusCode:400, { error: error.message }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  await fs.mkdir(dataDirectory, { recursive: true });
  const configPath = path.join(dataDirectory, 'bridge.json');
  try { await fs.writeFile(configPath, JSON.stringify({ port: actualPort, token }), { mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  return { port: actualPort, async close() {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    try { const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); if (saved.token === token) await fs.unlink(configPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } };
}
