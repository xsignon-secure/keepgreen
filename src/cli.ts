#!/usr/bin/env node
/**
 * keepgreen: one command for the whole agent.
 *   explore  writes new tests (KeepGreen's own recipe, built on AutoHeal's cover)
 *   heal     fixes broken tests on your machine (AutoHeal's `fix`)
 *   init     writes .keepgreen.yml, the explore workflow and AutoHeal's heal workflow
 *   doctor   checks the setup
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  CypressTools,
  McpTools,
  ProviderError,
  WdioTools,
  checkAppUrl,
  checkLogin,
  cover,
  ensureSession,
  frameworkSetting,
  isCypressProject,
  isPytestProject,
  isWdioProject,
  priceFor,
  providerFromEnv,
  startApp,
  type Framework,
  type StartedApp,
  type ToolCaller,
} from 'xsignon-autoheal';
import { ConfigFileError, loadConfigFile, resolveConfig } from './config.js';
import { existingTitles, explore, exploreReport } from './explore.js';
import { init } from './init.js';
import { PROVIDER_LABEL, SECRET_NAME, connectGithub, detectProvider, githubReady, githubRepo, healWorkflowText, setupChecks, type GithubStep, type Provider } from './setup.js';
import { newFilesPatch } from './newfiles.js';
import { checkPatch } from './patch.js';
import { lookupPrice } from './price.js';
import { VERSION } from './version.js';

export const USAGE = `keepgreen ${VERSION}: free, self-hosted AI test agent. It writes new end-to-end tests
for your app and fixes the ones that break, with your own AI key (Anthropic, OpenAI or any
OpenAI-compatible endpoint). Built on playwright-e2e-mcp and AutoHeal. MIT, no account, no telemetry.

Start here: npx keepgreen init

  keepgreen init [--provider anthropic|openai|openrouter] [--url <app> | --start-command <cmd>
                 --start-url <url>] [--github | --no-github] [--force] [--dry-run]
        set everything up in one go: finds where your app runs and how CI installs it, writes
        .keepgreen.yml, the explore workflow and AutoHeal's heal workflow, and (with the gh CLI)
        adds your AI key secret and lets Actions open PRs
  keepgreen doctor
        check this project and machine
  keepgreen explore [--url <app>] [--start-command <cmd> --start-url <url>] [--pages /a,/b]
                    [--flow "<sentence>" ...] [--max-flows 3] [--max-usd 3] [--runs 5]
                    [--session <file>] [--login-url /login --login-step "<step>" ...
                     --login-check "<locator>" --login-totp-env E2E_TOTP_SECRET]
                    [--dry-run] [--out <dir>]
        find important user flows with no test yet and write a test for each; a test is kept
        only if it makes real assertions and passes --runs times in a row. --flow skips the
        planning and writes a test for the flow you name (repeat it for more). --login-step
        signs in first (secrets as {{env:E2E_PASSWORD}}), so flows behind a login are tested
  keepgreen heal [AutoHeal fix options]
        run your tests, fix what broke, leave the changes for you to review
  keepgreen autoheal <command> [...]
        run any AutoHeal command (heal, publish, learn, metrics, dashboard, ...)
  keepgreen check-patch <file>
        CI publish step: accept a patch only if it just adds test files
  keepgreen --version

Settings come from .keepgreen.yml; flags win. The AI key comes from ANTHROPIC_API_KEY,
OPENAI_API_KEY (+ AUTOHEAL_MODEL) or AUTOHEAL_BASE_URL (+ AUTOHEAL_MODEL).
`;

const HEAL_WORKFLOW = '.github/workflows/autoheal.yml';

const log = (line: string) => process.stderr.write(`[keepgreen] ${line}\n`);

/** Path of AutoHeal's CLI inside the installed xsignon-autoheal package. */
export function autohealCli(): string {
  const entry = fileURLToPath(import.meta.resolve('xsignon-autoheal'));
  return path.join(path.dirname(entry), 'cli.js');
}

