/**
 * The GitHub side of everyday use, through the gh CLI, so nobody has to click
 * through the web UI:
 *
 *  - openSetupPr: commits only the files init wrote or edited to a new branch
 *    and opens a pull request ("Add KeepGreen").
 *  - runExplore: starts the explore workflow (`keepgreen run`) and returns the
 *    link to the run.
 *  - status: is the key there, may Actions open PRs, the latest explore and
 *    heal runs, and the open KeepGreen / AutoHeal pull requests.
 */

import { SECRET_NAME, runCommand, type Provider, type Run } from './setup.js';

export const EXPLORE_WORKFLOW_FILE = 'keepgreen-explore.yml';
export const HEAL_WORKFLOW_FILE = 'autoheal.yml';

const ok = (r: { status: number | null }) => r.status === 0;
const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).pop() ?? '';

export interface SetupPr {
  ok: boolean;
  branch?: string;
  url?: string;
  /** Why it did not work, and what to do instead. */
  why?: string;
}

/** Commits `files` (and nothing else) on a new branch, pushes it and opens a PR. */
export function openSetupPr(options: { root: string; repo: string; files: string[]; body: string; run?: Run }): SetupPr {
  const run = options.run ?? runCommand;
  const git = (...args: string[]) => run('git', ['-C', options.root, ...args]);
  const files = [...new Set(options.files)];
  if (!files.length) return { ok: false, why: 'nothing to commit' };
  let branch = 'keepgreen/setup';
  for (let n = 2; ok(git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)); n++) branch = `keepgreen/setup-${n}`;
  const base = run('gh', ['repo', 'view', options.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
  const baseBranch = ok(base) ? base.stdout.trim() : '';
  const steps: Array<[string[], string]> = [
    [['switch', '-c', branch], 'create the branch'],
    [['add', '--', ...files], 'stage the files'],
    // `--` with paths commits only these files, even if other changes are staged.
    [['commit', '-m', 'Add KeepGreen: explore and heal workflows', '--', ...files], 'commit'],
    [['push', '-u', 'origin', branch], 'push'],
  ];
  for (const [args, what] of steps) {
    const r = git(...args);
    if (!ok(r)) return { ok: false, branch, why: `git could not ${what}: ${firstLine(r.stderr || r.stdout)}` };
  }
  const pr = run('gh', ['pr', 'create', '--repo', options.repo, '--head', branch, ...(baseBranch ? ['--base', baseBranch] : []), '--title', 'Add KeepGreen', '--body-file', '-'], options.body);
  if (!ok(pr)) return { ok: false, branch, why: `branch ${branch} is pushed, but gh could not open the PR: ${firstLine(pr.stderr)}` };
  return { ok: true, branch, url: firstLine(pr.stdout) };
}

export function setupPrBody(changes: string[], provider: Provider): string {
  return [
    'Sets up [KeepGreen](https://github.com/xsignon-secure/keepgreen): an AI test agent that runs in your own GitHub Actions with your own AI key.',
    '',
    '- **KeepGreen explore** (`.github/workflows/keepgreen-explore.yml`): run it from Actions, or `npx keepgreen run`, and it opens one PR with new end-to-end tests that passed every run.',
    '- **AutoHeal** (`.github/workflows/autoheal.yml`): when your tests fail, it opens a draft PR that fixes the broken tests.',
    '',
    'Files:',
    ...changes.map((c) => `- ${c}`),
    '',
    `The AI key is the repository secret \`${SECRET_NAME[provider]}\`. After merging, start the first run with \`npx keepgreen run\` or from the Actions tab.`,
    '',
    '_Opened by `npx keepgreen init`._',
  ].join('\n');
}

export interface RunStarted {
  ok: boolean;
  url?: string;
  id?: string;
  why?: string;
}

/** Starts the explore workflow on the default branch. */
export function runExplore(options: { repo: string; url?: string; flows?: string[]; maxFlows?: string; ref?: string; run?: Run; now?: () => number; sleep?: (ms: number) => void }): RunStarted {
  const run = options.run ?? runCommand;
  const args = ['workflow', 'run', EXPLORE_WORKFLOW_FILE, '--repo', options.repo];
  if (options.ref) args.push('--ref', options.ref);
  if (options.url) args.push('-f', `url=${options.url}`);
  if (options.maxFlows) args.push('-f', `max-flows=${options.maxFlows}`);
  if (options.flows?.length) args.push('-f', `flows=${options.flows.join(';')}`);
  const started = (options.now ?? Date.now)();
  const r = run('gh', args);
  if (!ok(r)) {
    const err = `${r.stderr}${r.stdout}`;
    if (/could not find any workflows|not found|404/i.test(err)) {
      return { ok: false, why: `${EXPLORE_WORKFLOW_FILE} is not on the default branch of ${options.repo} yet. Merge the "Add KeepGreen" PR (or push the file), then run this again.` };
    }
    if (/workflow_dispatch/i.test(err)) return { ok: false, why: `${EXPLORE_WORKFLOW_FILE} has no workflow_dispatch trigger. Run \`npx keepgreen init --force\` to rewrite it.` };
    return { ok: false, why: `gh could not start the workflow: ${firstLine(err)}` };
  }
  // gh prints no run id; the new run shows up in the list within a few seconds.
  const sleep = options.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let i = 0; i < 10; i++) {
    const list = run('gh', ['run', 'list', '--repo', options.repo, '--workflow', EXPLORE_WORKFLOW_FILE, '--event', 'workflow_dispatch', '--limit', '1', '--json', 'databaseId,url,createdAt']);
    try {
      const [latest] = JSON.parse(list.stdout || '[]') as Array<{ databaseId: number; url: string; createdAt: string }>;
      if (latest && Date.parse(latest.createdAt) >= started - 60_000) return { ok: true, url: latest.url, id: String(latest.databaseId) };
    } catch {
      // try again
    }
    sleep(1500);
  }
  return { ok: true, url: `https://github.com/${options.repo}/actions/workflows/${EXPLORE_WORKFLOW_FILE}` };
}

