import { promises as fs } from 'node:fs';

// In-memory write queue. Completed blocks wait here and are flushed to disk in ascending file order (sequential
// access pattern, at most `concurrency` writes in flight). Each write opens its own short-lived handle, so no
// handle can outlive a download and block the final rename on Windows.
async function writeAll(fh, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const { bytesWritten } = await fh.write(buffer, done, buffer.length - done, position + done);
    if (!bytesWritten) throw new Error('Disk write made no progress.');
    done += bytesWritten;
  }
}

export class WriteQueue {
  constructor({ concurrency = 2 } = {}) { this.concurrency = concurrency; this.items = []; this.running = 0; }
  get pending() { return this.items.length + this.running; }
  // `block` must be a BlockBuffer; block.view() throws unless every byte was overwritten by received data.
  write(file, position, block) {
    const buffer = block.view();
    return new Promise((resolve, reject) => {
      this.items.push({ file, position, buffer, resolve, reject });
      this.items.sort((a, b) => a.position - b.position);
      this.pump();
    });
  }
  pump() {
    while (this.running < this.concurrency && this.items.length) {
      const item = this.items.shift();
      this.running++;
      (async () => {
        const fh = await fs.open(item.file, 'r+');
        try { await writeAll(fh, item.buffer, item.position); } finally { await fh.close(); }
      })().then(item.resolve, item.reject).finally(() => { this.running--; this.pump(); });
    }
  }
}
export const defaultWriteQueue = new WriteQueue();
