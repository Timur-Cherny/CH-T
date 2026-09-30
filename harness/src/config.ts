// Site configuration: everything that belongs to one machine and one organisation rather than to the contour —
// protected and integration branches, company git hosts, the owner's shell path variables, watched repositories,
// the work-doc convention, prod relations whose rows are configuration. The code carries generic defaults only.
// INVARIANT: no file is a fresh machine, not an error — generic defaults, silence where a behaviour means nothing
// unconfigured. A file that exists but does not read (broken JSON, a field of the wrong shape) is `problem`: the gates
// that protect (pre-push-guard, owner-actions, data-boundary) answer unknown on it instead of guarding the defaults.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkDocsConfig {
  /** Regex over the cwd path: repositories where the reminder applies. */
  cwd: string;
  /** The whole reminder text — a convention of the site. */
  text: string;
}

export interface ShellPathsConfig {
  /** File under $HOME the owner's shell sources for path variables (`. file`). */
  file: string;
  /** Variable names it defines; a command that uses `$NAME` gets the value the shell would have. */
  vars: string[];
}

export interface FreshnessConfig {
  /** Variable holding the notes vault; its default path is `vaultRel` under $HOME. */
  vaultVar?: string;
  /** Variables holding repositories whose HEAD shifts are reported. */
  repoVars: string[];
  /** A file inside the vault whose edits are reported, relative to the vault. */
  trackerRel?: string;
  /** Local branches fast-forwarded to `<remote>/<branch>` after that remote fetches; absent — no ref is moved. */
  sync?: { remote: string; branches: string[] };
}

export interface HarnessConfig {
  /** Branches a feature branch may not push or open an MR into; only release/* and hotfix/* reach them. */
  protectedBranches: string[];
  /** Branches feature MRs target — the live lines next to the protected ones. */
  integrationBranches: string[];
  /** Hosts of the company git whose tags, merges and protected branches only the owner touches. */
  ownerHosts: string[];
  shellPaths?: ShellPathsConfig;
  freshness: FreshnessConfig;
  /** Prod relations whose rows describe the system (configuration), not its business data. */
  dataBoundary: { configTables: string[] };
  workDocs?: WorkDocsConfig;
  /** Vault path relative to $HOME when its variable is unset; absent — no default vault. */
  vaultRel?: string;
  /** Why the file that exists was not read in full; null when it read or does not exist. */
  problem: string | null;
}

const DEFAULTS: HarnessConfig = {
  protectedBranches: ['main'], integrationBranches: [], ownerHosts: [], freshness: { repoVars: [] },
  dataBoundary: { configTables: [] }, problem: null,
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const REF_NAME = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_][A-Za-z0-9._\/-]*(?<![./])$/;

// One hook is one process, but tests call decide() in a batch: the cache is per resolved path, not a global flag.
const cache = new Map<string, HarnessConfig>();

/** Config path: an explicit CLAUDE_HARNESS_CONFIG outranks ~/.claude/harness.config.json. The shims (bin/hook,
 *  bin/run) set CLAUDE_HARNESS_CONFIG to the checkout's own harness.config.json when neither is present, so the
 *  lookup next to the harness root lives at the entry point and in-process callers stay hermetic. */
export function configPath(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_HARNESS_CONFIG) return env.CLAUDE_HARNESS_CONFIG;
  return env.HOME ? join(env.HOME, '.claude', 'harness.config.json') : null;
}

function readFields(raw: Record<string, unknown>, bad: string[]): HarnessConfig {
  const text = (k: string, v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'string' && v) return v;
    bad.push(k); return undefined;
  };
  const list = (k: string, v: unknown, re?: RegExp): string[] | undefined => {
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x && (!re || re.test(x)))) return v as string[];
    bad.push(k); return undefined;
  };
  const obj = (k: string, v: unknown): Record<string, unknown> | undefined => {
    if (v === undefined) return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    bad.push(k); return undefined;
  };
  const protectedBranches = list('protectedBranches', raw.protectedBranches);
  if (protectedBranches && !protectedBranches.length) bad.push('protectedBranches');
  const wd = obj('workDocs', raw.workDocs);
  const workDocs = wd ? { cwd: text('workDocs.cwd', wd.cwd), text: text('workDocs.text', wd.text) } : undefined;
  if (wd && (!workDocs?.cwd || !workDocs.text)) bad.push('workDocs');
  const sp = obj('shellPaths', raw.shellPaths);
  const shellPaths = sp ? { file: text('shellPaths.file', sp.file), vars: list('shellPaths.vars', sp.vars, ENV_NAME) } : undefined;
  const fr = obj('freshness', raw.freshness) ?? {};
  const db = obj('dataBoundary', raw.dataBoundary) ?? {};
  const vaultVar = text('freshness.vaultVar', fr.vaultVar);
  if (vaultVar && !ENV_NAME.test(vaultVar)) bad.push('freshness.vaultVar');
  const sy = obj('freshness.sync', fr.sync);
  const syncRemote = sy ? text('freshness.sync.remote', sy.remote) : undefined;
  const syncBranches = sy ? list('freshness.sync.branches', sy.branches, REF_NAME) : undefined;
  if (syncRemote && !REMOTE_NAME.test(syncRemote)) bad.push('freshness.sync.remote');
  const sync = syncRemote && REMOTE_NAME.test(syncRemote) && syncBranches?.length ? { remote: syncRemote, branches: syncBranches } : undefined;
  if (sy && !sync) bad.push('freshness.sync');
  return {
    protectedBranches: protectedBranches?.length ? protectedBranches : DEFAULTS.protectedBranches,
    integrationBranches: list('integrationBranches', raw.integrationBranches) ?? [],
    ownerHosts: list('ownerHosts', raw.ownerHosts) ?? [],
    shellPaths: shellPaths?.file && shellPaths.vars?.length ? { file: shellPaths.file, vars: shellPaths.vars } : undefined,
    freshness: {
      vaultVar: vaultVar && ENV_NAME.test(vaultVar) ? vaultVar : undefined,
      repoVars: list('freshness.repoVars', fr.repoVars, ENV_NAME) ?? [],
      trackerRel: text('freshness.trackerRel', fr.trackerRel),
      ...(sync ? { sync } : {}),
    },
    dataBoundary: { configTables: list('dataBoundary.configTables', db.configTables) ?? [] },
    workDocs: workDocs?.cwd && workDocs.text ? { cwd: workDocs.cwd, text: workDocs.text } : undefined,
    vaultRel: text('vaultRel', raw.vaultRel),
    problem: null,
  };
}

/** Site config; never throws. A field of the wrong shape falls back to its default and is named in `problem`. */
export function loadConfig(env: NodeJS.ProcessEnv): HarnessConfig {
  const path = configPath(env);
  if (!path) return DEFAULTS;
  const hit = cache.get(path);
  if (hit) return hit;
  let cfg: HarnessConfig = DEFAULTS;
  let body: string | null = null;
  try { body = readFileSync(path, 'utf8'); } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') cfg = { ...DEFAULTS, problem: `${path} не прочитан (${code ?? 'ошибка чтения'})` };
  }
  if (body !== null) {
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { raw = undefined; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) cfg = { ...DEFAULTS, problem: `${path}: не JSON-объект` };
    else {
      const bad: string[] = [];
      cfg = readFields(raw as Record<string, unknown>, bad);
      if (bad.length) cfg.problem = `${path}: поля не той формы — ${[...new Set(bad)].join(', ')}`;
    }
  }
  cache.set(path, cfg);
  return cfg;
}

/** Tests only: forget the configs read so far. */
export function resetConfigCache(): void {
  cache.clear();
}
