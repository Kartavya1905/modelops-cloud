#!/usr/bin/env node
/**
 * make-gif.mjs: the recorded demo video -> docs/images/demo.gif (the README's demo).
 *
 *   pnpm --filter @modelops/e2e demo:record && node scripts/make-gif.mjs
 *
 * The video (tests/e2e/test-results/demo-video/demo.webm, not committed) starts with a blank page
 * while the first page loads; the recorder writes when the first real frame appears (start.txt)
 * and the GIF starts there. ffmpeg runs in a pinned container (nothing to install). Two passes:
 * a 256-colour palette from the whole video, then the encode; 8 frames/s at 960 px wide keeps the
 * GIF small enough for a README while the UI text stays readable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const videoDir = join(root, 'tests', 'e2e', 'test-results', 'demo-video');
const images = join(root, 'docs', 'images');
const FFMPEG =
  'linuxserver/ffmpeg:9.0.2-cli-ls88@sha256:f4191c1abe18d75c49a23f7224d1403d55334f80013a47cb096f5056cf19617b';
if (!existsSync(join(videoDir, 'demo.webm'))) {
  console.error('make-gif: no demo video; run `pnpm --filter @modelops/e2e demo:record` first');
  process.exit(1);
}
const start = existsSync(join(videoDir, 'start.txt'))
  ? readFileSync(join(videoDir, 'start.txt'), 'utf8').trim()
  : '0';

const ffmpeg = (...args) => {
  const r = spawnSync(
    'docker',
    [
      ...['run', '--rm', '-v', `${videoDir}:/in`, '-v', `${images}:/out`, FFMPEG],
      ...['-hide_banner', '-loglevel', 'error', ...args],
    ],
    { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const input = ['-ss', start, '-i', '/in/demo.webm'];
const filters = 'fps=8,scale=960:-1:flags=lanczos';
ffmpeg('-y', ...input, '-vf', `${filters},palettegen=stats_mode=diff`, '/in/palette.png');
ffmpeg(
  ...['-y', ...input, '-i', '/in/palette.png'],
  ...[
    '-lavfi',
    `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  ],
  '/out/demo.gif',
);
rmSync(join(videoDir, 'palette.png'));
console.log(
  `make-gif: docs/images/demo.gif from ${start} s (${(statSync(join(images, 'demo.gif')).size / 2 ** 20).toFixed(1)} MiB)`,
);
