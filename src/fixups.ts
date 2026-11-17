/**
 * `keepgreen init` edits the few lines of your own setup that KeepGreen and
 * AutoHeal need, instead of printing them as homework:
 *
 *  - playwright.config: a JSON report (AutoHeal reads it), traces on failure
 *    (screenshots, the runtime guard, fingerprint fixes) and, when it starts
 *    the app itself, `reuseExistingServer` that also reuses the app KeepGreen
 *    started.
 *  - the test workflow: `workflow_dispatch` (so CI runs on AutoHeal's fix PRs)
 *    and an upload of the report and traces when the tests fail.
 *
 * Each edit is small and textual, is made only when the pattern is one we
 * understand, and is listed in init's summary so it can be reviewed in the
 * diff. Anything we cannot edit safely is left alone and reported as before.
 * `--no-fix` turns all of it off.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileFix {
  /** Path relative to the project. */
  file: string;
  /** One short line per change, for the summary. */
  changes: string[];
  text: string;
}

const PW_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.mts', 'playwright.config.cjs'];
const JSON_REPORTER = "['json', { outputFile: 'playwright-report/results.json' }]";
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Index just past the `{` that opens the config object, or -1. */
function configStart(text: string): number {
  const m = /defineConfig\(\s*\{/.exec(text) ?? /export\s+default\s+\{/.exec(text) ?? /module\.exports\s*=\s*\{/.exec(text);
  return m ? m.index + m[0].length : -1;
}

/** Index of the `}` matching the `{` just before `from` (strings and comments are not parsed: good enough for config objects). */
function closeBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `]` matching the `[` at `from - 1`. */
function closeBracket(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** The indentation used for the config's top-level keys. */
function keyIndent(text: string, start: number): string {
  return /\n([ \t]+)\S/.exec(text.slice(start))?.[1] ?? '  ';
}

/** The edits playwright.config needs, applied to its text. */
export function fixPlaywrightConfigText(text: string, options: { webServerReuse?: boolean } = {}): { text: string; changes: string[] } {
  let out = text;
  const changes: string[] = [];
  const start = configStart(out);
  if (start < 0) return { text, changes };
  const pad = keyIndent(out, start);

  // 1. A JSON (or blob) report.
  if (!/['"](?:json|blob)['"]/.test(out)) {
    const str = /(\breporter\s*:\s*)(['"])([\w-]+)\2/.exec(out);
    const arr = /(\breporter\s*:\s*)\[(\s*)\[/.exec(out);
    if (str) {
      out = `${out.slice(0, str.index)}${str[1]}[[${str[2]}${str[3]}${str[2]}], ${JSON_REPORTER}]${out.slice(str.index + str[0].length)}`;
      changes.push('added a JSON report next to your reporter');
    } else if (arr) {
      // Last in the list: the html reporter empties playwright-report/ when it starts writing.
      const open = arr.index + arr[0].length - 1 - (arr[2] ?? "").length - 1;
      const close = closeBracket(out, open + 1);
      if (close > 0) {
        const before = out.slice(0, close).replace(/[\s,]*$/, '');
        const tail = out.slice(before.length, close);
        const multiline = tail.includes('\n');
        const itemPad = multiline ? (/\n([ \t]*)\[[^\n]*$/.exec(before)?.[1] ?? `${pad}  `) : '';
        out = `${before},${multiline ? `\n${itemPad}` : ' '}${JSON_REPORTER}${multiline ? ',' : ''}${tail.replace(/^,/, '')}${out.slice(close)}`;
        changes.push('added a JSON report next to your reporters');
      }
    } else if (!/\breporter\s*:/.test(out)) {
      const s = configStart(out);
      out = `${out.slice(0, s)}\n${pad}reporter: [['list'], ${JSON_REPORTER}],${out.slice(s)}`;
      changes.push('added a JSON report');
    }
  }

  // 2. Traces on failure (any trace setting the user made is kept).
  if (!/\btrace\s*:/.test(out)) {
    const use = /(\n([ \t]*)use\s*:\s*\{)/.exec(out);
    if (use) {
      const inner = `${use[2]}  `;
      const at = use.index + use[0].length;
      const oneLine = !/^\s*\n/.test(out.slice(at));
      out = oneLine ? `${out.slice(0, at)} trace: 'retain-on-failure',${out.slice(at)}` : `${out.slice(0, at)}\n${inner}trace: 'retain-on-failure',${out.slice(at)}`;
    } else {
      const s = configStart(out);
      out = `${out.slice(0, s)}\n${pad}use: { trace: 'retain-on-failure' },${out.slice(s)}`;
    }
    changes.push("kept traces on failure (trace: 'retain-on-failure')");
  }

  // 3. Let Playwright reuse the app KeepGreen started.
  if (options.webServerReuse !== false) {
    const ws = /\bwebServer\s*:\s*\{/.exec(out);
    if (ws) {
      const open = ws.index + ws[0].length;
      const close = closeBrace(out, open);
      const block = close > 0 ? out.slice(open, close) : '';
      if (close > 0 && !/KEEPGREEN/.test(block)) {
        const reuse = /(\breuseExistingServer\s*:\s*)([^,\n}]+?)(\s*)(,|\n|$)/.exec(block);
        if (reuse && reuse[2]?.trim() !== 'true') {
          const expr = (reuse[2] ?? "").trim();
          const value = expr === 'false' ? '!!process.env.KEEPGREEN' : `${/^[\w.!]+$/.test(expr) ? expr : `(${expr})`} || !!process.env.KEEPGREEN`;
          const at = open + reuse.index;
          out = `${out.slice(0, at)}${reuse[1]}${value}${reuse[3]}${reuse[4]}${out.slice(at + reuse[0].length)}`;
          changes.push('webServer reuses the app KeepGreen starts (reuseExistingServer ... || !!process.env.KEEPGREEN)');
        } else if (!reuse) {
          out = `${out.slice(0, open)} reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN,${out.slice(open)}`;
          changes.push('webServer reuses a running app locally and the app KeepGreen starts');
        }
      }
    }
  }
  return { text: out, changes };
}

/** The edits the test workflow needs, applied to its text. */
export function fixTestWorkflowText(text: string): { text: string; changes: string[] } {
  let out = text;
  const changes: string[] = [];

  // 1. workflow_dispatch, so AutoHeal's publish job can start CI on its PR.
  if (!/\bworkflow_dispatch\b/.test(out)) {
    const block = /^(on|"on"|'on'):[ \t]*(#.*)?\n([ \t]+)\S/m.exec(out);
    const list = /^((?:on|"on"|'on'):[ \t]*\[)([^\]\n]*)\]/m.exec(out);
    const single = /^((?:on|"on"|'on'):[ \t]*)([a-z_]+)[ \t]*$/m.exec(out);
    if (block) {
      const at = block.index + block[0].length - (block[3] ?? "").length - 1;
      out = `${out.slice(0, at)}${block[3]}# AutoHeal starts this workflow on its fix PRs.\n${block[3]}workflow_dispatch:\n${out.slice(at)}`;
      changes.push('added workflow_dispatch (CI runs on AutoHeal\'s fix PRs)');
    } else if (list) {
      out = `${out.slice(0, list.index)}${list[1]}${(list[2] ?? "").trim()}, workflow_dispatch]${out.slice(list.index + list[0].length)}`;
      changes.push('added workflow_dispatch (CI runs on AutoHeal\'s fix PRs)');
    } else if (single) {
      out = `${out.slice(0, single.index)}${single[1]}[${single[2]}, workflow_dispatch]${out.slice(single.index + single[0].length)}`;
      changes.push('added workflow_dispatch (CI runs on AutoHeal\'s fix PRs)');
    }
  }

  // 2. Upload the report and traces when the tests fail, right after the test step.
  if (!/upload-artifact/.test(out)) {
    const lines = out.split('\n');
    const runAt = lines.findIndex((l) => /playwright test/.test(l) && !/^\s*#/.test(l));
    if (runAt >= 0) {
      // The step that contains it starts at the nearest "- " line above with less or equal indent.
      let stepAt = runAt;
      while (stepAt >= 0 && !/^\s*-\s/.test(lines[stepAt] ?? '')) stepAt--;
      const dash = stepAt >= 0 ? /^(\s*)-\s/.exec(lines[stepAt] ?? '') : null;
      if (dash) {
        const indent = dash[1] ?? '';
        let end = stepAt + 1;
        while (end < lines.length) {
          const l = lines[end] ?? '';
          if (l.trim() && !l.trim().startsWith('#')) {
            const ind = /^(\s*)/.exec(l)?.[1]?.length ?? 0;
            if (ind <= indent.length) break;
          }
          end++;
        }
        while (end > stepAt + 1 && !(lines[end - 1] ?? '').trim()) end--;
        const step = [
          `${indent}# AutoHeal reads the report and traces when the tests fail.`,
          `${indent}- uses: ${UPLOAD}`,
          `${indent}  if: failure()`,
          `${indent}  with:`,
          `${indent}    name: playwright-results`,
          `${indent}    path: |`,
          `${indent}      playwright-report/`,
          `${indent}      test-results/`,
        ];
        lines.splice(end, 0, ...step);
        out = lines.join('\n');
        changes.push('uploads playwright-report/ and test-results/ when the tests fail');
      }
    }
  }
  return { text: out, changes };
}

/** The workflow that runs `playwright test` (not KeepGreen's or AutoHeal's own). */
export function findTestWorkflowFile(root: string): string | undefined {
  const dir = path.join(root, '.github', 'workflows');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && !/^(autoheal|keepgreen)/.test(n));
  } catch {
    return undefined;
  }
  return names.sort().find((n) => /playwright test/.test(read(path.join(dir, n))));
}

/** Plans (and unless dryRun, makes) the edits. Only Playwright Test projects are edited. */
export async function fixProject(root: string, options: { dryRun?: boolean; webServerReuse?: boolean } = {}): Promise<FileFix[]> {
  const fixes: FileFix[] = [];
  const config = PW_CONFIGS.find((n) => read(path.join(root, n)));
  if (config) {
    const before = read(path.join(root, config));
    const r = fixPlaywrightConfigText(before, options);
    if (r.changes.length && r.text !== before) fixes.push({ file: config, changes: r.changes, text: r.text });
  }
  const wf = config ? findTestWorkflowFile(root) : undefined;
  if (wf) {
    const rel = path.posix.join('.github', 'workflows', wf);
    const before = read(path.join(root, rel));
    const r = fixTestWorkflowText(before);
    if (r.changes.length && r.text !== before) fixes.push({ file: rel, changes: r.changes, text: r.text });
  }
  if (!options.dryRun) for (const f of fixes) await writeFile(path.join(root, f.file), f.text);
  return fixes;
}
