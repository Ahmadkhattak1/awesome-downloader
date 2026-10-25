/**
 * @file Desktop shell constants and enumerations for Awesome Downloader.
 * Standardizes IPC channels, window dimensions, hash algorithms, and error messages.
 */

'use strict';

/**
 * Standardized cryptographic hashing algorithm names.
 * @readonly
 * @enum {string}
 */
const HashAlgorithm = Object.freeze({
  MD5: 'md5',
  SHA256: 'sha256'
});

/**
 * IPC channel invocations between renderer and desktop shell.
 * @readonly
 * @enum {string}
 */
const IpcChannel = Object.freeze({
  SNAPSHOT: 'downloader:snapshot',
  ADD: 'downloader:add',
  REVIEW: 'downloader:review',
  ACTION: 'downloader:action',
  SETTINGS: 'downloader:settings',
  CHOOSE_DIRECTORY: 'downloader:chooseDirectory',
  CLIPBOARD: 'downloader:clipboard',
  INTEGRATION: 'downloader:integration',
  BROWSER_SETUP: 'downloader:browserSetup',
  REGISTER_BROWSER: 'downloader:registerBrowser',
  OPEN_PROGRESS: 'downloader:openProgress',
  CLOSE_PROGRESS: 'downloader:closeProgress',
  RESIZE_PROGRESS: 'downloader:resizeProgress',
  CHECKSUM: 'downloader:checksum',
  CHANGE_EVENT: 'downloader:change',
  COMMAND_EVENT: 'downloader:command'
});

/**
 * Common configuration bounds for desktop shell components.
 * @readonly
 */
const DesktopConfig = Object.freeze({
  DEFAULT_WINDOW_WIDTH: 920,
  DEFAULT_WINDOW_HEIGHT: 560,
  MIN_WINDOW_WIDTH: 640,
  MIN_WINDOW_HEIGHT: 400,
  READ_STREAM_HIGH_WATER_MARK_BYTES: 64 * 1024
});

module.exports = {
  HashAlgorithm,
  IpcChannel,
  DesktopConfig
};
