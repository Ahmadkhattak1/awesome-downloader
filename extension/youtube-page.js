// Observes only player responses consumed by this YouTube page. Never initiates downloads.
(() => {
  const publish = (value) => {
    const data = globalThis.youtubeMedia.playerData(value);

    if (data) {
      window.postMessage({ type: 'awesome-player-response', data }, globalThis.location.origin);
    }
  };

  const playerEndpoint = (value) => {
    try {
      const endpoint = new URL(value, globalThis.location.href);
      return (
        endpoint.origin === globalThis.location.origin &&
        /^\/youtubei\/v1\/player$/.test(endpoint.pathname)
      );
    } catch {
      return false;
    }
  };

  const originalFetch = window.fetch;

  window.fetch = function observedFetch(...args) {
    const result = Reflect.apply(originalFetch, this, args);

    if (playerEndpoint(args[0]?.url || args[0])) {
      result
        .then(async (response) => {
          if (!response.ok || Number(response.headers.get('content-length')) > 2097152) {
            return;
          }

          const reader = response.clone().body?.getReader();

          if (!reader) {
            return;
          }

          const chunks = [];
          let size = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                break;
              }

              size += value.length;

              if (size > 2097152) {
                reader.cancel().catch(() => {});
                return;
              }

              chunks.push(value);
            }

            const bytes = new Uint8Array(size);
            let offset = 0;

            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }

            publish(JSON.parse(new TextDecoder().decode(bytes)));
          } catch {
            // Not a player response this script understands; leave it to the page.
          }
        })
        .catch(() => {});
    }

    return result;
  };

  const { open } = XMLHttpRequest.prototype;

  XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
    if (playerEndpoint(url)) {
      this.addEventListener(
        'load',
        () => {
          try {
            if (this.responseType === 'json') {
              publish(this.response);
            } else if (
              (this.responseType === '' || this.responseType === 'text') &&
              this.responseText.length <= 2097152
            ) {
              publish(JSON.parse(this.responseText));
            }
          } catch {
            // Not a player response this script understands; leave it to the page.
          }
        },
        { once: true },
      );
    }

    return Reflect.apply(open, this, [method, url, ...rest]);
  };

  function current() {
    try {
      publish(window.ytInitialPlayerResponse);
      const player = document.getElementById('movie_player');

      if (player?.getPlayerResponse) {
        publish(player.getPlayerResponse());
      }
    } catch {
      // The page has not finished setting up its player yet.
    }
  }

  globalThis.addEventListener('awesome-request-player', current);
  globalThis.addEventListener('yt-navigate-finish', current);
  globalThis.addEventListener('DOMContentLoaded', current, { once: true });
})();
