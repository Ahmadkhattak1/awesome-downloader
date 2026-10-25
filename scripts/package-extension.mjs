// Builds the Chrome Web Store submission ZIP for the browser extension.
// Usage: yarn package:extension
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tests, the Firefox manifest and hidden files such as macOS's .DS_Store stay out.
const isPackaged = (relativePath) =>
  !relativePath.endsWith('.test.cjs') &&
  relativePath !== 'manifest.firefox.json' &&
  !relativePath.split('/').some((part) => part.startsWith('.'));

// A fixed timestamp makes the archive identical for identical sources.
const ENTRY_DATE = new Date('2000-01-01T00:00:00Z');

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const nested = await Promise.all(
    entries.map((entry) => {
      const relativePath = prefix + entry.name;

      return entry.isDirectory()
        ? listFiles(path.join(directory, entry.name), `${relativePath}/`)
        : [relativePath];
    }),
  );

  return nested.flat();
}

// Every file the manifest points at must be in the package.
function manifestReferences(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((script) => [
      ...(script.js || []),
      ...(script.css || []),
    ]),
  ].filter(Boolean);
}

export default async function packageExtension({
  extensionDirectory = path.join(projectRoot, 'extension'),
  outputDirectory = path.join(projectRoot, 'release-extension'),
} = {}) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'),
  );

  const files = (await listFiles(extensionDirectory)).filter(isPackaged).sort();
  const missing = manifestReferences(manifest).filter((reference) => !files.includes(reference));

  if (missing.length) {
    throw new Error(`manifest.json refers to files that are not packaged: ${missing.join(', ')}`);
  }

  const contents = Object.fromEntries(
    await Promise.all(
      files.map(async (relativePath) => [
        relativePath,
        [
          new Uint8Array(await fs.readFile(path.join(extensionDirectory, relativePath))),
          { mtime: ENTRY_DATE },
        ],
      ]),
    ),
  );

  const archivePath = path.join(
    outputDirectory,
    `Awesome-Downloader-Extension-${manifest.version}.zip`,
  );

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(archivePath, zipSync(contents, { level: 9 }));

  return { archivePath, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { archivePath, files } = await packageExtension();

  // eslint-disable-next-line no-console -- command-line output.
  console.log(
    `Extension package (${files.length} files): ${path.relative(projectRoot, archivePath)}`,
  );
}
