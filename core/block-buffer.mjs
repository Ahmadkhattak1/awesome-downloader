// Fixed-size aggregation buffer for one download block.
//
// Buffers come from Buffer.allocUnsafe() (no zero-fill, so no wasted memset on every 2-4 MB block). That is only
// safe when no byte that was never written by the network can ever reach the disk. The class enforces that by
// construction: data can only be appended, and view() - the only way to obtain bytes for a disk write - throws unless
// every one of the `length` bytes has been overwritten with received data.
const CAPACITY = 4 * 1024 * 1024, KEEP = 4;
const free = [];

export class BlockBuffer {
  constructor(length) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError('Block length must be a positive integer.');
    this.length = length; this.filled = 0; this.released = false;
    this.data = length <= CAPACITY ? (free.pop() || Buffer.allocUnsafe(CAPACITY)) : Buffer.allocUnsafe(length);
  }
  get complete() { return this.filled === this.length; }
  get remaining() { return this.length - this.filled; }
  append(chunk) {
    if (this.released) throw new Error('Block buffer was already released.');
    if (this.filled + chunk.length > this.length) throw new RangeError('Server sent more bytes than requested.');
    chunk.copy(this.data, this.filled); this.filled += chunk.length;
  }
  view() {
    if (this.released) throw new Error('Block buffer was already released.');
    if (!this.complete) throw new Error(`Refusing to expose a partially filled block (${this.filled}/${this.length} bytes).`);
    return this.data.subarray(0, this.length);
  }
  release() {
    if (this.released) return;
    this.released = true;
    if (this.data.length === CAPACITY && free.length < KEEP) free.push(this.data);
    this.data = null;
  }
}
export const pooledBuffers = () => free.length;
