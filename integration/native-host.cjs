const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');

const MAX_MESSAGE = 1024 * 1024;

class MessageDecoder extends Transform {
  constructor() {
    super({ readableObjectMode: true });
    this.pending = Buffer.alloc(0);
  }

  // eslint-disable-next-line no-underscore-dangle -- Node's Transform stream API method name.
  _transform(chunk, encoding, done) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);

      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE(0);

        if (!length || length > MAX_MESSAGE) {
          throw new Error('Native message size is invalid.');
        }

        if (this.pending.length < length + 4) {
          break;
        }

        const message = JSON.parse(this.pending.subarray(4, length + 4).toString('utf8'));

        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('Native message must be an object.');
        }

        this.pending = this.pending.subarray(length + 4);
        this.push(message);
      }

      done();
    } catch (error) {
      done(error);
    }
  }

  // eslint-disable-next-line no-underscore-dangle -- Node's Transform stream API method name.
  _flush(done) {
    done(this.pending.length ? new Error('Truncated native message.') : undefined);
  }
}

function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value));

  if (body.length > MAX_MESSAGE) {
    throw new Error('Response is too large.');
  }

  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) {
    throw new Error('Invalid download URL.');
  }

  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  }

  return url.href;
}

function boundedInteger(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error('Invalid SABR number.');
  }

  return number;
}

function boundedText(value, max, pattern) {
  if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) {
    throw new Error('Invalid SABR text.');
  }

  return value;
}

function sanitizeSabr(value, downloadUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SABR session.');
  }

  const serverAbrStreamingUrl = validateUrl(value.serverAbrStreamingUrl);
  const stream = new URL(serverAbrStreamingUrl);

  if (
    stream.href !== downloadUrl ||
    !(stream.hostname === 'googlevideo.com' || stream.hostname.endsWith('.googlevideo.com')) ||
    stream.pathname !== '/videoplayback' ||
    stream.searchParams.get('sabr') !== '1'
  ) {
    throw new Error('Invalid SABR stream URL.');
  }

  const videoId = boundedText(value.videoId, 11, /^[\w-]{11}$/);

  const videoPlaybackUstreamerConfig = boundedText(
    value.videoPlaybackUstreamerConfig,
    131072,
    /^[A-Za-z0-9_+/=.-]+$/,
  );

  const rawFormats = value.formats;

  if (!Array.isArray(rawFormats) || !rawFormats.length || rawFormats.length > 150) {
    throw new Error('Invalid SABR formats.');
  }

  const formats = rawFormats.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid SABR format.');
    }

    const format = {
      itag: boundedInteger(raw.itag, 99999),
      mimeType: boundedText(raw.mimeType, 200, /^(?:audio|video)\/(?:mp4|webm)(?:;[^\r\n\0]*)?$/i),
      bitrate: boundedInteger(raw.bitrate || 0),
    };

    for (const key of ['width', 'height', 'fps', 'averageBitrate', 'audioChannels']) {
      if (raw[key] !== undefined) {
        format[key] = boundedInteger(raw[key], 1000000000);
      }
    }

    for (const [key, max, pattern] of [
      ['lastModified', 32, /^\d*$/],
      ['contentLength', 32, /^\d*$/],
      ['approxDurationMs', 32, /^\d*$/],
      ['xtags', 2048, /^[^\r\n\0]*$/],
      ['audioQuality', 80, /^[\w.-]*$/],
      ['quality', 80, /^[\w .-]*$/],
      ['qualityLabel', 80, /^[\w .-]*$/],
    ]) {
      if (raw[key] !== undefined) {
        format[key] = boundedText(String(raw[key]), max, pattern);
      }
    }

    if (raw.targetDurationSec !== undefined) {
      const duration = Number(raw.targetDurationSec);

      if (!Number.isFinite(duration) || duration < 0 || duration > 86400) {
        throw new Error('Invalid SABR duration.');
      }

      format.targetDurationSec = duration;
    }

    if (raw.audioTrack) {
      format.audioTrack = {
        id: boundedText(String(raw.audioTrack.id || ''), 100, /^[^\r\n\0]*$/),
        audioIsDefault: raw.audioTrack.audioIsDefault === true,
      };
    }

    if (raw.colorInfo?.transferCharacteristics) {
      format.colorInfo = {
        transferCharacteristics: boundedText(
          String(raw.colorInfo.transferCharacteristics),
          80,
          /^[\w .-]+$/,
        ),
      };
    }

    format.isDrc = raw.isDrc === true;
    format.isVb = raw.isVb === true;
    return format;
  });

  const audioItag = boundedInteger(value.audioItag, 99999);

  const videoItag =
    value.videoItag === undefined ? undefined : boundedInteger(value.videoItag, 99999);

  if (
    !formats.some((format) => format.itag === audioItag && /^audio\/mp4/i.test(format.mimeType)) ||
    (videoItag !== undefined &&
      !formats.some((format) => format.itag === videoItag && /^video\/mp4/i.test(format.mimeType)))
  ) {
    throw new Error('Selected SABR format is unavailable.');
  }

  const client = value.clientInfo || {};

  const clientInfo = {
    clientName: boundedInteger(client.clientName || 1, 10000),
    clientVersion: boundedText(String(client.clientVersion || ''), 80, /^[\w.-]*$/),
  };

  let requestBody;

  if (value.requestBody !== undefined) {
    requestBody = boundedText(value.requestBody, 350000, /^[A-Za-z0-9+/]*={0,2}$/);
    const decoded = Buffer.from(requestBody, 'base64');

    if (
      !decoded.length ||
      decoded.length > 262144 ||
      decoded.toString('base64').replace(/=+$/, '') !== requestBody.replace(/=+$/, '')
    ) {
      throw new Error('Invalid SABR request body.');
    }
  }

  return {
    videoId,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    clientInfo,
    formats,
    videoItag,
    audioItag,
    requestBody,
  };
}

