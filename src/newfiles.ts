/**
 * A git patch that adds the given files, for the CI hand-off from the
 * read-only explore job to the publish job (checked by patch.ts there).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function addFilePatch(file: string, content: string): string {
  if (!content) return '';
  const endsWithNewline = content.endsWith('\n');
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  const out = [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@`];
  for (const line of lines) out.push(`+${line}`);
  if (!endsWithNewline) out.push('\\ No newline at end of file');
  return `${out.join('\n')}\n`;
}

export async function newFilesPatch(root: string, files: string[]): Promise<string> {
  let patch = '';
  for (const file of [...new Set(files)].sort()) {
    const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    patch += addFilePatch(rel, await readFile(path.join(root, rel), 'utf8'));
  }
  return patch;
}
