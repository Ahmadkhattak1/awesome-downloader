/**
 * @file Renderer-level constants, enumerations, and UI configuration for Awesome Downloader.
 * Standardizes dialog tabs, context menu actions, and viewport dimensions.
 */

'use strict';

/**
 * Standardized detail dialog property tabs.
 * @readonly
 * @enum {string}
 */
const DetailTab = Object.freeze({
  STATUS: 'status',
  SPEED: 'speed',
  COMPLETION: 'completion',
  CHECKSUM: 'checksum'
});

/**
 * Context menu actions dispatchable on table download rows.
 * @readonly
 * @enum {string}
 */
const ContextAction = Object.freeze({
  RESUME: 'resume',
  PAUSE: 'pause',
  RETRY: 'retry',
  OPEN: 'open',
  OPEN_WITH: 'openWith',
  REVEAL: 'reveal',
  COPY_LINK: 'copyLink',
  CHECKSUM: 'checksum',
  REMOVE: 'remove',
  DETAILS: 'details'
});

/**
 * Status mapping for visual styles and label presentation.
 * @type {Readonly<Record<string, string>>}
 */
const StatusLabels = Object.freeze({
  completed: 'Complete',
  downloading: 'Receiving data…',
  connecting: 'Connecting…',
  assembling: 'Finalizing…',
  queued: 'Queued',
  scheduled: 'Scheduled',
  paused: 'Stopped',
  cancelled: 'Cancelled',
  failed: 'Error'
});

/**
 * Visual verification status values for checksum comparator.
 * @readonly
 * @enum {string}
 */
const ChecksumMatchStatus = Object.freeze({
  MATCH: 'match',
  MISMATCH: 'mismatch',
  IDLE: ''
});

/**
 * UI layout and positioning numerical thresholds.
 * @readonly
 */
const UiDimensions = Object.freeze({
  CONTEXT_MENU_MIN_WIDTH_PX: 180,
  CONTEXT_MENU_MIN_HEIGHT_PX: 220,
  VIEWPORT_SAFETY_PADDING_PX: 4,
  TOAST_ERROR_DURATION_MS: 14000,
  TOAST_INFO_DURATION_MS: 7000,
  SETUP_POLL_INTERVAL_MS: 3000
});

if (typeof window !== 'undefined') {
  window.DetailTab = DetailTab;
  window.ContextAction = ContextAction;
  window.StatusLabels = StatusLabels;
  window.ChecksumMatchStatus = ChecksumMatchStatus;
  window.UiDimensions = UiDimensions;
}