function runAutoheal(args: string[]): number {
  const r = spawnSync(process.execPath, [autohealCli(), ...args], { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

async function detectFramework(root: string, value: string | undefined): Promise<Framework> {
  let setting: ReturnType<typeof frameworkSetting>;
  try {
    setting = frameworkSetting(value ?? process.env.AUTOHEAL_FRAMEWORK);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  if (setting !== 'auto') return setting;
  if (await isWdioProject(root)) return 'webdriverio';
  if (await isCypressProject(root)) return 'cypress';
  return (await isPytestProject(root)) ? 'pytest' : 'playwright';
}

async function cmdExplore(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'start-command': { type: 'string' },
      'start-url': { type: 'string' },
      pages: { type: 'string' },
      'max-flows': { type: 'string' },
      'max-usd': { type: 'string' },
      runs: { type: 'string' },
      framework: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      flow: { type: 'string', multiple: true },
      session: { type: 'string' },
      'login-url': { type: 'string' },
      'login-step': { type: 'string', multiple: true },
      'login-check': { type: 'string' },
      'login-totp-env': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const projectRoot = path.resolve(values.project ?? '.');
  const { project: _p, out: _o, 'dry-run': _d, flow: _f, ...flags } = values;
  const config = resolveConfig(await loadConfigFile(projectRoot), flags);
  if (config.login) {
    try {
      checkLogin(config.login);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
  }
  const env = process.env;
  // Lets playwright.config tell a KeepGreen run apart, e.g.
  // reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN
  env.KEEPGREEN = '1';
  const provider = providerFromEnv(env);
  if (!provider) throw new ConfigError('keepgreen explore needs an AI key: set ANTHROPIC_API_KEY, OPENAI_API_KEY (and AUTOHEAL_MODEL) or AUTOHEAL_BASE_URL.');
  const framework = await detectFramework(projectRoot, config.framework);
  if (config.login && framework !== 'playwright' && framework !== 'pytest') throw new ConfigError(`Signed-in flows work with Playwright and pytest-playwright tests; this project uses ${framework}.`);

  let app: StartedApp | null = null;
  let appUrl = config.url;
  let engine: McpTools | null = null;
  let runner: ToolCaller | null = null;
  try {
    if (config.startCommand) {
      const url = config.startUrl ?? config.url;
      if (!url) throw new ConfigError('start-command needs start-url: the address to wait for.');
      // startApp gives your app the tests' scrubbed environment: no AI key, no CI tokens.
      app = await startApp({ command: config.startCommand, url, cwd: projectRoot, sandbox: null, log });
      appUrl = app.url;
    }
    if (!appUrl) throw new ConfigError('Tell KeepGreen where your app runs: --url http://localhost:3000, or url: in .keepgreen.yml (or start-command + start-url).');
    // An app KeepGreen starts must be on this machine (startApp checks it). An app that is
    // already running may be anywhere, such as a staging or preview deployment.
    if (app) checkAppUrl(appUrl);
    else checkRemoteUrl(appUrl);
    const price = priceFor(provider.model, env) ?? (await lookupPrice(provider.model, env.AUTOHEAL_BASE_URL, { log }));
    if (!price) log(`No price is known for ${provider.model}, so max-usd cannot be enforced (only a token cap). Set AUTOHEAL_PRICE_IN and AUTOHEAL_PRICE_OUT (USD per 1M tokens).`);
    log(`KeepGreen ${VERSION}: exploring ${appUrl} (${framework}, ${provider.name} ${provider.model}, limit $${config.maxUsd})`);
    engine = await McpTools.start(projectRoot);
    runner = framework === 'cypress' ? new CypressTools(projectRoot, { log }) : framework === 'webdriverio' ? new WdioTools(projectRoot, { log }) : engine;
    let session: string | undefined;
    if (config.login) {
      try {
        session = await ensureSession(engine, config.login, { projectRoot, appUrl, log });
      } catch (error) {
        throw new ConfigError(error instanceof Error ? error.message : String(error));
      }
    }
    const result = await explore({
      ...(session ? { session } : {}),
      projectRoot,
      provider,
      engine,
      runner,
      appUrl,
      pages: config.pages,
      existing: await existingTitles(projectRoot),
      maxFlows: config.maxFlows,
      maxUsd: config.maxUsd,
      runs: config.runs,
      price,
      framework,
      cover,
      log,
      dryRun: values['dry-run'] === true,
      ...(values.flow?.length ? { flows: values.flow } : {}),
    });
    const report = exploreReport(result, config.runs);
    process.stdout.write(`\n${report}\n`);
    const written = result.results.filter((r) => r.result.status === 'written').map((r) => r.result.file);
    if (values.out) {
      const out = path.resolve(values.out);
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, 'report.md'), `${report}\n`);
      await writeFile(path.join(out, 'summary.json'), `${JSON.stringify(
          {
            version: VERSION,
            written,
            flows: result.flows,
            results: result.results.map(({ flow, result: r }) => ({ flow: flow.flow, status: r.status, file: r.file, explanation: r.explanation })),
            usd: result.usd,
            priced: result.priced,
          },
          null,
          2,
        )}\n`);
      await writeFile(path.join(out, 'new-tests.patch'), await newFilesPatch(projectRoot, written));
      log(`Wrote ${path.relative(process.cwd(), out) || '.'}/report.md, summary.json and new-tests.patch`);
    }
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${report}\n`).catch(() => undefined);
    return values['dry-run'] || written.length ? 0 : 1;
  } finally {
    if (runner && runner !== engine) await runner.close().catch(() => undefined);
    await engine?.close();
    await app?.stop().catch(() => undefined);
  }
}

/** A running app to explore: any http(s) address without a user name or password in it. */
export function checkRemoteUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`url is not a URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('url must start with http:// or https://');
  if (u.username || u.password) throw new ConfigError('Do not put a user name or password in url.');
  return u;
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function cmdInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      provider: { type: 'string' },
      url: { type: 'string' },
      'start-command': { type: 'string' },
      'start-url': { type: 'string' },
      github: { type: 'boolean' },
      'no-github': { type: 'boolean' },
    },
    strict: true,
  });
  const root = path.resolve(values.project ?? '.');
  const dryRun = values['dry-run'] === true;
  let provider: Provider;
  try {
    provider = detectProvider(process.env, values.provider);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  if (values.url) checkRemoteUrl(values.url);
  if (values['start-command'] && !values['start-url'] && !values.url) throw new ConfigError('--start-command needs --start-url (the address to wait for).');
  const target = {
    ...(values.url ? { url: values.url } : {}),
    ...(values['start-command'] ? { startCommand: values['start-command'] } : {}),
    ...(values['start-url'] ? { startUrl: values['start-url'] } : {}),
  };
  const healFile = path.join(root, HEAL_WORKFLOW);
  const healExisted = await access(healFile).then(() => true, () => false);
  const r = await init(root, { force: values.force === true, dryRun, provider, target });

  // AutoHeal writes the heal workflow. Its own "what to do next" list is
  // replaced by KeepGreen's below; only its checks of the test setup are kept.
  const ah = spawnSync(process.execPath, [autohealCli(), 'init', '--ci', 'github', '--project', root, ...(values.force ? ['--force'] : []), ...(dryRun ? ['--dry-run'] : [])], { encoding: 'utf8' });
  if (ah.error) throw ah.error;
  const code = ah.status ?? 1;
  if (code !== 0) process.stderr.write(`${ah.stdout ?? ''}${ah.stderr ?? ''}`);
  const checks = setupChecks(ah.stdout ?? '');
  const healWritten = !dryRun && (!healExisted || values.force === true);
  if (healWritten) {
    const text = await readFile(healFile, 'utf8').catch(() => '');
    if (text) await writeFile(healFile, healWorkflowText(text, { provider, target: r.target }));
  }

  const t = r.target;
  const out = ['', `━━ KeepGreen ${VERSION} is set up ━━`, ''];
  out.push(`  App      ${t.startCommand ? `starts with "${t.startCommand}", then ${t.startUrl}` : t.url}   (${t.from})`);
  out.push(`  AI       ${PROVIDER_LABEL[provider]}, your own key in the secret ${SECRET_NAME[provider]}`);
  out.push(`  Installs ${r.pm}`);
  for (const w of r.written) out.push(`  ${dryRun ? 'would write' : 'wrote'}    ${w}`);
  if (healWritten) out.push(`  wrote    ${HEAL_WORKFLOW} (by AutoHeal)`);
  for (const w of r.skipped) out.push(`  kept     ${w} (exists; --force to overwrite)`);
  if (t.webServerNeedsReuse) {
    out.push('', "  Tip: playwright.config starts the app too. Let it reuse the one KeepGreen starts:", '       reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN');
  }

  if (checks.length) {
    out.push('', '  Your test setup (AutoHeal needs these to fix tests in CI):');
    for (const c of checks) out.push(`    ${c}`);
  }

  let ghSteps: GithubStep[] = [];
  const remote = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const repo = remote.status === 0 ? githubRepo(remote.stdout ?? '') : undefined;
  if (!dryRun && values['no-github'] !== true) {
    const ready = githubReady(root);
    const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (ready.why) {
      if (values.github) out.push('', `  GitHub   not connected: ${ready.why}`);
    } else if (ready.repo && (values.github || (tty && (await ask(`\nAdd your AI key to ${ready.repo} and let Actions open PRs, using the gh CLI? [Y/n] `))))) {
      ghSteps = connectGithub({ repo: ready.repo, provider, env: process.env, interactive: tty });
      out.push('', `  GitHub   ${ready.repo}`);
      for (const s of ghSteps) out.push(`    ${s.ok ? '✓' : '✗'} ${s.what}${s.fix ? `\n        do it here: ${s.fix}` : ''}`);
    }
  }

  const web = repo ? `https://github.com/${repo}` : undefined;
  const todo: string[] = [];
  if (!ghSteps.length) {
    todo.push(`Add your ${PROVIDER_LABEL[provider]} key as the repository secret ${SECRET_NAME[provider]}${web ? `: ${web}/settings/secrets/actions/new` : ''}`);
    todo.push(`Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests"${web ? ` (${web}/settings/actions)` : ''}`);
    if (provider === 'openai') todo.push(`Add the repository variable AUTOHEAL_MODEL with your OpenAI model${web ? `: ${web}/settings/variables/actions/new` : ''}`);
    if (values['no-github'] !== true) todo.push('(or let KeepGreen do these two: install the gh CLI, then run `npx keepgreen init --github`)');
  }
  todo.push('git add .keepgreen.yml .github .gitignore && git commit -m "Add KeepGreen" && git push');
  todo.push(`Run it: ${web ? `${web}/actions/workflows/keepgreen-explore.yml` : 'Actions > KeepGreen explore'} > Run workflow. You get one PR with new, proven tests.`);
  out.push('', '  Next:');
  todo.forEach((s, i) => out.push(`    ${i + 1}. ${s}`));
  out.push('', '  Try it on this machine first: npx keepgreen explore --dry-run   (plans flows, writes nothing)', '');
  process.stdout.write(out.join('\n'));
  return code;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } }, strict: true });
  const root = path.resolve(values.project ?? '.');
  const lines = [`KeepGreen ${VERSION} doctor`, ''];
  let failed = false;
  try {
    const config = resolveConfig(await loadConfigFile(root), {});
    const target = config.startCommand ? `start-command "${config.startCommand}" then ${config.startUrl ?? config.url ?? '(no start-url!)'}` : (config.url ?? null);
    lines.push(target ? `ok    explore target: ${target}` : 'warn  no url in .keepgreen.yml: pass --url to keepgreen explore');
    if (config.startCommand && !(config.startUrl ?? config.url)) failed = true;
  } catch (error) {
    failed = true;
    lines.push(`fail  .keepgreen.yml: ${error instanceof Error ? error.message : String(error)}`);
  }
  lines.push('', 'AutoHeal checks (keys, framework, CI):', '');
  process.stdout.write(lines.join('\n'));
  const code = runAutoheal(['doctor', '--project', root]);
  return failed ? 1 : code;
}

