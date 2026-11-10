/**
 * The explore job in CI runs AI-written tests, so it has no write access.
 * It hands its new files to a separate publish job as a git patch, and the
 * publish job checks that patch before opening a PR: it may only ADD test
 * files. It may not change or delete anything, touch workflows, configs or
 * dependencies, or leave the project folder.
 */

const TEST_FILE = /\.(?:spec|test|cy|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test_\w+\.py$/;
const MAX_FILES = 10;
const MAX_BYTES = 400_000;

export interface PatchCheck {
  ok: boolean;
  files: string[];
  problems: string[];
}

function badPath(file: string): string | null {
  if (!file || file.includes('\0')) return 'empty path';
  if (file.startsWith('/') || /^[a-zA-Z]:/.test(file)) return 'absolute path';
  const parts = file.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return 'path leaves the project';
  if (parts.some((p) => p.startsWith('.'))) return 'hidden folder or file (.github, .git and the like)';
  if (parts.includes('node_modules')) return 'inside node_modules';
  if (!TEST_FILE.test(file)) return 'not a test file';
  return null;
}

export function checkPatch(patch: string): PatchCheck {
  const problems: string[] = [];
  const files: string[] = [];
  if (Buffer.byteLength(patch) > MAX_BYTES) problems.push(`patch is larger than ${MAX_BYTES} bytes`);
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  if (!chunks.length && patch.trim()) problems.push('not a git patch');
  for (const chunk of chunks) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/m.exec(chunk);
    if (!header) {
      problems.push('unreadable diff header (paths with spaces are not allowed)');
      continue;
    }
    const [, a, b] = header as unknown as [string, string, string];
    if (a !== b) problems.push(`${b}: renames and copies are not allowed`);
    if (!/^new file mode 100644$/m.test(chunk)) problems.push(`${b}: only new, non-executable files are allowed`);
    if (/^(?:deleted file mode|old mode|new mode|similarity index|rename |copy |Binary files|GIT binary patch)/m.test(chunk)) problems.push(`${b}: only plain new text files are allowed`);
    if (!/^--- \/dev\/null$/m.test(chunk)) problems.push(`${b}: changes an existing file`);
    const why = badPath(b);
    if (why) problems.push(`${b}: ${why}`);
    files.push(b);
  }
  if (files.length > MAX_FILES) problems.push(`more than ${MAX_FILES} files`);
  if (new Set(files).size !== files.length) problems.push('the same file appears twice');
  return { ok: problems.length === 0 && files.length > 0, files, problems };
}
