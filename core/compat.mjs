// Runtime compatibility shims for older Node versions (e.g. Electron 22 / Node 16 used by the
// Windows 7/8/8.1 build). Every shim is a no-op when the feature already exists, so modern
// 64-bit builds are unaffected.
if (typeof AbortSignal.any !== 'function') {
  AbortSignal.any = signals => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); break; }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
}
if (!Array.prototype.findLast) {
  Object.defineProperty(Array.prototype, 'findLast', { configurable: true, writable: true, value(predicate, thisArg) {
    for (let i = this.length - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  } });
}
export const hasFetch = typeof globalThis.fetch === 'function';
