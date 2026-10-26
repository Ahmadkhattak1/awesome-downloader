(() => {
  function assetKey(value) {
    try {
      const assetUrl = new URL(value);

      if (!/(^|\.)twimg\.com$/.test(assetUrl.hostname)) {
        return '';
      }

      return (
        /\/(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)/.exec(
          assetUrl.pathname,
        )?.[1] || ''
      );
    } catch {
      return '';
    }
  }

  // Whether a choice is known to carry sound, from its paired track or its codecs.
  function audioStateOf(item) {
    if (item.audioUrl || /mp4a|ac-3|ec-3|opus/i.test(item.codecs || '')) {
      return 'Video + audio';
    }

    return item.codecs ? 'Video only (silent)' : 'Audio not verified';
  }

  function mediaChoices(items, context = {}) {
    const wanted = assetKey(context.url) || assetKey(context.poster);

    if (items.some((media) => media.provider === 'youtube')) {
      return items.filter((media) => media.provider === 'youtube');
    }

    let list = items.filter(
      (media) =>
        !media.unsupported &&
        !/\.(m4s|ts|aac)(?:[?#]|$)/i.test(media.url) &&
        !/^https:\/\/(?:www\.)?youtube\.com\/s\//.test(media.url),
    );

    if (wanted) {
      list = list.filter((media) => assetKey(media.url) === wanted);
    }

    const richAssets = new Set(
      list
        .filter((media) => media.masterUrl)
        .map((media) => assetKey(media.url))
        .filter(Boolean),
    );

    const audioUrls = new Set(list.map((media) => media.audioUrl).filter(Boolean));

    list = list.filter(
      (media) =>
        !audioUrls.has(media.url) && (!richAssets.has(assetKey(media.url)) || media.masterUrl),
    );

    const seen = new Set();
    const choices = [];

    for (const item of list.sort((first, second) => (second.bitrate || 0) - (first.bitrate || 0))) {
      const hls = item.format === 'HLS';
      const audioState = audioStateOf(item);

      const video = {
        ...item,
        format: hls ? 'MP4' : item.format,
        outputFormat: hls ? 'mp4' : item.outputFormat,
        audioState,
        asset: assetKey(item.url),
      };

      const variants = [video];

      if (item.audioUrl) {
        variants.push({
          ...item,
          url: item.audioUrl,
          audioUrl: undefined,
          format: 'MP3',
          outputFormat: 'mp3',
          quality: '',
          bitrate: 0,
          audioState: 'Audio only',
          asset: assetKey(item.url),
        });
      }

      for (const choice of variants) {
        const key = `${choice.url}|${choice.outputFormat || ''}`;

        if (!seen.has(key)) {
          seen.add(key);
          choices.push(choice);
        }
      }
    }

    return choices;
  }

  globalThis.mediaChoices = mediaChoices;

  if (typeof module !== 'undefined') {
    module.exports = { mediaChoices, assetKey };
  }
})();