/** The pull request a finished explore run opened, if any. */
export function explorePr(repo: string, runId: string, run: Run = runCommand): string | undefined {
  const r = run('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--search', `head:keepgreen/explore-${runId}`, '--json', 'url,headRefName']);
  try {
    return (JSON.parse(r.stdout || '[]') as Array<{ url: string; headRefName: string }>).find((p) => p.headRefName.startsWith(`keepgreen/explore-${runId}-`))?.url;
  } catch {
    return undefined;
  }
}

interface RunInfo {
  status: string;
  conclusion: string;
  createdAt: string;
  url: string;
  event: string;
}

function describeRun(r: RunInfo): string {
  const state = r.status === 'completed' ? (r.conclusion === 'success' ? '✓ passed' : r.conclusion === 'skipped' ? '- skipped' : `✗ ${r.conclusion}`) : `… ${r.status.replace('_', ' ')}`;
  return `${state}  ${r.createdAt.slice(0, 16).replace('T', ' ')} UTC (${r.event})  ${r.url}`;
}

/** A plain-text status report for `keepgreen status`. */
export function status(options: { repo: string; provider?: Provider; run?: Run }): { text: string; problems: number } {
  const run = options.run ?? runCommand;
  const { repo } = options;
  const web = `https://github.com/${repo}`;
  const out: string[] = [`KeepGreen in ${repo}`, ''];
  let problems = 0;

  const secrets = run('gh', ['secret', 'list', '--repo', repo, '--json', 'name']);
  if (ok(secrets)) {
    let names: string[] = [];
    try {
      names = (JSON.parse(secrets.stdout || '[]') as Array<{ name: string }>).map((s) => s.name);
    } catch {
      // shown as missing
    }
    const wanted = options.provider ? [SECRET_NAME[options.provider]] : Object.values(SECRET_NAME);
    const found = wanted.filter((n) => names.includes(n));
    if (found.length) out.push(`  ✓ AI key secret: ${found.join(', ')}`);
    else {
      problems++;
      out.push(`  ✗ no AI key secret (${wanted.join(' or ')}): npx keepgreen init --github, or ${web}/settings/secrets/actions/new`);
    }
  } else out.push('  ? could not list the secrets (you may need admin rights)');

  const perms = run('gh', ['api', `repos/${repo}/actions/permissions/workflow`]);
  try {
    const p = JSON.parse(perms.stdout || '{}') as { can_approve_pull_request_reviews?: boolean };
    if (!ok(perms)) out.push('  ? could not read the Actions settings');
    else if (p.can_approve_pull_request_reviews) out.push('  ✓ GitHub Actions may open pull requests');
    else {
      problems++;
      out.push(`  ✗ GitHub Actions may not open pull requests: npx keepgreen init --github, or ${web}/settings/actions`);
    }
  } catch {
    out.push('  ? could not read the Actions settings');
  }

  for (const [label, file] of [
    ['Explore runs', EXPLORE_WORKFLOW_FILE],
    ['Heal runs', HEAL_WORKFLOW_FILE],
  ] as const) {
    const r = run('gh', ['run', 'list', '--repo', repo, '--workflow', file, '--limit', '3', '--json', 'status,conclusion,createdAt,url,event']);
    out.push('', `  ${label} (${file}):`);
    if (!ok(r)) {
      out.push(/not found|could not find/i.test(r.stderr) ? '    not on the default branch yet: merge the "Add KeepGreen" PR' : `    could not list: ${firstLine(r.stderr)}`);
      continue;
    }
    let runs: RunInfo[] = [];
    try {
      runs = JSON.parse(r.stdout || '[]') as RunInfo[];
    } catch {
      // none
    }
    if (!runs.length) out.push(file === EXPLORE_WORKFLOW_FILE ? '    none yet: start one with `npx keepgreen run`' : '    none yet (it runs when your tests fail)');
    for (const x of runs) out.push(`    ${describeRun(x)}`);
  }

  const prs = run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title,url,headRefName,isDraft']);
  let open: Array<{ number: number; title: string; url: string; headRefName: string; isDraft: boolean }> = [];
  try {
    open = (JSON.parse(prs.stdout || '[]') as typeof open).filter((p) => /^(keepgreen|autoheal)\//.test(p.headRefName));
  } catch {
    // none
  }
  out.push('', '  Open pull requests to review:');
  if (!open.length) out.push('    none');
  for (const p of open) out.push(`    #${p.number}${p.isDraft ? ' (draft)' : ''} ${p.title}  ${p.url}`);
  return { text: `${out.join('\n')}\n`, problems };
}
