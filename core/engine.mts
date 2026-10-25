import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  validUrl,
  cleanHeaders,
  request,
  probe,
  type HeaderMap,
  type HttpResponse,
  type ProbeInfo,
} from './http.mjs';
import { resolveHls, scopedHeaders } from './hls.mjs';
import { youtubeUrl, downloadYoutube } from './youtube.mjs';
import { streamProgress } from './stream-progress.mjs';
import { downloadSabr, normalizeSabrSession } from './sabr.mjs';
import type {
  Category,
  Download,
  DownloadStatus,
  OutputFormat,
  Segment,
  Settings,
} from './types.mjs';

export type * from './types.mjs';

export interface AddOptions {
  urls?: string[];
  url?: string;
  audioUrl?: string;
  outputFormat?: OutputFormat;
  youtubeFormat?: string;
  sabr?: unknown;
  filename?: string;
  scheduledAt?: string | number | null;
  referer?: string;
  headers?: Record<string, unknown>;
  directory?: string;
  category?: Category;
  description?: string;
  queueOnly?: boolean;
  reviewOnly?: boolean;
  reuseActive?: boolean;
}
export interface ReviewOptions {
  id?: string;
  filename?: string;
  directory?: string;
  category?: Category;
  description?: string;
  queueOnly?: boolean;
  scheduledAt?: string | number | null;
}
export type Snapshot = ReturnType<DownloadEngine['snapshot']>;
interface Job {
  controller: AbortController;
  promise: Promise<void>;
}

const TRANSIENT = new Set(['downloading', 'probing', 'assembling']);

const CATEGORY = {
  Video: /\.(mp4|webm|mkv|mov|avi|m4v)$/i,
  Audio: /\.(mp3|m4a|aac|flac|ogg|wav)$/i,
  Archives: /\.(zip|7z|rar|tar|gz|iso)$/i,
  Documents: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub)$/i,
  Programs: /\.(exe|msi|msix)$/i,
};

export function safeFilename(value: unknown) {
  let name = path.win32
    .basename(String(value || 'download'))
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 180);

  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    name = `download_${name || 'file'}`;
  }

  return name;
}

// A new or just-confirmed download is held, scheduled for later, or queued.
function initialStatus(hold: boolean, when: number | null): DownloadStatus {
  if (hold) {
    return 'paused';
  }

  return when && when > Date.now() ? 'scheduled' : 'queued';
}

function suggestedName(url: string, disposition?: string) {
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
  const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition || '');

  try {
    if (utf) {
      return safeFilename(decodeURIComponent(utf[1]));
    }

    if (plain) {
      return safeFilename((plain[1] || plain[2]).trim());
    }

    return safeFilename(decodeURIComponent(new URL(url).pathname.split('/').pop()!) || 'download');
  } catch {
    return 'download';
  }
}

const categoryFor = (name: string) =>
  (Object.entries(CATEGORY).find(([, re]) => re.test(name))?.[0] as Category | undefined) ||
  'Other';

// Prefer the failure that caused sibling transfers to abort over their AbortErrors.
function firstFailure(outcomes: PromiseSettledResult<unknown>[]) {
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  return rejected.find((outcome) => outcome.reason.name !== 'AbortError') || rejected[0];
}

export class DownloadEngine extends EventEmitter {
  dataDirectory: string;

  statePath: string;

  partsDirectory: string;

  settings: Settings;

  downloads: Download[];

  jobs: Map<string, Job>;

  persistChain: Promise<void>;

  tickMs: number;

  closing: boolean;

  rateTail: Promise<void>;

  rateNext: number;

  timer?: NodeJS.Timeout;

  closePromise?: Promise<void>;

  constructor({
    dataDirectory,
    downloadDirectory,
    tickMs = 500,
  }: {
    dataDirectory: string;
    downloadDirectory: string;
    tickMs?: number;
  }) {
    super();
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, 'downloads.json');
    this.partsDirectory = path.join(dataDirectory, 'parts');

    this.settings = {
      defaultDirectory: downloadDirectory,
      maxConcurrent: 3,
      connections: 8,
      speedLimitKbps: 0,
      categoryDirectories: {},
      notifyOnComplete: true,
      revealOnComplete: false,
      confirmBrowserDownloads: true,
    };

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

      this.downloads = (state.downloads || []).map((download: Download) => ({
        ...download,
        status: TRANSIENT.has(download.status) ? 'paused' : download.status,
        speed: 0,
      }));
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;

