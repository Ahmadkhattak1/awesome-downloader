import type { Segment } from './types.mjs';

// eslint-disable-next-line import/prefer-default-export -- core modules use named exports
export function streamProgress(segments: Segment[]) {
  const complete = segments.filter((segment) => segment.done);
  const downloaded = segments.reduce((sum, segment) => sum + segment.downloaded, 0);
  const completedBytes = complete.reduce((sum, segment) => sum + segment.downloaded, 0);
  return {
    completed: complete.length,
    total: segments.length,
    estimatedBytes:
      complete.length >= 2 && complete.length < segments.length
        ? Math.max(downloaded, (completedBytes / complete.length) * segments.length)
        : null,
  };
}
