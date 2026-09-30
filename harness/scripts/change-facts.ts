// Facts about what a git range changed, for notes that go to business and users (0 tokens, read-only git).
//   node scripts/change-facts.ts --repo <path> --from <ref> --to <ref> [--repo … --from … --to …] [--memory <dir>]
//   node scripts/change-facts.ts --session <id> [--journal <file>] [--state <dir>] [triples…] [--memory <dir>]
// --session takes the ranges from the commits journal: the session's commits per repository, chained along first
// parents, each with how its authorship is known (see sessionRanges); the journal carries no path, harness.db does.
// Prints one JSON document: per range — commits, UI texts added/removed/reworded, API routes added/removed,
// migrations, titles of added tests, changed files by layer, removed files, where the end of the range lives,
// and the memory notes that name a commit, tag or branch of the range (name and description only).
// Exit codes: 0 facts · 1 a range, or the session, has no commits (an empty run is not green) · 2 a ref does not resolve · 64 usage.
// The model writes the prose; every sentence of it has to point back at one of these facts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from '../src/git.ts';
import { isMainModule } from '../src/is-main.ts';
import { commitsJournalPath } from '../src/journal.ts';
import { resolveStateDir } from '../src/state.ts';
import { shortHash } from '../src/session/common.ts';

export type Layer = 'test' | 'texts' | 'migration' | 'api' | 'contract' | 'ui' | 'ci' | 'docs' | 'logic';
export interface RangeSpec { repo: string; from: string; to: string }
export interface Commit { sha: string; date: string; subject: string; type: string | null; scope: string | null; task: string | null; breaking: boolean; merge: boolean }
export interface TextChange { file: string; key: string; change: 'added' | 'removed' | 'changed'; before: string | null; after: string | null }
export interface RouteChange { change: 'added' | 'removed'; route: string; file: string }
export interface RangeFacts {
  repo: string; from: string; to: string; fromSha: string; toSha: string;
  diverged: { behind: number } | null;
  version: { from: string | null; to: string | null };
  commits: Commit[]; texts: TextChange[]; routes: RouteChange[];
  migrations: Array<{ file: string; down: 'restores' | 'empty' | 'absent' }>;
  tests: string[]; layers: Record<Layer, number>; removedFiles: string[];
  containment: { tags: string[]; branches: string[] };
  memory: Array<{ name: string; description: string }>;
}
export interface Outcome { rc: number; stdout: string; stderr: string }

const SLOW = 60000;
const MAX_TITLES = 80;

