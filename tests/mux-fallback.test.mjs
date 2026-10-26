import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { muxTracks } from '../core/mux.mjs';

const run = promisify(execFile);

async function createTracks(root) {
  await run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','color=c=red:s=64x64:r=5','-t','1','-an','-c:v','libx264', path.join(root,'video.mp4')], { windowsHide: true });
  await run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','sine=frequency=440','-t','1','-c:a','aac', path.join(root,'audio.m4a')], { windowsHide: true });
  await fs.copyFile(path.join(root,'video.mp4'), path.join(root,'0.part'));
  await fs.copyFile(path.join(root,'audio.m4a'), path.join(root,'1.part'));
}

test('a crashing FFmpeg override falls back to another working build', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-mux-crash-'));
  const previous = process.env.AWESOME_FFMPEG_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.AWESOME_FFMPEG_PATH;
    else process.env.AWESOME_FFMPEG_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await createTracks(root);
  const crashing = path.join(root, 'crashing-ffmpeg');
  await fs.writeFile(crashing, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o755 });
  process.env.AWESOME_FFMPEG_PATH = crashing;
  const output = await muxTracks(root, 1, 2, new AbortController().signal);
  assert.ok((await fs.stat(output)).size > 0, 'the fallback build produced the combined file');
});

test('a missing FFmpeg override does not break media assembly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-mux-missing-'));
  const previous = process.env.AWESOME_FFMPEG_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.AWESOME_FFMPEG_PATH;
    else process.env.AWESOME_FFMPEG_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await createTracks(root);
  process.env.AWESOME_FFMPEG_PATH = path.join(root, 'does-not-exist');
  const output = await muxTracks(root, 1, 2, new AbortController().signal);
  assert.ok((await fs.stat(output)).size > 0, 'a usable build produced the combined file');
});
