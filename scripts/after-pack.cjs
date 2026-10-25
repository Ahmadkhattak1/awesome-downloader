// electron-builder afterPack hook. ffmpeg-static only downloads the FFmpeg binary for the
// machine running `yarn install`, so a macOS build for the other architecture would ship an
// FFmpeg that cannot run. Swap in the matching binary before the app is signed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('electron-builder');

const projectDirectory = path.join(__dirname, '..');
const ffmpegStaticDirectory = path.join(projectDirectory, 'node_modules', 'ffmpeg-static');
const cacheDirectory = path.join(projectDirectory, 'node_modules', '.cache');
const MACHO_64_MAGIC = 0xfeedfacf;
const CPU_TYPES = { x64: 0x01000007, arm64: 0x0100000c };

function machOArch(file) {
  const header = Buffer.alloc(8);
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.readSync(descriptor, header, 0, 8, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.readUInt32LE(0) !== MACHO_64_MAGIC) {
    return null;
  }
  const cpuType = header.readUInt32LE(4);
  return Object.keys(CPU_TYPES).find((arch) => CPU_TYPES[arch] === cpuType) || null;
}

// Reuses ffmpeg-static's own installer, so the release tag and download source stay the ones
// pinned by the installed package.
function downloadFfmpeg(arch) {
  const binary = path.join(cacheDirectory, `ffmpeg-darwin-${arch}`, 'ffmpeg');
  if (fs.existsSync(binary) && machOArch(binary) === arch) {
    return binary;
  }
  fs.rmSync(path.dirname(binary), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  execFileSync(process.execPath, [path.join(ffmpegStaticDirectory, 'install.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FFMPEG_BIN: binary,
      npm_config_platform: 'darwin',
      npm_config_arch: arch,
    },
  });
  return binary;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  const arch = Arch[context.arch];
  if (!CPU_TYPES[arch]) {
    throw new Error(`No FFmpeg build is configured for macOS ${arch}.`);
  }
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const packaged = path.join(resources, 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg');
  if (machOArch(packaged) === arch) {
    return;
  }

  const source = downloadFfmpeg(arch);
  fs.copyFileSync(source, packaged);
  fs.chmodSync(packaged, 0o755);
  fs.copyFileSync(`${source}.LICENSE`, path.join(resources, 'licenses', 'FFmpeg-LICENSE.txt'));
  fs.copyFileSync(`${source}.README`, path.join(resources, 'licenses', 'FFmpeg-BUILD.txt'));
  if (machOArch(packaged) !== arch) {
    throw new Error(`Packaged FFmpeg is not a macOS ${arch} binary: ${packaged}`);
  }
  // eslint-disable-next-line no-console -- reports the swap in the build log.
  console.log(`  • replaced FFmpeg with the darwin-${arch} build`);
};
