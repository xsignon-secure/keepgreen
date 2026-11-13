/**
 * The smart part of `keepgreen init`: it reads the project so the user does
 * not have to fill anything in.
 *
 *  - Where the app runs: playwright.config `webServer` / `baseURL`, else the
 *    `dev` / `start` script in package.json (with the usual port of the tool
 *    it runs), else Django's manage.py.
 *  - Which AI provider: --provider, else the key found in the environment.
 *  - How CI installs the project: npm, pnpm, yarn or pip.
 *  - Optionally, GitHub's side through the `gh` CLI: the AI key secret and
 *    the "Actions may open pull requests" setting. The key is passed to gh on
 *    stdin (or typed into gh's own hidden prompt) and is never printed.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Provider = 'anthropic' | 'openai' | 'openrouter';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip';

export interface AppTarget {
  url?: string;
  startCommand?: string;
  startUrl?: string;
  /** Where it was found, for the summary ("package.json script dev"). */
  from: string;
  /** playwright.config starts the app itself and does not yet let KeepGreen's app be reused. */
  webServerNeedsReuse?: boolean;
}

/** OpenRouter model used when the repository sets no AUTOHEAL_MODEL variable. */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

/** The repository secret that holds the key, per provider. */
export const SECRET_NAME: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' };

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const PW_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.mts', 'playwright.config.cjs'];

/** A literal string value of `key:` in a slice of a JS/TS config. */
function literal(text: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`\\n]{1,300})\\1`).exec(text);
  const v = m?.[2];
  return v && !v.includes('${') ? v : undefined;
}

