import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validUrl, cleanHeaders, request, probe, transientStatus, retryAfter } from './http.mjs';
import { resolveHls, scopedHeaders } from './hls.mjs';
import { youtubeUrl, downloadYoutube } from './youtube.mjs';
import {streamProgress} from './stream-progress.mjs';
import {downloadSabr,normalizeSabrSession} from './sabr.mjs';

const TRANSIENT = new Set(['downloading', 'probing', 'assembling']);
const CATEGORY = { Video: /\.(mp4|webm|mkv|mov|avi|m4v)$/i, Audio: /\.(mp3|m4a|aac|flac|ogg|wav)$/i, Archives: /\.(zip|7z|rar|tar|gz|iso)$/i, Documents: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub)$/i, Programs: /\.(exe|msi|msix)$/i };
export function safeFilename(value) {
  let name = path.win32.basename(String(value || 'download')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (name.length > 180) {
    const extension = path.win32.extname(name);
    if (extension && extension.length < 180) {
      const basename = name.slice(0, -extension.length).slice(0, 180 - extension.length).replace(/[. ]+$/, '');
      name = basename + extension;
    } else name = name.slice(0, 180).replace(/[. ]+$/, '');
  }
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `download_${name || 'file'}`;
  return name;
}
function suggestedName(url, disposition) {
  const utf = /filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition || '');
  const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition || '');
  const extended = (utf?.[1] || utf?.[2] || '').trim().match(/^UTF-8'[^']*'(.*)$/i)?.[1];
  const candidates = [
    extended === undefined ? null : () => decodeURIComponent(extended),
    plain ? () => (plain[1] || plain[2]).trim() : null,
    () => decodeURIComponent(new URL(url).pathname.split('/').pop())
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const name = candidate(); if (name) return safeFilename(name); } catch { /* Try the standard fallback. */ }
  }
  return 'download';
}
const categoryFor = name => Object.entries(CATEGORY).find(([, re]) => re.test(name))?.[0] || 'Other';
// Marks a transfer failure that another attempt cannot fix, or the wait the server asked for.
const failure = (message, retryable = false, retryDelay = null) => Object.assign(new Error(message), { retryable, retryDelay });

