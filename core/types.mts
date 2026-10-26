import type { HeaderMap } from './http.mjs';
import type { SabrSession } from './sabr.mjs';

export type DownloadStatus =
  | 'scheduled'
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'assembling'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'error';
export type Category = 'Video' | 'Audio' | 'Archives' | 'Documents' | 'Programs' | 'Other';
export type OutputFormat = 'mp4' | 'mp3';

export interface Segment {
  start: number;
  end: number | null;
  downloaded: number;
  done?: boolean;
  url?: string;
}

export interface Settings {
  defaultDirectory: string;
  maxConcurrent: number;
  connections: number;
  speedLimitKbps: number;
  categoryDirectories: Partial<Record<Category, string>>;
  notifyOnComplete: boolean;
  revealOnComplete: boolean;
  confirmBrowserDownloads: boolean;
  hideCompletionDialog?: boolean;
}

export interface Download {
  id: string;
  url: string;
  audioUrl?: string;
  outputFormat?: OutputFormat;
  youtubeFormat?: string;
  sabr?: SabrSession;
  filename: string;
  explicitFilename: boolean;
  category: Category;
  explicitCategory: boolean;
  description: string;
  status: DownloadStatus;
  needsReview: boolean;
  scheduledAt: string | null;
  downloaded: number;
  total: number | null;
  speed: number;
  connections: number;
  error: string | null;
  path: string | null;
  directory: string;
  createdAt: string;
  segments: Segment[];
  validator: string | null;
  // Credentials stay in memory; persist() drops them from history.
  headers?: HeaderMap;
  kind?: 'youtube' | 'hls' | 'paired' | 'sabr';
  resumable?: boolean;
  duration?: number;
  estimated?: boolean;
  completedAt?: string;
  cleanupError?: string;
  playlistIdentity?: string;
  hlsFilenameResolved?: boolean;
}
