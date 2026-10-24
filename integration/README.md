# Browser integration

Start Awesome Downloader once, install its unpacked extension in Chrome or Edge, and reload existing video tabs. The app detects this extension and registers its own Windows native host automatically. There is no extension-ID or Connect step. For development use `extension/`; the packaged app shows its extension folder in Browser Integration.

Click **Download this video**, choose a quality/format, then **Start Download** in Download File Info. A separate progress window shows speed, transferred bytes, time remaining, and connection progress. Supported HLS can produce MP4; MP3 is offered when a separate audio track is identified. Qualities come from real manifest metadata.

The native executable forwards bounded JSON to an authenticated local endpoint and starts the app if it is closed. Registration affects only this product's per-user native-host keys; changed registrations are backed up. Firefox's manifest variant and manual script remain development features without equivalent end-to-end verification.

Captured cookies, authorization, user agent and referrer stay in extension memory. Only context observed for the selected URL and tab is passed to the desktop. Credentials are excluded from history and stripped on cross-origin redirects. Page JavaScript has no exposed handoff endpoint.

Supported: HTTP(S), resumable byte ranges, unencrypted HLS VOD, TS/fMP4 segments, separate audio/video assembly, MP4 remuxing and MP3 extraction. Unsupported: DASH, live/encrypted HLS, byte-range HLS, arbitrary POST downloads, proxy inheritance and proprietary players. Blob URLs themselves cannot be downloaded; their observed network playlists may be supported.

Browser interception is opt-in. Native acceptance is required before cancelling a browser transfer; failure leaves the browser transfer intact. Store distribution and signing are not supplied.

API references: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest), [FFmpeg stream selection](https://ffmpeg.org/ffmpeg.html#Stream-selection).
