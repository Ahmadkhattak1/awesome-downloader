/**
 * @file Core system constants, enums, and configuration thresholds for Awesome Downloader.
 * Eliminates magic numbers and inline string literals across the engine and transport layers.
 */

/**
 * Enumeration of standardized download lifecycle statuses.
 * @readonly
 * @enum {string}
 */
export const DownloadStatus = Object.freeze({
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  DOWNLOADING: 'downloading',
  ASSEMBLING: 'assembling',
  COMPLETE: 'complete',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  SCHEDULED: 'scheduled'
});

/**
 * Transient states representing active processing pipelines.
 * @type {ReadonlySet<string>}
 */
export const TRANSIENT_STATUSES = Object.freeze(new Set([
  DownloadStatus.DOWNLOADING,
  'probing',
  DownloadStatus.ASSEMBLING
]));

/**
 * Lifecycle and control actions dispatchable to download entities.
 * @readonly
 * @enum {string}
 */
export const DownloadAction = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  RETRY: 'retry',
  CANCEL: 'cancel',
  REMOVE: 'remove'
});

/**
 * High-level categorization groupings for downloaded files.
 * @readonly
 * @enum {string}
 */
export const DownloadCategory = Object.freeze({
  VIDEO: 'Video',
  AUDIO: 'Audio',
  ARCHIVES: 'Archives',
  DOCUMENTS: 'Documents',
  PROGRAMS: 'Programs',
  OTHER: 'Other'
});

/**
 * Supported cryptographic hash algorithms for file integrity verification.
 * @readonly
 * @enum {string}
 */
export const HashAlgorithm = Object.freeze({
  MD5: 'md5',
  SHA256: 'sha256'
});

/**
 * Extension pattern matcher by high-level category.
 * @type {Readonly<Record<string, RegExp>>}
 */
export const CATEGORY_PATTERNS = Object.freeze({
  [DownloadCategory.VIDEO]: /\.(mp4|webm|mkv|mov|avi|m4v)$/i,
  [DownloadCategory.AUDIO]: /\.(mp3|m4a|aac|flac|ogg|wav)$/i,
  [DownloadCategory.ARCHIVES]: /\.(zip|7z|rar|tar|gz|iso)$/i,
  [DownloadCategory.DOCUMENTS]: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub)$/i,
  [DownloadCategory.PROGRAMS]: /\.(exe|msi|msix)$/i
});

/**
 * Core engine configuration and operational numerical constants.
 * @readonly
 */
export const EngineLimits = Object.freeze({
  DEFAULT_MAX_CONCURRENT: 3,
  MAX_ALLOWED_CONCURRENT: 16,
  DEFAULT_CONNECTIONS_PER_FILE: 8,
  MAX_CONNECTIONS_PER_FILE: 32,
  MAX_SPEED_LIMIT_KBPS: 1048576,
  DEFAULT_TICK_MS: 500,
  MIN_CHUNK_BYTES: 512 * 1024,
  SEGMENT_SPLIT_THRESHOLD_BYTES: 2 * 1024 * 1024,
  MAX_URLS_PER_BATCH: 500,
  MAX_DESCRIPTION_LENGTH: 4096,
  MAX_FILENAME_LENGTH: 180,
  MAX_NETWORK_RETRIES: 4,
  INITIAL_RETRY_BACKOFF_MS: 250,
  STREAM_MANIFEST_MAX_BYTES: 1024 * 1024,
  MAX_FREE_FILENAME_COLLISION_ATTEMPTS: 10000
});
