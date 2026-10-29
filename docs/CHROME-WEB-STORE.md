# Chrome Web Store submission

## Listing

**Name:** Awesome Downloader Integration

**Summary:** Detect downloadable media and send user-selected files to the
Awesome Downloader desktop app.

**Category:** Productivity

**Language:** English

**Detailed description:**

Awesome Downloader Integration connects supported web pages to the Awesome
Downloader desktop application. It detects direct media and file downloads,
shows available qualities near supported video players, and sends only the
option you choose to the desktop app.

- Choose a detected video or audio quality from the page.
- Send links, video, and audio from the right-click menu.
- Hand normal browser downloads to the desktop download manager.
- Keep detection and download history on your computer; no project analytics or
  advertising service receives your browsing activity.

The free Awesome Downloader desktop application must be installed for downloads
to start. Availability depends on the site and media format. DRM-protected,
live, private, and sign-in-restricted media may not work. Download only content
you own or are permitted to save.

**Homepage:** https://github.com/Ahmadkhattak1/awesome-downloader

**Privacy policy:**
https://github.com/Ahmadkhattak1/awesome-downloader/blob/main/PRIVACY.md

## Single purpose

Detect downloadable media and file links on the page the user is viewing and,
after the user chooses an item, transfer that download to the locally installed
Awesome Downloader desktop application.

## Permission justifications

- **nativeMessaging:** Sends a user-selected download and the request context
  required to retrieve it to the local desktop application. No remote project
  server receives this message.
- **storage:** Keeps the latest local error and bounded per-tab media candidates
  for the current browser session.
- **contextMenus:** Adds “Download with Awesome Downloader” actions for links,
  video, audio, and the current page.
- **webRequest:** Observes media responses and captures only the request context
  needed to reproduce a transfer the user selects.
- **downloads:** Pauses a new browser download during handoff to the desktop app,
  cancels the browser copy only after the desktop app accepts it, and resumes it
  if handoff fails.
- **http://*/* and https://*/*:** Downloadable files and media can be hosted on
  any website or content-delivery domain. The extension needs page access to
  locate media and display its user-activated download control.

## Privacy dashboard answers

Disclose **Web history**, **Website content**, and **Authentication information**.
Explain that these categories are processed locally only to detect media and
complete a download explicitly selected by the user. They are sent only through
native messaging to the user's local desktop app and are not collected by the
developer, sold, used for advertising, or used for purposes unrelated to the
extension's single purpose.

Certify that the data is not sold, is not used or transferred for purposes
unrelated to the single purpose, is not used for creditworthiness or lending,
and is handled according to the published privacy policy.

## Submission files

Run `powershell -ExecutionPolicy Bypass -File integration/package-extension.ps1`.
Upload the resulting ZIP from `release-extension`. The package deliberately
excludes tests and the Firefox-only manifest.

The listing also requires the 128×128 icon already included in the package and
at least one 1280×800 or 640×400 screenshot of the real extension experience.