      if (code !== 'ENOENT') {
        throw new Error(`Could not load download history: ${message}`);
      }
    }

    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    this.tick();
    return this;
  }

  snapshot() {
    return {
      downloads: this.downloads.map(({ segments, headers, validator, sabr, ...download }) => ({
        ...download,
        streamProgress: download.kind === 'hls' ? streamProgress(segments || []) : undefined,
        connectionsProgress: (segments || []).map((segment) => ({
          start: segment.start,
          end: segment.end,
          downloaded: segment.downloaded,
          total: segment.end === null ? null : segment.end - segment.start + 1,
          status:
            segment.done ||
            (segment.end !== null && segment.downloaded === segment.end - segment.start + 1)
              ? 'complete'
              : download.status,
        })),
      })),
      settings: { ...this.settings },
    };
  }

  async persist() {
    const content = JSON.stringify(
      {
        version: 1,
        settings: this.settings,
        downloads: this.downloads.map((download) => ({
          ...download,
          headers: undefined,
          sabr: undefined,
        })),
      },
      null,
      2,
    );

    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        const temp = `${this.statePath}.tmp`;
        await fs.writeFile(temp, content, { mode: 0o600 });
        await fs.rename(temp, this.statePath);
      });

    return this.persistChain;
  }

  changed() {
    this.emit('change', this.snapshot());
  }

  // Patches arrive untyped over IPC, so every field is validated here.
  updateSettings(patch: Record<string, unknown>, save = true): Promise<Snapshot> | undefined {
    if (!patch || typeof patch !== 'object') {
      throw new Error('Invalid settings.');
    }

    const next = { ...this.settings };

    for (const [key, max] of [
      ['maxConcurrent', 16],
      ['connections', 32],
      ['speedLimitKbps', 1048576],
    ] as const) {
      if (patch[key] !== undefined) {
        const value = Number(patch[key]);

        if (!Number.isInteger(value) || value < (key === 'speedLimitKbps' ? 0 : 1) || value > max) {
          throw new Error(`Invalid ${key}.`);
        }

        next[key] = value;
      }
    }

    if (patch.defaultDirectory !== undefined) {
      if (typeof patch.defaultDirectory !== 'string' || !path.isAbsolute(patch.defaultDirectory)) {
        throw new Error('Choose an absolute download folder.');
      }

      next.defaultDirectory = path.resolve(patch.defaultDirectory);
    }

    if (patch.categoryDirectories !== undefined) {
      if (
        !patch.categoryDirectories ||
        typeof patch.categoryDirectories !== 'object' ||
        Array.isArray(patch.categoryDirectories)
      ) {
        throw new Error('Invalid category folders.');
      }

      next.categoryDirectories = {};

      for (const [category, folder] of Object.entries(patch.categoryDirectories)) {
        if (
          ![...Object.keys(CATEGORY), 'Other'].includes(category) ||
          typeof folder !== 'string' ||
          !path.isAbsolute(folder)
        ) {
          throw new Error('Invalid category folder.');
        }

        next.categoryDirectories[category as Category] = path.resolve(folder);
      }
    }

    for (const key of [
      'notifyOnComplete',
      'revealOnComplete',
      'confirmBrowserDownloads',
      'hideCompletionDialog',
    ] as const) {
      const value = patch[key];

      if (value !== undefined) {
        if (typeof value !== 'boolean') {
          throw new Error(`Invalid ${key}.`);
        }

        next[key] = value;
      }
    }

    if (next.speedLimitKbps !== this.settings.speedLimitKbps) {
      this.rateNext = 0;
    }

    this.settings = next;

    if (!save) {
      return undefined;
    }

    return this.persist().then(() => {
      this.changed();
      this.tick();
      return this.snapshot();
    });
  }

  async add({
    urls,
    url,
    audioUrl,
    outputFormat,
    youtubeFormat,
    sabr,
    filename,
    scheduledAt,
    referer,
    headers,
    directory,
    category,
    description,
    queueOnly = false,
    reviewOnly = false,
    reuseActive = false,
  }: AddOptions = {}) {
    const source = urls || (url ? [url] : []);

    if (!Array.isArray(source) || !source.length || source.length > 500) {
      throw new Error('Add between 1 and 500 download URLs.');
    }

    const normalized = source.map(validUrl);

    if (
      youtubeFormat !== undefined &&
      (!/^(?:audio:)?[\w-]+(?:\+[\w-]+)?$/.test(youtubeFormat) ||
        youtubeFormat.length > 80 ||
        normalized.some((normalizedUrl) => !youtubeUrl(normalizedUrl)))
    ) {
      throw new Error('Invalid YouTube format.');
    }

    if (outputFormat !== undefined && !['mp4', 'mp3'].includes(outputFormat)) {
      throw new Error('Invalid output format.');
    }

    const sabrSession = sabr === undefined ? undefined : normalizeSabrSession(sabr);

    if (sabrSession && normalized.length !== 1) {
      throw new Error('A SABR session requires exactly one YouTube stream.');
    }

    const audio = audioUrl ? validUrl(audioUrl) : undefined;

    if (audio && normalized.length !== 1) {
      throw new Error('A separate audio track requires exactly one video.');
    }

    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;

    if (when !== null && !Number.isFinite(when)) {
      throw new Error('Invalid scheduled time.');
    }

    if (normalized.some((normalizedUrl) => /\.mpd(?:[?#]|$)/i.test(normalizedUrl))) {
      throw new Error(
        'DASH streams need a muxing engine; direct files and non-encrypted HLS VOD are supported.',
      );
    }

    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) {
      throw new Error('Choose an absolute save folder.');
    }

    if (category !== undefined && ![...Object.keys(CATEGORY), 'Other'].includes(category)) {
      throw new Error('Invalid category.');
    }

    if (
      description !== undefined &&
      (typeof description !== 'string' || description.length > 4096)
    ) {
      throw new Error('Description is too long.');
    }

    if (reuseActive && normalized.length === 1) {
      const existing = this.downloads.find(
        (download) =>
          !['complete', 'cancelled', 'error'].includes(download.status) &&
          download.outputFormat === outputFormat &&
          (sabrSession
            ? download.sabr?.videoId === sabrSession.videoId &&
              download.sabr?.videoItag === sabrSession.videoItag &&
              download.sabr?.audioItag === sabrSession.audioItag
            : !download.sabr &&
              download.url === normalized[0] &&
              download.audioUrl === audio &&
              download.youtubeFormat === youtubeFormat),
      );

      if (existing) {
        return [existing.id];
      }
    }

    const added = normalized.map((normalizedUrl): Download => {
      const name = safeFilename(filename || suggestedName(normalizedUrl));
      const selectedCategory = category || categoryFor(name);
      return {
        id: randomUUID(),
        url: normalizedUrl,
        audioUrl: audio,
        outputFormat,
        youtubeFormat,
        sabr: sabrSession,
        filename: name,
        explicitFilename: Boolean(filename),
        category: selectedCategory,
        explicitCategory: Boolean(category),
        description: description || '',
        status: initialStatus(queueOnly || reviewOnly, when),
        needsReview: reviewOnly,
        scheduledAt: when ? new Date(when).toISOString() : null,
        downloaded: 0,
        total: null,
        speed: 0,
        connections: 0,
        error: null,
        path: null,
        directory:
          directory ||
          this.settings.categoryDirectories[selectedCategory] ||
          this.settings.defaultDirectory,
        createdAt: new Date().toISOString(),
        segments: [],
        validator: null,
        headers: cleanHeaders({ ...headers, ...(referer ? { referer } : {}) }),
      };
    });

    this.downloads.push(...added);
    await this.persist();
    this.changed();
    this.tick();
    return added.map((download) => download.id);
  }

  async reviewDownload({
    id,
    filename,
    directory,
    category,
    description = '',
    queueOnly = false,
    scheduledAt,
  }: ReviewOptions = {}) {
    const download = this.downloads.find((item) => item.id === id);

    if (!download?.needsReview || this.jobs.has(download.id)) {
      throw new Error('This download is not waiting for confirmation.');
    }

    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) {
      throw new Error('Choose an absolute save folder.');
    }

    if (category !== undefined && ![...Object.keys(CATEGORY), 'Other'].includes(category)) {
      throw new Error('Invalid category.');
    }

    if (typeof description !== 'string' || description.length > 4096) {
      throw new Error('Description is too long.');
    }

    const when = scheduledAt ? new Date(scheduledAt).getTime() : null;

    if (when !== null && !Number.isFinite(when)) {
      throw new Error('Invalid scheduled time.');
    }

    if (filename) {
      download.explicitFilename ||= filename !== download.filename;
      download.filename = safeFilename(filename);
    }

    if (category) {
      download.category = category;
      download.explicitCategory = true;
    }

    if (directory) {
      download.directory = path.resolve(directory);
    }

    download.description = description;
    download.needsReview = false;
    download.scheduledAt = when ? new Date(when).toISOString() : null;
    download.status = initialStatus(queueOnly, when);
    await this.persist();
    this.changed();
    this.tick();
    return [download.id];
  }

  async action(id: string, action: string) {
    const download = this.downloads.find((item) => item.id === id);

    if (!download) {
      throw new Error('Download not found.');
    }

    if (!['pause', 'resume', 'retry', 'cancel', 'remove'].includes(action)) {
      throw new Error('Unknown download action.');
    }

    if (action === 'pause' || action === 'cancel' || action === 'remove') {
      const job = this.jobs.get(id);

      if (job) {
        job.controller.abort();
        await job.promise;
      }

      if (action === 'pause' && download.status !== 'complete') {
        download.status = 'paused';
      }

      if (action === 'cancel' && download.status !== 'complete') {
        download.status = 'cancelled';
        download.needsReview = false;
      }

      if (action === 'remove') {
        this.downloads = this.downloads.filter((item) => item.id !== id);
      }

      if (action !== 'pause') {
        await fs.rm(path.join(this.partsDirectory, id), { recursive: true, force: true });
        download.segments = [];

        if (download.status !== 'complete') {
          download.downloaded = 0;
        }
      }
    } else {
      if (download.needsReview) {
        throw new Error('Confirm this browser download in Download File Info first.');
      }

      if (this.jobs.has(id) || download.status === 'complete') {
        return;
      }

      download.error = null;
      download.status = 'queued';
      download.scheduledAt = null;
    }

    download.speed = 0;
    await this.persist();
    this.changed();
    this.tick();
  }

  tick() {
    if (this.closing) {
      return;
    }

    for (const download of this.downloads) {
      if (
        download.status === 'scheduled' &&
        new Date(download.scheduledAt ?? 0).getTime() <= Date.now()
      ) {
        download.status = 'queued';
      }

      if (
        download.status === 'queued' &&
        !this.jobs.has(download.id) &&
        this.jobs.size < this.settings.maxConcurrent
      ) {
        const controller = new AbortController();
        const job: Job = { controller, promise: Promise.resolve() };
        this.jobs.set(download.id, job);

        job.promise = this.run(download, controller.signal)
          .catch((error) => {
            download.status = controller.signal.aborted ? 'paused' : 'error';
            download.error = controller.signal.aborted ? null : error.message;
          })
          .finally(async () => {
            download.speed = 0;

            // Keep the job owned until all cleanup and its final checkpoint finish.
            try {
              await this.persist();
            } catch (error) {
              download.status = 'error';
              download.error = `History checkpoint failed: ${(error as Error).message}`;
            }

            this.jobs.delete(download.id);

            if (!this.jobs.size) {
              this.rateNext = 0;
            }

            this.changed();
            this.tick();
          });
      }
    }
  }

  async throttle(bytes: number, signal: AbortSignal) {
    if (!this.settings.speedLimitKbps) {
      return;
    }

    const wait = Math.max(0, this.rateNext - Date.now());

    this.rateNext =
      Math.max(Date.now(), this.rateNext) + (bytes * 1000) / (this.settings.speedLimitKbps * 1024);

    if (wait) {
      await delay(wait, undefined, { signal });
    }
  }

  async run(download: Download, signal: AbortSignal) {
    download.status = 'probing';
    download.error = null;
    this.changed();

    if (download.sabr) {
      await this.runSabr(download, cleanHeaders(download.headers), signal);
      return;
    }

    if (youtubeUrl(download.url)) {
      const dir = path.join(this.partsDirectory, download.id);
      await fs.mkdir(dir, { recursive: true });
      download.kind = 'youtube';
      download.resumable = true;
      download.connections = 1;

      const result = await downloadYoutube({
        url: download.url,
        formatKey: download.youtubeFormat,
        directory: dir,
        signal,
        speedLimitKbps: this.settings.speedLimitKbps,
        onMetadata: (choice) => {
          download.filename = safeFilename(`${choice.title}.${choice.outputFormat}`);
          download.duration = choice.duration;
          this.changed();
        },
        onProgress: (progress) => {
          Object.assign(download, progress);

          download.segments = [
            {
              start: 0,
              end: progress.total ? progress.total - 1 : null,
              downloaded: progress.downloaded,
            },
          ];

          this.changed();
        },
      });

      download.filename = safeFilename(`${result.choice.title}.${result.choice.outputFormat}`);
      download.duration = result.choice.duration;
      download.category = result.choice.outputFormat === 'mp3' ? 'Audio' : 'Video';
      download.total = result.size;
      download.downloaded = result.size;
      download.estimated = false;
      download.segments = [{ start: 0, end: result.size - 1, downloaded: result.size, done: true }];
      await this.assemble(download, dir, signal, [result.output], true);
      return;
    }

    const headers = cleanHeaders(download.headers);

    if (/\.m3u8(?:[?#]|$)/i.test(download.url)) {
      await this.runHls(download, headers, signal);
      return;
    }

    if (download.audioUrl) {
      await this.runPairedTracks(download, headers, signal);
      return;
    }

    const resourceInfo = await probe(download.url, headers, signal);
    const mime = String(resourceInfo.headers['content-type'] || '');

    if (/mpegurl/i.test(mime)) {
      await this.runHls(download, headers, signal);
      return;
    }

    if (/dash\+xml/i.test(mime)) {
      throw new Error('DASH streams need a muxing engine, which is not included yet.');
    }

    if (!download.explicitFilename) {
      download.filename = suggestedName(
        resourceInfo.url,
        resourceInfo.headers['content-disposition'],
      );

      if (!download.explicitCategory) {
        download.category = categoryFor(download.filename);
      }
    }

    const dir = path.join(this.partsDirectory, download.id);
    await fs.mkdir(dir, { recursive: true });

    // Resume only when both resource identity and range support can be established.
    if (
      !resourceInfo.ranges ||
      !resourceInfo.validator ||
      download.validator !== resourceInfo.validator ||
      download.total !== resourceInfo.total
    ) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      download.segments = [];
    }

    download.total = resourceInfo.total;
    download.validator = resourceInfo.validator;
    download.resumable = Boolean(resourceInfo.ranges && resourceInfo.validator);

    const count =
      resourceInfo.ranges && resourceInfo.total !== null && resourceInfo.total > 1024 * 1024
        ? Math.min(this.settings.connections, Math.ceil(resourceInfo.total / (512 * 1024)))
        : 1;

    if (!download.segments.length) {
      download.segments = Array.from({ length: count }, (_, segmentIndex) => ({
        start:
          resourceInfo.total === null ? 0 : Math.floor((resourceInfo.total * segmentIndex) / count),
        end:
          resourceInfo.total === null
            ? null
            : Math.floor((resourceInfo.total * (segmentIndex + 1)) / count) - 1,
        downloaded: 0,
      }));
    }

    for (let segmentIndex = 0; segmentIndex < download.segments.length; segmentIndex += 1) {
      let size = 0;

      try {
        size = (await fs.stat(path.join(dir, `${segmentIndex}.part`))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const segment = download.segments[segmentIndex];

      if (segment.end !== null && size > segment.end - segment.start + 1) {
        throw new Error(
          'Partial file is larger than its segment. Remove and re-add this download.',
        );
      }

      segment.downloaded = size;
    }

    download.downloaded = download.segments.reduce((sum, segment) => sum + segment.downloaded, 0);
    download.connections = download.segments.length;
    download.status = 'downloading';
    await this.persist();
    this.changed();
    let lastBytes = download.downloaded;
    let lastAt = Date.now();

    const progress = setInterval(() => {
      const now = Date.now();
      download.speed = ((download.downloaded - lastBytes) * 1000) / (now - lastAt);
      lastBytes = download.downloaded;
      lastAt = now;
      this.changed();
    }, this.tickMs);

    const siblings = new AbortController();
    const transferSignal = AbortSignal.any([signal, siblings.signal]);

    try {
      const outcomes = await Promise.allSettled(
        download.segments.map((segment, segmentIndex) =>
          this.transfer(
            download,
            resourceInfo,
            segment,
            path.join(dir, `${segmentIndex}.part`),
            headers,
            transferSignal,
          ).catch((error) => {
            siblings.abort();
            throw error;
          }),
        ),
      );

      const failure = firstFailure(outcomes);

      if (failure) {
        throw failure.reason;
      }
    } finally {
      clearInterval(progress);
    }

    await this.assemble(download, dir, signal);
  }

  async assemble(
    download: Download,
    dir: string,
    signal: AbortSignal,
    files = download.segments.map((_, segmentIndex) => path.join(dir, `${segmentIndex}.part`)),
    converted = false,
  ): Promise<void> {
    signal.throwIfAborted();
    download.status = 'assembling';
    download.speed = 0;
    this.changed();

    if (download.outputFormat && !converted) {
      const { convertMedia } = await import('./mux.mjs');
      const output = await convertMedia(dir, files, download.outputFormat, signal);

      download.filename = safeFilename(
        `${download.filename.replace(/\.[^.]+$/, '')}.${download.outputFormat}`,
      );

      if (!download.explicitCategory) {
        download.category = download.outputFormat === 'mp3' ? 'Audio' : 'Video';
      }

      await this.assemble(download, dir, signal, [output], true);
      return;
    }

    await fs.mkdir(download.directory, { recursive: true });
    // Exclusive creation prevents collision with user files or another download.
    let destination = '';
    let destinationFile: FileHandle | undefined;

    for (let suffix = 0; suffix < 10000; suffix += 1) {
      const extension = path.extname(download.filename);
      const base = path.basename(download.filename, extension);

      destination = path.join(
        download.directory,
        suffix ? `${base} (${suffix})${extension}` : download.filename,
      );

      try {
        destinationFile = await fs.open(destination, 'wx');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }

    if (!destinationFile) {
      throw new Error('Could not choose a free output filename.');
    }

    let complete = false;

    try {
      for (const file of files) {
        const input = await fs.open(file, 'r');

        try {
          for await (const chunk of input.createReadStream()) {
            signal.throwIfAborted();
            await destinationFile.writeFile(chunk);
          }
        } finally {
          await input.close();
        }
      }

      await destinationFile.sync();
      complete = true;
    } finally {
      await destinationFile.close();

      if (!complete) {
        await fs.unlink(destination);
      }
    }

    download.path = destination;
    download.filename = path.basename(destination);
    download.status = 'complete';
    download.completedAt = new Date().toISOString();
    await this.persist();

    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      download.cleanupError = `Downloaded file is complete; temporary segments could not be removed: ${(error as Error).message}`;
    }

    this.emit('complete', { ...download });
  }

  async runHls(download: Download, headers: HeaderMap, signal: AbortSignal) {
    const plan = await resolveHls(download.url, headers, signal);

    if (download.audioUrl) {
      plan.audio = await resolveHls(
        download.audioUrl,
        scopedHeaders(headers, download.url, download.audioUrl),
        signal,
      );
    }

    const videoCount = plan.urls.length;

    if (plan.audio) {
      plan.urls.push(...plan.audio.urls);
      plan.identity += `:${plan.audio.identity}`;
      plan.extension = '.mp4';
    }

    const dir = path.join(this.partsDirectory, download.id);

    if (download.playlistIdentity !== plan.identity) {
      await fs.rm(dir, { recursive: true, force: true });
      download.segments = [];
    }

    await fs.mkdir(dir, { recursive: true });
    download.playlistIdentity = plan.identity;
    download.duration = plan.duration;
    download.resumable = true;
    download.kind = 'hls';

    if (!download.explicitFilename && !download.hlsFilenameResolved) {
      download.filename = safeFilename(
        download.filename.replace(/\.(m3u8|mpd)$/i, '') + plan.extension,
      );

      download.hlsFilenameResolved = true;
    }

    if (!download.explicitCategory) {
      download.category = 'Video';
    }

    download.total = null;
    download.downloaded = 0;

    download.segments = await Promise.all(
      plan.urls.map(async (url, segmentIndex) => {
        let size = 0;
        let done = false;

        try {
          size = (await fs.stat(path.join(dir, `${segmentIndex}.part`))).size;
          done = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }

        download.downloaded += size;
        return { url, start: 0, end: null, downloaded: size, done };
      }),
    );

    download.connections = Math.min(this.settings.connections, download.segments.length);
    download.status = 'downloading';
    await this.persist();
    this.changed();
    let index = 0;
    let lastBytes = download.downloaded;
    let lastTime = Date.now();

    const progress = setInterval(() => {
      const now = Date.now();
      download.speed = ((download.downloaded - lastBytes) * 1000) / Math.max(1, now - lastTime);
      lastBytes = download.downloaded;
      lastTime = now;
      this.changed();
    }, this.tickMs);

    const siblings = new AbortController();
    const groupSignal = AbortSignal.any([signal, siblings.signal]);

    // Fetches one segment into its .part file, retrying with backoff.
    const fetchSegment = async (segment: Segment, segmentIndex: number) => {
      // Every HLS segment is created above with its playlist URL.
      const url = segment.url!;
      const receivingPath = path.join(dir, `${segmentIndex}.receiving`);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        download.downloaded -= segment.downloaded;
        segment.downloaded = 0;
        const partFile = await fs.open(receivingPath, 'w');
        let response: HttpResponse | undefined;

        try {
          response = await request(url, {
            headers: scopedHeaders(headers, plan.source, url),
            signal: groupSignal,
          });

          if (response.statusCode !== 200) {
            throw new Error(`HLS segment returned HTTP ${response.statusCode}.`);
          }

          const expected = Number(response.headers['content-length']);

          for await (const chunk of response) {
            groupSignal.throwIfAborted();
            await this.throttle(chunk.length, groupSignal);
            await partFile.writeFile(chunk);
            segment.downloaded += chunk.length;
            download.downloaded += chunk.length;
          }

          if (Number.isFinite(expected) && expected !== segment.downloaded) {
            throw new Error('Incomplete HLS segment.');
          }

          await partFile.sync();
          await partFile.close();
          await fs.rename(receivingPath, path.join(dir, `${segmentIndex}.part`));
          segment.done = true;
          await this.persist();
          return;
        } catch (error) {
          await partFile.close();

          if (groupSignal.aborted || attempt === 3) {
            throw error;
          }

          await delay(250 * 2 ** attempt, undefined, { signal: groupSignal });
        } finally {
          response?.destroy();
        }
      }
    };

    const worker = async () => {
      while (index < download.segments.length) {
        groupSignal.throwIfAborted();
        const segmentIndex = index;
        index += 1;
        const segment = download.segments[segmentIndex];

        if (!segment.done) {
          await fetchSegment(segment, segmentIndex);
        }
      }
    };

    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: download.connections }, () =>
          worker().catch((error) => {
            siblings.abort();
            throw error;
          }),
        ),
      );

      const error = firstFailure(outcomes);

      if (error) {
        throw error.reason;
      }
    } finally {
      clearInterval(progress);
    }

    download.total = download.downloaded;

    if (plan.audio) {
      download.status = 'assembling';
      download.speed = 0;
      this.changed();
      const { muxTracks } = await import('./mux.mjs');
      const combined = await muxTracks(dir, videoCount, plan.urls.length, signal);
      download.filename = safeFilename(`${download.filename.replace(/\.[^.]+$/, '')}.mp4`);
      await this.assemble(download, dir, signal, [combined]);
    } else {
      await this.assemble(download, dir, signal);
    }
  }

  async runPairedTracks(download: Download, headers: HeaderMap, signal: AbortSignal) {
    // Only called when d.audioUrl is set.
    const urls = [download.url, download.audioUrl!];
    const trackHeaders = urls.map((url) => scopedHeaders(headers, download.url, url));

    const trackInfos = await Promise.all(
      urls.map((url, trackIndex) => probe(url, trackHeaders[trackIndex], signal)),
    );

    const dir = path.join(this.partsDirectory, download.id);
    await fs.mkdir(dir, { recursive: true });
    // Direct adaptive tracks are separate files; concatenating them corrupts MP4.
    download.kind = 'paired';
    download.resumable = false;
    download.downloaded = 0;

    download.total = trackInfos.every((track) => track.total !== null)
      ? trackInfos.reduce((sum, track) => sum + track.total!, 0)
      : null;

    download.segments = trackInfos.map((track) => ({
      start: 0,
      end: track.total === null ? null : track.total - 1,
      downloaded: 0,
    }));

    download.status = 'downloading';
    download.connections = 2;
    this.changed();
    let last = 0;
    let at = Date.now();

    const timer = setInterval(() => {
      const now = Date.now();
      download.speed = ((download.downloaded - last) * 1000) / Math.max(1, now - at);
      last = download.downloaded;
      at = now;
      this.changed();
    }, this.tickMs);

    const siblings = new AbortController();
    const group = AbortSignal.any([signal, siblings.signal]);

    try {
      const outcomes = await Promise.allSettled(
        urls.map(async (url, trackIndex) => {
          try {
            const file = path.join(dir, `${trackIndex}.part`);
            await fs.writeFile(file, Buffer.alloc(0));

            await this.transfer(
              download,
              trackInfos[trackIndex],
              download.segments[trackIndex],
              file,
              trackHeaders[trackIndex],
              group,
              url,
            );
          } catch (error) {
            siblings.abort();
            throw error;
          }
        }),
      );

      const failed = firstFailure(outcomes);

      if (failed) {
        throw failed.reason;
      }
    } finally {
      clearInterval(timer);
    }

    signal.throwIfAborted();
    download.status = 'assembling';
    download.speed = 0;
    this.changed();
    const { muxTracks } = await import('./mux.mjs');
    const combined = await muxTracks(dir, 1, 2, signal);
    download.total = (await fs.stat(combined)).size;
    download.downloaded = download.total;
    await this.assemble(download, dir, signal, [combined], true);
  }

  async runSabr(download: Download, headers: HeaderMap, signal: AbortSignal) {
    const dir = path.join(this.partsDirectory, download.id);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    download.kind = 'sabr';
    download.resumable = false;
    download.downloaded = 0;
    const selected = normalizeSabrSession(download.sabr);
    const hasVideo = selected.videoItag !== undefined;

    const picked = selected.formats.filter(
      (format) => format.itag === selected.audioItag || format.itag === selected.videoItag,
    );

    download.total = picked.every((format) => Number(format.contentLength) > 0)
      ? picked.reduce((sum, format) => sum + Number(format.contentLength), 0)
      : null;

    download.segments = picked.map((format) => ({
      start: 0,
      end: Number(format.contentLength) > 0 ? Number(format.contentLength) - 1 : null,
      downloaded: 0,
    }));

    download.connections = picked.length;
    download.status = 'downloading';
    await this.persist();
    this.changed();
    let networkDownloaded = 0;
    let last = 0;
    let at = Date.now();

    const timer = setInterval(() => {
      const now = Date.now();
      download.speed = ((networkDownloaded - last) * 1000) / Math.max(1, now - at);
      last = networkDownloaded;
      at = now;
      this.changed();
    }, this.tickMs);

    let result: Awaited<ReturnType<typeof downloadSabr>>;

    try {
      result = await downloadSabr({
        session: selected,
        headers,
        videoPath: path.join(dir, '0.part'),
        audioPath: path.join(dir, hasVideo ? '1.part' : '0.part'),
        signal,
        onProgress: (progress) => {
          download.downloaded = progress.downloaded;

          if (progress.total !== null) {
            download.total = progress.total;
          }

          networkDownloaded = progress.networkDownloaded;

          for (let trackIndex = 0; trackIndex < download.segments.length; trackIndex += 1) {
            download.segments[trackIndex].downloaded =
              progress.tracks[picked[trackIndex].itag] || 0;
          }
        },
      });
    } finally {
      clearInterval(timer);
    }

    signal.throwIfAborted();
    download.status = 'assembling';
    download.speed = 0;
    download.duration = result.duration || undefined;
    this.changed();
    let output: string;

    if (hasVideo) {
      const { muxTracks, videoCodec, convertVideoToH264 } = await import('./mux.mjs');
      output = await muxTracks(dir, 1, 2, signal);

      // The SABR library writes whatever format YouTube's server sends, which can be
      // AV1 even when H.264 was chosen. Keep the H.264 choice, which every player plays.
      const requested = selected.formats.find((format) => format.itag === selected.videoItag);

      if (
        /avc1/i.test(requested?.mimeType ?? '') &&
        (await videoCodec(output, signal)) !== 'h264'
      ) {
        output = await convertVideoToH264(
          dir,
          output,
          signal,
          requested?.averageBitrate || requested?.bitrate,
        );
      }
    } else {
      const { convertMedia } = await import('./mux.mjs');
      output = await convertMedia(dir, [path.join(dir, '0.part')], 'mp3', signal);
    }

    download.total = (await fs.stat(output)).size;
    download.downloaded = download.total;

    download.segments = [
      { start: 0, end: download.total - 1, downloaded: download.total, done: true },
    ];

    await this.assemble(download, dir, signal, [output], true);
  }

  async transfer(
    download: Download,
    resourceInfo: ProbeInfo,
    segment: Segment,
    file: string,
    headers: HeaderMap,
    signal: AbortSignal,
    url = download.url,
  ) {
    const expected = segment.end === null ? null : segment.end - segment.start + 1;

    if (expected !== null && segment.downloaded === expected) {
      await fs.appendFile(file, Buffer.alloc(0));
      return;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal.throwIfAborted();

      try {
        const ranged = resourceInfo.ranges && resourceInfo.total !== null;

        if (!ranged && segment.downloaded) {
          download.downloaded -= segment.downloaded;
          segment.downloaded = 0;
          await fs.writeFile(file, Buffer.alloc(0));
        }

        const start = segment.start + segment.downloaded;
        const requestHeaders: HeaderMap = { ...headers };

        if (ranged) {
          requestHeaders.Range = `bytes=${start}-${segment.end}`;

          if (resourceInfo.validator) {
            requestHeaders['If-Range'] = resourceInfo.validator;
          }
        }

        const response = await request(url, { headers: requestHeaders, signal });

        if ((ranged && response.statusCode !== 206) || (!ranged && response.statusCode !== 200)) {
          response.destroy();
          throw new Error(
            `Server returned HTTP ${response.statusCode}${ranged ? ' instead of a byte range' : ''}.`,
          );
        }

        if (ranged) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');

          if (
            !match ||
            Number(match[1]) !== start ||
            Number(match[2]) !== segment.end ||
            Number(match[3]) !== resourceInfo.total
          ) {
            response.destroy();
            throw new Error('Server returned an inconsistent byte range.');
          }
        }

        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        ) {
          response.destroy();
          throw new Error('Server ignored identity encoding; refusing to save corrupt ranges.');
        }

        const partFile = await fs.open(file, 'a');

        try {
          for await (const chunk of response) {
            signal.throwIfAborted();

            if (expected !== null && segment.downloaded + chunk.length > expected) {
              throw new Error('Server sent more bytes than requested.');
            }

            await this.throttle(chunk.length, signal);
            await partFile.writeFile(chunk);
            segment.downloaded += chunk.length;
            download.downloaded += chunk.length;
          }

          await partFile.sync();
        } finally {
          await partFile.close();
          response.destroy();
        }

        if (expected !== null && segment.downloaded !== expected) {
          throw new Error('Connection ended before the segment finished.');
        }

        return;
      } catch (error) {
        if (signal.aborted || attempt === 3) {
          throw error;
        }

        await delay(250 * 2 ** attempt, undefined, { signal });
      }
    }
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closePromise = this.shutdown();
    return this.closePromise;
  }

  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);

    for (const job of this.jobs.values()) {
      job.controller.abort();
    }

    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    await this.persist();
  }
}
