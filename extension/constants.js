/**
 * @file Extension-level constants, enumerations, and configuration parameters.
 * Eliminates magic strings and numbers in the browser extension service worker.
 */

'use strict';

/**
 * Native messaging host application identifier registered in Windows registry.
 * @type {string}
 */
const NATIVE_HOST_NAME = 'com.awesome.downloader';

/**
 * Storage session key for tab-associated media.
 * @type {string}
 */
const CACHE_KEY_MEDIA = 'mediaByTab';

/**
 * File extension pattern for automatic download interception.
 * Captures archives, executables, disk images, documents, and media files.
 * @type {RegExp}
 */
const INTERCEPT_EXTENSIONS_PATTERN = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|dmg|bin|apk|pdf|doc|docx|xls|xlsx|ppt|pptx|mp4|mkv|mov|avi|wmv|flv|webm|mp3|wav|flac|aac|epub|torrent)$/i;

/**
 * Protocol schemes that should never be intercepted.
 * @type {ReadonlyArray<string>}
 */
const EXCLUDED_URL_SCHEMES = Object.freeze([
  'blob:',
  'data:',
  'chrome:',
  'edge:',
  'about:',
  'javascript:'
]);

/**
 * Configuration boundaries for memory and network caches.
 * @readonly
 */
const ExtensionLimits = Object.freeze({
  MAX_RECENT_INTERCEPTED_URLS: 100,
  MAX_TRACKED_TABS: 50,
  MAX_MEDIA_PER_TAB: 100,
  MAX_HEADER_VALUE_LENGTH: 16384,
  MAX_MANIFEST_BYTES: 1048576,
  MAX_CONCURRENT_HLS_DISCOVERIES: 8,
  MANIFEST_FETCH_TIMEOUT_MS: 10000,
  MAX_YOUTUBE_SEED_BYTES: 262144
});

/**
 * Dispatchable native message actions.
 * @readonly
 * @enum {string}
 */
const NativeAction = Object.freeze({
  DOWNLOAD: 'download',
  FORMATS: 'formats',
  COLLECT_LINKS: 'collectLinks',
  PLAYER_RESPONSE: 'playerResponse',
  REMEMBER: 'remember',
  LIST: 'list',
  LIST_FOR_FRAME: 'listForFrame'
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NATIVE_HOST_NAME,
    CACHE_KEY_MEDIA,
    INTERCEPT_EXTENSIONS_PATTERN,
    EXCLUDED_URL_SCHEMES,
    ExtensionLimits,
    NativeAction
  };
}