export function classify(path: string): Layer {
  if (/\.(test|spec|db-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(test|tests|__tests__|e2e)\//.test(path)) return 'test';
  if (/(^|\/)(i18n|locales?)\/.*\.json$/.test(path)) return 'texts';
  if (/(^|\/)migrations?\//.test(path)) return 'migration';
  if (/\.controller\.[jt]s$/.test(path) || /(^|\/)api\/[^/]+\.[jt]sx?$/.test(path)) return 'api';
  if (/\.dto\.[jt]s$/.test(path) || /(^|\/)(dto|typedefs|contracts?|proto)\//.test(path)) return 'contract';
  if (/\.(tsx|jsx|vue|css|scss)$/.test(path) || /(^|\/)(screens|components|pages|features|navigators)\//.test(path)) return 'ui';
  if (/(^|\/)(\.gitlab-ci\.yml|Dockerfile[^/]*|\.github\/|helm\/|k8s\/|deploy\/)/.test(path)) return 'ci';
  if (/\.(md|mdx|txt)$/.test(path) || /(^|\/)docs?\//.test(path)) return 'docs';
  return 'logic';
}

export function flattenKeys(value: unknown, prefix = '', into = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') { if (prefix) into.set(prefix, value); return into; }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenKeys(v, prefix ? `${prefix}.${k}` : k, into);
  }
  return into;
}

const joinRoute = (base: string, sub: string): string => {
  const path = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return path === '' ? '/' : path;
};

export function routesOf(source: string): string[] {
  const controller = /@Controller\(\s*(?:\{[^}]*?path:\s*)?['"`]([^'"`]*)['"`]/s.exec(source);
  const base = controller?.[1] ?? '';
  const out: string[] = [];
  for (const m of source.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?/g)) {
    out.push(`${m[1]!.toUpperCase()} ${joinRoute(base, m[2] ?? '')}`);
  }
  return out;
}

export function testTitles(diff: string): string[] {
  const titles: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const m = /^\+\s*(?:it|test)(?:\.each(?:<[^>]*>)?\([\s\S]*?\)\s*)?\(\s*(['"`])(.+?)\1\s*,/.exec(line);
    if (m) titles.push(m[2]!);
  }
  return titles;
}

function show(repo: string, ref: string, path: string): string | null {
  const r = git(repo, ['show', `${ref}:${path}`], SLOW);
  return r.rc === 0 ? r.stdout : null;
}

function parseCommit(line: string): Commit {
  const [sha = '', date = '', parents = '', ...rest] = line.split('\x1f');
  const subject = rest.join('\x1f');
  const head = /^(\w+)(?:\(([^)]*)\))?(!)?:/.exec(subject);
  const task = /\b([A-Z]{2,}-\d+|NO-JS)\b/.exec(subject);
  return { sha, date, subject, type: head?.[1] ?? null, scope: head?.[2] ?? null, task: task?.[1] ?? null, breaking: !!head?.[3], merge: parents.trim().includes(' ') };
}

function versionAt(repo: string, ref: string): string | null {
  try { return (JSON.parse(show(repo, ref, 'package.json') ?? '') as { version?: string }).version ?? null; } catch { return null; }
}

function downOf(source: string | null): 'restores' | 'empty' | 'absent' {
  const m = /\bdown\s*\([^)]*\)[^{]*\{([\s\S]*?)\n?\s*\}/.exec(source ?? '');
  if (!m) return 'absent';
  return m[1]!.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '').trim() === '' ? 'empty' : 'restores';
}

function textChanges(repo: string, from: string, to: string, file: string): TextChange[] {
  const parse = (ref: string): Map<string, string> => { try { return flattenKeys(JSON.parse(show(repo, ref, file) ?? '{}')); } catch { return new Map(); } };
  const before = parse(from); const after = parse(to);
  const out: TextChange[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(key) ?? null; const a = after.get(key) ?? null;
    if (b === a) continue;
    out.push({ file, key, change: b === null ? 'added' : a === null ? 'removed' : 'changed', before: b, after: a });
  }
  return out;
}

function memoryNotes(dir: string | undefined, needles: string[]): Array<{ name: string; description: string }> {
  if (!dir || !existsSync(dir) || needles.length === 0) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (!needles.some((n) => text.includes(n))) continue;
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const field = (k: string): string => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
    out.push({ name: field('name') || basename(file, '.md'), description: field('description') });
  }
  return out;
}

export class RangeFailure extends Error {
  rc: number;
  constructor(rc: number, message: string) { super(message); this.rc = rc; }
}

function rangeFacts(spec: RangeSpec, memoryDir: string | undefined): RangeFacts {
  const resolve = (ref: string): string => {
    const r = git(spec.repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], SLOW);
    if (r.rc !== 0) throw new RangeFailure(2, `ref «${ref}» не разрешается в ${spec.repo}`);
    return r.stdout.trim();
  };
  const fromSha = resolve(spec.from); const toSha = resolve(spec.to);
  // Files are compared with the point the range LEFT `from`, not with where `from` went since: a plain two-ended
  // diff reports everything the mainline gained after the fork as removed by the branch.
  const fork = git(spec.repo, ['merge-base', fromSha, toSha], SLOW).stdout.trim() || fromSha;
  const behind = fork === fromSha ? 0 : Number(git(spec.repo, ['rev-list', '--count', `${fork}..${fromSha}`], SLOW).stdout.trim()) || 0;
  const range = `${fromSha}..${toSha}`;
  const tree = `${fork}..${toSha}`;

  const log = git(spec.repo, ['log', '--format=%H%x1f%cI%x1f%P%x1f%s', range], SLOW).stdout.split('\n').filter(Boolean);
  const commits = log.map(parseCommit);
  if (commits.length === 0) throw new RangeFailure(1, `диапазон ${spec.from}..${spec.to} в ${basename(spec.repo)} пуст — проверь порядок ссылок`);

  const layers: Record<Layer, number> = { test: 0, texts: 0, migration: 0, api: 0, contract: 0, ui: 0, ci: 0, docs: 0, logic: 0 };
  const texts: TextChange[] = []; const routes: RouteChange[] = []; const removedFiles: string[] = [];
  const migrations: RangeFacts['migrations'] = [];
  for (const row of git(spec.repo, ['diff', '--name-status', '--no-renames', tree], SLOW).stdout.split('\n').filter(Boolean)) {
    const [status = '', path = ''] = row.split('\t');
    const layer = classify(path);
    layers[layer] += 1;
    if (status === 'D' && layer !== 'test') removedFiles.push(path);
    if (layer === 'texts') texts.push(...textChanges(spec.repo, fork, toSha, path));
    if (layer === 'migration' && status === 'A') migrations.push({ file: path, down: downOf(show(spec.repo, toSha, path)) });
    if (/\.controller\.[jt]s$/.test(path)) {
      const before = new Set(routesOf(show(spec.repo, fork, path) ?? '')); const after = new Set(routesOf(show(spec.repo, toSha, path) ?? ''));
      for (const route of [...after].filter((r) => !before.has(r)).sort()) routes.push({ change: 'added', route, file: path });
      for (const route of [...before].filter((r) => !after.has(r)).sort()) routes.push({ change: 'removed', route, file: path });
    }
  }

  const testDiff = git(spec.repo, ['diff', '-U0', '--no-renames', tree, '--', '*.test.*', '*.spec.*', '*-spec.*'], SLOW).stdout;
  const refs = (args: string[]): string[] => git(spec.repo, ['for-each-ref', '--format=%(refname:short)', ...args], SLOW).stdout.split('\n').filter(Boolean);
  const tags = refs(['--points-at', toSha, 'refs/tags']);
  const branches = refs(['--contains', toSha, 'refs/heads', 'refs/remotes']).filter((b) => /(^|\/)(main|master|dev|develop)$/.test(b)).sort();

  const MAINLINE = /(^|\/)(main|master|dev|develop|HEAD)$/;
  const ownBranch = /^[0-9a-f]{7,40}$/.test(spec.to) || MAINLINE.test(spec.to) ? [] : [spec.to.replace(/^(origin|source|upstream|github)\//, '')];
  const needles = [...commits.map((c) => c.sha.slice(0, 7)), ...tags, ...ownBranch];
  return {
    repo: basename(spec.repo), from: spec.from, to: spec.to, fromSha, toSha,
    diverged: behind > 0 ? { behind } : null,
    version: { from: versionAt(spec.repo, fork), to: versionAt(spec.repo, toSha) },
    commits, texts, routes, migrations, tests: testTitles(testDiff).slice(0, MAX_TITLES), layers, removedFiles: removedFiles.sort(),
    containment: { tags, branches }, memory: memoryNotes(memoryDir, needles),
  };
}

export function collect(opts: { ranges: RangeSpec[]; memoryDir?: string }): { ranges: RangeFacts[] } {
  return { ranges: opts.ranges.map((r) => rangeFacts(r, opts.memoryDir)) };
}

/** session — its call alone made the commit; shared — it is one of `candidates`; legacy — written before attribution
 * by the first session that saw it; pending — made in a worktree it worked in, attribution not settled yet (< 11 min). */
export type Share = 'session' | 'shared' | 'legacy' | 'pending';
export interface SessionCommit { sha: string; repo: string; share: Share }
export interface SessionFacts { id: string; commits: SessionCommit[]; unresolvedRepos: number; missing: number; rootCommits: number }
interface JournalRow { session?: string | null; attribution?: string; candidates?: string[]; repo_hash?: string; commit_hash?: string }

export function shareOf(row: JournalRow, id: string): Share | null {
  if (row.attribution === undefined) return row.session === id ? 'legacy' : null;
  if (row.attribution === 'session') return row.session === id ? 'session' : null;
  return row.candidates?.includes(id) ? 'shared' : null;
}

/** repo_hash → path: the journal carries no path, the harness state on this machine does. */
function reposByHash(stateDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const path = join(stateDir, 'harness.db');
  if (!existsSync(path)) return out;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = (t: string): boolean => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', t);
    const sources = ['session_roots', 'repos', 'head_moves', 'pending_commits'].filter(has).map((t) => `SELECT repo FROM ${t}`);
    for (const { repo } of db.prepare(sources.join(' UNION ')).all() as { repo: string }[]) out.set(shortHash(repo), repo);
    return out;
  } finally { db.close(); }
}

function pendingOf(stateDir: string, id: string): Array<{ repo: string; hash: string }> {
  const path = join(stateDir, 'harness.db');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'pending_commits'").get()) return [];
    return db.prepare("SELECT p.repo, p.hash FROM pending_commits p WHERE p.kind = 'made' AND EXISTS (SELECT 1 FROM head_moves h WHERE h.repo = p.repo AND h.session_id = ?)").all(id) as Array<{ repo: string; hash: string }>;
  } finally { db.close(); }
}

