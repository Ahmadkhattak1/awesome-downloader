# Browser installation

The current preview automatically connects an extension after it is installed.
It does not yet install the extension in a new browser.

For consumer Chrome on Windows or Linux, external installation requires a
published Chrome Web Store extension. The desktop installer can register its
store update URL; Chrome then downloads the extension and asks the user to enable
it. It cannot silently enable a bundled unpacked extension. Edge supports external
installation from its own store or the Chrome Web Store.

## Prepare the submission

Run `powershell -File integration/package-extension.ps1` from the project root on
Windows, or zip `extension/` on Linux after replacing `manifest.json` with the
Firefox variant when needed. The ZIP must have manifest.json at the archive root
and exclude tests and the Firefox-specific manifest. It is a store submission
package, not a replacement for a reviewed store listing.

Publish it through the owner's Chrome Web Store developer account. Complete the
store's privacy and permission disclosures based on the actual extension, and
retain the resulting extension ID. Publishing and approval are still pending.

Once the listing is available, wire its ID into the native messaging allowlist
and the per-platform install/uninstall registration (the Windows registry or
Linux native-messaging manifests). Keep development extension IDs working
alongside it. Verify the complete flow on a fresh browser profile on each
platform: install the desktop app, accept the browser's extension prompt, select
a video, and receive the download dialog. Do not claim automatic installation
until this flow has been verified.

Official distribution references:

- https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options
