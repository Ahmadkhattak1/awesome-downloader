# Awesome Downloader privacy policy

Effective date: October 29, 2026

Awesome Downloader is a local desktop download manager with a companion browser
extension. The project does not operate an analytics, advertising, account, or
download-proxy service.

## Data the browser extension handles

To show download choices and complete downloads selected by the user, the
extension processes the current page address and title, media addresses and
metadata, browser download events, and a small set of request headers needed by
some sites (`Referer`, `Origin`, `User-Agent`, cookies, or authorization headers).
For YouTube playback it may also process bounded player and streaming-session
metadata. This is browsing activity and may include authentication information.

Media candidates and request context are kept temporarily in browser memory or
session storage and are removed when the tab navigates or closes or the browser
session ends. The extension stores only the latest local error message across
browser sessions.

When the user explicitly selects a download, the extension sends only the
selected media information and the request context needed for that transfer to
the Awesome Downloader desktop application through the browser's native
messaging system. The desktop application connects directly to the website that
hosts the selected file. Selected download history and settings remain on the
user's computer until the user removes them or uninstalls and deletes the app's
data.

## Sharing, selling, and remote collection

The project developer does not receive, store, sell, rent, or use browsing data,
download data, authentication information, or personal information for
advertising, profiling, credit decisions, or any unrelated purpose. The
extension contains no analytics or advertising SDK. Data is shared only with
the local Awesome Downloader desktop application and the website hosting a file
that the user chooses to download.

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Software updates

Installed desktop builds contact GitHub Releases to check for new Awesome
Downloader versions. The update check uses GitHub's standard release service and
does not add a project-specific identifier or analytics event. Updates require
the user's approval before download and again before restart.

## User choices and deletion

Users can remove the extension from the browser, remove individual download
records from the desktop app, and uninstall the desktop application. Temporary
browser session data is cleared by closing the relevant tab or browser session.

## Contact

Questions or privacy reports can be filed in the public project issue tracker:
https://github.com/Ahmadkhattak1/awesome-downloader/issues

Do not include private URLs, cookies, authorization headers, or other secrets in
a public issue.
