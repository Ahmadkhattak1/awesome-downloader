(() => {
  const api = globalThis.browser || chrome;
  const pending = new Set();
  let stopped = false;

  function shutdown() {
    if (stopped) {
      return;
    }

    stopped = true;
    globalThis.removeEventListener('message', onPlayer);

    try {
      api.runtime.onMessage.removeListener(onMessage);
    } catch {
      // The extension context is already gone; nothing is listening anymore.
    }

    for (const done of pending) {
      done(false);
    }

    pending.clear();
  }

  function connected() {
    if (stopped) {
      return false;
    }

    try {
      if (api.runtime.id) {
        return true;
      }
    } catch {
      // Reading runtime.id throws once the extension has been reloaded.
    }

    shutdown();
    return false;
  }

  async function onPlayer(event) {
    if (!connected()) {
      return;
    }

    if (
      event.source !== window ||
      event.origin !== globalThis.location.origin ||
      event.data?.type !== 'awesome-player-response'
    ) {
      return;
    }

    const { data } = event.data;

    if (
      !data ||
      !/^[\w-]{11}$/.test(data.videoId || '') ||
      !Array.isArray(data.formats) ||
      data.formats.length > 150
    ) {
      return;
    }

    try {
      await api.runtime.sendMessage({ action: 'playerResponse', data });

      for (const done of pending) {
        done();
      }

      pending.clear();
    } catch (error) {
      if (/extension context invalidated/i.test(error?.message || '')) {
        shutdown();
      }
    }
  }

  globalThis.addEventListener('message', onPlayer);

  function onMessage(message, sender, respond) {
    if (!connected() || sender.id !== api.runtime.id || message.action !== 'refreshPlayer') {
      return false;
    }

    let timer;

    const done = (ok = true) => {
      clearTimeout(timer);
      pending.delete(done);

      try {
        respond({ ok });
      } catch {
        // The caller stopped waiting for this answer.
      }
    };

    pending.add(done);
    timer = setTimeout(done, 1500);
    dispatchEvent(new Event('awesome-request-player'));
    return true;
  }

  api.runtime.onMessage.addListener(onMessage);
  dispatchEvent(new Event('awesome-request-player'));
})();
