# Install and use Awesome Downloader

## Download

Windows 10/11, 64-bit Intel/AMD PCs are the intended target. Native ARM builds
are not provided. This is preview software; YouTube speed and compatibility vary.

Once the first release is published, open the project's **Releases** page and
download **Awesome-Downloader-Setup.exe** from Assets. You do not need a GitHub
account, Git, Node.js, or a terminal to install the application. Do not download
the automatically generated "Source code" archives to install it.

The installer is currently unsigned. Windows may show an unknown-publisher
warning. Do not disable antivirus or other security protections; check the source
of your download and the release's SHA-256 checksum before deciding to run it.

Run the installer and follow the wizard. Launch **Awesome Downloader** from the
Start menu. Keep the app installed at its chosen location so browser integration
can find it.

## Enable video buttons (Chrome / Edge)

There is no browser-store listing yet. This is the one manual setup step:

1. Open the app's **Browser Integration** panel and copy its extension folder path.
2. Open `chrome://extensions` or `edge://extensions` in your browser.
3. Enable **Developer mode**, choose **Load unpacked**, and select that folder.
4. Leave Awesome Downloader open while it detects the extension, then refresh
   the video page. No extension ID needs to be entered.

Only install the extension if you trust this project. Its page/network permissions
allow it to detect media and hand the selected media session to the desktop app.
Firefox does not yet have equivalent verified YouTube support.

## Download a file or video

- For a file link, use **Add URL** in the app.
- For a supported video, play it briefly, click **Download this video**, and select
  a quality such as 1080p. Only download content you are permitted to save.
- In **Download File Info**, choose a name, folder, and category. Choose
  **Start Download**, **Download Later**, or **Cancel**.
- Start Download opens progress. On completion, use **Open** or **Open folder**.
- Repeated clicks reuse the active download. Cancel closes the progress window.

Closing the main window keeps the app in the tray. Use **Tasks → Exit** to quit.
Paused/queued YouTube sessions may expire; reselect the video in the browser if
resuming later fails. DRM, private/sign-in-required videos, and live streams are
not supported. Slow YouTube transfers remain a known limitation.

## Updates and uninstall

Quit the app before installing a newer release. After updating, reload the
extension on the browser's extensions page and refresh your video tabs.

Uninstall through Windows **Settings → Apps**. Remove the browser extension
separately. Downloads and the `.awesome-downloader` folder in your Windows user
folder are not automatically deleted. There is no automatic updater yet.
