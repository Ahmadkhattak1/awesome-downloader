// Every file type is downloadable; these tables only decide the category folder and a missing extension.
export const CATEGORY = {
  Video: /\.(mp4|webm|mkv|mov|avi|m4v|flv|f4v|wmv|ts|m2ts|mts|3gp|3g2|ogv|mpg|mpeg|vob|asf|divx|rm|rmvb)$/i,
  Audio: /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|aiff?|amr|mid|midi|mka|ac3|dts|weba)$/i,
  Images: /\.(jpe?g|png|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif|psd|raw|cr2|nef|arw|dng)$/i,
  Archives: /\.(zip|7z|rar|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|lz|lzma|cab|iso|img|dmg|z|arj|ace|wim)$/i,
  Documents: /\.(pdf|docx?|dotx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|tsv|epub|mobi|azw3?|djvu|md|json|xml|html?|log|tex|pages|numbers|key)$/i,
  Programs: /\.(exe|msi|msix|msixbundle|appx|appxbundle|apk|aab|ipa|deb|rpm|pkg|appimage|jar|bat|cmd|ps1|sh|run|bin|com|vbs)$/i
};
const MIME_EXTENSION = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/x-flv': 'flv', 'video/mp2t': 'ts', 'video/3gpp': '3gp', 'video/ogg': 'ogv', 'video/mpeg': 'mpg', 'video/x-ms-wmv': 'wmv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/x-ms-wma': 'wma',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/x-icon': 'ico',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/gzip': 'gz', 'application/x-tar': 'tar', 'application/x-bzip2': 'bz2', 'application/x-xz': 'xz',
  'application/json': 'json', 'application/xml': 'xml', 'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html', 'application/epub+zip': 'epub', 'application/vnd.android.package-archive': 'apk', 'application/x-msdownload': 'exe', 'application/vnd.microsoft.portable-executable': 'exe',
  'application/x-msi': 'msi', 'application/x-iso9660-image': 'iso', 'application/x-apple-diskimage': 'dmg', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};
export const CATEGORY_NAMES = [...Object.keys(CATEGORY), 'Other'];
export const categoryFor = name => Object.entries(CATEGORY).find(([, re]) => re.test(name))?.[0] || 'Other';
export function extensionForMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION[type] || '';
}
// A server-supplied name without an extension gets one from Content-Type (never from text/html error pages).
export function withExtension(name, mime) {
  if (/\.[A-Za-z0-9]{1,6}$/.test(name)) return name;
  const extension = extensionForMime(mime);
  return extension ? `${name}.${extension}` : name;
}
export const looksLikeWebPage = mime => /^(text\/html|application\/xhtml\+xml)/i.test(String(mime || ''));
