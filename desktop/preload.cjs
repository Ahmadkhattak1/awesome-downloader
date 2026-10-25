/**
 * @file Preload script establishing the secure, context-isolated bridge for the desktop renderer.
 * In a sandboxed renderer (sandbox: true), require is restricted to 'electron'.
 * All method invocations are dispatched over verified IPC channels without exposing Node internals.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Standardized IPC channel names.
 * Defined self-contained within preload to comply with Chromium renderer sandbox restrictions.
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
 * Registry of exposed bridge methods.
 * @type {Record<string, (payload?: unknown) => Promise<unknown>>}
 */
const api = {
  snapshot: data => ipcRenderer.invoke(IpcChannel.SNAPSHOT, data),
  add: data => ipcRenderer.invoke(IpcChannel.ADD, data),
  review: data => ipcRenderer.invoke(IpcChannel.REVIEW, data),
  action: data => ipcRenderer.invoke(IpcChannel.ACTION, data),
  settings: data => ipcRenderer.invoke(IpcChannel.SETTINGS, data),
  chooseDirectory: data => ipcRenderer.invoke(IpcChannel.CHOOSE_DIRECTORY, data),
  clipboard: data => ipcRenderer.invoke(IpcChannel.CLIPBOARD, data),
  integration: data => ipcRenderer.invoke(IpcChannel.INTEGRATION, data),
  browserSetup: data => ipcRenderer.invoke(IpcChannel.BROWSER_SETUP, data),
  registerBrowser: data => ipcRenderer.invoke(IpcChannel.REGISTER_BROWSER, data),
  openProgress: data => ipcRenderer.invoke(IpcChannel.OPEN_PROGRESS, data),
  closeProgress: data => ipcRenderer.invoke(IpcChannel.CLOSE_PROGRESS, data),
  resizeProgress: data => ipcRenderer.invoke(IpcChannel.RESIZE_PROGRESS, data),
  checksum: data => ipcRenderer.invoke(IpcChannel.CHECKSUM, data),

  /**
   * Subscribes to engine state snapshot update events.
   * @param {(snapshot: unknown) => void} callback
   * @returns {() => void} Unsubscribe cleanup function
   */
  subscribe: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(IpcChannel.CHANGE_EVENT, listener);
    return () => ipcRenderer.removeListener(IpcChannel.CHANGE_EVENT, listener);
  },

  /**
   * Subscribes to application menu or system commands dispatched to the window.
   * @param {(command: unknown) => void} callback
   * @returns {() => void} Unsubscribe cleanup function
   */
  onCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on(IpcChannel.COMMAND_EVENT, listener);
    return () => ipcRenderer.removeListener(IpcChannel.COMMAND_EVENT, listener);
  }
};

contextBridge.exposeInMainWorld('downloader', Object.freeze(api));
