import { EventEmitter } from 'node:events';
import { RangeSet } from './ranges.mjs';

const KiB = 1024, MiB = 1024 * KiB, BLOCK_STEP = 256 * KiB;
export const MIN_BLOCK = 2 * MiB, MAX_BLOCK = 4 * MiB, HUGE_BLOCK = 64 * MiB;
// Largest block for a file: small files keep 2-4 MB blocks; a 500 GB game would need ~125,000 requests at 4 MB, so the
// ceiling grows with the file (16 MB from 1 GiB, 32 MB from 16 GiB, 64 MB from 128 GiB). Speed and the memory budget still
// decide the actual size, so slow links keep small blocks.
export function maxBlockFor(total) {
  const GiB = 1024 * MiB;
  return total >= 128 * GiB ? HUGE_BLOCK : total >= 16 * GiB ? 32 * MiB : total >= GiB ? 16 * MiB : MAX_BLOCK;
}
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });

// Adaptive chunk sizing: fast connections get big blocks (fewer round trips), slow ones 2 MB (small loss if they
// stall or are dropped). Many parallel connections are capped by the memory budget but never go below 2 MB.
export function chooseBlockSize({ speed = 0, allowed = 1, memoryBudget = 256 * MiB, min = MIN_BLOCK, max = MAX_BLOCK, targetSeconds = 1.5 } = {}) {
  const memoryCap = Math.max(min, Math.floor(memoryBudget / Math.max(1, allowed)));
  const wanted = speed > 0 ? speed * targetSeconds : min;
  const size = Math.min(max, memoryCap, Math.max(min, wanted));
  return Math.max(min, Math.floor(size / BLOCK_STEP) * BLOCK_STEP);
}

// Splits a file into sequential 2-4 MB blocks and hands them to connection slots.
//  - Work stealing: every free slot takes the next unclaimed block, so faster connections / mirrors automatically
//    carry more of the file (bandwidth follows speed).
//  - Slow connections (far below the median of their peers) are aborted mid-block and put to sleep with back-off;
//    their block goes straight back to the queue. Slow mirrors are only probed occasionally.
//  - 429/503: the source's allowed connection count is halved (AIMD) and creeps back up when the server is calm.
//  - Endgame: when only a few blocks remain, an idle fast slot duplicates a straggler; the first copy to finish wins.
// I/O is injected through fetchBlock(), which keeps this class free of sockets and easy to test.
export class BlockScheduler extends EventEmitter {
  constructor({ total, done = [], sources, connections, fetchBlock, minBlock = MIN_BLOCK, maxBlock = MAX_BLOCK, memoryBudget = 256 * MiB,
    adaptive = true, slowRatio = 0.25, slowWarmupMs = 2000, tickMs = 400, maxAttempts = 5, recoverMs = 10000, dropCooldownMs = 10000, now = () => Date.now() }) {
    super();
    if (!Number.isSafeInteger(total) || total <= 0) throw new RangeError('A positive file size is required.');
    if (!sources?.length) throw new Error('At least one download source is required.');
    Object.assign(this, { total, fetchBlock, minBlock, maxBlock, memoryBudget, adaptive, slowRatio, slowWarmupMs, tickMs, maxAttempts, recoverMs, dropCooldownMs, now });
    this.connections = Math.max(1, connections);
    this.done = new RangeSet(done); this.claimed = new RangeSet(done);
    this.sources = sources.map((s, id) => ({ ...s, id, allowed: this.connections, ceiling: this.connections, active: 0, bytes: 0, speed: 0, samples: 0, errors: 0, errorStreak: 0,
      throttles: 0, throttleStreak: 0, cooldownUntil: 0, lastThrottleAt: 0, lastScaleAt: 0, lastRecoverAt: 0, lastProbeAt: 0, lastCeilingAt: 0, dead: false, multiplex: false }));
    this.slots = Array.from({ length: this.connections }, (_, index) => ({ index, speed: 0, samples: 0, sleepUntil: 0, drops: 0, attempt: null, source: null }));
    this.inflight = new Map(); this.attempts = new Set(); this.failures = new Map();
    this.failed = null; this.signal = null; this.waiters = new Set();
    this.stats_ = { throttles: 0, drops: 0, duplicates: 0, retries: 0 };
  }

