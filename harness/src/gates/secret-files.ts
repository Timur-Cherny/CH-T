// Config of the data-boundary gate: which files carry credentials. A file is known by its name or by the tail of its
// path, never by its content. Every entry reaches the shim through secretFileTrigger(); after an edit regenerate
// bin/prefilter.regex (test/meta/prefilter.test.ts requires byte equality).
export const SECRET_BASENAMES: readonly string[] = [
  '.pgpass', '.npmrc', '.netrc', '.secrets', 'id_rsa', 'id_ed25519',
  'keystore.properties', 'key.properties', 'signing.properties',
];
export const SECRET_EXTENSIONS: readonly string[] = ['jks', 'keystore', 'p12', 'pfx'];
/** Tracked repo files with passwords inside, as a path from the repo root (a mobile app keeps its release keystore passwords here). */
export const SECRET_REPO_PATHS: readonly string[] = ['companies/companies.json'];
/** A key whose name ends like this holds a secret value. */
export const SECRET_KEY_SUFFIXES: readonly string[] = ['password', 'token', 'authorization'];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, (c) => (c === '/' ? '/' : `\\${c}`));

export function secretFileTrigger(): string {
  return [...SECRET_BASENAMES.map(esc), ...SECRET_REPO_PATHS.map(esc), `\\.(${SECRET_EXTENSIONS.join('|')})([^A-Za-z0-9_]|$)`].join('|');
}
