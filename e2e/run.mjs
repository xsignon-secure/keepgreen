// End-to-end check of `keepgreen explore` against a real app and a real
// browser, with a scripted AI (no key, no network). It proves the whole
// chain: start the app, inspect it with the engine, plan, write a test with
// AutoHeal's cover, run it 3 times, keep it, and hand it off as a patch that
// passes check-patch and applies with git.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const work = mkdtempSync(path.join(os.tmpdir(), 'kg-e2e-'));
cpSync(path.join(here, 'fixture'), work, { recursive: true, filter: (src) => !src.includes('node_modules') });
symlinkSync(path.join(here, 'fixture', 'node_modules'), path.join(work, 'node_modules'), 'dir');
const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd: work, encoding: 'utf8' });
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'fixture');

const flow = "A visitor searches for 'shoes' from the home page and sees 2 results";
const spec = `import { test, expect } from '@playwright/test';

test('search for shoes shows two results', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search').fill('shoes');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\\/search\\?q=shoes/);
  await expect(page.getByRole('status')).toHaveText('2 result(s)');
  await expect(page.getByRole('listitem')).toHaveCount(2);
});
`;
const script = [
  { calls: [{ name: 'propose_flows', input: { flows: [{ flow, why: 'search drives sales' }, { flow: 'A visitor opens a missing page and sees Not found', why: 'error page' }] } }] },
  { calls: [{ name: 'inspect_page', input: { url: '/' } }] },
  { calls: [{ name: 'write_test', input: { content: spec, explanation: 'Searches for shoes and checks the two results.' } }] },
  { calls: [{ name: 'give_up', input: { reason: 'Skipping the error page in this check.' } }] },
];
writeFileSync(path.join(work, 'script.json'), JSON.stringify(script));
writeFileSync(path.join(work, '.keepgreen.yml'), 'start-command: node server.mjs\nstart-url: http://127.0.0.1:4173\nmax-flows: 2\nruns: 3\n');

const r = spawnSync(process.execPath, [cli, 'explore', '--out', 'keepgreen-out'], {
  cwd: work,
  encoding: 'utf8',
  env: { ...process.env, AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(work, 'script.json'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
  timeout: 600_000,
});
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);

const fail = (msg) => {
  console.error(`\nE2E FAILED: ${msg}\n(work dir: ${work})`);
  process.exit(1);
};
if (r.status !== 0) fail(`explore exited ${r.status}`);
const summary = JSON.parse(readFileSync(path.join(work, 'keepgreen-out', 'summary.json'), 'utf8'));
if (summary.written.length !== 1) fail(`expected 1 kept test, got ${JSON.stringify(summary.written)}`);
const file = summary.written[0];
if (!existsSync(path.join(work, file))) fail(`${file} was not written`);
const report = readFileSync(path.join(work, 'keepgreen-out', 'report.md'), 'utf8');
if (!report.includes('Wrote **1** new test') || !report.includes('gave-up')) fail('report does not show one kept and one given-up flow');

const check = spawnSync(process.execPath, [cli, 'check-patch', path.join(work, 'keepgreen-out', 'new-tests.patch')], { encoding: 'utf8' });
if (check.status !== 0 || check.stdout.trim() !== file) fail(`check-patch refused the patch: ${check.stderr}`);
// The publish job's view: a clean checkout plus the patch.
const patchCopy = path.join(mkdtempSync(path.join(os.tmpdir(), 'kg-patch-')), 'new-tests.patch');
cpSync(path.join(work, 'keepgreen-out', 'new-tests.patch'), patchCopy);
git('stash', '-u', '-q');
git('apply', '--check', patchCopy);
git('apply', patchCopy);
if (readFileSync(path.join(work, file), 'utf8') !== spec) fail('the applied patch does not match the kept test');
console.log(`\nE2E OK: kept ${file}, patch accepted.`);
