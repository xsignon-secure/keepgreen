/**
 * `keepgreen init`: writes .keepgreen.yml and the explore workflow, filled in
 * for this project (where the app runs, how CI installs it, which AI
 * provider). Healing is set up by AutoHeal's own init (the CLI runs it right
 * after and then sets AutoHeal's workflow to the same provider and app).
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { configText, detectApp, detectPackageManager, exploreWorkflowText, type AppTarget, type PackageManager, type Provider } from './setup.js';
import { VERSION } from './version.js';

export const EXPLORE_WORKFLOW = '.github/workflows/keepgreen-explore.yml';

export interface InitResult {
  written: string[];
  skipped: string[];
  target: AppTarget;
  provider: Provider;
  pm: PackageManager;
}

export interface InitOptions {
  force?: boolean;
  dryRun?: boolean;
  provider?: Provider;
  /** Overrides what is detected. */
  target?: Partial<AppTarget>;
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function template(name: string): Promise<string> {
  const text = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
  return text.replaceAll('{{VERSION}}', VERSION);
}

export async function init(root: string, options: InitOptions = {}): Promise<InitResult> {
  const pm = detectPackageManager(root);
  const given = options.target ?? {};
  const target: AppTarget =
    given.url || given.startCommand
      ? { ...(given.url ? { url: given.url } : {}), ...(given.startCommand ? { startCommand: given.startCommand, startUrl: given.startUrl ?? given.url ?? 'http://localhost:3000' } : {}), from: 'your flags' }
      : detectApp(root, pm);
  if (target.startCommand && target.url) delete target.url;
  const provider = options.provider ?? 'anthropic';
  const result: InitResult = { written: [], skipped: [], target, provider, pm };
  const files: Array<[string, string]> = [
    [CONFIG_FILE, configText(await template('keepgreen.yml'), target)],
    [EXPLORE_WORKFLOW, exploreWorkflowText(await template('keepgreen-explore.yml'), { provider, pm })],
  ];
  for (const [rel, content] of files) {
    const file = path.join(root, rel);
    if (!options.force && (await exists(file))) {
      result.skipped.push(rel);
      continue;
    }
    if (!options.dryRun) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    result.written.push(rel);
  }
  return result;
}
