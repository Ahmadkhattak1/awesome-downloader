import './compat.mjs';
import { EventEmitter, setMaxListeners } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validUrl, cleanHeaders, request, probe } from './http.mjs';
import { resolveHls, scopedHeaders } from './hls.mjs';
import { youtubeUrl, downloadYoutube } from './youtube.mjs';
import {streamProgress} from './stream-progress.mjs';
import {downloadSabr,normalizeSabrSession} from './sabr.mjs';
import { constants as fsConstants } from 'node:fs';
import { prefetch, resolveHost } from './dns.mjs';
import { downloadBlock } from './chunk.mjs';
import { ChunkPool } from './pool.mjs';
import { configureTransport, transportConfig, throttleFrom, preferMultiplex } from './http.mjs';
import { RangeSet } from './ranges.mjs';
import { BlockScheduler, MIN_BLOCK, maxBlockFor } from './scheduler.mjs';
import { HashService } from './hasher.mjs';
import { HashSession } from './hash-session.mjs';
import { normalizeChecksum, digestsFromHeaders } from './digest.mjs';
import { CATEGORY, CATEGORY_NAMES, categoryFor, withExtension, looksLikeWebPage } from './filetypes.mjs';
import { EXTRACT_FORMATS, validFormatSelector, downloadWithYtdlp, downloadWithFfmpeg, available as extractorAvailable, isAudioFormat } from './extract.mjs';

const TRANSIENT = new Set(['downloading', 'probing', 'assembling']);
export function safeFilename(value) {
  let name = path.win32.basename(String(value || 'download')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `download_${name || 'file'}`;
  return name;
}
function suggestedName(url, disposition) {
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
  const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition || '');
  try { return safeFilename(utf ? decodeURIComponent(utf[1]) : plain ? (plain[1] || plain[2]).trim() : decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download'); }
  catch { return 'download'; }
}
// Moves a finished file into place; falls back to a kernel-side copy (reflink / copy_file_range / CopyFile)
// when source and destination are on different volumes. No bytes pass through JavaScript.
async function moveOrCopy(source, destination) {
  try { await fs.rename(source, destination); }
  catch { await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE); await fs.unlink(source).catch(() => {}); }
}
// Pipelined concatenation: reads the next block while the previous one is being written (double buffering).
async function concatFiles(files, out, signal) {
  const SIZE = 4 * 1024 * 1024, buffers = [Buffer.allocUnsafe(SIZE), Buffer.allocUnsafe(SIZE)];
  let index = 0, writing = null;
  for (const file of files) {
    const input = await fs.open(file, 'r');
    try {
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await input.read(buffers[index], 0, SIZE, null);
        if (!bytesRead) break;
        if (writing) await writing;
        const buffer = buffers[index];
        writing = (async () => { let at = 0; while (at < bytesRead) at += (await out.write(buffer, at, bytesRead - at)).bytesWritten; })();
        writing.catch(() => {});
        index ^= 1;
      }
    } finally { await input.close(); }
  }
  if (writing) await writing;
}
const MiB = 1024 * 1024;
// Delay before retrying a failed request: honour Retry-After for 429/503, otherwise exponential back-off.
const retryDelay = (error, attempt) => error?.code === 'THROTTLED' ? Math.max(error.retryAfterMs || 0, 1000 * 2 ** attempt) : 250 * 2 ** attempt;
// Video titles often contain / : ? etc.; turn them into spaces so safeFilename() does not treat them as path parts.
const titleName = title => String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