function sanitizeRequest(message) {
  if (!message || !['download', 'formats'].includes(message.action)) {
    throw new Error('Unsupported native action.');
  }

  const sanitized = { url: validateUrl(message.url) };

  if (message.action === 'formats') {
    const watchUrl = new URL(sanitized.url);

    if (
      watchUrl.protocol !== 'https:' ||
      !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(watchUrl.hostname) ||
      watchUrl.pathname !== '/watch' ||
      !/^[\w-]{11}$/.test(watchUrl.searchParams.get('v') || '')
    ) {
      throw new Error('A YouTube watch URL is required.');
    }

    return {
      action: 'formats',
      url: `https://www.youtube.com/watch?v=${watchUrl.searchParams.get('v')}`,
    };
  }

  if (message.youtubeFormat !== undefined) {
    if (
      typeof message.youtubeFormat !== 'string' ||
      message.youtubeFormat.length > 80 ||
      !/^(?:audio:)?[\w-]+(?:\+[\w-]+)?$/.test(message.youtubeFormat)
    ) {
      throw new Error('Invalid YouTube format.');
    }

    sanitized.youtubeFormat = message.youtubeFormat;
  }

  if (message.sabr !== undefined) {
    sanitized.sabr = sanitizeSabr(message.sabr, sanitized.url);
  }

  if (message.startNow === true) {
    sanitized.startNow = true;
  }

  if (message.audioUrl) {
    sanitized.audioUrl = validateUrl(message.audioUrl);
  }

  if (message.outputFormat !== undefined) {
    if (!['mp4', 'mp3'].includes(message.outputFormat)) {
      throw new Error('Invalid output format.');
    }

    sanitized.outputFormat = message.outputFormat;
  }

  if (/\.mpd(?:[?#]|$)/i.test(sanitized.url)) {
    throw new Error('DASH manifests are not supported.');
  }

  if (message.filename) {
    if (
      typeof message.filename !== 'string' ||
      message.filename.length > 255 ||
      // eslint-disable-next-line no-control-regex -- rejects control characters in filenames.
      /[\x00-\x1f<>:"/\\|?*]/.test(message.filename) ||
      ['.', '..'].includes(message.filename)
    ) {
      throw new Error('Invalid filename.');
    }

    sanitized.filename = message.filename;
  }

  if (message.referer) {
    sanitized.referer = validateUrl(message.referer);
  }

  if (
    message.requestHeaders &&
    typeof message.requestHeaders === 'object' &&
    !Array.isArray(message.requestHeaders)
  ) {
    sanitized.headers = {};

    for (const name of ['cookie', 'authorization', 'user-agent', 'origin', 'referer']) {
      const value = message.requestHeaders[name];

      if (typeof value === 'string' && value.length <= 16384 && !/[\r\n\0]/.test(value)) {
        sanitized.headers[name] = value;
      }
    }
  }

  // Unknown headers and filesystem paths are never forwarded.
  return sanitized;
}

function readBridge(configPath) {
  const file = configPath || path.join(os.homedir(), '.awesome-downloader', 'bridge.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(config.token)
  ) {
    throw new Error('Desktop bridge configuration is invalid.');
  }

  return config;
}

function submitDownload(payload, config) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const request = http.request(
      {
        host: '127.0.0.1',
        port: config.port,
        path: payload.action === 'formats' ? '/formats' : '/downloads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${config.token}`,
        },
        // Longer than the desktop's 120 s yt-dlp format lookup, so the desktop answers first.
        timeout: payload.action === 'formats' ? 130000 : 15000,
      },
      (response) => {
        let result = '';

        response.on('data', (chunk) => {
          result += chunk;

          if (result.length > MAX_MESSAGE) {
            response.destroy(new Error('Desktop response too large.'));
          }
        });

        response.on('error', reject);

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            let reason = '';

            try {
              const data = JSON.parse(result);

              if (typeof data.error === 'string') {
                reason = data.error
                  .replace(/https?:\/\/\S+/g, '[URL]')
                  // eslint-disable-next-line no-control-regex -- strips control characters from the shown error.
                  .replace(/[\x00-\x1f\x7f]/g, ' ')
                  .slice(0, 700);
              }
            } catch {
              // A body that is not JSON falls back to the generic message below.
            }

            reject(
              new Error(
                reason
                  ? `${reason} (${response.statusCode})`
                  : `Desktop request failed (${response.statusCode}).`,
              ),
            );

            return;
          }

          try {
            const data = JSON.parse(result);

            if (!data || typeof data !== 'object' || data.ok === false) {
              throw new Error(data?.error || 'Desktop rejected download.');
            }

            resolve(
              payload.action === 'formats'
                ? { ok: true, items: data.items }
                : { ok: true, id: data.id || data.download?.id || data.ids?.[0] },
            );
          } catch (error) {
            reject(new Error(`Invalid desktop response: ${error.message}`));
          }
        });
      },
    );

    request.on('timeout', () => request.destroy(new Error('Desktop connection timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}

function runNativeHost({ input = process.stdin, output = process.stdout, configPath } = {}) {
  const decoder = new MessageDecoder();
  let chain = Promise.resolve();
  let pendingCount = 0;

  decoder.on('data', (message) => {
    if (pendingCount >= 32) {
      output.write(encodeMessage({ ok: false, error: 'Native bridge queue is full. Try again.' }));
      return;
    }

    pendingCount += 1;

    chain = chain.then(async () => {
      try {
        const payload = sanitizeRequest(message);
        let result;

        try {
          result = await submitDownload(payload, readBridge(configPath));
        } catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
            throw error;
          }

          const launch = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'desktop-launch.json'), 'utf8'),
          );

          if (!path.isAbsolute(launch.executable) || !Array.isArray(launch.args)) {
            throw new Error('Desktop launch configuration is invalid.');
          }

          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;

          const child = spawn(launch.executable, launch.args, {
            env,
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
          });

          child.on('error', () => {});
          child.unref();

          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => {
              setTimeout(resolve, 250);
            });

            try {
              result = await submitDownload(payload, readBridge(configPath));
              break;
            } catch (retry) {
              if (!['ENOENT', 'ECONNREFUSED'].includes(retry.code)) {
                throw retry;
              }
            }
          }

          if (!result) {
            throw new Error('The download manager could not start. Open it once and try again.');
          }
        }

        output.write(encodeMessage(result));
      } catch (error) {
        output.write(
          encodeMessage({
            ok: false,
            error:
              error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
                ? 'Start Awesome Downloader before sending downloads.'
                : error.message,
          }),
        );
      } finally {
        pendingCount -= 1;
      }
    });
  });

  decoder.on('error', (error) => {
    output.write(encodeMessage({ ok: false, error: error.message }));
    input.unpipe(decoder);
    input.pause();
  });

  input.pipe(decoder);
  return decoder;
}

if (require.main === module) {
  runNativeHost();
}

module.exports = {
  MessageDecoder,
  encodeMessage,
  sanitizeRequest,
  readBridge,
  submitDownload,
  runNativeHost,
};
