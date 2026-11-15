// Renders the KeepGreen ad (scripts/ad.html) frame by frame and encodes:
//   docs/keepgreen-ad.gif  960x540, for the README
//   docs/keepgreen-ad.mp4  1080x1920 vertical, for Reels, Shorts and LinkedIn
//
// Run: node scripts/gen-ad.mjs   (needs the `playwright` package with Chromium,
// and ffmpeg on PATH or FFMPEG=/path/to/ffmpeg)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// require() also finds a globally installed playwright.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const logo = `data:image/png;base64,${readFileSync(join(root, 'docs', 'logo.png')).toString('base64')}`;

async function frames(width, height, fps) {
  const dir = mkdtempSync(join(tmpdir(), 'kg-ad-'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(root, 'scripts', 'ad.html')).href);
  await page.evaluate((src) => window.setLogo(src), logo);
  await page.waitForFunction(() => document.getElementById('logo').complete);
  const total = await page.evaluate(() => window.TOTAL);
  const count = Math.round(total * fps);
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => window.render(t), i / fps);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
  }
  await browser.close();
  return dir;
}

const gifDir = await frames(960, 540, 12);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '12', '-i', join(gifDir, 'f%04d.png'), '-vf', 'split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', join(root, 'docs', 'keepgreen-ad.gif')]);
rmSync(gifDir, { recursive: true, force: true });

const mp4Dir = await frames(1080, 1920, 30);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(mp4Dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', join(root, 'docs', 'keepgreen-ad.mp4')]);
rmSync(mp4Dir, { recursive: true, force: true });
console.log('wrote docs/keepgreen-ad.gif and docs/keepgreen-ad.mp4');
