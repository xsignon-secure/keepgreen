/**
 * `keepgreen init`: writes .keepgreen.yml and the explore workflow. Healing
 * is set up by AutoHeal's own init (the CLI runs it right after).
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { VERSION } from './version.js';

export const EXPLORE_WORKFLOW = '.github/workflows/keepgreen-explore.yml';

export interface InitResult {
  written: string[];
  skipped: string[];
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function template(name: string): Promise<string> {
  const text = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
  return text.replaceAll('{{VERSION}}', VERSION);
}

export async function init(root: string, options: { force?: boolean; dryRun?: boolean } = {}): Promise<InitResult> {
  const result: InitResult = { written: [], skipped: [] };
  const files: Array<[string, string]> = [
    [CONFIG_FILE, await template('keepgreen.yml')],
    [EXPLORE_WORKFLOW, await template('keepgreen-explore.yml')],
  ];
  for (const [rel, content] of files) {
    const target = path.join(root, rel);
    if (!options.force && (await exists(target))) {
      result.skipped.push(rel);
      continue;
    }
    if (!options.dryRun) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    result.written.push(rel);
  }
  return result;
}