/** Commits → ranges along first parents, so a range holds the session's commits and nothing between them; a fork
 * starts a new range. A merge commit brings the history it merged — that is what merging did. */
export function chainRanges(repo: string, shas: string[]): { ranges: RangeSpec[]; missing: number; rootCommits: number } {
  const r = git(repo, ['log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %P', ...shas], SLOW);
  const parent = new Map<string, string | null>();
  for (const line of r.stdout.split('\n').filter(Boolean)) { const [h, p] = line.split(' '); parent.set(h!, p || null); }
  const children = new Map<string, string[]>();
  for (const [h, p] of parent) if (p && parent.has(p)) children.set(p, [...(children.get(p) ?? []), h]);
  const ranges: RangeSpec[] = [];
  const walk = (start: string, from: string): void => {
    let cur = start;
    for (let kids = children.get(cur) ?? []; kids.length === 1; kids = children.get(cur) ?? []) cur = kids[0]!;
    ranges.push({ repo, from, to: cur });
    for (const k of children.get(cur) ?? []) walk(k, cur);
  };
  let rootCommits = 0;
  for (const [h, p] of parent) {
    if (p && parent.has(p)) continue;
    if (p) walk(h, p); else rootCommits++;
  }
  return { ranges, missing: new Set(shas).size - parent.size, rootCommits };
}

