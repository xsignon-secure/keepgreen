import { readFileSync } from 'node:fs';

/** The package version, read from package.json so it cannot drift. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