async function cmdCheckPatch(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || argv.length > 1) throw new ConfigError('Usage: keepgreen check-patch <file>');
  const result = checkPatch(await readFile(file, 'utf8'));
  if (result.ok) {
    process.stdout.write(`${result.files.join('\n')}\n`);
    return 0;
  }
  log(result.files.length || result.problems.length ? `Patch refused:\n  ${(result.problems.length ? result.problems : ['no files']).join('\n  ')}` : 'Patch is empty.');
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command === 'explore') return await cmdExplore(rest);
    if (command === 'heal') return runAutoheal(['fix', ...rest]);
    if (command === 'autoheal') return runAutoheal(rest);
    if (command === 'init') return await cmdInit(rest);
    if (command === 'doctor') return await cmdDoctor(rest);
    if (command === 'check-patch') return await cmdCheckPatch(rest);
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ConfigFileError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      log((error as Error).message);
      return 2;
    }
    if (error instanceof ProviderError) {
      log(`The AI provider refused the request: ${error.message.slice(0, 600)}`);
      if (/HTTP 402|credits|quota|insufficient/i.test(error.message)) log('Your AI account or key is out of credit (or its spend limit is too low). Add credit or raise the key\'s limit, then run again.');
      else if (/HTTP 401|HTTP 403|api key|unauthori/i.test(error.message)) log('Check the API key (and AUTOHEAL_BASE_URL / AUTOHEAL_MODEL for OpenAI-compatible endpoints).');
      return 1;
    }
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
