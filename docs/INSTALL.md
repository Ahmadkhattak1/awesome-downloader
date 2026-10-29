# Install and use Awesome Downloader

## Download

Windows 10/11, 64-bit Intel/AMD PCs are the intended target. Native ARM builds
are not provided. This is preview software; YouTube speed and compatibility vary.

Open the project's [Windows preview release](https://github.com/Ahmadkhattak1/awesome-downloader/releases/tag/v0.1.0-preview.5)
and download **Awesome-Downloader-Setup.exe** from Assets. You do not need a GitHub
account, Git, Node.js, or a terminal to install the application. Do not download
the automatically generated "Source code" archives to install it.

The installer is currently unsigned. Windows may show an unknown-publisher
warning. Do not disable antivirus or other security protections; check the source
of your download and the release's SHA-256 checksum before deciding to run it.

Run the installer and follow the wizard. Launch **Awesome Downloader** from the
Start menu. Keep the app installed at its chosen location so browser integration
can find it.

## Enable video buttons (Chrome / Edge / Brave / Opera)

The browser extension adds **Download this video** buttons to supported web
videos. It is included with the installed application; you do not need to download
a separate ZIP or visit GitHub again. Until our browser-store listing is published,
add it once to each browser you use:

1. The app shows **Browser integration** on first launch. You can also open it
   from the toolbar later.
2. Choose the card for **Chrome**, **Edge**, **Brave**, or **Opera**. The card
   shows whether that browser is installed, needs setup, or is connected.
3. In that browser's guide, click **Copy path**. This copies the location of the
   extension that came with the app. It is **not** the folder where your
   downloaded videos will be saved. Then click **Open Browser extensions**.
   Your browser opens its **Extensions** page. If the button cannot find your
   browser, type `chrome://extensions`, `edge://extensions`,
   `brave://extensions`, or `opera://extensions` in that browser's address bar,
   then press **Enter**.
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
9. Return to Awesome Downloader and click **Refresh**. The selected browser's
   card changes to **Connected** after the extension is found and its local
   connector is registered. No extension ID or commands need to be entered.
10. Return to the video website, refresh the page, and play the video briefly.
    Look for **Download this video**, then follow the download steps below.

### Which folder should I choose?

The exact location for your computer is displayed as **Extension folder** in the
selected browser's guide. A normal installed copy uses:

`C:\Users\YOUR-WINDOWS-USERNAME\.awesome-downloader\BrowserIntegration\extension`

That path is an example; **Copy extension folder path** copies your actual path
with your own Windows username. **Show folder** opens that folder in
File Explorer if you want to inspect it. It contains `manifest.json` and an
`icons` folder. You select the enclosing `extension` folder, not `manifest.json`.
Do not move or delete this folder after loading it into your browser.

### If setup does not work

- **“Manifest file is missing or unreadable”:** Cancel the folder selection and
  click **Show folder** in Awesome Downloader. Confirm that the opened
  folder contains `manifest.json`. Return to the Extensions page, choose **Load
  unpacked**, and select that exact opened `extension` folder—not the app's
  installation folder, Downloads, `manifest.json` itself, or the `icons` folder.
- **No connection message:** Keep the app running, confirm the extension is
  switched on in the same browser you set up, then click **Refresh** in
  the app. Reload the extension on the browser's Extensions page and retry.
- **No video button:** Refresh the video page after setup and start playback.
  Some sites and protected media are not supported.
- **No Developer mode or Load unpacked button:** A workplace or school may
  restrict extension installation. Ask its administrator about permitted setup.

Only install the extension if you trust this project. Its page/network permissions
allow it to detect media and hand the selected media session to the desktop app.
Firefox is a supported browser option. **Set up Firefox** creates its
browser-specific folder and opens Firefox's add-on setup page. Choose
**This Firefox**, then **Load Temporary Add-on**, and select `manifest.json` from
the folder shown by the app. Firefox removes a temporary add-on when it restarts;
a signed AMO release is still required for permanent consumer installation.

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

Awesome Downloader checks GitHub Releases for updates after startup and every
six hours. It asks before downloading and again before restarting. Active
downloads are never restarted automatically; choose **Later** and let them
finish first. You can also choose **Help → Check for updates** at any time.
After an extension update, reload your video tabs if their download button is
missing.

Uninstall through Windows **Settings → Apps**. Remove the browser extension
separately. Downloads and the `.awesome-downloader` folder in your Windows user
folder are not automatically deleted.