  complete() { return this.done.covered(0, this.total) === this.total; }
  isOver() { return Boolean(this.failed) || Boolean(this.signal?.aborted) || this.complete(); }
  allowedTotal() { return Math.max(1, Math.min(this.connections, this.sources.reduce((n, s) => n + (s.dead ? 0 : s.allowed), 0))); }

  async run(signal) {
    this.signal = signal;
    if (signal.aborted) throw abortError();
    if (this.complete()) return;
    const onAbort = () => { this.abortAll('abort'); this.wake(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => this.tick(), this.tickMs);
    try { await Promise.all(this.slots.map(slot => this.slotLoop(slot).catch(error => this.fail(error)))); }
    finally { clearInterval(timer); signal.removeEventListener('abort', onAbort); }
    if (this.failed) throw this.failed;
    if (signal.aborted) throw abortError();
    if (!this.complete()) throw new Error('The download ended before every block was received.');
  }

  fail(error) { if (!this.failed) { this.failed = error; this.abortAll('failed'); } this.wake(); }
  abortAll(reason) { for (const a of this.attempts) { a.reason ||= reason; a.controller.abort(); } }
  wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(done); resolve(); }, Math.max(1, ms));
      const done = () => { clearTimeout(timer); resolve(); };
      this.waiters.add(done);
    });
  }

  async slotLoop(slot) {
    while (!this.isOver()) {
      const now = this.now();
      if (slot.sleepUntil > now) { await this.sleep(slot.sleepUntil - now); if (this.now() >= slot.sleepUntil) { slot.speed = 0; slot.samples = 0; } continue; }
      const source = this.pickSource(slot, now);
      if (!source) { await this.sleep(Math.min(500, this.nextSourceDelay(now) ?? 250)); continue; }
      let block = this.takeBlock(slot, source), duplicate = false;
      if (!block && this.adaptive) { block = this.pickDuplicate(slot, source, now); duplicate = Boolean(block); }
      if (!block) { if (!this.inflight.size) return; await this.sleep(100); continue; }
      await this.runAttempt(slot, source, block, duplicate);
    }
  }

  pickSource(slot, now) {
    const open = this.sources.filter(s => !s.dead && s.cooldownUntil <= now && s.active < s.allowed);
    if (!open.length) return null;
    let candidates = open;
    if (this.adaptive && open.length > 1) {
      const best = Math.max(...open.map(s => (s.samples ? s.speed : 0)));
      const fast = open.filter(s => !(s.samples >= 2 && best > 0 && s.speed < this.slowRatio * best && now - s.lastProbeAt < 20000));
      if (fast.length) candidates = fast;
    }
    const value = s => (s.samples ? s.speed : Infinity) / (s.active + 1);
    const chosen = candidates.reduce((a, b) => (value(b) > value(a) ? b : a));
    if (open.length > 1 && chosen.samples >= 2) chosen.lastProbeAt = now;
    return chosen;
  }
  nextSourceDelay(now) {
    const waits = this.sources.filter(s => !s.dead && s.cooldownUntil > now).map(s => s.cooldownUntil - now);
    return waits.length ? Math.min(...waits) : null;
  }

  takeBlock(slot, source) {
    const speed = this.adaptive ? (slot.speed || source.speed || 0) : 0;
    const size = chooseBlockSize({ speed, allowed: this.allowedTotal(), memoryBudget: this.memoryBudget, min: this.minBlock, max: this.adaptive ? this.maxBlock : this.minBlock });
    const gap = this.claimed.firstGap(this.total);
    if (!gap) return null;
    const start = gap[0];
    let end = Math.min(gap[1], start + size);
    if (end < gap[1] && gap[1] - end < this.minBlock) { // never leave a sliver smaller than the minimum block behind
      if (gap[1] - start <= this.maxBlock) end = gap[1];
      else if (gap[1] - this.minBlock - start >= this.minBlock) end = gap[1] - this.minBlock;
    }
    this.claimed.add(start, end);
    const block = { start, end: end - 1, size: end - start, attempts: new Set() };
    this.inflight.set(start, block);
    return block;
  }
  requeue(block) {
    if (block.attempts.size || this.done.covered(block.start, block.end + 1) === block.size) return;
    this.claimed.remove(block.start, block.end + 1); this.inflight.delete(block.start);
  }

  pickDuplicate(slot, source, now) {
    let best = null, worst = 0;
    const mine = slot.speed || source.speed || this.medianSpeed(now) || 0;
    if (!mine) return null;
    for (const block of this.inflight.values()) {
      if (block.attempts.size !== 1) continue;
      const [a] = block.attempts, elapsed = now - a.startedAt;
      if (a.slot === slot || elapsed < 1000) continue;
      const projected = (block.size - a.received) / Math.max(1, a.received * 1000 / elapsed);
      if (projected > 2 * (block.size / mine) + 0.5 && projected > worst) { best = block; worst = projected; }
    }
    if (best) this.stats_.duplicates++;
    return best;
  }
  attemptSpeed(a, now) { const elapsed = now - a.startedAt; return elapsed > 0 ? a.received * 1000 / elapsed : 0; }
  medianSpeed(now) {
    const speeds = [...this.attempts].filter(a => now - a.startedAt >= this.slowWarmupMs).map(a => this.attemptSpeed(a, now)).sort((x, y) => x - y);
    return speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
  }

  async runAttempt(slot, source, block, duplicate) {
    const controller = new AbortController();
    const attempt = { slot, source, block, controller, received: 0, startedAt: this.now(), reason: null, duplicate };
    block.attempts.add(attempt); this.attempts.add(attempt); slot.attempt = attempt; slot.source = source; source.active++;
    let outcome = null;
    try {
      await this.fetchBlock({ source, start: block.start, end: block.end, slot: slot.index, signal: AbortSignal.any([this.signal, controller.signal]),
        onBytes: n => { attempt.received += n; source.bytes += n; } });
    } catch (error) { outcome = error; }
    finally { source.active--; slot.attempt = null; block.attempts.delete(attempt); this.attempts.delete(attempt); this.wake(); }
    const now = this.now();
    if (!outcome) return this.succeeded(slot, source, block, attempt, now);
    if (this.done.covered(block.start, block.end + 1) === block.size) return; // lost a duplicate race
    this.requeue(block);
    if (this.signal.aborted || this.failed) return;
    if (attempt.reason === 'slow') return this.dropSlot(slot, source, attempt, now);
    if (attempt.reason === 'duplicate') return;
    if (outcome.code === 'THROTTLED') return this.onThrottle(source, outcome, now);
    source.errors++; source.errorStreak++; this.stats_.retries++;
    const failures = (this.failures.get(block.start) || 0) + 1; this.failures.set(block.start, failures);
    const allBad = this.sources.every(s => s.dead || s.errorStreak >= 3);
    if (failures >= this.maxAttempts && (allBad || failures >= this.maxAttempts * 2)) return this.fail(outcome);
    if (this.sources.length > 1 && source.errorStreak >= 3) {
      source.cooldownUntil = now + 30000;
      if (source.errorStreak >= 6) { source.dead = true; this.emit('source-dead', { source, error: outcome }); }
    }
    if (this.sources.every(s => s.dead)) return this.fail(outcome);
    slot.sleepUntil = now + Math.min(4000, 250 * 2 ** Math.min(failures, 4));
  }

  succeeded(slot, source, block, attempt, now) {
    const speed = block.size * 1000 / Math.max(1, now - attempt.startedAt);
    slot.speed = slot.samples ? 0.6 * slot.speed + 0.4 * speed : speed; slot.samples++;
    source.speed = source.samples ? 0.6 * source.speed + 0.4 * speed : speed; source.samples++;
    source.errorStreak = 0; source.throttleStreak = 0;
    if (this.done.covered(block.start, block.end + 1) !== block.size) {
      this.done.add(block.start, block.end + 1); this.inflight.delete(block.start); this.failures.delete(block.start);
      for (const other of block.attempts) { other.reason ||= 'duplicate'; other.controller.abort(); }
      this.emit('block', { start: block.start, end: block.end, source: source.id });
    }
  }

  dropSlot(slot, source, attempt, now) {
    const speed = this.attemptSpeed(attempt, now);
    source.speed = source.samples ? 0.5 * source.speed + 0.5 * speed : speed; source.samples++;
    slot.sleepUntil = now + Math.min(120000, this.dropCooldownMs * 2 ** Math.min(slot.drops, 4)); slot.drops++;
    this.stats_.drops++;
    this.emit('drop', { slot: slot.index, source: source.id, bytesPerSecond: speed });
  }

  onThrottle(source, error, now) {
    this.stats_.throttles++; source.throttles++;
    const firstOfBurst = now - source.lastScaleAt > 1000; // many in-flight requests get the same 429 at once: react once
    if (firstOfBurst) {
      const before = source.allowed;
      source.allowed = Math.max(1, Math.floor(before / 2));
      source.ceiling = Math.max(1, Math.min(source.ceiling, before - 1));
      source.lastScaleAt = now; source.throttleStreak++;
    }
    source.lastThrottleAt = now; source.multiplex = true;
    const wait = Math.max(error.retryAfterMs || 0, Math.min(8000, 500 * 2 ** Math.min(source.throttleStreak, 4)));
    source.cooldownUntil = Math.max(source.cooldownUntil, now + wait);
    this.emit('throttle', { source, statusCode: error.statusCode, waitMs: wait, allowed: source.allowed });
  }

  tick() {
    const now = this.now();
    for (const s of this.sources) {
      if (s.dead) continue;
      if (s.allowed < s.ceiling && now - Math.max(s.lastThrottleAt, s.lastRecoverAt) >= this.recoverMs) { s.allowed++; s.lastRecoverAt = now; this.emit('scale', { source: s, allowed: s.allowed }); }
      else if (s.allowed === s.ceiling && s.ceiling < this.connections && now - Math.max(s.lastThrottleAt, s.lastCeilingAt) >= 6 * this.recoverMs) { s.ceiling++; s.lastCeilingAt = now; }
    }
    if (!this.adaptive) return;
    const live = [...this.attempts].filter(a => now - a.startedAt >= this.slowWarmupMs && !a.reason);
    if (!live.length) return;
    // Reference speeds: running attempts past warm-up plus the recent speed of slots that are between blocks.
    const refs = [];
    for (const slot of this.slots) {
      if (slot.attempt) { if (now - slot.attempt.startedAt >= this.slowWarmupMs) refs.push(this.attemptSpeed(slot.attempt, now)); }
      else if (slot.samples > 0 && slot.speed > 0 && slot.sleepUntil <= now) refs.push(slot.speed);
    }
    if (refs.length < 3) return;
    refs.sort((x, y) => x - y);
    const median = refs[Math.floor(refs.length / 2)];
    const slowest = live.reduce((a, b) => (this.attemptSpeed(b, now) < this.attemptSpeed(a, now) ? b : a));
    if (median > 0 && this.attemptSpeed(slowest, now) < this.slowRatio * median) { slowest.reason = 'slow'; slowest.controller.abort(); }
  }

  // Bytes finished plus the partial progress of blocks still on the wire.
  downloaded() {
    let partial = 0;
    for (const block of this.inflight.values()) { let best = 0; for (const a of block.attempts) best = Math.max(best, a.received); partial += Math.min(best, block.size); }
    return Math.min(this.total, this.done.size + partial);
  }
  // [start, start + received) for every block still on the wire (progress display).
  partialRanges() {
    const out = [];
    for (const block of this.inflight.values()) { let best = 0; for (const a of block.attempts) best = Math.max(best, a.received); if (best) out.push([block.start, block.start + Math.min(best, block.size)]); }
    return out;
  }
  snapshot() {
    const now = this.now();
    return {
      allowed: this.allowedTotal(), configured: this.connections, active: this.attempts.size, ...this.stats_,
      sources: this.sources.map(s => ({ id: s.id, url: s.url, label: s.label, protocol: s.protocol, active: s.active, allowed: s.allowed, speed: Math.round(s.speed), bytes: s.bytes, throttles: s.throttles, errors: s.errors,
        dead: s.dead, coolingMs: Math.max(0, s.cooldownUntil - now), multiplex: s.multiplex })),
      slots: this.slots.map(sl => ({ index: sl.index, active: Boolean(sl.attempt), speed: Math.round(sl.attempt ? this.attemptSpeed(sl.attempt, now) : sl.speed), source: sl.source?.id ?? null, sleeping: sl.sleepUntil > now }))
    };
  }
}
