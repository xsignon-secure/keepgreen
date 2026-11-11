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
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  cover,
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
import { newFilesPatch } from './newfiles.js';
import { checkPatch } from './patch.js';
import { VERSION } from './version.js';

export const USAGE = `keepgreen ${VERSION}: free, self-hosted AI test agent. It writes new end-to-end tests
for your app and fixes the ones that break, with your own AI key (Anthropic, OpenAI or any
OpenAI-compatible endpoint). Built on playwright-e2e-mcp and AutoHeal. MIT, no account, no telemetry.

  keepgreen init [--force] [--dry-run]
        write .keepgreen.yml, the explore workflow and AutoHeal's heal workflow (GitHub Actions)
  keepgreen doctor
        check this project and machine
  keepgreen explore [--url <app>] [--start-command <cmd> --start-url <url>] [--pages /a,/b]
                    [--max-flows 3] [--max-usd 3] [--runs 5] [--dry-run] [--out <dir>]
        find important user flows with no test yet and write a test for each; a test is kept
        only if it makes real assertions and passes --runs times in a row
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
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const projectRoot = path.resolve(values.project ?? '.');
  const { project: _p, out: _o, 'dry-run': _d, ...flags } = values;
  const config = resolveConfig(await loadConfigFile(projectRoot), flags as Record<string, string | undefined>);
  const env = process.env;
  // Lets playwright.config tell a KeepGreen run apart, e.g.
  // reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN
  env.KEEPGREEN = '1';
  const provider = providerFromEnv(env);
  if (!provider) throw new ConfigError('keepgreen explore needs an AI key: set ANTHROPIC_API_KEY, OPENAI_API_KEY (and AUTOHEAL_MODEL) or AUTOHEAL_BASE_URL.');
  const framework = await detectFramework(projectRoot, config.framework);

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
    checkAppUrl(appUrl);
    log(`KeepGreen ${VERSION}: exploring ${appUrl} (${framework}, ${provider.name} ${provider.model}, limit $${config.maxUsd})`);
    engine = await McpTools.start(projectRoot);
    runner = framework === 'cypress' ? new CypressTools(projectRoot, { log }) : framework === 'webdriverio' ? new WdioTools(projectRoot, { log }) : engine;
    const result = await explore({
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
      price: priceFor(provider.model, env),
      framework,
      cover,
      log,
      dryRun: values['dry-run'] === true,
    });
    const report = exploreReport(result, config.runs);
    process.stdout.write(`\n${report}\n`);
    const written = result.results.filter((r) => r.result.status === 'written').map((r) => r.result.file);
    if (values.out) {
      const out = path.resolve(values.out);
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, 'report.md'), `${report}\n`);
      await writeFile(path.join(out, 'summary.json'), `${JSON.stringify({ version: VERSION, written, flows: result.flows, usd: result.usd }, null, 2)}\n`);
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

async function cmdInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: true });
  const root = path.resolve(values.project ?? '.');
  const dryRun = values['dry-run'] === true;
  const r = await init(root, { force: values.force === true, dryRun });
  const out = [`KeepGreen ${VERSION}`, ''];
  for (const w of r.written) out.push(`${dryRun ? 'would write' : 'wrote'}   ${w}`);
  for (const w of r.skipped) out.push(`kept    ${w} (exists; --force to overwrite)`);
  out.push('', 'Now AutoHeal sets up healing:', '');
  process.stdout.write(out.join('\n'));
  const code = runAutoheal(['init', '--ci', 'github', '--project', root, ...(values.force ? ['--force'] : []), ...(dryRun ? ['--dry-run'] : [])]);
  process.stdout.write(
    [
      '',
      'For KeepGreen explore, also:',
      '  1. Set url: in .keepgreen.yml (or start-command + start-url) so KeepGreen can reach your app.',
      '  2. Add ANTHROPIC_API_KEY (or OPENAI_API_KEY + the AUTOHEAL_MODEL variable) as a repository secret.',
      '  3. Settings > Actions > General: allow GitHub Actions to create pull requests.',
      '  4. Run it: Actions > KeepGreen explore > Run workflow (or `npx keepgreen explore` on your machine).',
      '',
    ].join('\n'),
  );
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
