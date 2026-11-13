import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedProvider, Budget } from 'xsignon-autoheal';
import { testFileFor, uniqueTestFile, lookupPrice, explore, planFlows, cleanFlows, existingTitles, exploreReport } from '../dist/index.js';

function fakeEngine(pages = {}) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      const text = pages[new URL(args.url).pathname];
      return text ? { ok: true, isError: false, text, data: {} } : { ok: false, isError: true, text: 'net::ERR_CONNECTION_REFUSED', data: {} };
    },
    async close() {},
  };
}

const FLOWS = [
  { flow: 'A visitor searches for shoes and sees at least one result', why: 'search drives sales' },
  { flow: 'A user logs in and sees their name in the header', why: 'login' },
  { flow: 'a user logs in and sees their name in the header', why: 'duplicate' },
  { flow: 'short', why: 'too short' },
  { flow: 'A shopper adds an item to the cart and the cart count shows 1', why: 'cart' },
];

test('planning reads the pages and the existing tests, and keeps clean, distinct flows', async () => {
  const provider = new ScriptedProvider([{ calls: [{ name: 'propose_flows', input: { flows: FLOWS } }] }]);
  const engine = fakeEngine({ '/': 'button "Search"', '/login': 'textbox "Email"' });
  const flows = await planFlows({
    provider,
    engine,
    appUrl: 'http://localhost:3000',
    pages: ['/login', '/gone'],
    existing: ['tests/home.spec.ts: home page loads'],
    maxFlows: 2,
    budget: new Budget({ maxUsd: 1, maxTokens: 100000, maxSteps: 3 }, [4, 20]),
  });
  assert.deepEqual(flows.map((f) => f.flow), [FLOWS[0].flow, FLOWS[1].flow]);
  assert.deepEqual(engine.calls.map((c) => c.args.url), ['http://localhost:3000/', 'http://localhost:3000/login', 'http://localhost:3000/gone']);
  const sent = provider.requests[0].turns[0].parts[0].text;
  assert.match(sent, /home page loads/);
  assert.match(sent, /textbox "Email"/);
  assert.equal(provider.requests[0].tools[0].name, 'propose_flows');
});

test('planning nudges once when the AI answers in text, and fails when no page opens', async () => {
  const provider = new ScriptedProvider([{ text: 'Here are some ideas' }, { calls: [{ name: 'propose_flows', input: { flows: FLOWS.slice(0, 1) } }] }]);
  const base = { engine: fakeEngine({ '/': 'link "Home"' }), appUrl: 'http://localhost:3000', pages: [], existing: [], maxFlows: 3, budget: new Budget({ maxUsd: 1, maxTokens: 100000, maxSteps: 3 }, null) };
  assert.equal((await planFlows({ ...base, provider })).length, 1);
  await assert.rejects(planFlows({ ...base, provider: new ScriptedProvider([]), engine: fakeEngine({}) }), /Could not open any page/);
});

test('cleanFlows ignores junk', () => {
  assert.deepEqual(cleanFlows('nope', 3), []);
  assert.deepEqual(cleanFlows([null, 1, { flow: 'x'.repeat(600) }], 3), []);
});

