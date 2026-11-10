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
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
}

export const DEFAULTS: KeepGreenConfig = { pages: [], maxFlows: 3, maxUsd: 3, runs: 5 };

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

const KEYS = new Set(['url', 'start-command', 'start-url', 'pages', 'max-flows', 'max-usd', 'runs', 'framework']);

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
      if (!list) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: a "- item" line must follow "pages:".`);
      (out[list] as string[]).push(unquote(item[1] ?? ''));
      return;
    }
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!pair) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: expected "key: value".`);
    const key = pair[1] ?? '';
    const value = pair[2] ?? '';
    if (!KEYS.has(key)) throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: unknown setting "${key}". Known: ${[...KEYS].join(', ')}.`);
    if (key === 'pages') {
      if (value.trim() && value.trim() !== '[]') throw new ConfigFileError(`${CONFIG_FILE} line ${index + 1}: list pages one per line as "  - /path".`);
      out.pages = [];
      list = 'pages';
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
export function resolveConfig(file: Record<string, string | string[]>, flags: Record<string, string | undefined>): KeepGreenConfig {
  const pick = (key: string): string | undefined => {
    const flag = flags[key];
    if (flag !== undefined) return flag;
    const value = file[key];
    return typeof value === 'string' ? value : undefined;
  };
  const pages = (flags.pages !== undefined ? flags.pages.split(',') : ((file.pages as string[] | undefined) ?? [])).map((p) => p.trim()).filter(Boolean);
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
