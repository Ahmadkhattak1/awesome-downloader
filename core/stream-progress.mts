import type { Segment } from './types.mjs';

// eslint-disable-next-line import/prefer-default-export -- core modules use named exports
export function streamProgress(segments: Segment[]) {
  const complete = segments.filter((s) => s.done);
  const downloaded = segments.reduce((n, s) => n + s.downloaded, 0);
  const completedBytes = complete.reduce((n, s) => n + s.downloaded, 0);
  return {
    completed: complete.length,
    total: segments.length,
    estimatedBytes:
      complete.length >= 2 && complete.length < segments.length
        ? Math.max(downloaded, (completedBytes / complete.length) * segments.length)
        : null,
  };
}
