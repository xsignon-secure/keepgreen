// Renders the KeepGreen ad (scripts/ad.html) frame by frame, lays the
// voiceover (scripts/voice/*.m4a, made by scripts/voiceover.py) under it and
// encodes:
//   docs/keepgreen-ad.mp4           1920x1080 with voiceover, for YouTube, X and LinkedIn
//   docs/keepgreen-ad-vertical.mp4  1080x1920 with voiceover, for Reels, Shorts and TikTok
//   docs/keepgreen-ad.gif           960x540, silent with captions, for the README
//
// Run: node scripts/gen-ad.mjs   (needs the `playwright` package with Chromium,
// ffmpeg and ffprobe on PATH, and internet for the Google Sans font)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// require() also finds a globally installed playwright.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 30;
const LEAD = 0.3; // seconds of picture before each line starts
const GAP = 0.55; // seconds after each line ends
const TAIL = 1.5; // the end card stays a little longer

const script = JSON.parse(readFileSync(join(root, 'scripts', 'ad-script.json'), 'utf8'));
const voice = (id) => join(root, 'scripts', 'voice', `${id}.m4a`);
const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));

let at = 0;
const scenes = script.map((s, i) => {
  const start = at;
  const speech = seconds(voice(s.id));
  at += LEAD + speech + GAP + (i === script.length - 1 ? TAIL : 0);
  return { ...s, start, end: at, speechAt: start + LEAD };
});
const total = at;
const logo = `data:image/png;base64,${readFileSync(join(root, 'docs', 'logo.png')).toString('base64')}`;

async function frames(width, height) {
  const dir = mkdtempSync(join(tmpdir(), 'kg-ad-'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(root, 'scripts', 'ad.html')).href, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await document.fonts.load('700 40px "Google Sans"');
    await document.fonts.load('400 40px "Google Sans Code"');
    await document.fonts.ready;
  });
  const fonts = await page.evaluate(() => document.fonts.check('700 40px "Google Sans"') && document.fonts.check('400 40px "Google Sans Code"'));
  if (!fonts) throw new Error('Google Sans did not load (is fonts.googleapis.com reachable?)');
  await page.evaluate((src) => window.setLogo(src), logo);
  await page.waitForFunction(() => document.getElementById('logo2').complete);
  await page.evaluate(([s, t]) => window.setTiming(s, t), [scenes.map((s) => [s.id, s.start, s.end, s.caption]), total]);
  const count = Math.round(total * FPS);
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
  }
  await browser.close();
  return dir;
}

// One audio track: each line placed at its scene's start.
const audioInputs = scenes.flatMap((s) => ['-i', voice(s.id)]);
const audioFilter = `${scenes.map((s, i) => `[${i + 1}:a]adelay=${Math.round(s.speechAt * 1000)}:all=1[a${i}]`).join(';')};${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

function video(dir, out) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%04d.png'), ...audioInputs, '-filter_complex', audioFilter, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k', '-t', total.toFixed(2), '-movflags', '+faststart', join(root, 'docs', out)]);
}

const wide = await frames(1920, 1080);
video(wide, 'keepgreen-ad.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(wide, 'f%04d.png'), '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', join(root, 'docs', 'keepgreen-ad.gif')]);
rmSync(wide, { recursive: true, force: true });

const tall = await frames(1080, 1920);
video(tall, 'keepgreen-ad-vertical.mp4');
rmSync(tall, { recursive: true, force: true });
console.log(`wrote docs/keepgreen-ad.mp4, docs/keepgreen-ad-vertical.mp4 and docs/keepgreen-ad.gif (${total.toFixed(1)}s)`);
