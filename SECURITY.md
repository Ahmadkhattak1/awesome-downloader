# Security

Do not include signed media URLs, cookies, authorization headers, native messaging
payloads, browser profile files, or `.awesome-downloader` contents in public issues.

For vulnerabilities, use GitHub's private vulnerability reporting feature if it
is enabled on this repository. If it is unavailable, open a minimal issue asking
for a private reporting channel without publishing exploitation details or secrets.

The native bridge must remain authenticated and loopback-only. No DRM bypass,
credential harvesting, or page-controlled filesystem paths are accepted.

Only the latest preview is maintained. There is no automatic updater yet.