export class DownloadEngine extends EventEmitter {
  constructor({ dataDirectory, downloadDirectory, tickMs = 500 }) {
    super();
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, 'downloads.json');
    this.partsDirectory = path.join(dataDirectory, 'parts');
    this.settings = { defaultDirectory: downloadDirectory, maxConcurrent: 3, connections: 8, speedLimitKbps: 0, categoryDirectories: {}, notifyOnComplete: true, revealOnComplete: false, confirmBrowserDownloads: true, startWithWindows: true };
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
    return { downloads: this.downloads.map(({ segments, headers, validator, sabr, ...d }) => ({ ...d,
      streamProgress: d.kind==='hls'?streamProgress(segments||[]):undefined,
      connectionsProgress: (segments || []).map(s => ({ start: s.start, end: s.end, downloaded: s.downloaded,
        total: s.end === null ? null : s.end - s.start + 1,
        status: s.done || (s.end !== null && s.downloaded === s.end - s.start + 1) ? 'complete' : d.status })) })), settings: { ...this.settings } };
  }
  async persist() {
    const content = JSON.stringify({ version: 1, settings: this.settings, downloads: this.downloads.map(d => ({ ...d, headers: undefined, sabr: undefined })) }, null, 2);
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
    for (const [key, max] of [['maxConcurrent', 16], ['connections', 32], ['speedLimitKbps', 1048576]]) {
      if (patch[key] !== undefined) {
        const n = Number(patch[key]);
        if (!Number.isInteger(n) || n < (key === 'speedLimitKbps' ? 0 : 1) || n > max) throw new Error(`Invalid ${key}.`);
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
        if (![...Object.keys(CATEGORY), 'Other'].includes(category) || typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid category folder.');
        next.categoryDirectories[category] = path.resolve(folder);
      }
    }
    for (const key of ['notifyOnComplete', 'revealOnComplete', 'confirmBrowserDownloads', 'hideCompletionDialog', 'startWithWindows']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw new Error(`Invalid ${key}.`); next[key] = patch[key]; }
    if (next.speedLimitKbps !== this.settings.speedLimitKbps) this.rateNext = 0;
    this.settings = next;
    if (save) return this.persist().then(() => { this.changed(); this.tick(); return this.snapshot(); });
  }
  async add({ urls, url, audioUrl, outputFormat, youtubeFormat, sabr, filename, scheduledAt, referer, headers, directory, category, description, queueOnly = false, reviewOnly = false, reuseActive = false } = {}) {
    const source = urls || (url ? [url] : []);
    if (!Array.isArray(source) || !source.length || source.length > 500) throw new Error('Add between 1 and 500 download URLs.');
    const normalized = source.map(validUrl);
    if(youtubeFormat!==undefined&&(!/^(?:audio:)?[\w-]+(?:\+[\w-]+)?$/.test(youtubeFormat)||youtubeFormat.length>80||normalized.some(u=>!youtubeUrl(u))))throw new Error('Invalid YouTube format.');
    if(outputFormat!==undefined&&!['mp4','mp3'].includes(outputFormat))throw new Error('Invalid output format.');
    const sabrSession=sabr===undefined?undefined:normalizeSabrSession(sabr);
    if(sabrSession&&normalized.length!==1)throw new Error('A SABR session requires exactly one YouTube stream.');
    const audio = audioUrl ? validUrl(audioUrl) : undefined;
    if (audio && normalized.length !== 1) throw new Error('A separate audio track requires exactly one video.');
    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (when !== null && !Number.isFinite(when)) throw new Error('Invalid scheduled time.');
    if (normalized.some(u => /\.mpd(?:[?#]|$)/i.test(u))) throw new Error('DASH streams need a muxing engine; direct files and non-encrypted HLS VOD are supported.');
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('Choose an absolute save folder.');
    if (category !== undefined && ![...Object.keys(CATEGORY), 'Other'].includes(category)) throw new Error('Invalid category.');
    if (description !== undefined && (typeof description !== 'string' || description.length > 4096)) throw new Error('Description is too long.');
    if(reuseActive && normalized.length===1){
      const existing=this.downloads.find(d=>!['complete','cancelled','error'].includes(d.status) && d.outputFormat===outputFormat &&
        (sabrSession ? d.sabr?.videoId===sabrSession.videoId && d.sabr?.videoItag===sabrSession.videoItag && d.sabr?.audioItag===sabrSession.audioItag : !d.sabr && d.url===normalized[0] && d.audioUrl===audio && d.youtubeFormat===youtubeFormat));
      if(existing)return [existing.id];
    }
    const added = normalized.map(u => {
      const name = safeFilename(filename || suggestedName(u));
      const selectedCategory = category || categoryFor(name);
      return { id: randomUUID(), url: u, audioUrl: audio, outputFormat, youtubeFormat, sabr:sabrSession, filename: name, explicitFilename: Boolean(filename), category: selectedCategory, explicitCategory: Boolean(category), description: description || '',
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
  async reviewDownload({ id, filename, directory, category, description = '', queueOnly = false, scheduledAt } = {}) {
    const d = this.downloads.find(d => d.id === id);
    if (!d?.needsReview || this.jobs.has(id)) throw new Error('This download is not waiting for confirmation.');
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('Choose an absolute save folder.');
    if (category !== undefined && ![...Object.keys(CATEGORY), 'Other'].includes(category)) throw new Error('Invalid category.');
    if (typeof description !== 'string' || description.length > 4096) throw new Error('Description is too long.');
    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (when !== null && !Number.isFinite(when)) throw new Error('Invalid scheduled time.');
    if (filename) { d.explicitFilename ||= filename !== d.filename; d.filename = safeFilename(filename); }
    if (category) { d.category = category; d.explicitCategory = true; }
    if (directory) d.directory = path.resolve(directory);
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
      if (action !== 'pause') { await fs.rm(path.join(this.partsDirectory, id), { recursive: true, force: true }); d.segments = []; if (d.status !== 'complete') d.downloaded = 0; }
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
    d.status = 'probing'; d.error = null; d.notice = null; this.changed();
    if(d.sabr){await this.runSabr(d,cleanHeaders(d.headers),signal);return;}
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
    if(d.audioUrl){await this.runPairedTracks(d,headers,signal);return;}
    const info = await probe(d.url, headers, signal);
    const mime = String(info.headers['content-type'] || '');
    if (/mpegurl/i.test(mime)) { await this.runHls(d, headers, signal); return; }
    if (/dash\+xml/i.test(mime)) throw new Error('DASH streams need a muxing engine, which is not included yet.');
    if (!d.explicitFilename) { d.filename = suggestedName(info.url, info.headers['content-disposition']); if (!d.explicitCategory) d.category = categoryFor(d.filename); }
    const dir = path.join(this.partsDirectory, d.id);
    await fs.mkdir(dir, { recursive: true });
    // Resume only when both resource identity and range support can be established.
    if (!info.ranges || !info.validator || d.validator !== info.validator || d.total !== info.total) {
      if (d.segments.some(s => s.downloaded > 0)) d.notice = `${!info.ranges ? 'The server does not support resuming'
        : !info.validator ? 'The server does not identify the file version' : 'The file changed on the server'}; restarted from the beginning.`;
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      d.segments = [];
    }
    d.total = info.total; d.validator = info.validator;
    d.resumable = Boolean(info.ranges && info.validator);
    const count = info.ranges && info.total > 1024 * 1024 ? Math.min(this.settings.connections, Math.ceil(info.total / (512 * 1024))) : 1;
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
    const workerControllers = d.segments.map(() => new AbortController());
    let fallbackResponse = null, fallbackIndex = -1, retryWithoutRange = false;
    try {
      const outcomes = await Promise.allSettled(d.segments.map(async (segment, i) => {
        try {
          const result = await this.transfer(d, info, segment, path.join(dir, `${i}.part`), headers,
            AbortSignal.any([signal, workerControllers[i].signal]));
          if (result?.fallbackResponse) {
            if (fallbackResponse) result.fallbackResponse.destroy();
            else {
              fallbackResponse = result.fallbackResponse;
              fallbackIndex = i;
              workerControllers.forEach((controller, index) => { if (index !== i) controller.abort(); });
            }
          } else if (result?.retryWithoutRange) {
            retryWithoutRange = true;
            workerControllers.forEach((controller, index) => { if (index !== i) controller.abort(); });
          }
        } catch (error) {
          // Do not abort the worker whose full 200 response is being consumed.
          if (fallbackIndex >= 0) {
            workerControllers.forEach((controller, index) => {
              if (index !== i && index !== fallbackIndex) controller.abort();
            });
          } else {
            // Keep the first request alive in case it returns a full 200 fallback.
            const preserveFirst = i > 0 && !retryWithoutRange;
            workerControllers.forEach((controller, index) => {
              if (index !== i && !(preserveFirst && index === 0)) controller.abort();
            });
          }
          throw error;
        }
      }));
      if (fallbackResponse || retryWithoutRange) {
        await this.downloadUnranged(d, dir, headers, signal, fallbackResponse, info.url);
      } else {
        const transferFailure = outcomes.find(r => r.status === 'rejected' && r.reason.name !== 'AbortError') || outcomes.find(r => r.status === 'rejected');
        if (transferFailure) throw transferFailure.reason;
      }
    } finally { clearInterval(progress); }
    await this.assemble(d, dir, signal);
  }
  async downloadUnranged(d, dir, headers, signal, response, url) {
    if (!response) response = await request(url, { headers, signal });
    if (response.statusCode !== 200) {
      const status = response.statusCode;
      response.destroy();
      throw failure(`Server returned HTTP ${status} when retrying without byte ranges.`);
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') {
      response.destroy();
      throw failure('Server ignored identity encoding; refusing to save a potentially corrupt file.');
    }
    const rawLength = response.headers['content-length'];
    const parsedLength = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const expected = Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null;

    // A full response replaces every partial range; never concatenate it with stale segments.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, '0.part');
    const segment = { start: 0, end: expected !== null && expected > 0 ? expected - 1 : null, downloaded: 0 };
    d.segments = [segment];
    d.connections = 1;
    d.total = expected;
    d.downloaded = 0;
    d.validator = null;
    d.resumable = false;
    d.status = 'downloading';

    let received = 0, out;
    try {
      out = await fs.open(file, 'w');
      await this.persist();
      this.changed();
      for await (const chunk of response) {
        signal.throwIfAborted();
        if (expected !== null && received + chunk.length > expected) {
          throw failure('Server sent more bytes than advertised.');
        }
        await this.throttle(chunk.length, signal);
        await out.writeFile(chunk);
        received += chunk.length;
        segment.downloaded = received;
        d.downloaded = received;
      }
      if (expected !== null && received !== expected) {
        throw failure('Connection ended before the full file finished.');
      }
      await out.sync();
    } finally {
      try { if (out) await out.close(); } finally { response.destroy(); }
    }
    d.total = received;
    segment.end = received > 0 ? received - 1 : null;
    await this.persist();
    this.changed();
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
      for (const file of files) {
        const input = await fs.open(file, 'r');
        try {
          for await (const chunk of input.createReadStream()) { signal.throwIfAborted(); await out.writeFile(chunk); }
        } finally { await input.close(); }
      }
      await out.sync(); complete = true;
    } finally { await out.close(); if (!complete) await fs.unlink(destination); }
    d.path = destination; d.filename = path.basename(destination); d.status = 'complete';
    d.completedAt = new Date().toISOString();
    await this.persist();
    try { await fs.rm(dir, { recursive: true, force: true }); }
    catch (error) { d.cleanupError = `Downloaded file is complete; temporary segments could not be removed: ${error.message}`; }
    this.emit('complete', { ...d });
  }
  async runHls(d, headers, signal) {
    const plan = await resolveHls(d.url, headers, signal);
    if (d.audioUrl) plan.audio = await resolveHls(d.audioUrl, scopedHeaders(headers, d.url, d.audioUrl), signal);
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
            await delay(250 * 2 ** attempt, undefined, { signal: groupSignal });
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
    const infos=await Promise.all(urls.map((url,i)=>probe(url,trackHeaders[i],signal)));
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
        if (ranged && response.statusCode === 200) {
          // If-Range can legitimately turn a range request into a full 200 response.
          // Keep this response body and restart as one non-range transfer.
          return { fallbackResponse: response };
        }
        if (ranged && response.statusCode === 416) {
          response.destroy();
          return { retryWithoutRange: true };
        }
        if ((ranged && response.statusCode !== 206) || (!ranged && response.statusCode !== 200)) {
          const status = response.statusCode; response.destroy();
          throw failure(`Server returned HTTP ${status}${ranged ? ' instead of a byte range' : ''}.`, transientStatus(status),
            status === 429 || status === 503 ? retryAfter(response.headers['retry-after']) : null);
        }
        if (ranged) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
          if (!match || Number(match[1]) !== start || Number(match[2]) !== segment.end || Number(match[3]) !== info.total) { response.destroy(); throw failure('Server returned an inconsistent byte range.'); }
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); throw failure('Server ignored identity encoding; refusing to save corrupt ranges.'); }
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
        // Never shorten the server's requested cooldown. Long waits release
        // the active job instead of consuming a download slot indefinitely.
        if (error.retryDelay > 60000) throw failure('The server requested a longer cooldown. Retry after ' + Math.ceil(error.retryDelay / 1000) + ' seconds. Partial data has been kept.');
        await delay(error.retryDelay ?? 250 * 2 ** attempt, undefined, { signal });
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
    await this.persist();
  }
}
