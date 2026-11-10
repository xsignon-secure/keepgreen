import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addFilePatch, newFilesPatch, checkPatch } from '../dist/index.js';

const spec = "import { test, expect } from '@playwright/test';\n\ntest('x', async ({ page }) => {\n  await expect(page).toHaveURL('/');\n});\n";

test('a new-file patch passes the check', () => {
  const p = addFilePatch('tests/keepgreen-a.spec.ts', spec) + addFilePatch('tests/test_login.py', 'def test_login():\n    assert True');
  const r = checkPatch(p);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.files, ['tests/keepgreen-a.spec.ts', 'tests/test_login.py']);
});

test('the patch applies with git, with and without a final newline', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-patch-'));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(dir, 'tests'));
  const src = mkdtempSync(path.join(os.tmpdir(), 'kg-src-'));
  mkdirSync(path.join(src, 'tests'));
  writeFileSync(path.join(src, 'tests/a.spec.ts'), spec);
  writeFileSync(path.join(src, 'tests/b.spec.ts'), 'no newline');
  return newFilesPatch(src, ['tests/b.spec.ts', 'tests/a.spec.ts', '../outside.spec.ts']).then((p) => {
    writeFileSync(path.join(dir, 'p.patch'), p);
    git('apply', '--check', 'p.patch');
    git('apply', 'p.patch');
    assert.equal(readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'), spec);
    assert.equal(readFileSync(path.join(dir, 'tests/b.spec.ts'), 'utf8'), 'no newline');
    assert.equal(checkPatch(p).files.length, 2);
  });
});

test('anything but adding test files is refused', () => {
  const modify = `diff --git a/tests/a.spec.ts b/tests/a.spec.ts\nindex 1..2 100644\n--- a/tests/a.spec.ts\n+++ b/tests/a.spec.ts\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.match(checkPatch(modify).problems.join(), /existing file/);
  const del = `diff --git a/tests/a.spec.ts b/tests/a.spec.ts\ndeleted file mode 100644\n--- a/tests/a.spec.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`;
  assert.equal(checkPatch(del).ok, false);
  for (const bad of ['.github/workflows/x.spec.ts', 'tests/../package.json', 'package.json', 'node_modules/x/a.spec.ts', 'tests/.hidden/a.spec.ts', '/etc/a.spec.ts']) {
    assert.equal(checkPatch(addFilePatch(bad, 'x\n')).ok, false, bad);
  }
  const exec = addFilePatch('tests/a.spec.ts', 'x\n').replace('new file mode 100644', 'new file mode 100755');
  assert.equal(checkPatch(exec).ok, false);
  const binary = `diff --git a/tests/a.spec.ts b/tests/a.spec.ts\nnew file mode 100644\n--- /dev/null\n+++ b/tests/a.spec.ts\nGIT binary patch\nliteral 1\n`;
  assert.equal(checkPatch(binary).ok, false);
  assert.equal(checkPatch('').ok, false);
  assert.equal(checkPatch('rm -rf /').ok, false);
  assert.equal(checkPatch(addFilePatch('tests/a.spec.ts', 'x\n').repeat(2)).ok, false);
});
