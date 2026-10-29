// Sorted, merged set of half-open byte ranges [start, end). Used to track which parts of a file are
// completed (durable on disk) and which are claimed by an in-flight request.
export class RangeSet {
  constructor(list = []) {
    this.r = [];
    for (const item of list) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [a, b] = item;
      if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b > a) this.add(a, b);
    }
  }
  get size() { let n = 0; for (const [a, b] of this.r) n += b - a; return n; }
  get count() { return this.r.length; }
  add(start, end) {
    if (!(end > start)) return;
    const out = []; let a = start, b = end, placed = false;
    for (const [x, y] of this.r) {
      if (y < a) out.push([x, y]);
      else if (x > b) { if (!placed) { out.push([a, b]); placed = true; } out.push([x, y]); }
      else { a = Math.min(a, x); b = Math.max(b, y); }
    }
    if (!placed) out.push([a, b]);
    this.r = out;
  }
  remove(start, end) {
    if (!(end > start)) return;
    const out = [];
    for (const [x, y] of this.r) {
      if (y <= start || x >= end) { out.push([x, y]); continue; }
      if (x < start) out.push([x, start]);
      if (y > end) out.push([end, y]);
    }
    this.r = out;
  }
  // Number of bytes of [start, end) that are inside the set.
  covered(start, end) {
    let n = 0;
    for (const [x, y] of this.r) { if (y <= start) continue; if (x >= end) break; n += Math.min(y, end) - Math.max(x, start); }
    return n;
  }
  // End of the contiguous run that begins exactly at `from` (returns `from` when it is not covered).
  contiguousFrom(from = 0) {
    for (const [x, y] of this.r) { if (x <= from && y > from) return y; if (x > from) break; }
    return from;
  }
  // First uncovered [start, end) inside [from, limit), or null.
  firstGap(limit, from = 0) {
    let cursor = from;
    for (const [x, y] of this.r) {
      if (y <= cursor) continue;
      if (x > cursor) return [cursor, Math.min(x, limit)];
      cursor = y;
      if (cursor >= limit) return null;
    }
    return cursor < limit ? [cursor, limit] : null;
  }
  toJSON() { return this.r.map(([a, b]) => [a, b]); }
}