export class DownloadEngine extends EventEmitter {
  constructor({ dataDirectory, downloadDirectory, tickMs = 500 }) {
    super();
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, 'downloads.json');
    this.partsDirectory = path.join(dataDirectory, 'parts');
    this.settings = { defaultDirectory: downloadDirectory, maxConcurrent: 3, connections: 8, speedLimitKbps: 0, categoryDirectories: {}, notifyOnComplete: true, revealOnComplete: false, confirmBrowserDownloads: true, watchClipboard: true, directWrite: true, workerThreads: true, http2: true, adaptive: true, verifyHashes: true, memoryBudgetMb: 256, closeToTray: true, launchAtLogin: false };
    this.pool = null;
    this.hashService = null;
    this.downloads = [];
    this.jobs = new Map();
    this.persistChain = Promise.resolve();
    this.tickMs = tickMs;
    this.closing = false;
    this.rateTail = Promise.resolve();
    this.rateNext = 0;
  }
  async init() {
    await fs.mkdir(this.partsDirectory, { recursive: true });
    try {
      const state = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      this.updateSettings(state.settings || {}, false);
      this.downloads = (state.downloads || []).map(d => ({ ...d, status: TRANSIENT.has(d.status) ? 'paused' : d.status, speed: 0 }));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not load download history: ${error.message}`); }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    this.tick();
    return this;
  }
  snapshot() {
    return { downloads: this.downloads.map(({ segments, headers, validator, sabr, ranges, ...d }) => ({ ...d,
      streamProgress: d.kind==='hls'?streamProgress(segments||[]):undefined,
      connectionsProgress: (segments || []).map(s => ({ start: s.start, end: s.end, downloaded: s.downloaded,
        total: s.end === null ? null : s.end - s.start + 1,
        status: s.done || (s.end !== null && s.downloaded === s.end - s.start + 1) ? 'complete' : d.status })) })), settings: { ...this.settings } };
  }
  // Compact, credential-free view used by the browser extension popup.
  statusList(limit = 25) {
    return this.downloads.filter(d => !d.needsReview).slice(-limit).reverse().map(d => ({ id: d.id, filename: d.filename, status: d.status,
      downloaded: d.downloaded || 0, total: d.total ?? null, speed: d.speed || 0,
      percent: d.total ? Math.min(100, Math.floor((d.downloaded || 0) / d.total * 100)) : null, error: d.error ? String(d.error).slice(0, 200) : null }));
  }
  async persist() {
    const content = JSON.stringify({ version: 1, settings: this.settings, downloads: this.downloads.map(d => ({ ...d, headers: undefined, sabr: undefined, transfer: undefined })) }, null, 2);
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      const temp = `${this.statePath}.tmp`;
      await fs.writeFile(temp, content, { mode: 0o600 });
      await fs.rename(temp, this.statePath);
    });
    return this.persistChain;
  }
  changed() { this.emit('change', this.snapshot()); }
  updateSettings(patch, save = true) {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings.');
    const next = { ...this.settings };
    for (const [key, max] of [['maxConcurrent', 16], ['connections', 64], ['speedLimitKbps', 1048576], ['memoryBudgetMb', 1024]]) {
      if (patch[key] !== undefined) {
        const n = Number(patch[key]);
        if (!Number.isInteger(n) || n < (key === 'speedLimitKbps' ? 0 : key === 'memoryBudgetMb' ? 32 : 1) || n > max) throw new Error(`Invalid ${key}.`);
        next[key] = n;
      }
    }
    if (patch.defaultDirectory !== undefined) {
      if (typeof patch.defaultDirectory !== 'string' || !path.isAbsolute(patch.defaultDirectory)) throw new Error('Choose an absolute download folder.');
      next.defaultDirectory = path.resolve(patch.defaultDirectory);
    }
    if (patch.categoryDirectories !== undefined) {
      if (!patch.categoryDirectories || typeof patch.categoryDirectories !== 'object' || Array.isArray(patch.categoryDirectories)) throw new Error('Invalid category folders.');
      next.categoryDirectories = {};
      for (const [category, folder] of Object.entries(patch.categoryDirectories)) {
        if (!CATEGORY_NAMES.includes(category) || typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid category folder.');
        next.categoryDirectories[category] = path.resolve(folder);
      }
    }
    for (const key of ['notifyOnComplete', 'revealOnComplete', 'confirmBrowserDownloads', 'hideCompletionDialog', 'watchClipboard', 'directWrite', 'workerThreads', 'http2', 'adaptive', 'verifyHashes', 'closeToTray', 'launchAtLogin']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw new Error(`Invalid ${key}.`); next[key] = patch[key]; }
    if (next.speedLimitKbps !== this.settings.speedLimitKbps) this.rateNext = 0;
    this.settings = next;
    if (transportConfig().http2 !== next.http2) { configureTransport({ http2: next.http2 }); this.pool?.reconfigure(transportConfig()); }
    if (save) return this.persist().then(() => { this.changed(); this.tick(); return this.snapshot(); });
  }
  async add({ urls, url, audioUrl, outputFormat, youtubeFormat, sabr, mirrors, checksum, extract, extractFormat, filename, scheduledAt, referer, headers, directory, category, description, queueOnly = false, reviewOnly = false, reuseActive = false } = {}) {
    const source = urls || (url ? [url] : []);
    if (!Array.isArray(source) || !source.length || source.length > 500) throw new Error('Add between 1 and 500 download URLs.');
    const normalized = source.map(validUrl);
    if(youtubeFormat!==undefined&&(!/^(?:audio:)?[\w-]+(?:\+[\w-]+)?$/.test(youtubeFormat)||youtubeFormat.length>80||normalized.some(u=>!youtubeUrl(u))))throw new Error('Invalid YouTube format.');
    if (extract !== undefined && typeof extract !== 'boolean') throw new Error('Invalid extract flag.');
    if (extractFormat !== undefined && !validFormatSelector(extractFormat)) throw new Error('Invalid video format selector.');
    const wideOutput = extract === true || normalized.some(u => /\.mpd(?:[?#]|$)/i.test(u));
    if(outputFormat!==undefined&&!(wideOutput?EXTRACT_FORMATS:['mp4','mp3']).includes(outputFormat))throw new Error('Invalid output format.');
    const sabrSession=sabr===undefined?undefined:normalizeSabrSession(sabr);
    if(sabrSession&&normalized.length!==1)throw new Error('A SABR session requires exactly one YouTube stream.');
    const audio = audioUrl ? validUrl(audioUrl) : undefined;
    prefetch(audio ? [...normalized, audio] : normalized);
    if (audio && normalized.length !== 1) throw new Error('A separate audio track requires exactly one video.');
    let mirrorList = [];
    if (mirrors !== undefined) {
      if (!Array.isArray(mirrors) || mirrors.length > 8) throw new Error('Add at most 8 mirror URLs.');
      mirrorList = [...new Set(mirrors.map(validUrl))].filter(m => !normalized.includes(m));
      if (mirrorList.length && normalized.length !== 1) throw new Error('Mirrors can only be used with a single download URL.');
    }
    const expectedChecksum = normalizeChecksum(checksum);
    if (expectedChecksum && normalized.length !== 1) throw new Error('A checksum can only be used with a single download URL.');
    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (when !== null && !Number.isFinite(when)) throw new Error('Invalid scheduled time.');
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('Choose an absolute save folder.');
    if (category !== undefined && !CATEGORY_NAMES.includes(category)) throw new Error('Invalid category.');
    if (description !== undefined && (typeof description !== 'string' || description.length > 4096)) throw new Error('Description is too long.');
    if(reuseActive && normalized.length===1){
      const existing=this.downloads.find(d=>!['complete','cancelled','error'].includes(d.status) && d.outputFormat===outputFormat &&
        (sabrSession ? d.sabr?.videoId===sabrSession.videoId && d.sabr?.videoItag===sabrSession.videoItag && d.sabr?.audioItag===sabrSession.audioItag : !d.sabr && d.url===normalized[0] && d.audioUrl===audio && d.youtubeFormat===youtubeFormat));
      if(existing)return [existing.id];
    }
    const added = normalized.map(u => {
      const name = safeFilename(filename || suggestedName(u));
      const selectedCategory = category || categoryFor(name);
      return { id: randomUUID(), url: u, audioUrl: audio, mirrors: mirrorList.length ? mirrorList : undefined, checksum: expectedChecksum || undefined, extract: extract === true ? true : undefined, extractFormat, outputFormat, youtubeFormat, sabr:sabrSession, filename: name, explicitFilename: Boolean(filename), category: selectedCategory, explicitCategory: Boolean(category), description: description || '',
        status: queueOnly || reviewOnly ? 'paused' : when && when > Date.now() ? 'scheduled' : 'queued', needsReview: reviewOnly, scheduledAt: when ? new Date(when).toISOString() : null,
        downloaded: 0, total: null, speed: 0, connections: 0, error: null, path: null,
        directory: directory || this.settings.categoryDirectories[selectedCategory] || this.settings.defaultDirectory, createdAt: new Date().toISOString(), segments: [], validator: null,
        headers: cleanHeaders({ ...headers, ...(referer ? { referer } : {}) }) };
    });
    this.downloads.push(...added);
    await this.persist();
    this.changed(); this.tick();
    return added.map(d => d.id);
  }
  async reviewDownload({ id, filename, directory, category, description = '', queueOnly = false, scheduledAt, mirrors, checksum } = {}) {
    const d = this.downloads.find(d => d.id === id);
    if (!d?.needsReview || this.jobs.has(id)) throw new Error('This download is not waiting for confirmation.');
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('Choose an absolute save folder.');
    if (category !== undefined && !CATEGORY_NAMES.includes(category)) throw new Error('Invalid category.');
    if (typeof description !== 'string' || description.length > 4096) throw new Error('Description is too long.');
    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (when !== null && !Number.isFinite(when)) throw new Error('Invalid scheduled time.');
    if (filename) { d.explicitFilename ||= filename !== d.filename; d.filename = safeFilename(filename); }
    if (category) { d.category = category; d.explicitCategory = true; }
    if (directory) d.directory = path.resolve(directory);
    if (mirrors !== undefined) { if (!Array.isArray(mirrors) || mirrors.length > 8) throw new Error('Add at most 8 mirror URLs.'); const list = [...new Set(mirrors.map(validUrl))].filter(m => m !== d.url); d.mirrors = list.length ? list : undefined; }
    if (checksum !== undefined) d.checksum = normalizeChecksum(checksum) || undefined;
    d.description = description; d.needsReview = false; d.scheduledAt = when ? new Date(when).toISOString() : null;
    d.status = queueOnly ? 'paused' : when && when > Date.now() ? 'scheduled' : 'queued';
    await this.persist(); this.changed(); this.tick();
    return [d.id];
  }
  async action(id, action) {
    const d = this.downloads.find(d => d.id === id);
    if (!d) throw new Error('Download not found.');
    if (!['pause', 'resume', 'retry', 'cancel', 'remove'].includes(action)) throw new Error('Unknown download action.');
    if (action === 'pause' || action === 'cancel' || action === 'remove') {
      const job = this.jobs.get(id);
      if (job) { job.controller.abort(); await job.promise; }
      if (action === 'pause' && d.status !== 'complete') d.status = 'paused';
      if (action === 'cancel' && d.status !== 'complete') { d.status = 'cancelled'; d.needsReview = false; }
      if (action === 'remove') this.downloads = this.downloads.filter(x => x.id !== id);
      if (action !== 'pause') { await fs.rm(path.join(this.partsDirectory, id), { recursive: true, force: true }); d.segments = []; d.ranges = undefined; d.integrity = undefined; if (d.status !== 'complete') d.downloaded = 0; }
    } else {
      if (d.needsReview) throw new Error('Confirm this browser download in Download File Info first.');
      if (this.jobs.has(id) || d.status === 'complete') return;
      d.error = null; d.status = 'queued'; d.scheduledAt = null;
    }
    d.speed = 0;
    await this.persist(); this.changed(); this.tick();
  }
  tick() {
    if (this.closing) return;
    for (const d of this.downloads) {
      if (d.status === 'scheduled' && new Date(d.scheduledAt).getTime() <= Date.now()) d.status = 'queued';
      if (d.status === 'queued' && !this.jobs.has(d.id) && this.jobs.size < this.settings.maxConcurrent) {
        const controller = new AbortController();
        const job = { controller, promise: null };
        this.jobs.set(d.id, job);
        job.promise = this.run(d, controller.signal).catch(error => {
          d.status = controller.signal.aborted ? 'paused' : 'error';
          d.error = controller.signal.aborted ? null : error.message;
        }).finally(async () => {
          d.speed = 0;
          // Keep the job owned until all cleanup and its final checkpoint finish.
          try { await this.persist(); } catch (error) { d.status = 'error'; d.error = `History checkpoint failed: ${error.message}`; }
          this.jobs.delete(d.id); if (!this.jobs.size) this.rateNext = 0; this.changed(); this.tick();
        });
      }
    }
  }
  async throttle(bytes, signal) {
    if (!this.settings.speedLimitKbps) return;
    const wait = Math.max(0, this.rateNext - Date.now());
    this.rateNext = Math.max(Date.now(), this.rateNext) + bytes * 1000 / (this.settings.speedLimitKbps * 1024);
    if (wait) await delay(wait, undefined, { signal });
  }
  async run(d, signal) {
    d.status = 'probing'; d.error = null; this.changed();
    if(d.sabr){await this.runSabr(d,cleanHeaders(d.headers),signal);return;}
    if (d.extract) { await this.runExtract(d, cleanHeaders(d.headers), signal); return; }
    if(youtubeUrl(d.url)) {
      const dir=path.join(this.partsDirectory,d.id);await fs.mkdir(dir,{recursive:true});
      d.kind='youtube';d.resumable=true;d.connections=1;
      const result=await downloadYoutube({url:d.url,formatKey:d.youtubeFormat,directory:dir,signal,speedLimitKbps:this.settings.speedLimitKbps,onMetadata:choice=>{d.filename=safeFilename(choice.title+'.'+choice.outputFormat);d.duration=choice.duration;this.changed();},onProgress:p=>{Object.assign(d,p);d.segments=[{start:0,end:p.total?p.total-1:null,downloaded:p.downloaded}];this.changed();}});
      d.filename=safeFilename(result.choice.title+'.'+result.choice.outputFormat);
      d.duration=result.choice.duration;d.category=result.choice.outputFormat==='mp3'?'Audio':'Video';
      d.total=d.downloaded=result.size;d.estimated=false;
      d.segments=[{start:0,end:result.size-1,downloaded:result.size,done:true}];
      await this.assemble(d,dir,signal,[result.output],true);return;
    }
    const headers = cleanHeaders(d.headers);
    if (/\.m3u8(?:[?#]|$)/i.test(d.url)) { await this.runHls(d, headers, signal); return; }
    if (/\.mpd(?:[?#]|$)/i.test(d.url)) { await this.runFfmpegStream(d, headers, signal); return; }
    if(d.audioUrl){await this.runPairedTracks(d,headers,signal);return;}
    const info = await this.probeWithRetry(d.url, headers, signal);
    const mime = String(info.headers['content-type'] || '');
    if (/mpegurl/i.test(mime)) { await this.runHls(d, headers, signal); return; }
    if (/dash\+xml/i.test(mime)) { await this.runFfmpegStream(d, headers, signal); return; }
    // A web page instead of a file: let yt-dlp find the video on it (any supported site). If there is none, the page
    // itself is saved like any other file.
    if (looksLikeWebPage(mime) && !info.headers['content-disposition'] && await extractorAvailable()) {
      try { d.extract = true; await this.runExtract(d, headers, signal); return; }
      catch (error) { if (error.code !== 'UNSUPPORTED') throw error; d.extract = undefined; d.kind = undefined; d.status = 'connecting'; } // nothing playable: save the page as a file
    }
    if (!d.explicitFilename) { d.filename = withExtension(suggestedName(info.url, info.headers['content-disposition']), mime); if (!d.explicitCategory) d.category = categoryFor(d.filename); }
    const dir = path.join(this.partsDirectory, d.id);
    await fs.mkdir(dir, { recursive: true });
    // Resume only when both resource identity and range support can be established.
    if (!info.ranges || !info.validator || d.validator !== info.validator || d.total !== info.total) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      d.segments = [];
    }
    if (!d.segments.length) d.layout = undefined;
    d.total = info.total; d.validator = info.validator;
    d.resumable = Boolean(info.ranges && info.validator); d.protocol = info.protocol;
    const count = info.ranges && info.total > 1024 * 1024 ? Math.min(this.settings.connections, Math.ceil(info.total / (512 * 1024))) : 1;
    const direct = d.layout === 'direct' || (!d.segments.length && this.settings.directWrite !== false && !this.settings.speedLimitKbps && info.ranges && info.validator && info.total >= 2 * MIN_BLOCK);
    if (direct) { await this.runDirect(d, info, dir, headers, signal, count); return; }
    if (!d.segments.length) {
      d.segments = Array.from({ length: count }, (_, i) => ({ start: info.total === null ? 0 : Math.floor(info.total * i / count),
        end: info.total === null ? null : Math.floor(info.total * (i + 1) / count) - 1, downloaded: 0 }));
    }
    for (let i = 0; i < d.segments.length; i++) {
      let size = 0;
      try { size = (await fs.stat(path.join(dir, `${i}.part`))).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const s = d.segments[i];
      if (s.end !== null && size > s.end - s.start + 1) throw new Error('Partial file is larger than its segment. Remove and re-add this download.');
      s.downloaded = size;
    }
    d.downloaded = d.segments.reduce((n, s) => n + s.downloaded, 0);
    d.connections = d.segments.length; d.status = 'downloading'; await this.persist(); this.changed();
    let lastBytes = d.downloaded, lastAt = Date.now();
    const progress = setInterval(() => {
      const now = Date.now(); d.speed = (d.downloaded - lastBytes) * 1000 / (now - lastAt);
      lastBytes = d.downloaded; lastAt = now; this.changed();
    }, this.tickMs);
    const siblings = new AbortController();
    const transferSignal = AbortSignal.any([signal, siblings.signal]);
    try {
      const outcomes = await Promise.allSettled(d.segments.map((segment, i) => this.transfer(d, info, segment, path.join(dir, `${i}.part`), headers, transferSignal).catch(error => { siblings.abort(); throw error; })));
      const failure = outcomes.find(r => r.status === 'rejected' && r.reason.name !== 'AbortError') || outcomes.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
    } finally { clearInterval(progress); }
    await this.assemble(d, dir, signal);
  }
  async assemble(d, dir, signal, files = d.segments.map((_,i) => path.join(dir, `${i}.part`)), converted = false) {
    signal.throwIfAborted();
    d.status = 'assembling'; d.speed = 0; this.changed();
    if(d.outputFormat&&!converted){
      const {convertMedia}=await import('./mux.mjs');
      const output=await convertMedia(dir,files,d.outputFormat,signal);
      d.filename=safeFilename(d.filename.replace(/\.[^.]+$/,'')+'.'+d.outputFormat);
      if(!d.explicitCategory)d.category=d.outputFormat==='mp3'?'Audio':'Video';
      return this.assemble(d,dir,signal,[output],true);
    }
    await fs.mkdir(d.directory, { recursive: true });
    // Exclusive creation prevents collision with user files or another download.
    let destination, out;
    for (let n = 0; n < 10000; n++) {
      const ext = path.extname(d.filename), base = path.basename(d.filename, ext);
      destination = path.join(d.directory, n ? `${base} (${n})${ext}` : d.filename);
      try { out = await fs.open(destination, 'wx'); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!out) throw new Error('Could not choose a free output filename.');
    let complete = false;
    try {
      if (files.length === 1) { await out.close(); out = null; await moveOrCopy(files[0], destination); }
      else { await concatFiles(files, out, signal); await out.sync(); }
      complete = true;
    } finally { if (out) await out.close(); if (!complete) await fs.unlink(destination).catch(() => {}); }
    if (d.checksum && !d.kind && !d.outputFormat && !d.integrity) {
      const digests = await this.hashFile(destination, (await fs.stat(destination)).size);
      d.integrity = this.integrityFor(d, undefined, digests);
      if (d.integrity.status === 'mismatch') {
        const { expected } = d.integrity;
        await fs.unlink(destination).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
        d.segments = []; d.downloaded = 0; d.validator = null;
        throw new Error(`Checksum mismatch: expected ${expected.algorithm} ${expected.value}, got ${d.integrity[expected.algorithm]}. The corrupted download was discarded.`);
      }
    }
    d.path = destination; d.filename = path.basename(destination); d.status = 'complete';
    d.completedAt = new Date().toISOString();
    await this.persist();
    try { await fs.rm(dir, { recursive: true, force: true }); }
    catch (error) { d.cleanupError = `Downloaded file is complete; temporary segments could not be removed: ${error.message}`; }
    this.emit('complete', { ...d });
  }
  getPool() {
    if (this.settings.workerThreads === false || process.env.AWESOME_NO_WORKERS) return null;
    if (this.pool?.broken) return null;
    if (!this.pool || this.pool.closed) this.pool = new ChunkPool({ transport: transportConfig() });
    return this.pool;
  }
  async probeWithRetry(url, headers, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await probe(url, headers, signal); }
      catch (error) {
        if (error.code !== 'THROTTLED' || attempt >= 3) throw error;
        await delay(retryDelay(error, attempt), undefined, { signal });
      }
    }
  }
  hashes() {
    return this.hashService ||= new HashService({ useWorker: this.settings.workerThreads !== false && !process.env.AWESOME_NO_WORKERS });
  }
  // Hashes a finished file in the hashing thread (used when a checksum must be verified but the file was not
  // hashed on the fly, e.g. the part-file layout).
  async hashFile(file, size) {
    const session = this.hashes().open(file);
    try { return await session.digest(size); } finally { session.close(); }
  }
  // Compares the computed digests with what the user (fatal) or the server (advisory) expects.
  integrityFor(d, headers, digests) {
    const announced = digestsFromHeaders(headers || {}), preferred = announced.find(a => a.algorithm === 'sha256') || announced[0];
    const expected = d.checksum ? { ...d.checksum, source: 'user' } : preferred ? { ...preferred, source: 'server' } : null;
    const integrity = { sha256: digests.sha256, md5: digests.md5, expected, status: 'computed', checkedAt: new Date().toISOString() };
    if (expected) {
      const actual = digests[expected.algorithm];
      if (!actual) integrity.status = 'computed';
      else if (actual === expected.value) integrity.status = 'verified';
      else integrity.status = expected.source === 'user' ? 'mismatch' : 'warning';
    }
    return integrity;
  }
  // Direct block download: one pre-sized file; the scheduler hands 2-4 MB blocks to connections (worker threads),
  // each block is aggregated in memory and written at its own offset. No temp parts, no merge/copy step at the end.
  async runDirect(d, info, dir, headers, signal, count) {
    const file = path.join(dir, 'data.bin'), total = info.total;
    if (!d.segments.length) d.segments = Array.from({ length: count }, (_, i) => ({ start: Math.floor(total * i / count), end: Math.floor(total * (i + 1) / count) - 1, downloaded: 0 }));
    // Histories written by the fixed-segment layout recorded per-segment committed bytes; fold them into byte ranges once.
    let done = new RangeSet(Array.isArray(d.ranges) ? d.ranges : d.segments.filter(s => s.committed > 0).map(s => [s.start, s.start + Math.min(s.committed, s.end - s.start + 1)]));
    for (const s of d.segments) delete s.committed;
    d.layout = 'direct'; d.ranges = done.toJSON();
    let fh;
    try { fh = await fs.open(file, 'r+'); } catch (e) { if (e.code !== 'ENOENT') throw e; fh = await fs.open(file, 'w+'); }
    try {
      if ((await fh.stat()).size !== total) { done = new RangeSet(); d.ranges = []; await fh.truncate(0); await fh.truncate(total); }
    } catch (error) { await fh.close(); throw error; }
    d.downloaded = done.size; d.protocol = info.protocol;
    d.connections = Math.min(this.settings.connections, Math.max(1, Math.ceil(total / MIN_BLOCK)));
    d.status = 'downloading'; d.integrity = undefined;
    try { await this.persist(); this.changed(); } catch (error) { await fh.close(); throw error; }

    const target = info.url, scoped = scopedHeaders(headers, d.url, target);
    const sources = [{ url: target, headers: scoped, validator: info.validator, protocol: info.protocol, label: hostOf(target) }];
    const mirrorNotes = [];
    await Promise.all((d.mirrors || []).map(async mirror => {
      try {
        const mi = await probe(mirror, scopedHeaders(headers, d.url, mirror), signal);
        if (!mi.ranges || mi.total !== total) { mirrorNotes.push({ url: mirror, ok: false, reason: 'Different size or no range support.' }); return; }
        sources.push({ url: mi.url, headers: scopedHeaders(headers, d.url, mi.url), validator: mi.validator, protocol: mi.protocol, label: hostOf(mi.url) });
        mirrorNotes.push({ url: mirror, ok: true });
      } catch (error) { if (signal.aborted) return; mirrorNotes.push({ url: mirror, ok: false, reason: error.message }); }
    }));
    d.mirrorNotes = mirrorNotes.length ? mirrorNotes : undefined;

    const limit = this.settings.speedLimitKbps;
    let scheduler, lastThrottle = null;
    const fetchBlock = async ({ source, start, end, signal: blockSignal, onBytes }) => {
      const task = { url: source.url, headers: source.headers, file, start, end, total, validator: source.validator, protocol: source.protocol === 'http/1.1' ? 'http/1.1' : undefined,
        limitBps: limit ? limit * 1024 / (scheduler.allowedTotal() * Math.max(1, this.jobs.size)) : 0, attempts: 2 };
      const pool = this.getPool();
      if (pool) {
        try { await pool.run(task, { signal: blockSignal, onBytes, sticky: source.multiplex ? new URL(source.url).origin : undefined }); return; }
        catch (error) { if (error.code !== 'POOL_UNAVAILABLE' || blockSignal.aborted) throw error; }
      }
      await downloadBlock({ ...task, signal: blockSignal, onBytes });
    };
    scheduler = new BlockScheduler({ total, done: done.toJSON(), sources, connections: d.connections, fetchBlock, adaptive: this.settings.adaptive !== false,
      maxBlock: maxBlockFor(total), memoryBudget: (this.settings.memoryBudgetMb || 256) * MiB, maxAttempts: 4, tickMs: Math.min(400, Math.max(50, this.tickMs)) });
    done = scheduler.done; // single source of truth from here on

    // Rate limited (429/503): the scheduler already halved this origin's connections; also move it to one multiplexed
    // HTTP/2 session (shared by every block) instead of opening more sockets.
    scheduler.on('throttle', event => {
      const origin = new URL(event.source.url).origin;
      preferMultiplex(origin); this.pool?.multiplex(origin);
      lastThrottle = { at: new Date().toISOString(), statusCode: event.statusCode, waitMs: event.waitMs, allowed: event.allowed };
      this.changed();
    });

    const wantsHash = this.settings.verifyHashes !== false || Boolean(d.checksum);
    const hasher = wantsHash ? this.hashes().open(file) : null;
    let hashedUpTo = 0;
    const advanceHash = () => { // only the contiguous, fully written prefix is ever hashed
      if (!hasher) return;
      const frontier = done.contiguousFrom(0);
      if (frontier > hashedUpTo) { hashedUpTo = frontier; hasher.advance(frontier); }
    };
    scheduler.on('block', advanceHash); advanceHash();

    let lastBytes = d.downloaded, lastAt = Date.now(), syncing = false;
    const commit = async () => {
      if (syncing) return; syncing = true;
      try { const snapshot = done.toJSON(); await fh.sync(); d.ranges = snapshot; await this.persist(); } finally { syncing = false; }
    };
    const refresh = () => {
      const snap = scheduler.snapshot(), partial = scheduler.partialRanges();
      d.downloaded = Math.max(d.downloaded, scheduler.downloaded());
      for (const s of d.segments) {
        let n = done.covered(s.start, s.end + 1);
        for (const [a, b] of partial) n += Math.max(0, Math.min(b, s.end + 1) - Math.max(a, s.start));
        s.downloaded = Math.min(n, s.end - s.start + 1);
      }
      d.transfer = { protocol: info.protocol, multiplex: snap.sources.some(x => x.multiplex), active: snap.active, allowed: snap.allowed, configured: snap.configured, throttles: snap.throttles, drops: snap.drops, duplicates: snap.duplicates,
        retries: snap.retries, lastThrottle, sources: snap.sources.map(x => ({ host: x.label, protocol: x.protocol, active: x.active, allowed: x.allowed, speed: x.speed, bytes: x.bytes, throttles: x.throttles, dead: x.dead, coolingMs: x.coolingMs })),
        hashing: { enabled: Boolean(hasher), threaded: Boolean(hasher?.threaded), hashedBytes: hashedUpTo }, adaptive: this.settings.adaptive !== false };
    };
    const progress = setInterval(() => {
      refresh(); const now = Date.now();
      d.speed = (d.downloaded - lastBytes) * 1000 / Math.max(1, now - lastAt); lastBytes = d.downloaded; lastAt = now; this.changed();
    }, this.tickMs);
    const checkpoint = setInterval(() => commit().catch(() => {}), 2000);
    refresh();
    try { await scheduler.run(signal); }
    finally {
      clearInterval(progress); clearInterval(checkpoint);
      while (syncing) await delay(5);
      try { await fh.sync(); d.ranges = done.toJSON(); } catch {}
      await fh.close();
    }
    d.downloaded = total; refresh(); d.speed = 0;
    if (hasher) {
      d.status = 'assembling'; this.changed();
      let digests;
      try { digests = await hasher.digest(total); } finally { hasher.close(); }
      d.integrity = this.integrityFor(d, info.headers, digests);
      if (d.integrity.status === 'mismatch') {
        const { expected } = d.integrity;
        await fs.rm(dir, { recursive: true, force: true });
        d.segments = []; d.ranges = []; d.downloaded = 0; d.layout = undefined; d.validator = null;
        throw new Error(`Checksum mismatch: expected ${expected.algorithm} ${expected.value}, got ${d.integrity[expected.algorithm]}. The corrupted download was discarded.`);
      }
      if (d.integrity.status === 'warning') this.emit('integrity-warning', { ...d });
    }
    await this.assemble(d, dir, signal, [file]);
  }
  // Page URL of any supported site -> best video/audio via yt-dlp (ffmpeg merges and converts).
  async runExtract(d, headers, signal) {
    const dir = path.join(this.partsDirectory, d.id);
    await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
    d.kind = 'extract'; d.resumable = false; d.connections = 1; d.downloaded = 0; d.total = null; d.segments = []; d.protocol = undefined;
    d.status = 'downloading'; this.changed();
    const result = await downloadWithYtdlp({ url: d.url, headers, directory: dir, signal, format: d.extractFormat, outputFormat: d.outputFormat, speedLimitKbps: this.settings.speedLimitKbps,
      onMetadata: ({ title }) => { if (title && !d.explicitFilename) { d.filename = safeFilename(`${titleName(title) || 'video'}.${isAudioFormat(d.outputFormat) ? d.outputFormat : 'mp4'}`); this.changed(); } },
      onProgress: p => { d.downloaded = p.downloaded; d.total = p.total; d.speed = p.speed; d.estimated = true; d.segments = [{ start: 0, end: p.total ? p.total - 1 : null, downloaded: p.downloaded }]; this.changed(); } });
    if (!d.explicitFilename) d.filename = safeFilename(`${titleName(result.title) || titleName(path.basename(new URL(d.url).pathname)) || 'video'}.${result.extension}`);
    d.duration = result.duration || d.duration;
    if (!d.explicitCategory) d.category = isAudioFormat(result.extension) ? 'Audio' : 'Video';
    d.total = d.downloaded = result.size; d.estimated = false; d.segments = [{ start: 0, end: result.size - 1, downloaded: result.size, done: true }];
    await this.assemble(d, dir, signal, [result.output], true);
  }
  // DASH manifests and other streams that only ffmpeg can read: copied (not re-encoded) into one file.
  async runFfmpegStream(d, headers, signal) {
    const dir = path.join(this.partsDirectory, d.id);
    await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
    d.kind = 'stream'; d.resumable = false; d.connections = 1; d.downloaded = 0; d.total = null; d.segments = [];
    d.status = 'downloading'; this.changed();
    const result = await downloadWithFfmpeg({ url: d.url, headers, directory: dir, signal, outputFormat: d.outputFormat,
      onProgress: p => { d.downloaded = p.downloaded; d.speed = p.speed; d.estimated = true; d.segments = [{ start: 0, end: null, downloaded: p.downloaded }]; this.changed(); } });
    if (!d.explicitFilename) d.filename = safeFilename(`${path.basename(new URL(d.url).pathname).replace(/\.[^.]+$/, '') || 'video'}.${result.extension}`);
    if (!d.explicitCategory) d.category = isAudioFormat(result.extension) ? 'Audio' : 'Video';
    d.total = d.downloaded = result.size; d.estimated = false; d.segments = [{ start: 0, end: result.size - 1, downloaded: result.size, done: true }];
    await this.assemble(d, dir, signal, [result.output], true);
  }
  async runHls(d, headers, signal) {
    const plan = await resolveHls(d.url, headers, signal);
    if (d.audioUrl) plan.audio = await resolveHls(d.audioUrl, scopedHeaders(headers, d.url, d.audioUrl), signal);
    prefetch([d.url, ...plan.urls.slice(0, 32)]);
    const videoCount = plan.urls.length;
    if (plan.audio) { plan.urls.push(...plan.audio.urls); plan.identity += ':' + plan.audio.identity; plan.extension = '.mp4'; }
    const dir = path.join(this.partsDirectory, d.id);
    if (d.playlistIdentity !== plan.identity) {
      await fs.rm(dir, { recursive: true, force: true }); d.segments = [];
    }
    await fs.mkdir(dir, { recursive: true });
    d.playlistIdentity = plan.identity; d.duration = plan.duration; d.resumable = true; d.kind = 'hls';
    if (!d.explicitFilename && !d.hlsFilenameResolved) { d.filename = safeFilename(d.filename.replace(/\.(m3u8|mpd)$/i, '') + plan.extension); d.hlsFilenameResolved = true; }
    if (!d.explicitCategory) d.category = 'Video';
    d.total = null; d.downloaded = 0;
    d.segments = await Promise.all(plan.urls.map(async (url, i) => {
      let size = 0, done = false;
      try { size = (await fs.stat(path.join(dir, `${i}.part`))).size; done = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      d.downloaded += size;
      return { url, start: 0, end: null, downloaded: size, done };
    }));
    d.connections = Math.min(this.settings.connections, d.segments.length);
    d.status = 'downloading'; await this.persist(); this.changed();
    let index = 0, lastBytes = d.downloaded, lastTime = Date.now();
    const progress = setInterval(() => { const now = Date.now(); d.speed = (d.downloaded - lastBytes) * 1000 / Math.max(1, now - lastTime); lastBytes = d.downloaded; lastTime = now; this.changed(); }, this.tickMs);
    const siblings = new AbortController(), groupSignal = AbortSignal.any([signal, siblings.signal]);
    const worker = async () => {
      while (index < d.segments.length) {
        groupSignal.throwIfAborted();
        const i = index++, segment = d.segments[i];
        if (segment.done) continue;
        const temp = path.join(dir, `${i}.receiving`);
        for (let attempt = 0; attempt < 4; attempt++) {
          d.downloaded -= segment.downloaded; segment.downloaded = 0;
          const out = await fs.open(temp, 'w'); let response;
          try {
            response = await request(segment.url, { headers: scopedHeaders(headers, plan.source, segment.url), signal: groupSignal });
            const throttle = throttleFrom(response); if (throttle) throw throttle;
            if (response.statusCode !== 200) throw new Error(`HLS segment returned HTTP ${response.statusCode}.`);
            const expected = Number(response.headers['content-length']);
            for await (const chunk of response) { groupSignal.throwIfAborted(); await this.throttle(chunk.length, groupSignal); await out.writeFile(chunk); segment.downloaded += chunk.length; d.downloaded += chunk.length; }
            if (Number.isFinite(expected) && expected !== segment.downloaded) throw new Error('Incomplete HLS segment.');
            await out.sync(); await out.close();
            await fs.rename(temp, path.join(dir, `${i}.part`)); segment.done = true;
            await this.persist(); break;
          } catch (error) {
            await out.close();
            if (groupSignal.aborted || attempt === 3) throw error;
            await delay(retryDelay(error, attempt), undefined, { signal: groupSignal });
          } finally { response?.destroy(); }
        }
      }
    };
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: d.connections }, () => worker().catch(error => { siblings.abort(); throw error; })));
      const error = outcomes.find(o => o.status === 'rejected' && o.reason.name !== 'AbortError') || outcomes.find(o => o.status === 'rejected');
      if (error) throw error.reason;
    } finally { clearInterval(progress); }
    d.total = d.downloaded;
    if (plan.audio) {
      d.status = 'assembling'; d.speed = 0; this.changed();
      const { muxTracks } = await import('./mux.mjs');
      const combined = await muxTracks(dir, videoCount, plan.urls.length, signal);
      d.filename = safeFilename(d.filename.replace(/\.[^.]+$/, '') + '.mp4');
      await this.assemble(d, dir, signal, [combined]);
    } else await this.assemble(d, dir, signal);
  }
  async runPairedTracks(d,headers,signal) {
    const urls=[d.url,d.audioUrl];
    const trackHeaders=urls.map(url=>scopedHeaders(headers,d.url,url));
    const infos=await Promise.all(urls.map((url,i)=>this.probeWithRetry(url,trackHeaders[i],signal)));
    const dir=path.join(this.partsDirectory,d.id);await fs.mkdir(dir,{recursive:true});
    // Direct adaptive tracks are separate files; concatenating them corrupts MP4.
    d.kind='paired';d.resumable=false;d.downloaded=0;d.total=infos.every(i=>i.total!==null)?infos.reduce((n,i)=>n+i.total,0):null;
    d.segments=infos.map(i=>({start:0,end:i.total===null?null:i.total-1,downloaded:0}));
    d.status='downloading';d.connections=2;this.changed();
    let last=0,at=Date.now();const timer=setInterval(()=>{const now=Date.now();d.speed=(d.downloaded-last)*1000/Math.max(1,now-at);last=d.downloaded;at=now;this.changed();},this.tickMs);
    const siblings=new AbortController(),group=AbortSignal.any([signal,siblings.signal]);
    try {
      const outcomes=await Promise.allSettled(urls.map(async(url,i)=>{try{const file=path.join(dir,i+'.part');await fs.writeFile(file,Buffer.alloc(0));await this.transfer(d,infos[i],d.segments[i],file,trackHeaders[i],group,url);}catch(error){siblings.abort();throw error;}}));
      const failed=outcomes.find(o=>o.status==='rejected'&&o.reason.name!=='AbortError')||outcomes.find(o=>o.status==='rejected');if(failed)throw failed.reason;
    } finally {clearInterval(timer);}
    signal.throwIfAborted();d.status='assembling';d.speed=0;this.changed();
    const {muxTracks}=await import('./mux.mjs');const combined=await muxTracks(dir,1,2,signal);
    d.total=d.downloaded=(await fs.stat(combined)).size;
    await this.assemble(d,dir,signal,[combined],true);
  }
  async runSabr(d,headers,signal) {
    const dir=path.join(this.partsDirectory,d.id);
    await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
    d.kind='sabr';d.resumable=false;d.downloaded=0;
    const selected=normalizeSabrSession(d.sabr), hasVideo=selected.videoItag!==undefined;
    const picked=selected.formats.filter(f=>f.itag===selected.audioItag||f.itag===selected.videoItag);
    d.total=picked.every(f=>Number(f.contentLength)>0)?picked.reduce((sum,f)=>sum+Number(f.contentLength),0):null;
    d.segments=picked.map(f=>({start:0,end:Number(f.contentLength)>0?Number(f.contentLength)-1:null,downloaded:0}));
    d.connections=picked.length;d.status='downloading';await this.persist();this.changed();
    let networkDownloaded=0,last=0,at=Date.now();const timer=setInterval(()=>{const now=Date.now();d.speed=(networkDownloaded-last)*1000/Math.max(1,now-at);last=networkDownloaded;at=now;this.changed();},this.tickMs);
    let result;
    try{
      result=await downloadSabr({session:selected,headers,videoPath:path.join(dir,'0.part'),audioPath:path.join(dir,hasVideo?'1.part':'0.part'),signal,onProgress:progress=>{
        d.downloaded=progress.downloaded;if(progress.total!==null)d.total=progress.total;
        networkDownloaded=progress.networkDownloaded;
        for(let i=0;i<d.segments.length;i++)d.segments[i].downloaded=progress.tracks[picked[i].itag]||0;
      }});
    }finally{clearInterval(timer);}
    signal.throwIfAborted();d.status='assembling';d.speed=0;d.duration=result.duration||undefined;this.changed();
    let output;
    if(hasVideo){const {muxTracks}=await import('./mux.mjs');output=await muxTracks(dir,1,2,signal);}
    else{const {convertMedia}=await import('./mux.mjs');output=await convertMedia(dir,[path.join(dir,'0.part')],'mp3',signal);}
    d.total=d.downloaded=(await fs.stat(output)).size;d.segments=[{start:0,end:d.total-1,downloaded:d.total,done:true}];
    await this.assemble(d,dir,signal,[output],true);
  }
  async transfer(d, info, segment, file, headers, signal, url=d.url) {
    const expected = segment.end === null ? null : segment.end - segment.start + 1;
    if (expected !== null && segment.downloaded === expected) { await fs.appendFile(file, Buffer.alloc(0)); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      try {
        const ranged = info.ranges && info.total !== null;
        if (!ranged && segment.downloaded) { d.downloaded -= segment.downloaded; segment.downloaded = 0; await fs.writeFile(file, Buffer.alloc(0)); }
        const start = segment.start + segment.downloaded;
        const h = { ...headers };
        if (ranged) { h.Range = `bytes=${start}-${segment.end}`; if (info.validator) h['If-Range'] = info.validator; }
        const response = await request(url, { headers: h, signal });
        const throttle = throttleFrom(response); if (throttle) throw throttle;
        if ((ranged && response.statusCode !== 206) || (!ranged && response.statusCode !== 200)) {
          response.destroy(); throw new Error(`Server returned HTTP ${response.statusCode}${ranged ? ' instead of a byte range' : ''}.`);
        }
        if (ranged) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
          if (!match || Number(match[1]) !== start || Number(match[2]) !== segment.end || Number(match[3]) !== info.total) { response.destroy(); throw new Error('Server returned an inconsistent byte range.'); }
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); throw new Error('Server ignored identity encoding; refusing to save corrupt ranges.'); }
        const out = await fs.open(file, 'a');
        try {
          for await (const chunk of response) {
            signal.throwIfAborted();
            if (expected !== null && segment.downloaded + chunk.length > expected) throw new Error('Server sent more bytes than requested.');
            await this.throttle(chunk.length, signal);
            await out.writeFile(chunk); segment.downloaded += chunk.length; d.downloaded += chunk.length;
          }
          await out.sync();
        } finally { await out.close(); response.destroy(); }
        if (expected !== null && segment.downloaded !== expected) throw new Error('Connection ended before the segment finished.');
        return;
      } catch (error) {
        if (signal.aborted || attempt === 3 || error.retryable === false) throw error;
        await delay(error.retryDelay ?? retryDelay(error, attempt), undefined, { signal });
      }
    }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.shutdown();
    return this.closePromise;
  }
  async shutdown() {
    this.closing = true; clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
    await this.pool?.close();
    await this.hashService?.close();
    await this.persist();
  }
}
