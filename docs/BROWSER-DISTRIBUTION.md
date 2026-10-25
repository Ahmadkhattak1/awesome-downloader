# Browser installation

The current preview automatically connects an extension after it is installed.
It does not yet install the extension in a new browser.

For consumer Windows Chrome, external installation requires a published Chrome
Web Store extension. The desktop installer can register its store update URL;
Chrome then downloads the extension and asks the user to enable it. It cannot
silently enable a bundled unpacked extension. Edge supports external installation
from its own store or the Chrome Web Store.

## Prepare the submission

Run `yarn package:extension` on any platform. It writes
`release-extension/Awesome-Downloader-Extension-<version>.zip` with manifest.json at
the archive root, leaves out tests, the Firefox-specific manifest and hidden files
such as `.DS_Store`, and refuses to build if the manifest refers to a missing file.
The "Build release candidates" workflow also builds it, with a checksum, as the
`browser-extension-store-package` artifact. It is a store submission package, not a
replacement for a reviewed store listing.

Publish it through the owner's Chrome Web Store developer account. Complete the
store's privacy and permission disclosures based on the actual extension, and
retain the resulting extension ID. Publishing and approval are still pending.

Once the listing is available, wire its ID into the native messaging allowlist
and the Windows install/uninstall registration. Keep development extension IDs
working alongside it. Verify the complete flow on a fresh Windows browser profile:
install the desktop app, accept the browser's extension prompt, select a video,
and receive the download dialog. Do not claim automatic installation until this
flow has been verified.

Official distribution references:

- https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options