test('explore writes one test per flow, shares the budget and reports', async () => {
  const provider = new ScriptedProvider([{ calls: [{ name: 'propose_flows', input: { flows: [FLOWS[0], FLOWS[1], FLOWS[4]] } }] }]);
  const seen = [];
  const cover = async (o) => {
    seen.push({ file: o.file, flow: o.flow, maxUsd: o.budget.limits.maxUsd, runs: o.runs, appUrl: o.appUrl, framework: o.framework });
    o.budget.record({ inputTokens: 50_000, outputTokens: 5_000 }); // $0.30 at [4, 20]
    if (o.flow.includes('cart')) throw new Error('browser crashed');
    return o.flow.includes('searches')
      ? { status: 'written', file: 'tests/autoheal-search.spec.ts', explanation: 'search', runs: 5, attempts: 1 }
      : { status: 'rejected', file: 'tests/autoheal-login.spec.ts', explanation: 'no real assertion', attempts: 4 };
  };
  const runner = fakeEngine({});
  const result = await explore({
    projectRoot: '/tmp/x',
    provider,
    engine: fakeEngine({ '/': 'button "Search"' }),
    runner,
    appUrl: 'http://localhost:3000',
    pages: [],
    existing: [],
    maxFlows: 3,
    maxUsd: 3,
    runs: 5,
    price: [4, 20],
    framework: 'playwright',
    cover,
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].file, 'tests/keepgreen-searches-shoes-one-result.spec.ts');
  assert.ok(seen[0].maxUsd > 0.9 && seen[0].maxUsd < 1, `first share ${seen[0].maxUsd}`);
  assert.ok(seen[1].maxUsd > seen[0].maxUsd, 'unspent money rolls over to later flows');
  assert.deepEqual(result.results.map((r) => r.result.status), ['written', 'rejected', 'error']);
  assert.ok(result.usd > 0.9 && result.usd < 1, String(result.usd));
  const report = exploreReport(result, 5);
  assert.match(report, /Wrote \*\*1\*\* new test\./);
  assert.match(report, /`tests\/autoheal-search\.spec\.ts`/);
  assert.match(report, /browser crashed/);
  assert.doesNotMatch(report, /autoheal-login\.spec\.ts`/);
});

test('dry run plans only', async () => {
  const provider = new ScriptedProvider([{ calls: [{ name: 'propose_flows', input: { flows: [FLOWS[0]] } }] }]);
  let called = false;
  const result = await explore({
    projectRoot: '/tmp/x', provider, engine: fakeEngine({ '/': 'x' }), runner: fakeEngine({}), appUrl: 'http://localhost:3000', pages: [], existing: [],
    maxFlows: 3, maxUsd: 3, runs: 5, price: null, framework: 'playwright', dryRun: true,
    cover: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.flows.length, 1);
  assert.match(exploreReport(result, 5), /dry run, nothing written/);
  assert.match(exploreReport(result, 5), /unknown/);
});

test('existing test titles are collected from spec and pytest files, skipping node_modules', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kg-titles-'));
  mkdirSync(path.join(root, 'tests'));
  mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  writeFileSync(path.join(root, 'tests/a.spec.ts'), "test('home page loads', async () => {});\ntest.only(\"search works\", () => {});\nit(`cart ${'x'}`, () => {})");
  writeFileSync(path.join(root, 'tests/test_login.py'), 'def test_login_works(page):\n    pass\n');
  writeFileSync(path.join(root, 'node_modules/x/b.spec.ts'), "test('hidden', () => {})");
  const titles = await existingTitles(root);
  assert.deepEqual(titles.sort(), ["tests/a.spec.ts: cart ${'x'}", 'tests/a.spec.ts: home page loads', 'tests/a.spec.ts: search works', 'tests/test_login.py: test_login_works']);
});

test('new test files are named after KeepGreen', () => {
  assert.equal(testFileFor('A user logs in', 'playwright'), 'tests/keepgreen-a-user-logs-in.spec.ts');
  assert.equal(testFileFor('A user logs in', 'pytest'), 'tests/test_keepgreen_a_user_logs_in.py');
  assert.equal(testFileFor('A user logs in', 'cypress'), 'cypress/e2e/keepgreen-a-user-logs-in.cy.ts');
});

test('file names skip filler words and never collide with each other or with files on disk', async () => {
  assert.equal(testFileFor('A visitor opens the home page, clicks the Account link and lands on /login', 'playwright'), 'tests/keepgreen-opens-home-clicks-account-link-lands.spec.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'kg-names-'));
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests/keepgreen-a-user-logs-in.spec.ts'), '');
  const taken = new Set();
  assert.equal(await uniqueTestFile('A user logs in', 'playwright', root, taken), 'tests/keepgreen-a-user-logs-in-2.spec.ts');
  assert.equal(await uniqueTestFile('A user logs in', 'playwright', root, taken), 'tests/keepgreen-a-user-logs-in-3.spec.ts');
  assert.equal(await uniqueTestFile('A user logs in', 'pytest', root, taken), 'tests/test_keepgreen_a_user_logs_in.py');
  assert.equal(await uniqueTestFile('A user logs in', 'pytest', root, taken), 'tests/test_keepgreen_a_user_logs_in_2.py');
  assert.equal(await uniqueTestFile('A user logs in', 'cypress', root, taken), 'cypress/e2e/keepgreen-a-user-logs-in.cy.ts');
  assert.equal(await uniqueTestFile('A user logs in', 'cypress', root, taken), 'cypress/e2e/keepgreen-a-user-logs-in-2.cy.ts');
});

test('flows you name skip planning; AI text in the report cannot ping anyone', async () => {
  const files = [];
  const result = await explore({
    projectRoot: mkdtempSync(path.join(os.tmpdir(), 'kg-given-')),
    provider: new ScriptedProvider([]), // planning would throw: no scripted answer
    engine: fakeEngine({}),
    runner: fakeEngine({}),
    appUrl: 'https://staging.example.com',
    pages: [],
    existing: [],
    maxFlows: 3,
    maxUsd: 3,
    runs: 5,
    price: [4, 20],
    framework: 'playwright',
    flows: ['A shopper adds the mug to the cart, ask @octocat', 'A shopper adds the mug to the cart, ask @octocat', 'tiny'],
    cover: async (o) => {
      files.push(o.file);
      return { status: 'written', file: o.file, explanation: 'ok', runs: 5, attempts: 1 };
    },
  });
  assert.equal(result.flows.length, 1, 'duplicates and junk are dropped');
  assert.equal(result.flows[0].why, 'named by you');
  assert.equal(files.length, 1);
  const report = exploreReport(result, 5);
  assert.doesNotMatch(report, /@octocat/);
  assert.match(report, /@​octocat/);
  await assert.rejects(explore({ projectRoot: '/tmp/x', provider: new ScriptedProvider([]), engine: fakeEngine({}), runner: fakeEngine({}), appUrl: 'http://localhost:3000', pages: [], existing: [], maxFlows: 3, maxUsd: 3, runs: 5, price: null, framework: 'playwright', flows: ['tiny'], cover: async () => ({}) }), /--flow/);
});

test('OpenRouter prices are looked up for models AutoHeal has no price for', async () => {
  const models = { data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000002', completion: '0.00001' } }] };
  const fetchFn = async (url) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
    return { ok: true, json: async () => models };
  };
  assert.deepEqual(await lookupPrice('anthropic/claude-sonnet-5.5', 'https://openrouter.ai/api/v1', { fetchFn }), [2, 10]);
  assert.equal(await lookupPrice('nope/model', 'https://openrouter.ai/api/v1', { fetchFn }), null);
  assert.equal(await lookupPrice('anthropic/claude-sonnet-5.5', 'http://localhost:11434/v1', { fetchFn: async () => { throw new Error('must not fetch'); } }), null);
  assert.equal(await lookupPrice('x', 'https://openrouter.ai/api/v1', { fetchFn: async () => { throw new Error('offline'); } }), null);
});
