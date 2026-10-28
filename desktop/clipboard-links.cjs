// Decides whether copied text is one or more download links worth offering to the user (IDM-style clipboard monitor).
// Strict on purpose: the whole clipboard must be URLs, so copied paragraphs never trigger a prompt.
const FILE = /\.(?:zip|7z|rar|tar|gz|tgz|bz2|xz|zst|cab|iso|img|dmg|exe|msi|msix|msixbundle|appx|apk|aab|ipa|deb|rpm|pkg|appimage|jar|bin|torrent|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub|mobi|csv|mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|3gp|mpe?g|m3u8|mpd|mp3|m4a|aac|ogg|opus|flac|wav|wma|jpe?g|png|gif|webp|bmp|svg|tiff?|heic|avif|psd|ttf|otf|woff2?)$/i;
const HINT = /(^|[/?&=._-])(download|dl|attachment|export|getfile|file|get)([/?&=._-]|$)/i;
// Page addresses of video sites: handled through yt-dlp extraction rather than as files.
const VIDEO_SITES = [
  [/(^|\.)youtube\.com$/, /^\/(watch|shorts\/|live\/|embed\/)/], [/^youtu\.be$/, /^\/[\w-]{6,}/], [/(^|\.)vimeo\.com$/, /^\/(\d+|[\w-]+\/[\w-]+)/],
  [/(^|\.)(twitter|x)\.com$/, /\/status\/\d+/], [/(^|\.)tiktok\.com$/, /\/(video|@[\w.]+\/video)\/|^\/t\//], [/(^|\.)instagram\.com$/, /^\/(p|reel|tv)\//],
  [/(^|\.)facebook\.com$|^fb\.watch$/, /\/(videos?|watch|reel)|^\/[\w-]{5,}/], [/(^|\.)dailymotion\.com$/, /^\/video\//], [/(^|\.)twitch\.tv$/, /\/(clip|videos)\//],
  [/(^|\.)reddit\.com$/, /\/comments\//], [/(^|\.)bilibili\.com$/, /^\/video\//], [/(^|\.)soundcloud\.com$/, /^\/[\w-]+\/[\w-]+/], [/(^|\.)streamable\.com$/, /^\/\w+/]
];

function classify(token) {
  if (token.length > 2048) return null;
  let url; try { url = new URL(token); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
  const host = url.hostname.toLowerCase();
  if (FILE.test(decodeURIComponent(url.pathname).replace(/\/+$/, ''))) return { url: url.href, kind: 'file' };
  if (VIDEO_SITES.some(([h, p]) => h.test(host) && p.test(url.pathname + url.search))) return { url: url.href, kind: 'video' };
  if (HINT.test(url.pathname + url.search)) return { url: url.href, kind: 'file' };
  return null;
}
function clipboardLinks(text, max = 25) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > max) return null;
  const found = tokens.map(classify);
  if (found.some(item => !item)) return null; // something that is not a downloadable link: do not interrupt
  return { links: found.map(item => item.url), extract: found.every(item => item.kind === 'video') };
}
module.exports = { clipboardLinks, classify };
