(() => {
  const MAX_URL = 16384;
  const MAX_FORMATS = 150;
  const text = (value, max = 200) => String(value || '').slice(0, max);

  const integer = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };

  const decimal = (value, max = 32) =>
    /^\d+$/.test(String(value || '')) ? String(value).slice(0, max) : '';

  function googleVideoUrl(value, requireSabr) {
    try {
      const videoUrl = new URL(value);

      if (
        videoUrl.protocol !== 'https:' ||
        !(
          videoUrl.hostname === 'googlevideo.com' || videoUrl.hostname.endsWith('.googlevideo.com')
        ) ||
        videoUrl.pathname !== '/videoplayback' ||
        videoUrl.username ||
        videoUrl.password ||
        videoUrl.href.length > MAX_URL
      ) {
        return null;
      }

      if (requireSabr) {
        return videoUrl.searchParams.get('sabr') === '1' ? videoUrl.href : null;
      }

      if (
        videoUrl.searchParams.has('sq') ||
        videoUrl.searchParams.get('source') === 'yt_live_broadcast' ||
        videoUrl.searchParams.get('sabr') === '1'
      ) {
        return null;
      }

      if (videoUrl.searchParams.has('range')) {
        if ((videoUrl.searchParams.get('sparams') || '').split(',').includes('range')) {
          return null;
        }

        videoUrl.searchParams.delete('range');
      }

      return videoUrl.href;
    } catch {
      return null;
    }
  }

  const mediaUrl = (value) => googleVideoUrl(value, false);
  const sabrUrl = (value) => googleVideoUrl(value, true);

  function cleanFormat(rawFormat) {
    if (
      !rawFormat ||
      typeof rawFormat !== 'object' ||
      Array.isArray(rawFormat) ||
      rawFormat.drmFamilies?.length ||
      rawFormat.drmTrackType
    ) {
      return null;
    }

    const cipher = new URLSearchParams(
      typeof rawFormat.signatureCipher === 'string' ? rawFormat.signatureCipher : '',
    );

    const mimeType = text(rawFormat.mimeType, 200);

    const audioTrack =
      rawFormat.audioTrack && typeof rawFormat.audioTrack === 'object'
        ? {
            id: text(rawFormat.audioTrack.id, 100),
            audioIsDefault: !!rawFormat.audioTrack.audioIsDefault,
          }
        : null;

    const colorInfo =
      rawFormat.colorInfo && typeof rawFormat.colorInfo === 'object'
        ? { transferCharacteristics: text(rawFormat.colorInfo.transferCharacteristics, 80) }
        : undefined;

    return {
      itag: integer(rawFormat.itag),
      url: mediaUrl(rawFormat.url),
      sourceUrl: mediaUrl(rawFormat.url || cipher.get('url')),
      mimeType,
      width: integer(rawFormat.width),
      height: integer(rawFormat.height),
      fps: integer(rawFormat.fps),
      bitrate: integer(rawFormat.bitrate),
      averageBitrate: integer(rawFormat.averageBitrate),
      audioQuality: text(rawFormat.audioQuality, 80),
      audioTrack,
      lastModified: decimal(rawFormat.lastModified),
      xtags: text(rawFormat.xtags, 2048),
      contentLength: decimal(rawFormat.contentLength),
      approxDurationMs: decimal(rawFormat.approxDurationMs),
      quality: text(rawFormat.quality, 80),
      qualityLabel: text(rawFormat.qualityLabel, 80),
      audioChannels: integer(rawFormat.audioChannels),
      targetDurationSec: Number.isFinite(Number(rawFormat.targetDurationSec))
        ? Number(rawFormat.targetDurationSec)
        : undefined,
      isDrc: !!rawFormat.isDrc,
      isVb: !!rawFormat.isVb,
      colorInfo,
    };
  }

  function sanitizePlayer(value) {
    if (
      !value ||
      !/^[\w-]{11}$/.test(value.videoId || '') ||
      !Array.isArray(value.formats) ||
      value.formats.length > MAX_FORMATS
    ) {
      return null;
    }

    const formats = value.formats
      .map(cleanFormat)
      .filter((format) => format && format.itag && format.mimeType);

    const url = sabrUrl(value.sabrUrl);

    const config = /^[A-Za-z0-9_+/=.-]{1,131072}$/.test(String(value.ustreamerConfig || ''))
      ? String(value.ustreamerConfig)
      : '';

    const clientName = integer(value.clientName) || 1;

    const clientVersion = /^[\w.-]{1,80}$/.test(String(value.clientVersion || ''))
      ? String(value.clientVersion)
      : '';

    return {
      videoId: value.videoId,
      title: text(value.title || 'Video', 180),
      sabr: !!value.sabr || !!url,
      sabrUrl: url,
      ustreamerConfig: config,
      clientName,
      clientVersion,
      formats,
    };
  }

  function playerData(value) {
    if (value?.videoId && Array.isArray(value.formats)) {
      return sanitizePlayer(value);
    }

    if (
      !value ||
      !/^[\w-]{11}$/.test(value.videoDetails?.videoId || '') ||
      value.videoDetails?.isLiveContent
    ) {
      return null;
    }

    const formats = [
      ...(Array.isArray(value.streamingData?.formats) ? value.streamingData.formats : []),
      ...(Array.isArray(value.streamingData?.adaptiveFormats)
        ? value.streamingData.adaptiveFormats
        : []),
    ];

    const { ytcfg } = globalThis;
    return sanitizePlayer({
      videoId: value.videoDetails.videoId,
      title: value.videoDetails.title,
      sabr: !!value.streamingData?.serverAbrStreamingUrl,
      sabrUrl: value.streamingData?.serverAbrStreamingUrl,
      ustreamerConfig:
        value.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
          ?.videoPlaybackUstreamerConfig,
      clientName:
        ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME') ||
        // eslint-disable-next-line no-underscore-dangle -- YouTube's own ytcfg property
        ytcfg?.data_?.INNERTUBE_CONTEXT_CLIENT_NAME ||
        1,
      clientVersion:
        ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_VERSION') ||
        // eslint-disable-next-line no-underscore-dangle -- YouTube's own ytcfg property
        ytcfg?.data_?.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        '',
      formats,
    });
  }

  // H.264 plays in QuickTime, Windows players and every browser. AV1 and VP9 need newer
  // hardware or players (QuickTime plays AV1 only on M3 Macs or newer), so they are
  // chosen only when a quality has no H.264 version, and are labelled when they are.
  const isH264 = (format) => /avc1/i.test(format.mimeType);

  function codecName(format) {
    if (/av01/i.test(format.mimeType)) {
      return 'AV1';
    }

    if (/vp0?9/i.test(format.mimeType)) {
      return 'VP9';
    }

    return '';
  }

  function qualityLabel(format) {
    const fps = format.fps > 30 ? ` ${format.fps}fps` : '';
    const codec = isH264(format) ? '' : codecName(format);

    return `${format.height}p${fps}${codec ? ` · ${codec}` : ''}`;
  }

  // Best resolution and frame rate first; within the same one, H.264 before other codecs.
  const byQuality = (first, second) =>
    second.height - first.height ||
    second.fps - first.fps ||
    Number(isH264(second)) - Number(isH264(first)) ||
    second.bitrate - first.bitrate;

  function choices(data, observed = []) {
    if (!data) {
      return [];
    }

    const formats = data.formats
      .map((format) => {
        const source = format.sourceUrl && new URL(format.sourceUrl);

        const match =
          source &&
          observed.find((raw) => {
            try {
              const observedUrl = new URL(raw);
              return (
                observedUrl.searchParams.get('itag') === String(format.itag) &&
                !!source.searchParams.get('id') &&
                observedUrl.searchParams.get('id') === source.searchParams.get('id')
              );
            } catch {
              return false;
            }
          });

        // With SABR available, metadata-only direct URLs can be unusable (403).
        // Prefer SABR unless this exact asset/itag was observed succeeding.
        return {
          ...format,
          url: match || (data.sabrUrl && data.ustreamerConfig ? null : format.url),
        };
      })
      .filter(
        (format) =>
          format.url &&
          (!new URL(format.url).searchParams.has('expire') ||
            Number(new URL(format.url).searchParams.get('expire')) * 1000 > Date.now() + 30000),
      );

    const result = [];
    const seen = new Set();
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
    const title = data.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 170);

    const audio = formats
      .filter(
        (format) =>
          /^audio\/mp4/i.test(format.mimeType) &&
          (!format.audioTrack || format.audioTrack.audioIsDefault),
      )
      .sort((first, second) => second.bitrate - first.bitrate)[0];

    const isMuxed = (format) => format.audioQuality || /mp4a/i.test(format.mimeType);

    // Video-only formats are offered only when there is an audio track to pair them with.
    const videos = formats
      .filter(
        (format) =>
          /^video\/mp4/i.test(format.mimeType) && format.height && (audio || isMuxed(format)),
      )
      .sort(byQuality);

    for (const video of videos) {
      const key = `${video.height}:${video.fps}`;

      if (!seen.has(key)) {
        seen.add(key);

        result.push({
          url: video.url,
          audioUrl: isMuxed(video) ? undefined : audio.url,
          provider: 'youtube',
          format: 'MP4',
          outputFormat: 'mp4',
          quality: qualityLabel(video),
          audioState: 'Video + audio',
          title: data.title,
          filename: `${title}.mp4`,
          bitrate: video.bitrate,
        });
      }
    }

    if (audio) {
      result.push({
        url: audio.url,
        provider: 'youtube',
        format: 'MP3',
        outputFormat: 'mp3',
        quality: 'Audio',
        audioState: 'Audio only',
        title: data.title,
        filename: `${title}.mp3`,
      });
    }

    if (!data.sabrUrl || !data.ustreamerConfig) {
      return result;
    }

    const sabrAudio = data.formats
      .filter(
        (format) =>
          /^audio\/mp4/i.test(format.mimeType) &&
          (!format.audioTrack || format.audioTrack.audioIsDefault) &&
          !format.isDrc &&
          !format.isVb,
      )
      .sort((first, second) => second.bitrate - first.bitrate)[0];

    if (!sabrAudio) {
      return result;
    }

    const sabrVideos = data.formats
      .filter((format) => /^video\/mp4/i.test(format.mimeType) && format.height && !isMuxed(format))
      .sort(byQuality);

    for (const video of sabrVideos) {
      const key = `${video.height}:${video.fps}`;

      if (!seen.has(key)) {
        seen.add(key);

        result.push({
          url: data.sabrUrl,
          provider: 'youtube',
          format: 'MP4',
          outputFormat: 'mp4',
          quality: qualityLabel(video),
          audioState: 'Video + audio',
          title: data.title,
          filename: `${title}.mp4`,
          bitrate: video.bitrate,
          sabrSelection: { videoItag: video.itag, audioItag: sabrAudio.itag },
        });
      }
    }

    if (!result.some((item) => item.format === 'MP3')) {
      result.push({
        url: data.sabrUrl,
        provider: 'youtube',
        format: 'MP3',
        outputFormat: 'mp3',
        quality: 'Audio',
        audioState: 'Audio only',
        title: data.title,
        filename: `${title}.mp3`,
        bitrate: sabrAudio.bitrate,
        sabrSelection: { audioItag: sabrAudio.itag },
      });
    }

    return result;
  }

  globalThis.youtubeMedia = { mediaUrl, sabrUrl, playerData, sanitizePlayer, choices };

  if (typeof module !== 'undefined') {
    module.exports = globalThis.youtubeMedia;
  }
})();
