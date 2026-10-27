import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

const READ = 4 * 1024 * 1024;

// Incremental hashing of a file that is still being downloaded. advance(n) hashes the bytes [position, n) from disk;
// callers only pass offsets of the contiguous, fully written prefix, so the digest is of the final file's content.
// The read buffer comes from allocUnsafe(): only bytes actually returned by read() are fed to the hash.
export class HashSession {
  constructor(file, algorithms = ['sha256', 'md5']) {
    this.file = file; this.position = 0; this.chain = Promise.resolve(); this.error = null;
    this.hashes = Object.fromEntries(algorithms.map(a => [a, createHash(a)]));
  }
  advance(upTo) {
    this.chain = this.chain.then(() => (this.error ? undefined : this.readTo(upTo))).catch(error => { this.error ||= error; });
    return this.chain;
  }
  async readTo(upTo) {
    if (upTo <= this.position) return;
    const fh = await fs.open(this.file, 'r'), buffer = Buffer.allocUnsafe(READ);
    try {
      while (this.position < upTo) {
        const want = Math.min(READ, upTo - this.position);
        const { bytesRead } = await fh.read(buffer, 0, want, this.position);
        if (!bytesRead) throw new Error('The downloaded file is shorter than expected while hashing.');
        const chunk = buffer.subarray(0, bytesRead);
        for (const hash of Object.values(this.hashes)) hash.update(chunk);
        this.position += bytesRead;
      }
    } finally { await fh.close(); }
  }
  async digest(total) {
    await this.advance(total);
    if (this.error) throw this.error;
    if (this.position !== total) throw new Error('Hashing did not cover the whole file.');
    return Object.fromEntries(Object.entries(this.hashes).map(([name, hash]) => [name, hash.digest('hex')]));
  }
}
