/**
 * `.keepgreen.yml`: the one settings file. It is a small, flat YAML subset
 * (key: value lines, and `pages:` as a list of `- /path` lines), so it needs
 * no YAML library. Command-line flags win over the file.
 *
 *   url: http://localhost:3000        # the running app to explore
 *   start-command: npm run dev        # or: start it for me
 *   start-url: http://localhost:3000  # address to wait for after start-command
 *   pages:                            # extra pages to look at when planning
 *     - /login
 *     - /pricing
 *   max-flows: 3                      # new tests per explore run
 *   max-usd: 3                        # AI spend cap for one explore run
 *   runs: 5                           # passing runs in a row a new test needs
 *   framework: auto                   # auto | playwright | pytest | cypress | webdriverio
 *
 * Flows behind a login (Playwright and pytest): KeepGreen signs in once,
 * looks at the pages as that user, and the new tests load the same session.
 * Secrets come from the environment as {{env:NAME}}, never from this file.
 *
 *   login-url: /login
 *   login-steps:
 *     - fill getByLabel('Email') = {{env:E2E_USER}}
 *     - fill getByLabel('Password') = {{env:E2E_PASSWORD}}
 *     - click getByRole('button', { name: 'Sign in' })
 *   login-check: getByRole('button', { name: 'Sign out' })
 *   login-totp-env: E2E_TOTP_SECRET   # only if a step types {{totp}}
 *   session: playwright/.auth/user.json  # alone: reuse a session your setup project makes
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoginConfig } from 'xsignon-autoheal';

export const CONFIG_FILE = '.keepgreen.yml';

export interface KeepGreenConfig {
  url?: string;
  startCommand?: string;
  startUrl?: string;
  pages: string[];
  maxFlows: number;
  maxUsd: number;
  runs: number;
  framework?: string;
  /** Sign in before exploring; absent for public apps. */
  login?: LoginConfig;
}

export const DEFAULTS: KeepGreenConfig = { pages: [], maxFlows: 3, maxUsd: 3, runs: 5 };

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

const KEYS = new Set(['url', 'start-command', 'start-url', 'pages', 'max-flows', 'max-usd', 'runs', 'framework', 'session', 'login-url', 'login-steps', 'login-check', 'login-totp-env']);
const LISTS = new Set(['pages', 'login-steps']);

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Drops a trailing `# comment` that is outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) return line.slice(0, i);
  }
  return line;
}

export function parseConfig(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let list: string | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) return;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!list) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: a "- item" line must follow "pages:" or "login-steps:".`);
      (out[list] as string[]).push(unquote(item[1] ?? ''));
      return;
    }
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!pair) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: expected "key: value".`);
    const key = pair[1] ?? '';
    const value = pair[2] ?? '';
    if (!KEYS.has(key)) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: unknown setting "${key}". Known: ${[...KEYS].join(', ')}.`);
    if (LISTS.has(key)) {
      if (value.trim() && value.trim() !== '[]') throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: list ${key} one per line as "  - ${key === 'pages' ? '/path' : 'step'}".`);
      out[key] = [];
      list = key;
      return;
    }
    list = null;
    out[key] = unquote(value);
  });
  return out;
}

function numberIn(raw: string | undefined, name: string, min: number, max: number, integer: boolean): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new ConfigFileError(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max} (got "${raw}").`);
  }
  return n;
}

/** Merges defaults, the file and flags (flags win), and checks the values. */
export function resolveConfig(file: Record<string, string | string[]>, flags: Record<string, string | string[] | undefined>): KeepGreenConfig {
  const pick = (key: string): string | undefined => {
    const flag = flags[key];
    if (typeof flag === 'string') return flag;
    const value = file[key];
    return typeof value === 'string' ? value : undefined;
  };
  const pages = (typeof flags.pages === 'string' ? flags.pages.split(',') : ((file.pages as string[] | undefined) ?? [])).map((p) => p.trim()).filter(Boolean);
  for (const p of pages) {
    if (!p.startsWith('/') || p.startsWith('//')) throw new ConfigFileError(`pages must be paths of your app such as /login (got "${p}").`);
  }
  if (pages.length > 10) throw new ConfigFileError('List at most 10 pages.');
  const config: KeepGreenConfig = {
    pages,
    maxFlows: numberIn(pick('max-flows'), 'max-flows', 1, 10, true) ?? DEFAULTS.maxFlows,
    maxUsd: numberIn(pick('max-usd'), 'max-usd', 0.05, 100, false) ?? DEFAULTS.maxUsd,
    runs: numberIn(pick('runs'), 'runs', 2, 20, true) ?? DEFAULTS.runs,
  };
  const url = pick('url');
  const startCommand = pick('start-command');
  const startUrl = pick('start-url');
  const framework = pick('framework');
  if (url) config.url = url;
  if (startCommand) config.startCommand = startCommand;
  if (startUrl) config.startUrl = startUrl;
  if (framework) config.framework = framework;
  const flagSteps = flags['login-step'];
  const steps = (Array.isArray(flagSteps) && flagSteps.length ? flagSteps : ((file['login-steps'] as string[] | undefined) ?? [])).map((s) => s.trim()).filter(Boolean);
  const session = pick('session');
  const loginUrl = pick('login-url');
  const check = pick('login-check');
  const totpEnv = pick('login-totp-env');
  if (session || steps.length) {
    config.login = {
      session: session || 'playwright/.auth/user.json',
      ...(loginUrl ? { url: loginUrl } : {}),
      ...(steps.length ? { steps } : {}),
      ...(check ? { check } : {}),
      ...(totpEnv ? { totpEnv } : {}),
    };
  } else if (loginUrl || check || totpEnv) {
    throw new ConfigFileError('login-url, login-check and login-totp-env need login-steps (or session, for a session your setup project makes).');
  }
  return config;
}

export async function loadConfigFile(projectRoot: string): Promise<Record<string, string | string[]>> {
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, CONFIG_FILE), 'utf8');
  } catch {
    return {};
  }
  return parseConfig(text);
}
