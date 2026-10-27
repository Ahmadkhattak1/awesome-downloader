import { setTimeout as delay } from 'node:timers/promises';
import { request, throttleFrom } from './http.mjs';
import { BlockBuffer } from './block-buffer.mjs';
import { defaultWriteQueue } from './write-queue.mjs';

export const MIN_BLOCK = 2 * 1024 * 1024, MAX_BLOCK = 4 * 1024 * 1024;
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });

// Downloads bytes [start, end] (inclusive) of `url` into ONE in-memory block, then hands the finished block to the
// write queue, which stores it at its final position in `file` (direct seek-and-write: no temp parts, no merge step).
//
// Network chunks are aggregated into a BlockBuffer (allocUnsafe-backed). The block is written only after every byte of
// it was overwritten by socket data; a connection that dies part-way resumes from the filled offset and a block that
// cannot be completed is discarded, never written. Runs identically on the main thread or inside a worker thread.
// A 429/503 reply rejects with ThrottleError (never retried here) so the scheduler can scale connections down.
export async function downloadBlock({ url, headers, file, start, end, total, validator, protocol, signal, onBytes = () => {}, limitBps = 0, attempts = 3, writeQueue = defaultWriteQueue }) {
  const length = end - start + 1;
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError('Invalid block range.');
  const block = new BlockBuffer(length);
  let paceAt = 0;
  try {
    for (let attempt = 0; attempt < attempts && !block.complete; attempt++) {
      if (signal.aborted) throw abortError();
      let response, finished = false;
      try {
        const from = start + block.filled, h = { ...headers, Range: `bytes=${from}-${end}` };
        if (validator) h['If-Range'] = validator;
        response = await request(url, { headers: h, signal, protocol });
        const throttle = throttleFrom(response);
        if (throttle) throw throttle;
        if (response.statusCode !== 206) throw new Error(`Server returned HTTP ${response.statusCode} instead of a byte range.`);
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
        if (!match || Number(match[1]) !== from || Number(match[2]) !== end || Number(match[3]) !== total) throw new Error('Server returned an inconsistent byte range.');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Server ignored identity encoding; refusing to save corrupt ranges.');
        for await (const chunk of response) {
          if (signal.aborted) throw abortError();
          block.append(chunk); onBytes(chunk.length);
          if (limitBps) {
            const now = Date.now(), wait = Math.max(0, paceAt - now);
            paceAt = Math.max(now, paceAt) + chunk.length * 1000 / limitBps;
            if (wait) await delay(wait, undefined, { signal });
          }
        }
        if (!block.complete) throw new Error('Connection ended before the block finished.');
        finished = true;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error.code === 'THROTTLED' || attempt === attempts - 1) throw error;
        await delay(250 * 2 ** attempt, undefined, { signal });
      } finally { if (!finished) response?.destroy(); }
    }
    // Invariant behind allocUnsafe(): nothing is written unless all `length` bytes came from the socket.
    if (!block.complete) throw new Error('Block was not completely received.');
    await writeQueue.write(file, start, block);
    return length;
  } finally { block.release(); }
}

// Sequential helper (used when a caller wants a whole range rather than scheduling blocks itself).
export async function downloadChunk({ start, end, offset = 0, onBytes = () => {}, ...rest }) {
  for (let position = start + offset; position <= end;) {
    const stop = Math.min(end, position + MAX_BLOCK - 1);
    await downloadBlock({ ...rest, start: position, end: stop, onBytes });
    position = stop + 1;
  }
  return end - start + 1;
}
