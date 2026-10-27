import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './http.mjs';

const SLAB = 1024 * 1024, MAX_PENDING = 2;
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });

async function writeAll(fh, buffer, length, position) {
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await fh.write(buffer, done, length - done, position + done);
    if (!bytesWritten) throw new Error('Disk write made no progress.');
    done += bytesWritten;
  }
}

// Downloads bytes [start+offset, end] of `url` and writes them straight to their final position in `file`
// (direct seek-and-write: no per-segment temp files and no merge step). Runs identically on the main
// thread or inside a worker thread. Returns the number of bytes now present in the segment.
export async function downloadChunk({ url, headers, file, start, end, offset = 0, total, validator, protocol, signal, onBytes = () => {}, limitBps = 0, slabBytes = SLAB }) {
  const expected = end - start + 1;
  let done = offset, paceAt = 0;
  const slabSize = Math.max(16384, Math.min(slabBytes, expected)), free = [];
  const take = () => free.pop() || Buffer.allocUnsafe(slabSize); // recycled slabs: no per-flush allocation churn
  if (done >= expected) return done;
  const fh = await fs.open(file, 'r+');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal.aborted) throw abortError();
      let response, finished = false;
      const pending = [];
      try {
        const base = done, from = start + done, h = { ...headers, Range: `bytes=${from}-${end}` };
        if (validator) h['If-Range'] = validator;
        response = await request(url, { headers: h, signal, protocol });
        if (response.statusCode !== 206) throw new Error(`Server returned HTTP ${response.statusCode} instead of a byte range.`);
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
        if (!match || Number(match[1]) !== from || Number(match[2]) !== end || Number(match[3]) !== total) throw new Error('Server returned an inconsistent byte range.');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Server ignored identity encoding; refusing to save corrupt ranges.');
        // Zero-initialisation is skipped on purpose: every byte of a slab is overwritten before it is written.
        let slab = take(), fill = 0, position = from, received = 0, lastFlush = Date.now();
        const flush = length => {
          const buffer = slab, at = position;
          position += length; fill = 0; lastFlush = Date.now();
          slab = take();
          const task = writeAll(fh, buffer, length, at).then(() => { done += length; onBytes(length); free.push(buffer); });
          task.catch(() => {});
          pending.push(task);
        };
        for await (const chunk of response) {
          if (signal.aborted) throw abortError();
          if (base + received + chunk.length > expected) throw new Error('Server sent more bytes than requested.');
          received += chunk.length;
          if (limitBps) {
            const now = Date.now(), wait = Math.max(0, paceAt - now);
            paceAt = Math.max(now, paceAt) + chunk.length * 1000 / limitBps;
            if (wait) await delay(wait, undefined, { signal });
          }
          let at = 0;
          while (at < chunk.length) {
            const n = Math.min(chunk.length - at, slab.length - fill);
            chunk.copy(slab, fill, at, at + n); fill += n; at += n;
            if (fill === slab.length) { flush(fill); if (pending.length >= MAX_PENDING) await pending.shift(); }
          }
          // Time-based flush keeps progress / pause granularity fine on slow links without hurting fast ones.
          if (fill && Date.now() - lastFlush >= 30) { flush(fill); if (pending.length >= MAX_PENDING) await pending.shift(); }
        }
        if (fill) flush(fill);
        await Promise.all(pending);
        if (done !== expected) throw new Error('Connection ended before the segment finished.');
        finished = true;
        return done;
      } catch (error) {
        await Promise.allSettled(pending); // keep `done` exact before deciding how to resume
        if (signal.aborted || attempt === 3) throw signal.aborted ? abortError() : error;
        await delay(250 * 2 ** attempt, undefined, { signal });
      } finally { if (!finished) response?.destroy(); }
    }
  } finally { await fh.close(); }
  return done;
}
