import { validUrl, request, type HeaderMap } from './http.mjs';
import { createHash } from 'node:crypto';

interface Variant {
  url: string;
  bandwidth: number;
  resolution: string | null;
  audioGroup: string | undefined;
  audioUrl?: string;
}
interface MediaPlaylist {
  urls: string[];
  duration: number;
  extension: '.mp4' | '.ts';
}
export interface HlsPlan extends MediaPlaylist {
  source: string;
  identity: string;
  audio?: HlsPlan;
}

export function scopedHeaders(headers: HeaderMap, source: string, target: string): HeaderMap {
  const next = { ...headers };
  if (new URL(source).origin !== new URL(target).origin) {
    delete next.cookie;
    delete next.authorization;
    delete next.origin;
  }
  return next;
}
function attrs(line: string) {
  const fields: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    fields[match[1]] = match[2].replace(/^"|"$/g, '');
  return fields;
}
export function parseHls(text: string, base: string): { variants: Variant[] } | MediaPlaylist {
  if (!text.trimStart().startsWith('#EXTM3U'))
    throw new Error('The server did not return an HLS playlist.');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const variants: Variant[] = [],
    segments: string[] = [];
  let variant: Record<string, string> | null = null,
    duration = 0,
    map: string | null = null,
    encrypted = false;
  const audio = new Map<string | undefined, string>();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line);
      if (
        a.TYPE === 'AUDIO' &&
        a.URI &&
        a['GROUP-ID'] &&
        (!audio.has(a['GROUP-ID']) || a.DEFAULT === 'YES')
      )
        audio.set(a['GROUP-ID'], validUrl(new URL(a.URI, base).href));
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attrs(line);
    else if (line.startsWith('#EXT-X-KEY:')) {
      if (attrs(line).METHOD !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:'))
      throw new Error('HLS byte-range playlists are not supported yet.');
    else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line);
      if (a.BYTERANGE) throw new Error('HLS byte-range initialization is not supported yet.');
      const next = validUrl(new URL(a.URI, base).href);
      if (map && map !== next)
        throw new Error('HLS streams with changing initialization maps are not supported yet.');
      map = next;
    } else if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
    else if (!line.startsWith('#')) {
      const url = validUrl(new URL(line, base).href);
      if (variant) {
        variants.push({
          url,
          bandwidth: Number(variant.BANDWIDTH) || 0,
          resolution: variant.RESOLUTION || null,
          audioGroup: variant.AUDIO,
        });
        variant = null;
      } else segments.push(url);
    }
  }
  if (encrypted) throw new Error('Encrypted HLS is not supported by this build.');
  if (variants.length)
    return {
      variants: variants
        .map((v) => ({ ...v, audioUrl: audio.get(v.audioGroup) }))
        .sort((a, b) => b.bandwidth - a.bandwidth),
    };
  if (!lines.includes('#EXT-X-ENDLIST'))
    throw new Error('Live HLS streams are not supported yet. Choose an on-demand video.');
  if (!segments.length || segments.length > 20000)
    throw new Error('HLS playlist has no segments or exceeds the 20,000 segment limit.');
  return { urls: map ? [map, ...segments] : segments, duration, extension: map ? '.mp4' : '.ts' };
}
export async function fetchPlaylist(url: string, headers: HeaderMap, signal: AbortSignal) {
  const response = await request(url, { headers, signal });
  try {
    if (response.statusCode !== 200)
      throw new Error(`Playlist returned HTTP ${response.statusCode}.`);
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw new Error('HLS playlist exceeds 2 MiB.');
      buffers.push(chunk);
    }
    return { text: Buffer.concat(buffers).toString('utf8'), url: response.finalUrl };
  } finally {
    response.destroy();
  }
}
export async function resolveHls(
  url: string,
  headers: HeaderMap,
  signal: AbortSignal,
  depth = 0,
  source = url,
): Promise<HlsPlan> {
  if (depth > 3) throw new Error('Too many nested HLS playlists.');
  const playlist = await fetchPlaylist(url, scopedHeaders(headers, source, url), signal);
  const plan = parseHls(playlist.text, playlist.url);
  if ('variants' in plan) {
    const chosen = plan.variants[0];
    const video = await resolveHls(chosen.url, headers, signal, depth + 1, source);
    if (chosen.audioUrl)
      video.audio = await resolveHls(chosen.audioUrl, headers, signal, depth + 1, source);
    return video;
  }
  return {
    ...plan,
    source,
    identity: createHash('sha256').update(JSON.stringify(plan.urls)).digest('hex'),
  };
}
