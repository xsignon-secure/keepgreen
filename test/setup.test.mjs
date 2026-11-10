import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, VERSION, addFilePatch } from '../dist/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const cli = path.join(root, 'dist/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AUTOHEAL_BASE_URL: '', AUTOHEAL_PROVIDER: '' } });

test('the version is the same everywhere', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(readFileSync(path.join(root, 'action.yml'), 'utf8'), new RegExp(`default: "${pkg.version.replace(/\./g, '\\.')}"`));
  assert.match(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`## ${pkg.version.replace(/\./g, '\\.')}`));
  assert.equal(run('--version').stdout.trim(), pkg.version);
});

test('init writes the settings file and the explore workflow, pinned to this version, and keeps existing files', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-init-'));
  const first = await init(dir);
  assert.deepEqual(first.written, ['.keepgreen.yml', '.github/workflows/keepgreen-explore.yml']);
  const wf = readFileSync(path.join(dir, '.github/workflows/keepgreen-explore.yml'), 'utf8');
  assert.match(wf, new RegExp(`xsignon-secure/keepgreen@v${VERSION}`));
  assert.match(wf, new RegExp(`keepgreen@${VERSION} check-patch`));
  assert.doesNotMatch(wf, /\{\{VERSION\}\}/);
  // The job that runs AI-written tests must not get write access.
  const exploreJob = wf.slice(wf.indexOf('  explore:'), wf.indexOf('  publish:'));
  assert.match(exploreJob, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(exploreJob, /write/);
  assert.match(exploreJob, /persist-credentials: false/);
  const again = await init(dir);
  assert.deepEqual(again.written, []);
  assert.equal(again.skipped.length, 2);
  const dry = await init(mkdtempSync(path.join(os.tmpdir(), 'kg-dry-')), { dryRun: true });
  assert.equal(dry.written.length, 2);
});

test('cli: help, unknown command, missing key, check-patch', () => {
  assert.equal(run('--help').status, 0);
  assert.equal(run('nope').status, 2);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-cli-'));
  const noKey = spawnSync(process.execPath, [cli, 'explore', '--url', 'http://localhost:9', '--project', dir], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /needs an AI key/);
  const bad = spawnSync(process.execPath, [cli, 'explore', '--max-flows', '99', '--project', dir], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /max-flows/);
  writeFileSync(path.join(dir, 'good.patch'), addFilePatch('tests/a.spec.ts', 'x\n'));
  writeFileSync(path.join(dir, 'bad.patch'), addFilePatch('.github/workflows/a.spec.ts', 'x\n'));
  const good = run('check-patch', path.join(dir, 'good.patch'));
  assert.equal(good.status, 0);
  assert.equal(good.stdout.trim(), 'tests/a.spec.ts');
  const refused = run('check-patch', path.join(dir, 'bad.patch'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /hidden folder/);
});

test('heal and autoheal pass through to the installed AutoHeal', () => {
  const r = run('autoheal', '--version');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});
