# Install and use Awesome Downloader

## Download

Windows 10/11 and Linux x64 on Intel/AMD PCs are the intended targets. Native ARM
builds are not provided. This is preview software; YouTube speed and
compatibility vary.

### Windows

Open the project's [Windows preview release](https://github.com/Ahmadkhattak1/awesome-downloader/releases/tag/v0.1.0-preview.4)
and download **Awesome-Downloader-Setup.exe** from Assets. You do not need a GitHub
account, Git, Node.js, or a terminal to install the application. Do not download
the automatically generated "Source code" archives to install it.

The installer is currently unsigned. Windows may show an unknown-publisher
warning. Do not disable antivirus or other security protections; check the source
of your download and the release's SHA-256 checksum before deciding to run it.

Run the installer and follow the wizard. Launch **Awesome Downloader** from the
Start menu. Keep the app installed at its chosen location so browser integration
can find it.

### Linux

Use a Linux x64 build made from this source. With Node.js 22 or newer, run:

```sh
npm ci
npm run dist:linux
```

The installers are written to `release/`:

- **Awesome-Downloader-0.1.0-Linux-x86_64.AppImage** — portable, no installation
  needed. Make it executable and run it:
  ```sh
  chmod +x release/Awesome-Downloader-*-Linux-x86_64.AppImage
  ./release/Awesome-Downloader-*-Linux-x86_64.AppImage
  ```
  If your distribution restricts Electron's sandbox (Ubuntu 23.10+ AppArmor
  policies, for example) the AppImage may exit at startup. Prefer the `.deb`
  package, or run the AppImage with `--no-sandbox` if you accept that trade-off.
- **Awesome-Downloader-0.1.0-Linux-amd64.deb** — install with
  ```sh
  sudo apt install ./release/Awesome-Downloader-*-Linux-amd64.deb
  ```
  then launch **Awesome Downloader** from your applications menu. The package sets
  up the Chromium sandbox helper correctly.

Linux builds are unsigned. Verify any binary you did not build yourself.

## Enable video buttons (Chrome / Chromium / Edge)

The browser extension adds **Download this video** buttons to supported web
videos. It is included with the installed application; you do not need to download
a separate ZIP or visit GitHub again. Until our browser-store listing is published,
add it once to each browser you use:

1. The app shows **Browser integration** on first launch. You can also open it
   from the toolbar later.
2. In **Awesome Downloader**, click **Copy extension folder path**. This copies
   the location of the extension that came with the app. It is **not** the folder
   where your downloaded videos will be saved.
3. Click **Open Chrome extensions**, **Open Chromium extensions**, or **Open Edge
   extensions** in the app. Your browser opens its **Extensions** page. If the
   button cannot find your browser, type `chrome://extensions` in Chrome's or
   Chromium's web address bar, or `edge://extensions` in Edge's web address bar,
   then press **Enter**.
4. On the browser's Extensions page, switch on **Developer mode**. In Chrome it
   is usually at the upper right. In Edge, check the left sidebar; expand the menu
   if the sidebar is hidden.
5. Click **Load unpacked** on the Extensions page. This opens a **folder
   selection window**. The following step happens in that new window.
6. Press **Ctrl+L** to select the folder window's address bar at the top. Press
   **Ctrl+V** to paste the extension folder path copied in step 2, then press
   **Enter**. Do not paste into the browser's web address bar or the Search box.
7. Click **Select Folder** (some versions say **Select**) at the bottom of that
   folder window. Choose the **extension folder itself**, not a file inside it
   and not its `icons` subfolder.
8. The browser's Extensions page should now show **Awesome Downloader
   Integration**. Make sure its switch is on. Leave Developer mode on while using
   this unpacked preview extension.
9. Return to Awesome Downloader. The Browser integration panel checks
   automatically and shows the browser connection message. No extension ID or
   commands need to be entered.
10. Return to the video website, refresh the page, and play the video briefly.
    Look for **Download this video**, then follow the download steps below.

### Which folder should I choose?

The exact location for your computer is displayed under **Included browser
extension folder** in the app. A normal installed copy uses:

- Windows: `C:\Users\YOUR-WINDOWS-USERNAME\.awesome-downloader\BrowserIntegration\extension`
- Linux: `/home/YOUR-LINUX-USERNAME/.awesome-downloader/BrowserIntegration/extension`

Those paths are examples; **Copy extension folder path** copies your actual path.
**Show extension folder** opens that folder in File Explorer (Windows) or your
file manager (Linux) if you want to inspect it. It contains `manifest.json` and an
`icons` folder. You select the enclosing `extension` folder, not `manifest.json`.
Do not move or delete this folder after loading it into your browser.

### If setup does not work

- **“Manifest file is missing or unreadable”:** Cancel the folder selection and
  copy the path from Awesome Downloader again. Select the folder containing
  `manifest.json`, not the app's installation folder, Downloads, or `icons`.
- **No connection message:** Keep the app running, confirm the extension is
  switched on in the same browser you set up, then click **Refresh browsers** in
  the app. Reload the extension on the browser's Extensions page and retry.
- **Linux native messaging:** the app writes per-user manifests to
  `~/.config/google-chrome/NativeMessagingHosts` (Chrome),
  `~/.config/chromium/NativeMessagingHosts` (Chromium),
  `~/.config/microsoft-edge/NativeMessagingHosts` (Edge), or
  `~/.mozilla/native-messaging-hosts` (Firefox). Keep the browser and the app in
  the same user account.
- **No video button:** Refresh the video page after setup and start playback.
  Some sites and protected media are not supported.
- **No Developer mode or Load unpacked button:** A workplace or school may
  restrict extension installation. Ask its administrator about permitted setup.
- **HLS or media conversion fails on Linux:** the bundled FFmpeg static build may
  not work on every distribution. Install your distribution's FFmpeg and start
  the app with
  `AWESOME_FFMPEG_PATH=/usr/bin/ffmpeg ./release/Awesome-Downloader-*.AppImage`
  (or launch the installed `awesome-downloader` binary the same way).

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

- **Windows:** uninstall through Windows **Settings → Apps**.
- **Linux (deb):** `sudo apt remove awesome-downloader`.
- **Linux (AppImage):** delete the AppImage file.

Remove the browser extension separately. Downloads and the `.awesome-downloader`
folder in your user folder are not automatically deleted. There is no automatic
updater yet.
