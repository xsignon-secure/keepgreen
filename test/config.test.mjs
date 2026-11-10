import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, resolveConfig, ConfigFileError, DEFAULTS } from '../dist/index.js';

test('parses the template-style file with comments and a pages list', () => {
  const file = parseConfig(`# top comment
url: "http://localhost:3000" # where it runs
start-command: npm run dev
pages:
  - /login
  - '/pricing'
max-flows: 4
`);
  assert.deepEqual(file, { url: 'http://localhost:3000', 'start-command': 'npm run dev', pages: ['/login', '/pricing'], 'max-flows': '4' });
});

test('a # inside quotes is not a comment', () => {
  assert.equal(parseConfig(`start-command: "npm run dev -- --tag '#1'"`)['start-command'], "npm run dev -- --tag '#1'");
});

test('unknown keys and stray list items are errors', () => {
  assert.throws(() => parseConfig('colour: green'), ConfigFileError);
  assert.throws(() => parseConfig('  - /login'), ConfigFileError);
  assert.throws(() => parseConfig('pages: /login'), ConfigFileError);
});

test('defaults, then file, then flags', () => {
  assert.deepEqual(resolveConfig({}, {}), DEFAULTS);
  const c = resolveConfig({ 'max-flows': '4', url: 'http://a', pages: ['/x'] }, { 'max-flows': '2', pages: '/y, /z' });
  assert.equal(c.maxFlows, 2);
  assert.equal(c.url, 'http://a');
  assert.deepEqual(c.pages, ['/y', '/z']);
});

test('values are range-checked', () => {
  assert.throws(() => resolveConfig({ 'max-flows': '0' }, {}), /max-flows/);
  assert.throws(() => resolveConfig({ runs: '2.5' }, {}), /runs/);
  assert.throws(() => resolveConfig({ 'max-usd': 'lots' }, {}), /max-usd/);
  assert.throws(() => resolveConfig({ pages: ['https://evil.example'] }, {}), /paths/);
  assert.throws(() => resolveConfig({ pages: ['//evil.example'] }, {}), /paths/);
});
