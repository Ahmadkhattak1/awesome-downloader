# Install and use Awesome Downloader

## Download

Windows 10/11, 64-bit Intel/AMD PCs are the intended target. Native ARM builds
are not provided. This is preview software; YouTube speed and compatibility vary.

Open the project's [latest release](https://github.com/Ahmadkhattak1/awesome-downloader/releases/latest)
and download **Awesome-Downloader-Setup.exe** from Assets. You do not need a GitHub
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

1. The app shows **Browser integration** on first launch. You can also open it
   from the toolbar later.
2. Click **Open Chrome extensions** or **Open Edge extensions**.
3. Enable **Developer mode** and click **Load unpacked**.
4. In the app, click **Copy folder**. Paste it into the folder picker's address
   bar, press Enter, then click **Select Folder**.
5. The setup panel checks automatically and shows when the browser is connected.
   Refresh your video page. No extension ID or commands need to be entered.

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