export function sessionRanges(id: string, journal: string, stateDir: string): { facts: SessionFacts; ranges: RangeSpec[] } {
  const rows = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as JournalRow; } catch { return {}; } }) : [];
  const byHash = reposByHash(stateDir);
  const facts: SessionFacts = { id, commits: [], unresolvedRepos: 0, missing: 0, rootCommits: 0 };
  const perRepo = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  const add = (repo: string, sha: string, share: Share): void => {
    if (perRepo.get(repo)?.has(sha)) return;
    facts.commits.push({ sha, repo: basename(repo), share });
    perRepo.set(repo, (perRepo.get(repo) ?? new Set()).add(sha));
  };
  for (const row of rows) {
    const share = shareOf(row, id);
    if (share === null || !row.commit_hash || !row.repo_hash) continue;
    const repo = byHash.get(row.repo_hash);
    if (!repo || !existsSync(repo)) { unresolved.add(row.repo_hash); continue; }
    add(repo, row.commit_hash, share);
  }
  for (const p of pendingOf(stateDir, id)) if (existsSync(p.repo)) add(p.repo, p.hash, 'pending');
  facts.unresolvedRepos = unresolved.size;
  const ranges: RangeSpec[] = [];
  for (const [repo, shas] of perRepo) {
    const c = chainRanges(repo, [...shas]);
    ranges.push(...c.ranges); facts.missing += c.missing; facts.rootCommits += c.rootCommits;
  }
  return { facts, ranges };
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Outcome {
  const usage = 'change-facts: --repo <path> --from <ref> --to <ref> [повторить тройку] | --session <id> [--journal <file>] [--state <dir>]; [--memory <dir>]';
  const ranges: RangeSpec[] = []; let memoryDir: string | undefined; let cur: Partial<RangeSpec> = {};
  const opt: { session?: string; journal?: string; state?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value) return { rc: 64, stdout: '', stderr: usage };
    if (flag === '--memory') { memoryDir = value; continue; }
    if (flag === '--session' || flag === '--journal' || flag === '--state') { opt[flag.slice(2) as keyof typeof opt] = value; continue; }
    if (flag !== '--repo' && flag !== '--from' && flag !== '--to') return { rc: 64, stdout: '', stderr: usage };
    if (flag === '--repo' && Object.keys(cur).length) return { rc: 64, stdout: '', stderr: `${usage}\nнезавершённая тройка перед --repo ${value}` };
    cur[flag.slice(2) as keyof RangeSpec] = value;
    if (cur.repo && cur.from && cur.to) { ranges.push(cur as RangeSpec); cur = {}; }
  }
  if (Object.keys(cur).length || (!opt.session && (opt.journal || opt.state))) return { rc: 64, stdout: '', stderr: usage };
  let session: SessionFacts | undefined;
  if (opt.session) {
    const home = env.HOME ?? '';
    const derived = sessionRanges(opt.session, opt.journal ?? commitsJournalPath(home), opt.state ?? resolveStateDir(env));
    if (derived.ranges.length === 0 && ranges.length === 0) return { rc: 1, stdout: '', stderr: `change-facts: у сессии ${opt.session} в журнале нет ни одного своего коммита — назови диапазоны тройками` };
    session = derived.facts; ranges.push(...derived.ranges);
  }
  if (ranges.length === 0) return { rc: 64, stdout: '', stderr: usage };
  try {
    return { rc: 0, stdout: JSON.stringify(session ? { session, ...collect({ ranges, memoryDir }) } : collect({ ranges, memoryDir }), null, 2), stderr: '' };
  } catch (e) {
    if (e instanceof RangeFailure) return { rc: e.rc, stdout: '', stderr: `change-facts: ${e.message}` };
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  const out = run(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  if (out.stderr) process.stderr.write(out.stderr + '\n');
  process.exit(out.rc);
}
