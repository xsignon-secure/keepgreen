import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixPlaywrightConfigText, fixProject, fixTestWorkflowText, openSetupPr, runExplore, setupPrBody, status, explorePr } from '../dist/index.js';

const JSON_REPORTER = "['json', { outputFile: 'playwright-report/results.json' }]";

test('playwright.config: JSON report last (html empties its folder), traces, webServer reuse', () => {
  const str = fixPlaywrightConfigText("export default defineConfig({\n  reporter: 'html',\n  use: {\n    baseURL: 'http://127.0.0.1:3000',\n  },\n  webServer: { command: 'npm start', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI },\n});\n");
  assert.match(str.text, new RegExp(`reporter: \\[\\['html'\\], ${JSON_REPORTER.replace(/[[\]{}.()/]/g, '\\$&')}\\]`));
  assert.match(str.text, /use: \{\n    trace: 'retain-on-failure',\n    baseURL/);
  assert.match(str.text, /reuseExistingServer: !process\.env\.CI \|\| !!process\.env\.KEEPGREEN \}/);
  assert.equal(str.changes.length, 3);

  const arr = fixPlaywrightConfigText("export default defineConfig({\n  reporter: [\n    ['html', { open: 'never' }],\n    ['github'],\n  ],\n});\n");
  assert.ok(arr.text.indexOf("['github']") < arr.text.indexOf("'json'"), 'json goes after the other reporters');
  assert.match(arr.text, /\['github'\],\n    \['json', \{ outputFile: 'playwright-report\/results\.json' \}\],\n  \]/);

  const none = fixPlaywrightConfigText("export default defineConfig({\n  testDir: 'e2e',\n  webServer: { command: 'npm start', url: 'http://localhost:3000' },\n});\n");
  assert.match(none.text, /reporter: \[\['list'\], \['json'/);
  assert.match(none.text, /use: \{ trace: 'retain-on-failure' \}/);
  assert.match(none.text, /webServer: \{ reuseExistingServer: !process\.env\.CI \|\| !!process\.env\.KEEPGREEN,/);

  // Already fine, or a setting the user chose: left alone.
  const fine = "module.exports = { use: { trace: 'on-first-retry' }, reporter: 'blob', webServer: { command: 'x', url: 'y', reuseExistingServer: true } };";
  assert.deepEqual(fixPlaywrightConfigText(fine), { text: fine, changes: [] });
  // A computed reporter is not ours to rewrite.
  assert.doesNotMatch(fixPlaywrightConfigText("export default defineConfig({\n  reporter: process.env.CI ? 'github' : 'list',\n});").text, /'json'/);
  // Not a config we understand: unchanged.
  assert.deepEqual(fixPlaywrightConfigText('export default config;').changes, []);
});

test('test workflow: workflow_dispatch in every on: form, and an artifact upload after the test step', () => {
  const block = fixTestWorkflowText('name: E2E\non:\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - name: Tests\n        run: |\n          npx playwright test\n        env:\n          CI: true\n\n  lint:\n    runs-on: ubuntu-latest\n');
  assert.match(block.text, /^on:\n {2}# AutoHeal starts this workflow on its fix PRs\.\n {2}workflow_dispatch:\n {2}push:/m);
  assert.match(block.text, /CI: true\n {6}# AutoHeal reads[^\n]*\n {6}- uses: actions\/upload-artifact@\w+ # v7\.0\.2\n {8}if: failure\(\)/);
  assert.match(block.text, /test-results\/\n\n {2}lint:/);
  assert.equal(fixTestWorkflowText('on: [push, pull_request]\njobs:\n  t:\n    steps:\n      - run: npx playwright test\n').text.split('\n')[0], 'on: [push, pull_request, workflow_dispatch]');
  assert.equal(fixTestWorkflowText('on: push\njobs:\n  t:\n    steps:\n    - run: npx playwright test\n').text.split('\n')[0], 'on: [push, workflow_dispatch]');
  const done = 'on:\n  workflow_dispatch:\njobs:\n  t:\n    steps:\n      - run: npx playwright test\n      - uses: actions/upload-artifact@v4\n';
  assert.deepEqual(fixTestWorkflowText(done), { text: done, changes: [] });
});

test('fixProject edits only Playwright projects, plans without writing on dry run', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-fix-'));
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(dir, 'playwright.config.ts'), "export default defineConfig({\n  testDir: 'tests',\n});\n");
  writeFileSync(path.join(dir, '.github/workflows/e2e.yml'), 'on: [push]\njobs:\n  t:\n    steps:\n      - run: npx playwright test\n');
  writeFileSync(path.join(dir, '.github/workflows/keepgreen-explore.yml'), 'on: [push]\n# playwright test\n');
  const planned = await fixProject(dir, { dryRun: true });
  assert.deepEqual(planned.map((f) => f.file), ['playwright.config.ts', '.github/workflows/e2e.yml']);
  assert.doesNotMatch(readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8'), /json/);
  await fixProject(dir);
  assert.match(readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8'), /'json'/);
  assert.match(readFileSync(path.join(dir, '.github/workflows/e2e.yml'), 'utf8'), /workflow_dispatch/);
  assert.deepEqual(await fixProject(dir), [], 'a second run changes nothing');
  assert.deepEqual(await fixProject(mkdtempSync(path.join(os.tmpdir(), 'kg-nopw-'))), []);
});

/** Real git, fake gh. */
function fakeRun(gh) {
  const calls = [];
  const run = (cmd, args, input) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') return { status: 0, stdout: '', stderr: '', ...gh(args, input) };
    const r = spawnSync(cmd, args, { encoding: 'utf8', input: input ?? '' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { run, calls };
}

test('the setup PR commits only the KeepGreen files on a new branch', () => {
  const remote = mkdtempSync(path.join(os.tmpdir(), 'kg-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-pr-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'app.js'), '1\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('remote', 'add', 'origin', remote);
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  writeFileSync(path.join(dir, '.keepgreen.yml'), 'url: x\n');
  writeFileSync(path.join(dir, 'app.js'), '2\n'); // the user's own change: not in the PR
  git('add', 'app.js');
  let body = '';
  const { run } = fakeRun((args, input) => {
    if (args[0] === 'repo') return { stdout: 'main\n' };
    if (args[0] === 'pr') {
      body = input;
      return { stdout: 'https://github.com/o/r/pull/7\n' };
    }
    return {};
  });
  const pr = openSetupPr({ root: dir, repo: 'o/r', files: ['.keepgreen.yml'], body: setupPrBody(['`.keepgreen.yml` (new)'], 'openrouter'), run });
  assert.deepEqual(pr, { ok: true, branch: 'keepgreen/setup', url: 'https://github.com/o/r/pull/7' });
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), '.keepgreen.yml');
  assert.match(git('ls-remote', 'origin'), /refs\/heads\/keepgreen\/setup/);
  assert.match(git('status', '--porcelain'), /^M {2}app\.js/m, "the user's staged change stays staged, uncommitted");
  assert.match(body, /OPENROUTER_API_KEY/);
  // Branch taken: a new name.
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, '.keepgreen.yml'), 'url: y\n');
  assert.equal(openSetupPr({ root: dir, repo: 'o/r', files: ['.keepgreen.yml'], body: '', run }).branch, 'keepgreen/setup-2');
});

test('keepgreen run starts the workflow and finds its run; clear message when it is not merged yet', () => {
  const now = Date.parse('2026-11-17T20:00:00Z');
  const { run, calls } = fakeRun((args) => {
    if (args[0] === 'workflow') return {};
    if (args[0] === 'run') return { stdout: JSON.stringify([{ databaseId: 42, url: 'https://github.com/o/r/actions/runs/42', createdAt: '2026-11-17T20:00:03Z' }]) };
    return {};
  });
  const r = runExplore({ repo: 'o/r', url: 'https://staging.example.com', flows: ['a', 'b'], maxFlows: '2', run, now: () => now, sleep: () => {} });
  assert.deepEqual(r, { ok: true, url: 'https://github.com/o/r/actions/runs/42', id: '42' });
  assert.deepEqual(calls[0], ['gh', 'workflow', 'run', 'keepgreen-explore.yml', '--repo', 'o/r', '-f', 'url=https://staging.example.com', '-f', 'max-flows=2', '-f', 'flows=a;b']);
  const missing = runExplore({ repo: 'o/r', run: fakeRun(() => ({ status: 1, stderr: 'could not find any workflows named keepgreen-explore.yml' })).run, sleep: () => {} });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /not on the default branch/);
  const pr = explorePr('o/r', '42', fakeRun(() => ({ stdout: JSON.stringify([{ url: 'https://github.com/o/r/pull/9', headRefName: 'keepgreen/explore-42-1' }]) })).run);
  assert.equal(pr, 'https://github.com/o/r/pull/9');
});

test('keepgreen status: key, Actions setting, runs and PRs to review', () => {
  const { run } = fakeRun((args) => {
    if (args[0] === 'secret') return { stdout: JSON.stringify([{ name: 'OPENROUTER_API_KEY' }]) };
    if (args[0] === 'api') return { stdout: JSON.stringify({ can_approve_pull_request_reviews: false }) };
    if (args[0] === 'run' && args.includes('keepgreen-explore.yml')) return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', createdAt: '2026-11-17T19:00:00Z', url: 'u1', event: 'workflow_dispatch' }]) };
    if (args[0] === 'run') return { stdout: '[]' };
    if (args[0] === 'pr') return { stdout: JSON.stringify([{ number: 9, title: 'KeepGreen: new end-to-end tests', url: 'p9', headRefName: 'keepgreen/explore-1-1', isDraft: false }, { number: 3, title: 'Other', url: 'p3', headRefName: 'feature', isDraft: false }]) };
    return {};
  });
  const s = status({ repo: 'o/r', run });
  assert.equal(s.problems, 1);
  assert.match(s.text, /✓ AI key secret: OPENROUTER_API_KEY/);
  assert.match(s.text, /✗ GitHub Actions may not open pull requests/);
  assert.match(s.text, /✓ passed {2}2026-11-17 19:00 UTC \(workflow_dispatch\) {2}u1/);
  assert.match(s.text, /none yet \(it runs when your tests fail\)/);
  assert.match(s.text, /#9 KeepGreen: new end-to-end tests {2}p9/);
  assert.doesNotMatch(s.text, /Other/);
});
