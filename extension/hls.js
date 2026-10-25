(() => {
  function parseHlsMaster(text, baseUrl) {
    if (
      typeof text !== 'string' ||
      text.length > 1048576 ||
      !text.trimStart().startsWith('#EXTM3U')
    ) {
      throw new Error('Invalid or oversized HLS manifest.');
    }

    const lines = text.split(/\r?\n/).slice(0, 20000);
    const variants = [];

    const attributes = (line) => {
      const values = {};

      for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        values[match[1]] = match[2].replace(/^"|"$/g, '');
      }

      return values;
    };

    // Only plain HTTP(S) addresses without embedded credentials are followed.
    const safeUrl = (value) => {
      try {
        const url = new URL(value, baseUrl);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
      } catch {
        return null;
      }
    };

    const externalAudio = new Map();

    for (const media of lines.filter((line) => line.startsWith('#EXT-X-MEDIA:')).map(attributes)) {
      if (
        media.TYPE === 'AUDIO' &&
        media.URI &&
        media['GROUP-ID'] &&
        (!externalAudio.has(media['GROUP-ID']) || media.DEFAULT === 'YES')
      ) {
        const url = safeUrl(media.URI);

        if (url) {
          externalAudio.set(media['GROUP-ID'], url.href);
        }
      }
    }

    // A variant's address is the first non-blank line after its #EXT-X-STREAM-INF tag.
    const variantUrl = (index) => {
      let next = index + 1;

      while (next < lines.length && !lines[next].trim()) {
        next += 1;
      }

      const line = lines[next]?.trim();
      return line && !line.startsWith('#') ? safeUrl(line) : null;
    };

    for (let lineIndex = 0; lineIndex < lines.length && variants.length < 20; lineIndex += 1) {
      const url = lines[lineIndex].startsWith('#EXT-X-STREAM-INF:') ? variantUrl(lineIndex) : null;

      if (url) {
        const streamInfo = attributes(lines[lineIndex]);
        const resolution = /^(\d{1,5})x(\d{1,5})$/i.exec(streamInfo.RESOLUTION || '');
        const bitrate = Number(streamInfo['AVERAGE-BANDWIDTH'] || streamInfo.BANDWIDTH) || 0;
        const separateAudio = !!streamInfo.AUDIO && externalAudio.has(streamInfo.AUDIO);

        variants.push({
          url: url.href,
          audioUrl: externalAudio.get(streamInfo.AUDIO),
          quality: resolution ? `${resolution[2]}p` : '',
          bitrate: Number.isSafeInteger(bitrate) && bitrate > 0 ? bitrate : 0,
          codecs: (streamInfo.CODECS || '').slice(0, 200),
          mime: 'application/vnd.apple.mpegurl',
          format: 'HLS',
          separateAudio,
          unsupported: false,
          reason: '',
        });
      }
    }

    if (!variants.length) {
      variants.push({
        url: new URL(baseUrl).href,
        quality: '',
        bitrate: 0,
        mime: 'application/vnd.apple.mpegurl',
        format: 'HLS',
        unsupported: false,
      });
    }

    for (const item of variants) {
      if (item.codecs || item.quality || item.audioUrl) {
        item.masterUrl = baseUrl;
      }
    }

    return variants;
  }

  globalThis.parseHlsMaster = parseHlsMaster;

  if (typeof module !== 'undefined') {
    module.exports = { parseHlsMaster };
  }
})();
