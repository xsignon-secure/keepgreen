import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedProvider } from 'xsignon-autoheal';
import { ConfigFileError, explore, parseConfig, resolveConfig } from '../dist/index.js';

const FILE = `url: http://localhost:3000
login-url: /login
login-steps:
  - fill getByLabel('Email') = {{env:E2E_USER}}
  - fill getByLabel('Password') = {{env:E2E_PASSWORD}}
  - click getByRole('button', { name: 'Sign in' })
login-check: getByRole('button', { name: 'Sign out' })
pages:
  - /orders
`;

test('.keepgreen.yml: login steps are a list, and the login block becomes one setting', () => {
  const c = resolveConfig(parseConfig(FILE), {});
  assert.deepEqual(c.pages, ['/orders']);
  assert.deepEqual(c.login, {
    session: 'playwright/.auth/user.json',
    url: '/login',
    steps: ["fill getByLabel('Email') = {{env:E2E_USER}}", "fill getByLabel('Password') = {{env:E2E_PASSWORD}}", "click getByRole('button', { name: 'Sign in' })"],
    check: "getByRole('button', { name: 'Sign out' })",
  });
  // Flags win: --login-step replaces the file's steps; --session alone reuses a file.
  assert.deepEqual(resolveConfig(parseConfig(FILE), { 'login-step': ['click text=Go'] }).login.steps, ['click text=Go']);
  assert.deepEqual(resolveConfig({}, { session: 'auth/admin.json' }).login, { session: 'auth/admin.json' });
  assert.equal(resolveConfig({}, {}).login, undefined);
  assert.throws(() => resolveConfig(parseConfig('login-check: x\n'), {}), ConfigFileError);
  assert.throws(() => parseConfig('  - stray\n'), /pages:" or "login-steps:/);
});

test('explore with a session: planning sees signed-in pages and every test gets the session', async () => {
  const calls = [];
  const engine = {
    async call(name, args) {
      calls.push({ name, args });
      return { ok: true, isError: false, text: 'button "Orders"', data: {} };
    },
    async close() {},
  };
  const provider = new ScriptedProvider([{ calls: [{ name: 'propose_flows', input: { flows: [{ flow: 'A customer opens Orders and sees their past orders', why: 'orders' }] } }] }]);
  const seen = [];
  await explore({
    projectRoot: '/tmp/x',
    provider,
    engine,
    runner: engine,
    appUrl: 'http://localhost:3000',
    pages: ['/orders'],
    existing: [],
    maxFlows: 3,
    maxUsd: 3,
    runs: 5,
    price: [4, 20],
    framework: 'playwright',
    session: 'playwright/.auth/user.json',
    cover: async (o) => {
      seen.push(o.session);
      return { status: 'written', file: o.file, explanation: 'x', runs: 5, attempts: 1 };
    },
  });
  assert.deepEqual(calls.map((c) => c.args.storageState), ['playwright/.auth/user.json', 'playwright/.auth/user.json']);
  assert.deepEqual(seen, ['playwright/.auth/user.json']);
  assert.match(JSON.stringify(provider.requests[0]), /signed-in user/);
});
