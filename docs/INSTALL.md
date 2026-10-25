# Install and use Awesome Downloader

## Download

Windows 10/11, 64-bit Intel/AMD PCs are the main target; Windows ARM builds are
not provided. A macOS preview for Apple Silicon and Intel Macs is described [below](#macos-preview). This is preview software; YouTube speed and compatibility vary.

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

### macOS (preview)

There are two Mac downloads: **Awesome-Downloader-VERSION-mac-arm64.dmg** for
Apple Silicon Macs (M1 or newer) and **Awesome-Downloader-VERSION-mac-x64.dmg**
for Intel Macs. If you are not sure which Mac you have, choose **Apple menu → About
This Mac**: a **Chip** line names Apple M1 or newer, a **Processor** line names
Intel. A Mac download is not yet attached to a published release; it is produced
by the release workflow or by `yarn dist:mac` (see the README).

1. Open the DMG for your Mac and drag **Awesome Downloader** into
   **Applications**. Keep it there so browser integration can find it.
2. The app is not notarized by Apple yet, so the first launch is blocked. Open it
   once, then go to **System Settings → Privacy & Security**, find the message
   about Awesome Downloader, and click **Open Anyway**. Check the release's
   SHA-256 checksum before doing this.
3. Browser setup is the same as below, except that **Load unpacked** opens a
   Finder window: press **⌘⇧G** (Go to Folder), **⌘V** to paste the extension
   folder path, **Return**, then click **Select**. The folder is
   `/Users/YOUR-MAC-USERNAME/.awesome-downloader/BrowserIntegration/extension`.

Closing the window keeps the app running in the menu bar; use **Awesome
Downloader → Quit** (⌘Q) to quit. To uninstall, quit the app and move it to the
Trash. The `.awesome-downloader` folder in your home folder and the
`com.awesome.downloader.json` files in
`~/Library/Application Support/{Google/Chrome,Microsoft Edge,Mozilla}/NativeMessagingHosts`
are not removed automatically.

## Enable video buttons (Chrome / Edge)

The browser extension adds **Download this video** buttons to supported web
videos. It is included with the installed application; you do not need to download
a separate ZIP or visit GitHub again. Until our browser-store listing is published,
add it once to each browser you use:

1. The app shows **Browser integration** on first launch. You can also open it
   from the toolbar later.
2. In **Awesome Downloader**, click **Copy extension folder path**. This copies
   the location of the extension that came with the app. It is **not** the folder
   where your downloaded videos will be saved.
3. Click **Open Chrome extensions** or **Open Edge extensions** in the app.
   Your browser opens its **Extensions** page. If the button cannot find your
   browser, type `chrome://extensions` in Chrome's web address bar, or
   `edge://extensions` in Edge's web address bar, then press **Enter**.
4. On the browser's Extensions page, switch on **Developer mode**. In Chrome it
   is usually at the upper right. In Edge, check the left sidebar; expand the menu
   if the sidebar is hidden.
5. Click **Load unpacked** on the Extensions page. This opens a **Windows folder
   selection window**. The following step happens in that new window.
6. Press **Ctrl+L** to select the folder window's address bar at the top. Press
   **Ctrl+V** to paste the extension folder path copied in step 2, then press
   **Enter**. Do not paste into the browser's web address bar or the Search box.
7. Click **Select Folder** (some versions say **Select**) at the bottom of that
   Windows window. Choose the **extension folder itself**, not a file inside it
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

`C:\Users\YOUR-WINDOWS-USERNAME\.awesome-downloader\BrowserIntegration\extension`

That path is an example; **Copy extension folder path** copies your actual path
with your own Windows username. **Show extension folder** opens that folder in
File Explorer if you want to inspect it. It contains `manifest.json` and an
`icons` folder. You select the enclosing `extension` folder, not `manifest.json`.
Do not move or delete this folder after loading it into your browser.

### If setup does not work

- **“Manifest file is missing or unreadable”:** Cancel the folder selection and
  copy the path from Awesome Downloader again. Select the folder containing
  `manifest.json`, not the app's installation folder, Downloads, or `icons`.
- **No connection message:** Keep the app running, confirm the extension is
  switched on in the same browser you set up, then click **Refresh browsers** in
  the app. Reload the extension on the browser's Extensions page and retry.
- **No video button:** Refresh the video page after setup and start playback.
  Some sites and protected media are not supported.
- **No Developer mode or Load unpacked button:** A workplace or school may
  restrict extension installation. Ask its administrator about permitted setup.

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

Closing the main window keeps the app in the tray. Use **Tasks → Exit** to quit
(on macOS, **Awesome Downloader → Quit**).
Paused/queued YouTube sessions may expire; reselect the video in the browser if
resuming later fails. DRM, private/sign-in-required videos, and live streams are
not supported. Slow YouTube transfers remain a known limitation.

## Updates and uninstall

Quit the app before installing a newer release. After updating, reload the
extension on the browser's extensions page and refresh your video tabs.

Uninstall through Windows **Settings → Apps**. Remove the browser extension
separately. Downloads and the `.awesome-downloader` folder in your Windows user
folder are not automatically deleted. There is no automatic updater yet.
