import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  connectGithub,
  detectApp,
  detectPackageManager,
  detectProvider,
  exploreWorkflowText,
  githubReady,
  githubRepo,
  healWorkflowText,
  init,
  keyFromEnv,
  parseConfig,
  resolveConfig,
} from '../dist/index.js';
import { setupChecks } from '../dist/setup.js';

function project(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-setup-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('finds where the app runs: playwright webServer, baseURL, package.json scripts, Django, else a guess', () => {
  const web = project({ 'playwright.config.ts': "export default { webServer: { command: 'npm run start', port: 3100, reuseExistingServer: !process.env.CI } };" });
  assert.deepEqual(detectApp(web), { startCommand: 'npm run start', startUrl: 'http://localhost:3100', from: 'playwright.config webServer', webServerNeedsReuse: true });
  const reuse = project({ 'playwright.config.ts': "export default { webServer: { command: 'npm start', url: 'http://127.0.0.1:3000/', reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN } };" });
  assert.equal(detectApp(reuse).webServerNeedsReuse, false);
  assert.deepEqual(detectApp(project({ 'playwright.config.js': "module.exports = { use: { baseURL: 'https://staging.example.com' } };" })), { url: 'https://staging.example.com', from: 'playwright.config baseURL' });
  // A computed baseURL is not a URL we can use.
  assert.equal(detectApp(project({ 'playwright.config.ts': 'export default { use: { baseURL: `http://localhost:${port}` } };' })).from, 'a guess: set url in .keepgreen.yml');
  assert.deepEqual(detectApp(project({ 'package.json': '{"scripts":{"dev":"vite"}}' })), { startCommand: 'npm run dev', startUrl: 'http://localhost:5173', from: 'package.json script "dev"' });
  assert.equal(detectApp(project({ 'package.json': '{"scripts":{"start":"next start -p 4000"}}', 'yarn.lock': '' })).startCommand, 'yarn start');
  assert.equal(detectApp(project({ 'package.json': '{"scripts":{"start":"next start -p 4000"}}' })).startUrl, 'http://localhost:4000');
  assert.equal(detectApp(project({ 'package.json': '{"scripts":{"start":"ng serve"}}', 'pnpm-lock.yaml': '' })).startCommand, 'pnpm start');
  assert.equal(detectApp(project({ 'package.json': '{"scripts":{"start":"ng serve"}}' })).startUrl, 'http://localhost:4200');
  assert.equal(detectApp(project({ 'manage.py': '', 'requirements.txt': '' })).startCommand, 'python manage.py runserver 8000');
  assert.deepEqual(detectApp(project({})), { url: 'http://localhost:3000', from: 'a guess: set url in .keepgreen.yml' });
  assert.equal(detectPackageManager(project({ 'requirements.txt': '', 'conftest.py': '' })), 'pip');
});

test('picks the AI provider from the flag or the key in the environment', () => {
  assert.equal(detectProvider({}), 'anthropic');
  assert.equal(detectProvider({ OPENAI_API_KEY: 'x' }), 'openai');
  assert.equal(detectProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'anthropic');
  assert.equal(detectProvider({ ANTHROPIC_API_KEY: 'y', OPENROUTER_API_KEY: 'z' }), 'openrouter');
  assert.equal(detectProvider({ AUTOHEAL_BASE_URL: 'https://openrouter.ai/api/v1' }), 'openrouter');
  assert.equal(detectProvider({ OPENROUTER_API_KEY: 'z' }, 'OpenAI'), 'openai');
  assert.throws(() => detectProvider({}, 'gemini'), /anthropic, openai or openrouter/);
  assert.equal(keyFromEnv('openrouter', { AUTOHEAL_BASE_URL: 'https://openrouter.ai/api/v1', AUTOHEAL_API_KEY: ' sk-or ' }), 'sk-or');
  assert.equal(keyFromEnv('anthropic', {}), undefined);
});

test('init fills in the app, the provider and the installs, and the result is a valid config', async () => {
  const dir = project({ 'package.json': '{"scripts":{"dev":"vite --port 5000"}}', 'pnpm-lock.yaml': '' });
  const r = await init(dir, { provider: 'openrouter' });
  assert.equal(r.pm, 'pnpm');
  const config = resolveConfig(parseConfig(readFileSync(path.join(dir, '.keepgreen.yml'), 'utf8')), {});
  assert.equal(config.startCommand, 'pnpm dev');
  assert.equal(config.startUrl, 'http://localhost:5000');
  assert.equal(config.url, undefined);
  const wf = readFileSync(path.join(dir, '.github/workflows/keepgreen-explore.yml'), 'utf8');
  assert.match(wf, /base-url: https:\/\/openrouter\.ai\/api\/v1\n\s+api-key: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
  assert.match(wf, /model: \$\{\{ vars\.AUTOHEAL_MODEL \|\| 'anthropic\/claude-sonnet-5\.5' \}\}/);
  assert.doesNotMatch(wf, /anthropic-api-key/);
  assert.match(wf, /corepack enable && pnpm install --frozen-lockfile/);
  assert.doesNotMatch(wf, /run: npm ci/);
  // The explore job still gets no write access.
  const job = wf.slice(wf.indexOf('  explore:'), wf.indexOf('  publish:'));
  assert.doesNotMatch(job, /write/);

  const flags = await init(project({}), { target: { url: 'https://staging.example.com' }, dryRun: true });
  assert.deepEqual(flags.target, { url: 'https://staging.example.com', from: 'your flags' });
  const py = exploreWorkflowText(readFileSync(path.join(dir, '.github/workflows/keepgreen-explore.yml'), 'utf8'), { provider: 'anthropic', pm: 'pip' });
  assert.ok(py.length > 0);
  const fresh = await init(project({ 'requirements.txt': '' }), { dryRun: true });
  assert.equal(fresh.pm, 'pip');
});

test('the explore workflow for Anthropic, OpenAI and pip', async () => {
  const dir = project({});
  await init(dir);
  const base = readFileSync(path.join(dir, '.github/workflows/keepgreen-explore.yml'), 'utf8');
  assert.match(base, /anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(base, /run: npm ci/);
  const pip = await init(project({ 'requirements.txt': '', 'pytest.ini': '' }), { provider: 'openai', force: true });
  assert.equal(pip.pm, 'pip');
});

test('the heal workflow gets the same provider, the app start, and corepack for pnpm', () => {
  const heal = [
    '        run: |',
    '          pnpm install --frozen-lockfile',
    '          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}',
    '          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}',
    '          # model: <your OpenAI model>',
    '          # start-command: npm run start',
    '          # start-url: http://localhost:3000',
    '',
  ].join('\n');
  const out = healWorkflowText(heal, { provider: 'openrouter', target: { startCommand: 'pnpm dev', startUrl: 'http://localhost:5173', from: 'x' } });
  assert.match(out, /corepack enable && pnpm install --frozen-lockfile/);
  assert.match(out, / {10}api-key: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
  assert.match(out, / {10}start-command: pnpm dev\n {10}start-url: http:\/\/localhost:5173/);
  assert.doesNotMatch(out, /anthropic-api-key/);
  const plain = healWorkflowText(heal, { provider: 'anthropic', target: { url: 'http://localhost:3000', from: 'x' } });
  assert.match(plain, /anthropic-api-key/);
  assert.match(plain, /# start-command: npm run start/);
});

test('only the problems from AutoHeal\'s checks are shown', () => {
  const output = 'AutoHeal\n\nChecks:\n✓ Test workflow: "T"\n✗ no JSON report\n    → add a reporter\n! no traces\n    → add trace\n✓ fine\n\nOnly you can do these:\n  1. add the secret\n';
  assert.deepEqual(setupChecks(output), ['✗ no JSON report', '    → add a reporter', '! no traces', '    → add trace']);
  assert.deepEqual(setupChecks('nothing'), []);
});

test('GitHub setup through gh: the key goes on stdin, Actions may open PRs, failures say where to click', () => {
  assert.equal(githubRepo('git@github.com:acme/shop.git\n'), 'acme/shop');
  assert.equal(githubRepo('https://github.com/acme/shop'), 'acme/shop');
  assert.equal(githubRepo('https://gitlab.com/acme/shop.git'), undefined);

  const calls = [];
  const fake = (responses) => (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, res] of responses) if (pattern.test(key)) return { stdout: '', stderr: '', ...res };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(githubReady('/x', fake([[/^git /, { status: 0, stdout: 'https://github.com/acme/shop.git\n' }], [/^gh auth/, { status: 127 }]])).why, 'the GitHub CLI (gh) is not installed: https://cli.github.com');
  assert.deepEqual(githubReady('/x', fake([[/^git /, { status: 0, stdout: 'https://github.com/acme/shop.git\n' }]])), { repo: 'acme/shop' });

  calls.length = 0;
  const steps = connectGithub({
    repo: 'acme/shop',
    provider: 'openrouter',
    env: { OPENROUTER_API_KEY: 'sk-or-secret', AUTOHEAL_MODEL: 'openai/gpt-x' },
    interactive: false,
    run: fake([[/^gh api repos\/acme\/shop\/actions\/permissions\/workflow$/, { status: 0, stdout: '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}' }]]),
  });
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true]);
  const secret = calls.find((c) => c.args[0] === 'secret');
  assert.deepEqual(secret.args, ['secret', 'set', 'OPENROUTER_API_KEY', '--repo', 'acme/shop']);
  assert.equal(secret.input, 'sk-or-secret');
  assert.ok(!calls.some((c) => c.args.includes('sk-or-secret')), 'the key is never a command-line argument');
  const put = calls.find((c) => c.args.includes('PUT'));
  assert.ok(put.args.includes('default_workflow_permissions=read'), 'keeps the read-only default');
  assert.ok(put.args.includes('can_approve_pull_request_reviews=true'));
  assert.ok(!JSON.stringify(steps).includes('sk-or-secret'));

  const denied = connectGithub({
    repo: 'acme/shop',
    provider: 'anthropic',
    env: {},
    interactive: false,
    run: fake([[/permissions\/workflow$/, { status: 0, stdout: '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":false}' }], [/-X PUT/, { status: 1 }]]),
  });
  assert.equal(denied[0].ok, false);
  assert.match(denied[0].fix, /settings\/secrets\/actions\/new/);
  assert.equal(denied[1].ok, false);
  assert.match(denied[1].fix, /settings\/actions/);
});