function portOf(script: string): number | undefined {
  const m = /(?:--port[= ]|-p[= ]|\bPORT=)(\d{2,5})\b/.exec(script);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** The usual port of the tool a script runs. */
function defaultPort(script: string): number {
  if (/\bng\s+serve\b/.test(script)) return 4200;
  if (/\bastro\b/.test(script)) return 4321;
  if (/\bvite\b|svelte-kit|\bvitepress\b/.test(script)) return 5173;
  if (/\bgatsby\b/.test(script)) return 8000;
  if (/\bvue-cli-service\b/.test(script)) return 8080;
  return 3000;
}

function runScript(pm: PackageManager, name: string): string {
  if (pm === 'pnpm') return `pnpm ${name}`;
  if (pm === 'yarn') return `yarn ${name}`;
  return name === 'start' ? 'npm start' : `npm run ${name}`;
}

export function detectPackageManager(root: string): PackageManager {
  const has = (p: string) => existsSync(path.join(root, p));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (!has('package.json') && (has('requirements.txt') || has('pyproject.toml') || has('pytest.ini') || has('conftest.py'))) return 'pip';
  return 'npm';
}

/** Where the app runs, read from the project's own files. */
export function detectApp(root: string, pm: PackageManager = detectPackageManager(root)): AppTarget {
  const config = PW_CONFIGS.map((n) => read(path.join(root, n))).find(Boolean) ?? '';
  if (config) {
    const at = config.indexOf('webServer');
    if (at >= 0) {
      const block = config.slice(at, at + 1200);
      const command = literal(block, 'command');
      const port = /\bport\s*:\s*(\d{2,5})\b/.exec(block)?.[1];
      const url = literal(block, 'url') ?? (port ? `http://localhost:${port}` : undefined);
      if (command && url) {
        return { startCommand: command, startUrl: url, from: 'playwright.config webServer', webServerNeedsReuse: !/KEEPGREEN/.test(block) };
      }
    }
    const base = literal(config, 'baseURL');
    if (base && /^https?:\/\//.test(base)) return { url: base, from: 'playwright.config baseURL' };
  }
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(read(path.join(root, 'package.json')) || '{}') as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // not JSON: fall through
  }
  for (const name of ['dev', 'start', 'serve', 'preview']) {
    const script = scripts[name];
    if (typeof script !== 'string' || !script.trim()) continue;
    const port = portOf(script) ?? defaultPort(script);
    const url = `http://localhost:${port}`;
    return { startCommand: runScript(pm, name), startUrl: url, from: `package.json script "${name}"` };
  }
  if (existsSync(path.join(root, 'manage.py'))) {
    return { startCommand: 'python manage.py runserver 8000', startUrl: 'http://localhost:8000', from: 'manage.py (Django)' };
  }
  return { url: 'http://localhost:3000', from: 'a guess: set url in .keepgreen.yml' };
}

/** --provider wins; else the key that is in the environment; else Anthropic. */
export function detectProvider(env: NodeJS.ProcessEnv, flag?: string): Provider {
  if (flag !== undefined) {
    const p = flag.trim().toLowerCase();
    if (p === 'anthropic' || p === 'openai' || p === 'openrouter') return p;
    throw new Error(`--provider must be anthropic, openai or openrouter (got "${flag}").`);
  }
  if (env.OPENROUTER_API_KEY || /openrouter\.ai/.test(env.AUTOHEAL_BASE_URL ?? '')) return 'openrouter';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

/** The key's value in this shell, if any (never printed). */
export function keyFromEnv(provider: Provider, env: NodeJS.ProcessEnv): string | undefined {
  const v = provider === 'openrouter' ? (env.OPENROUTER_API_KEY ?? (/openrouter\.ai/.test(env.AUTOHEAL_BASE_URL ?? '') ? env.AUTOHEAL_API_KEY : undefined)) : env[SECRET_NAME[provider]];
  return v?.trim() || undefined;
}

/** .keepgreen.yml with the app target filled in. */
export function configText(template: string, target: AppTarget): string {
  const original = 'url: http://localhost:3000\n# ...or a command that starts it, plus the address to wait for:\n# start-command: npm run dev\n# start-url: http://localhost:3000\n';
  if (!template.includes(original)) return template;
  const found = `# Found in ${target.from}.\n`;
  const block = target.startCommand
    ? `${found}# url: http://localhost:3000\n# ...or a command that starts it, plus the address to wait for:\nstart-command: ${target.startCommand}\nstart-url: ${target.startUrl}\n`
    : `${found}url: ${target.url}\n# ...or a command that starts it, plus the address to wait for:\n# start-command: npm run dev\n# start-url: http://localhost:3000\n`;
  return template.replace(original, block);
}

const KEY_LINES =
  '          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n          openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n          model: ${{ vars.AUTOHEAL_MODEL }}\n          # OpenRouter or another OpenAI-compatible endpoint instead:\n          # base-url: https://openrouter.ai/api/v1\n          # api-key: ${{ secrets.OPENROUTER_API_KEY }}\n';

const OPENROUTER_LINES = `          # OpenRouter (keepgreen init picked it). Set the repository variable
          # AUTOHEAL_MODEL to use another model.
          base-url: https://openrouter.ai/api/v1
          api-key: \${{ secrets.OPENROUTER_API_KEY }}
          model: \${{ vars.AUTOHEAL_MODEL || '${OPENROUTER_DEFAULT_MODEL}' }}
`;

/** The explore workflow, set up for this project's installs and AI provider. */
export function exploreWorkflowText(template: string, options: { provider: Provider; pm: PackageManager }): string {
  let text = template;
  if (options.provider === 'openrouter') text = text.replace(KEY_LINES, OPENROUTER_LINES);
  else if (options.provider === 'openai') text = text.replace(KEY_LINES, '          openai-api-key: ${{ secrets.OPENAI_API_KEY }}\n          model: ${{ vars.AUTOHEAL_MODEL }}   # repository variable: your OpenAI model\n');
  else text = text.replace(KEY_LINES, '          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n          # model: ${{ vars.AUTOHEAL_MODEL }}\n');
  const cond = "      - if: steps.open.outputs.count == '0' || steps.open.outputs.count == ''\n";
  const npm = `${cond}        run: npm ci\n${cond}        run: npx playwright install --with-deps chromium\n`;
  if (options.pm === 'pnpm') text = text.replace(npm, `${cond}        run: corepack enable && pnpm install --frozen-lockfile\n${cond}        run: pnpm exec playwright install --with-deps chromium\n`);
  else if (options.pm === 'yarn') text = text.replace(npm, `${cond}        run: yarn install --frozen-lockfile\n${cond}        run: yarn playwright install --with-deps chromium\n`);
  else if (options.pm === 'pip') {
    text = text.replace(
      npm,
      `      - uses: actions/setup-python@v5\n        if: steps.open.outputs.count == '0' || steps.open.outputs.count == ''\n        with:\n          python-version: "3.12"\n${cond}        run: pip install -r requirements.txt\n${cond}        run: python -m playwright install --with-deps chromium\n`,
    );
  }
  return text;
}

/** AutoHeal's heal workflow, set to the same provider and app as explore. */
export function healWorkflowText(text: string, options: { provider: Provider; target: AppTarget }): string {
  let out = text;
  const keys = /( {10})anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}\n {10}# openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}\n {10}# model: <your OpenAI model>\n/;
  if (options.provider === 'openrouter') {
    out = out.replace(keys, (_m, pad: string) => `${pad}base-url: https://openrouter.ai/api/v1\n${pad}api-key: \${{ secrets.OPENROUTER_API_KEY }}\n${pad}model: \${{ vars.AUTOHEAL_MODEL || '${OPENROUTER_DEFAULT_MODEL}' }}\n`);
  } else if (options.provider === 'openai') {
    out = out.replace(keys, (_m, pad: string) => `${pad}openai-api-key: \${{ secrets.OPENAI_API_KEY }}\n${pad}model: \${{ vars.AUTOHEAL_MODEL }}\n`);
  }
  // GitHub's runners have no pnpm; corepack (part of Node) provides it.
  out = out.replace(/^( +)pnpm install --frozen-lockfile$/gm, (_m, pad: string) => `${pad}corepack enable && pnpm install --frozen-lockfile`);
  const t = options.target;
  if (t.startCommand && t.startUrl) {
    out = out.replace(/( {10})# start-command: npm run start\n {10}# start-url: http:\/\/localhost:3000\n/, (_m, pad: string) => `${pad}start-command: ${t.startCommand}\n${pad}start-url: ${t.startUrl}\n`);
  }
  return out;
}

/** owner/name from a GitHub remote URL. */
export function githubRepo(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

export type Run = (cmd: string, args: string[], input?: string, interactive?: boolean) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>;

export const runCommand: Run = (cmd, args, input, interactive) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...(interactive ? { stdio: 'inherit' as const } : { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], input: input ?? '' }),
  });
  return { status: r.error ? 127 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface GithubStep {
  ok: boolean;
  what: string;
  /** What to do by hand when it did not work. */
  fix?: string;
}

/** The repository this folder pushes to, if gh can work with it. */
export function githubReady(root: string, run: Run = runCommand): { repo?: string; why?: string } {
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin']);
  const repo = remote.status === 0 ? githubRepo(remote.stdout) : undefined;
  if (!repo) return { why: 'this folder has no GitHub remote named origin' };
  const auth = run('gh', ['auth', 'status']);
  if (auth.status === 127) return { repo, why: 'the GitHub CLI (gh) is not installed: https://cli.github.com' };
  if (auth.status !== 0) return { repo, why: 'gh is not signed in: run `gh auth login`' };
  return { repo };
}

/**
 * GitHub's side of the setup: the AI key secret and permission for
 * workflows to open pull requests. Each step reports what to do by hand if
 * it could not be done (for example an organisation policy).
 */
export function connectGithub(options: { repo: string; provider: Provider; env: NodeJS.ProcessEnv; interactive: boolean; run?: Run }): GithubStep[] {
  const run = options.run ?? runCommand;
  const { repo, provider } = options;
  const web = `https://github.com/${repo}`;
  const steps: GithubStep[] = [];
  const name = SECRET_NAME[provider];
  const key = keyFromEnv(provider, options.env);
  if (key) {
    const r = run('gh', ['secret', 'set', name, '--repo', repo], key);
    steps.push(r.status === 0 ? { ok: true, what: `secret ${name} added (from your environment)` } : { ok: false, what: `could not add the secret ${name}`, fix: `${web}/settings/secrets/actions/new` });
  } else if (options.interactive) {
    process.stdout.write(`\nPaste your ${PROVIDER_LABEL[provider]} API key for the secret ${name} (it is sent to GitHub only, not shown):\n`);
    const r = run('gh', ['secret', 'set', name, '--repo', repo], undefined, true);
    steps.push(r.status === 0 ? { ok: true, what: `secret ${name} added` } : { ok: false, what: `secret ${name} not added`, fix: `${web}/settings/secrets/actions/new` });
  } else {
    steps.push({ ok: false, what: `no ${name} in this shell, so no secret was added`, fix: `${web}/settings/secrets/actions/new (name ${name})` });
  }
  const model = options.env.AUTOHEAL_MODEL?.trim();
  if (model && provider !== 'anthropic') {
    const r = run('gh', ['variable', 'set', 'AUTOHEAL_MODEL', '--body', model, '--repo', repo]);
    steps.push(r.status === 0 ? { ok: true, what: `variable AUTOHEAL_MODEL = ${model}` } : { ok: false, what: 'could not set the variable AUTOHEAL_MODEL', fix: `${web}/settings/variables/actions/new` });
  } else if (provider === 'openai') {
    steps.push({ ok: false, what: 'OpenAI needs your model name as the repository variable AUTOHEAL_MODEL', fix: `${web}/settings/variables/actions/new` });
  }
  const perms = run('gh', ['api', `repos/${repo}/actions/permissions/workflow`]);
  let current: { default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean } = {};
  try {
    current = JSON.parse(perms.stdout || '{}') as typeof current;
  } catch {
    // handled below
  }
  const manual = `${web}/settings/actions: Workflow permissions > tick "Allow GitHub Actions to create and approve pull requests"`;
  if (perms.status === 0 && current.can_approve_pull_request_reviews === true) {
    steps.push({ ok: true, what: 'GitHub Actions may open pull requests (already on)' });
  } else if (perms.status === 0) {
    const level = current.default_workflow_permissions === 'write' ? 'write' : 'read';
    const r = run('gh', ['api', '-X', 'PUT', `repos/${repo}/actions/permissions/workflow`, '-f', `default_workflow_permissions=${level}`, '-F', 'can_approve_pull_request_reviews=true']);
    steps.push(r.status === 0 ? { ok: true, what: 'GitHub Actions may now open pull requests' } : { ok: false, what: 'could not let GitHub Actions open pull requests (you may need admin rights, or your organisation sets it)', fix: manual });
  } else {
    steps.push({ ok: false, what: 'could not read the repository\'s Actions settings', fix: manual });
  }
  return steps;
}

/** The ✗ and ! lines (with their fixes) from AutoHeal's init output. */
export function setupChecks(output: string): string[] {
  const start = output.indexOf('Checks:');
  if (start < 0) return [];
  const end = output.indexOf('Only you can do these:', start);
  const lines = output.slice(start + 'Checks:'.length, end < 0 ? undefined : end).split('\n');
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^[✓✗!]/.test(line)) keep = !line.startsWith('✓');
    if (keep) out.push(line.replace(/^\s+→/, '    →'));
  }
  return out;
}
