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
      const u = new URL(value, globalThis.location.href);
      return u.origin === globalThis.location.origin && /^\/youtubei\/v1\/player$/.test(u.pathname);
    } catch {
      return false;
    }
  };
  // Chrome's webRequest does not expose the body of YouTube's streaming (SABR) requests, so
  // a copy is taken here, before the page sends it. Bodies are never altered or consumed.
  const MAX_SABR_BODY = 262144;
  function copyBody(body) {
    try {
      if (body instanceof ArrayBuffer) {
        return Promise.resolve(new Uint8Array(body.slice(0)));
      }
      if (ArrayBuffer.isView(body)) {
        return Promise.resolve(
          new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
        );
      }
      if (body instanceof Request) {
        return body
          .clone()
          .arrayBuffer()
          .then((b) => new Uint8Array(b));
      }
      if (body instanceof Blob) {
        return body.arrayBuffer().then((b) => new Uint8Array(b));
      }
    } catch {
      // An unreadable body is simply not copied; the page's request is unaffected.
    }
    return null;
  }
  function publishSabr(url, bytes) {
    if (!bytes?.length || bytes.length > MAX_SABR_BODY) {
      return;
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    window.postMessage(
      { type: 'awesome-sabr-request', data: { url, body: btoa(binary) } },
      globalThis.location.origin,
    );
  }
  const originalFetch = window.fetch;
  window.fetch = function observedFetch(...args) {
    const input = args[0];
    const sabrUrl = globalThis.youtubeMedia.sabrUrl(String(input?.url || input || ''));
    const sabrBody =
      sabrUrl && copyBody(args[1]?.body ?? (input instanceof Request ? input : null));
    const result = Reflect.apply(originalFetch, this, args);
    // Only a request the server accepted is worth keeping, as with the webRequest path.
    if (sabrBody) {
      Promise.all([result, sabrBody])
        .then(([response, bytes]) => response.ok && publishSabr(sabrUrl, bytes))
        .catch(() => {});
    }
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
            for (const c of chunks) {
              bytes.set(c, offset);
              offset += c.length;
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
  const { send } = XMLHttpRequest.prototype;
  const sabrRequests = new WeakMap();
  XMLHttpRequest.prototype.send = function observedSend(body) {
    const sabrUrl = sabrRequests.get(this);
    const sabrBody = sabrUrl && copyBody(body);
    if (sabrBody) {
      this.addEventListener(
        'load',
        () => {
          if (this.status >= 200 && this.status < 300) {
            sabrBody.then((bytes) => publishSabr(sabrUrl, bytes)).catch(() => {});
          }
        },
        { once: true },
      );
    }
    return Reflect.apply(send, this, [body]);
  };
  XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
    const sabrUrl = globalThis.youtubeMedia.sabrUrl(String(url || ''));
    if (sabrUrl) {
      sabrRequests.set(this, sabrUrl);
    } else {
      sabrRequests.delete(this);
    }
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
  // Requested when a download needs a fresh streaming request. Seeking to the current
  // position makes the player request its stream again; a paused video plays muted for a
  // moment so that happens, then is put back where it was.
  function primeStream() {
    const player = document.getElementById('movie_player');
    const video = player?.querySelector('video');
    if (typeof player?.seekTo !== 'function' || !video) {
      return;
    }
    const time = video.currentTime;
    const { paused } = video;
    const muted = player.isMuted?.();
    if (paused) {
      player.mute?.();
      player.playVideo?.();
    }
    player.seekTo(time, true);
    if (paused) {
      setTimeout(() => {
        player.pauseVideo?.();
        player.seekTo(time, true);
        if (!muted) {
          player.unMute?.();
        }
      }, 2000);
    }
  }
  globalThis.addEventListener('awesome-prime-stream', primeStream);
  globalThis.addEventListener('awesome-request-player', current);
  globalThis.addEventListener('yt-navigate-finish', current);
  globalThis.addEventListener('DOMContentLoaded', current, { once: true });
})();
