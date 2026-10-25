// agent-revert — a subagent does not destroy an uncommitted change of a tracked file outside the scratch area: its Bash
// may not restore, stash, clean, reverse-apply, remove or overwrite-with-committed-content such a file, and its
// Write/Edit may not turn such a file back into committed content unless the change is its own (clean at its start, its
// own last write).
// INC-SUBAGENT-REVERTS-WORKING-FILES: 19.09 an interrupted verifier left the root's fix reverted to HEAD, 05.10 `cp` from
// a wiped backup wrote HEAD over three fixes. The gate judges the target and its state, not a list of commands —
// specs/SPEC_AGENT_REVERT_GUARD.md. Its verdict also leaves the shim's observe mode (`observe: true`): an agent's Bash
// reaches Node with or without a trigger word, so the prefilter gains no word and the root pays nothing.
// Boundary (declared): writers invisible in the command text (a script file, python -c, an npm script), output of an
// arbitrary command, sed -i, a partial revert, and every root session — corp-claude included — are not judged.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { register } from './registry.ts';
import { segmentsWithCwd, parseGit, type SegmentAt } from './git-argv.ts';
import { withShellPaths } from './owner-actions.ts';
import { tokenize } from '../parsers/shell.ts';
import { buildModel, SHELLS } from '../parsers/stages.ts';
import type { Segment } from '../parsers/shell.ts';
import { expandWord } from '../parsers/expand.ts';
import { git, objectsExist } from '../git.ts';
import { windowDigest } from '../window.ts';
import { loadConfig } from '../config.ts';
import { State } from '../state.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'agent-revert';
export const KILL = 'CLAUDE_SKIP_AGENT_REVERT';
const SILENT: Verdict = { kind: 'silent' };
const DEFAULT_AREAS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
const MAX_WALK = 2000;
const MAX_DIRS = 20000;
const STDIN = /^(-|\/dev\/stdin|\/dev\/fd\/0)$/;
/** friction.ts MAX_FILES: a start snapshot this long may be cut, and a file missing from it proves nothing. */
const SNAPSHOT_CAP = 200;
/** Words of the judged operations, for text no parser read (unparsed tails, a script piped into a shell). */
const JUDGED_WORD = /(^|[^A-Za-z0-9_-])(checkout|restore|reset|stash|switch|clean|rm|unlink|apply|patch|cp|mv|install|ditto|rsync|worktree)([^A-Za-z0-9_-]|$)/;

type Mode = 'worktree' | 'all' | 'untracked' | 'any';
interface Hit { kind: 'deny' | 'unknown'; op: string; why: string; files: string[] }

// ---------- paths and repositories ----------

/** Realpath of the nearest existing ancestor with the missing tail appended: a target that does not exist yet keeps the
 *  physical path of its directory (~/.claude/… is a symlink into the brain checkout). */
function physical(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    const real = realOrNull(cur);
    if (real !== null) return join(real, ...[...tail].reverse());
    const up = dirname(cur);
    if (up === cur) return p;
    tail.push(basename(cur)); cur = up;
  }
}
const realOrNull = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };
const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

class Repos {
  private tops = new Map<string, string | null>();
  private formats = new Map<string, 'sha1' | 'sha256'>();
  readonly areas: string[];
  constructor(p: PreToolUsePayload, env: NodeJS.ProcessEnv) {
    const defaults = env.HARNESS_SCRATCH_DEFAULTS !== undefined ? env.HARNESS_SCRATCH_DEFAULTS.split(':') : [...DEFAULT_AREAS, tmpdir()];
    const extra = (env.HARNESS_SCRATCH_AREAS ?? '').split(':');
    const own = typeof p.scratchpad_dir === 'string' ? [p.scratchpad_dir] : [];
    this.areas = [...defaults, ...extra, ...own].filter(Boolean).map(physical);
  }
  /** Toplevel of the repository holding `path` (physical), or null outside any. */
  repoOf(path: string): string | null {
    let dir = physical(path);
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { dir = dirname(dir); }
    while (!this.tops.has(dir)) {
      try { statSync(dir); break; } catch { const up = dirname(dir); if (up === dir) return null; dir = up; }
    }
    if (!this.tops.has(dir)) {
      const r = git(dir, ['rev-parse', '--show-toplevel'], 3000);
      this.tops.set(dir, r.rc === 0 ? physical(r.stdout.trim()) : null);
    }
    return this.tops.get(dir) ?? null;
  }
  scratch(path: string): boolean { return this.areas.some((a) => within(physical(path), a)); }
  /** The repository of `path` when it is protected: a repository outside the scratch area. */
  guarded(path: string): string | null {
    const repo = this.repoOf(path);
    return repo !== null && !this.scratch(repo) ? repo : null;
  }
  format(repo: string): 'sha1' | 'sha256' {
    let f = this.formats.get(repo);
    if (!f) { f = git(repo, ['rev-parse', '--show-object-format'], 3000).stdout.trim() === 'sha256' ? 'sha256' : 'sha1'; this.formats.set(repo, f); }
    return f;
  }
}

/** Entries `git status` reports for the pathspecs (null: whole tree), filtered by what the operation destroys.
 *  Paths come back relative to the repository root. Null — git did not answer. */
function changed(cwd: string, pathspecs: string[] | null, mode: Mode, timeoutMs = 15000): string[] | null {
  const r = git(cwd, ['status', '--porcelain', '-z', '-uall', ...(pathspecs ? ['--', ...pathspecs] : [])], timeoutMs);
  if (r.rc !== 0) return null;
  const out: string[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2); const path = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '!!') continue;
    const take = mode === 'untracked' ? xy === '??'
      : mode === 'any' ? true
        : xy === '??' ? false
          : mode === 'worktree' ? xy[1] !== ' ' : true;
    if (take) out.push(path);
  }
  return out;
}
const literal = (repo: string, abs: string): string => `:(literal)${relative(repo, physical(abs)) || '.'}`;

function blobOid(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Directories holding a `.git` entry under `dir`, level by level to `depth` — a worktree right under `dir` is found before
 *  any deep subtree is walked; node_modules and symbolic links are not entered (rm -rf removes a link, not its target).
 *  false — more than MAX_DIRS directories, the list is not complete. */
function gitDirs(dir: string, depth: number, out: Set<string>): boolean {
  let level = [dir];
  let seen = 0;
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const cur of level) {
      let names: string[];
      try { names = readdirSync(cur); } catch { continue; }
      if (names.includes('.git')) out.add(physical(cur));
      if (d === depth) continue;
      for (const n of names) {
        if (n === '.git' || n === 'node_modules') continue;
        const p = join(cur, n);
        let isDir = false;
        try { isDir = lstatSync(p).isDirectory(); } catch { continue; }
        if (!isDir) continue;
        if (++seen > MAX_DIRS) return false;
        next.push(p);
      }
    }
    level = next;
  }
  return true;
}

/** Blob ids the path held in the commits that touched it (git log --raw): a revert writes one of them back. Null — git
 *  did not answer. The index, a stash and dangling objects are not history: the root's staged fix is no revert target. */
function pathHistory(repo: string, rel: string, timeoutMs = 8000): Set<string> | null {
  const r = git(repo, ['log', '--format=', '--raw', '--no-abbrev', '-n', '500', '--', `:(literal)${rel}`], timeoutMs);
  if (r.rc !== 0) return null;
  const out = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /.exec(line);
    if (!m) continue;
    for (const oid of [m[1], m[2]]) if (!/^0+$/.test(oid)) out.add(oid);
  }
  return out;
}

// ---------- the command ----------

interface Cmd {
  seg: SegmentAt; src: string[]; dynamic: number[]; restAt: number; scope: string;
  /** stdout file of the segment's own redirect, `<` file, here-doc bodies — from a parse of the segment's own text. */
  stdoutTo: string | null; stdin: string | null; heredocs: string[]; writes: string[];
}

function commandOf(parse: { segments: Segment[] }, seg: SegmentAt, i: number): Cmd {
  const ps = parse.segments[i];
  const own = buildModel<null>(seg.raw, () => null).pipelines.flat().filter((st) => st.level === 0);
  const top = own.find((st) => st.name === seg.name) ?? own[own.length - 1];
  return {
    seg, src: ps?.src ?? seg.argv, dynamic: ps?.dynamic ?? [], restAt: seg.argv.length - seg.rest.length,
    scope: ps?.flow?.scope ?? '', stdoutTo: top?.stdoutTo ?? null, stdin: top?.stdin ?? null,
    heredocs: seg.heredocs, writes: own.flatMap((st) => st.writes),
  };
}

interface Overwrite { op: string; target: string; content: Buffer | null; stale: boolean }

class Judge {
  hits: Hit[] = [];
  /** Absolute paths an earlier stage of this command writes: a source read from them now is stale. */
  written = new Set<string>();
  /** Operations that reached a protected repository — the denominator of the rollout count — and the first of them. */
  judged = 0;
  firstOp: string | null = null;
  private pending: Overwrite[] = [];
  readonly repos: Repos;
  readonly env: NodeJS.ProcessEnv;
  constructor(repos: Repos, env: NodeJS.ProcessEnv) { this.repos = repos; this.env = env; }

  count(op: string): void { this.judged++; this.firstOp ??= op; }
  deny(op: string, why: string, files: string[]): void { this.hits.push({ kind: 'deny', op, why, files }); }
  unknown(op: string, why: string): void { this.hits.push({ kind: 'unknown', op, why, files: [] }); }

  /** Words of rest[from..] expanded as the shell will; null — one of them cannot be known before the run. */
  words(c: Cmd, idx: number[], glob: boolean): string[] | null {
    const out: string[] = [];
    for (const k of idx) {
      const at = c.restAt + k;
      if (c.dynamic.includes(at)) return null;
      const w = expandWord(c.src[at] ?? c.seg.rest[k], { ...this.env, ...c.seg.env }, c.seg.cwd, { glob });
      if (!w) return null;
      out.push(...w);
    }
    return out;
  }
  abs(word: string, cwd: string | null): string | null {
    if (isAbsolute(word)) return word;
    return cwd === null ? null : resolve(cwd, word);
  }

  /** git verbs that destroy by pathspec or for the whole tree. */
  gitScope(op: string, cwd: string | null, pathspecs: string[] | null, mode: Mode): void {
    if (cwd === null) { this.unknown(op, 'каталог команды не определён'); return; }
    const repo = this.repos.guarded(cwd);
    if (!repo) return;
    if (pathspecs && !pathspecs.length) return;
    this.count(op);
    const files = changed(cwd, pathspecs, mode);
    if (files === null) { this.unknown(op, `git status не ответил в ${repo}`); return; }
    if (files.length) this.deny(op, `уничтожит незакоммиченную правку (${repo})`, files);
  }

  /** A file overwritten with `content` (null — not known before the run); judged in settle(), once per repository. */
  overwrite(op: string, target: string, content: Buffer | null, stale: boolean): void { this.pending.push({ op, target, content, stale }); }

  /** The pending overwrites, one git status and one cat-file --batch-check per repository. A revert is new content the path
   *  held in a commit of its history, written over an uncommitted change (staged or not — a staged fix is lost at the next
   *  `git add`) that is not that content. A backup of the change, the root's staged fix, a stash are no history and pass. */
  settle(): void {
    const byRepo = new Map<string, Overwrite[]>();
    for (const w of this.pending) {
      const repo = this.repos.guarded(w.target);
      if (repo) (byRepo.get(repo) ?? byRepo.set(repo, []).get(repo)!).push(w);
    }
    this.pending = [];
    for (const [repo, list] of byRepo) {
      for (const w of list) this.count(w.op);
      const relOf = (w: Overwrite): string => relative(repo, physical(w.target));
      const specs = [...new Set(list.map((w) => literal(repo, w.target)))];
      const dirty = new Set<string>();
      let failed = false;
      for (let i = 0; i < specs.length && !failed; i += 300) {
        const part = changed(repo, specs.slice(i, i + 300), 'all');
        if (part === null) failed = true; else for (const f of part) dirty.add(f);
      }
      if (failed) { this.unknown(list[0].op, `git status не ответил в ${repo}`); continue; }
      const hit = list.filter((w) => dirty.has(relOf(w)));
      for (const w of hit.filter((x) => x.stale || x.content === null)) this.unknown(w.op, `источник для ${basename(w.target)} не прочитать до запуска, а у цели незакоммиченная правка`);
      const known = hit.filter((x) => !x.stale && x.content !== null);
      if (!known.length) continue;
      const fmt = this.repos.format(repo);
      const oids = new Map(known.map((w) => [w, blobOid(w.content as Buffer, fmt)] as const));
      const held = objectsExist(repo, [...new Set(oids.values())]);
      if (held === null) { this.unknown(known[0].op, `git cat-file не ответил в ${repo}`); continue; }
      const denied = new Map<string, string[]>();
      for (const w of known) {
        const oid = oids.get(w) as string;
        const now = this.read(w.target);
        if (!held.has(oid) || (now !== null && blobOid(now, fmt) === oid)) continue;
        const history = pathHistory(repo, relOf(w));
        if (history === null) { this.unknown(w.op, `git log не ответил в ${repo}`); continue; }
        if (history.has(oid)) (denied.get(w.op) ?? denied.set(w.op, []).get(w.op)!).push(relOf(w));
      }
      for (const [op, files] of denied) this.deny(op, `запишет закоммиченную версию поверх незакоммиченной правки (${repo})`, files);
    }
  }

  /** A path whose worktree content is removed (rm, mv away from its repository); a directory also takes the trees in it.
   *  A symbolic link is removed itself, not its target. */
  remove(op: string, target: string, recursive: boolean): void {
    let isDir = false;
    try { if (lstatSync(target).isSymbolicLink()) return; isDir = statSync(target).isDirectory(); } catch { return; }
    if (isDir && !recursive) return;
    if (isDir) this.nested(op, target);
    const repo = this.repos.guarded(target);
    if (!repo) return;
    this.count(op);
    const files = changed(repo, [literal(repo, target)], 'worktree');
    if (files === null) { this.unknown(op, `git status не ответил в ${repo}`); return; }
    if (files.length) this.deny(op, `удалит незакоммиченную правку (${repo})`, files);
  }

  /** Repositories and linked worktrees inside a directory a command removes: the outer status marks an ignored worktree
   *  directory `!!` and says nothing of its changes (.claude/worktrees of the brain sits under info/exclude). */
  nested(op: string, dir: string, untrackedOnly = false): void {
    const root = physical(dir);
    if (this.repos.scratch(root)) return;
    try { if (lstatSync(dir).isSymbolicLink()) return; } catch { return; }
    const trees = new Set<string>();
    const outer = this.repos.repoOf(root);
    if (outer !== null) {
      const r = git(outer, ['worktree', 'list', '--porcelain'], 5000);
      if (r.rc === 0) for (const l of r.stdout.split('\n')) if (l.startsWith('worktree ')) trees.add(physical(l.slice(9)));
    }
    if (basename(root) !== 'node_modules' && !gitDirs(root, 4, trees)) {
      if (outer !== null && !this.repos.scratch(outer)) this.unknown(op, `в ${basename(root)} больше ${MAX_DIRS} каталогов — вложенные деревья не перебрать`);
      return;
    }
    for (const t of trees) {
      if (!within(t, root) || t === outer || this.repos.scratch(t)) continue;
      if (untrackedOnly && outer !== null && /^160000 /.test(git(outer, ['ls-files', '-s', '--', `:(literal)${relative(outer, t)}`], 5000).stdout)) continue;
      this.count(op);
      const files = changed(t, null, 'any');
      if (files === null) this.unknown(op, `git status не ответил в ${t}`);
      else if (files.length) this.deny(op, `удалит дерево ${t} с незакоммиченными правками`, files);
    }
  }

  /** Committed content (git show, git cat-file) written over a file: a revert whatever the revision. */
  committed(op: string, target: string): void {
    const repo = this.repos.guarded(target);
    if (!repo) return;
    this.count(op);
    const files = changed(repo, [literal(repo, target)], 'all');
    if (files === null) this.unknown(op, `git status не ответил в ${repo}`);
    else if (files.length) this.deny(op, `запишет закоммиченную версию поверх незакоммиченной правки (${repo})`, files);
  }

  read(path: string): Buffer | null { try { return readFileSync(path); } catch { return null; } }
}

// ---------- operations ----------

const flagIn = (args: string[], short: string, long: string[]): boolean =>
  args.some((a) => long.includes(a) || (/^-[A-Za-z]+$/.test(a) && a.includes(short)));
const positional = (args: string[], valued: ReadonlySet<string>): number[] => {
  const out: number[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { for (let j = k + 1; j < args.length; j++) out.push(j); break; }
    if (valued.has(a)) { k++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(k);
  }
  return out;
};

function isCommit(cwd: string, word: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '-q', `${word}^{commit}`], 3000).rc === 0;
}

function judgeGit(j: Judge, c: Cmd): void {
  const call = parseGit(c.seg.rest, c.seg.cwd, { ...j.env, ...c.seg.env });
  if (!call) return;
  const op = `git ${call.verb}`;
  const argIdx = (k: number): number => c.seg.rest.length - call.args.length + k;
  const redirected = c.seg.argv.slice(0, c.restAt).some((a) => /^GIT_(DIR|WORK_TREE)=/.test(a))
    || c.seg.rest.slice(0, c.seg.rest.length - call.args.length).some((a) => /^--(git-dir|work-tree)(=|$)/.test(a))
    || c.seg.env.GIT_DIR !== j.env.GIT_DIR || c.seg.env.GIT_WORK_TREE !== j.env.GIT_WORK_TREE;
  const a = call.args;
  const DESTRUCTIVE = new Set(['checkout', 'restore', 'reset', 'switch', 'clean', 'rm', 'worktree', 'apply']);
  if (call.verb === 'stash') {
    const sub = a[0] !== undefined && !a[0].startsWith('-') ? a[0] : 'push';
    if (sub !== 'list' && sub !== 'show' && sub !== 'create') j.deny(op, 'стек stash общий для всех worktree сессии — субагент его не трогает', []);
    return;
  }
  if (DESTRUCTIVE.has(call.verb) && redirected) { j.unknown(op, '--git-dir/--work-tree уводят команду в другое дерево'); return; }
  const cwd = call.cwd;
  const words = (idx: number[], glob = true): string[] | null => j.words(c, idx.map(argIdx), glob);
  switch (call.verb) {
    case 'checkout': {
      const force = flagIn(a, 'f', ['--force']);
      const patch = a.includes('-p') || a.includes('--patch');
      const creates = a.includes('--orphan') || a.some((x) => /^-[A-Za-z]+$/.test(x) && /[bB]/.test(x));
      if (a.some((x) => x.startsWith('--pathspec-from-file'))) { j.gitScope(op, cwd, null, 'all'); return; }
      const dd = a.indexOf('--');
      const pos = positional(dd < 0 ? a : a.slice(0, dd), new Set(['-b', '-B', '--orphan', '--conflict']));
      if (dd >= 0) {
        const paths = words(a.slice(dd + 1).map((_, k) => dd + 1 + k));
        if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
        if (!paths.length) { if (force || patch) j.gitScope(op, cwd, null, force || pos.length ? 'all' : 'worktree'); return; }
        j.gitScope(op, cwd, paths, pos.length ? 'all' : 'worktree');
        return;
      }
      if (!pos.length || creates) { if (force || (patch && !creates)) j.gitScope(op, cwd, null, force ? 'all' : 'worktree'); return; }
      if (cwd === null) { j.unknown(op, 'каталог команды не определён'); return; }
      const first = words([pos[0]], false);
      if (first === null) { j.unknown(op, 'первый аргумент собран подстановкой — ветка это или путь, не доказать'); return; }
      if (first.length === 1 && isCommit(cwd, first[0])) {
        if (pos.length === 1) { if (force || patch) j.gitScope(op, cwd, null, 'all'); return; }
        const paths = words(pos.slice(1));
        if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
        j.gitScope(op, cwd, paths, 'all');
        return;
      }
      const paths = words(pos);
      if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
      j.gitScope(op, cwd, paths, 'worktree');
      return;
    }
    case 'restore': {
      let staged = false; let worktree = false; let source = false;
      for (const x of a) {
        if (x === '--staged') staged = true;
        else if (x === '--worktree') worktree = true;
        else if (x === '--source' || x.startsWith('--source=')) source = true;
        else if (/^-[A-Za-z]+$/.test(x)) { staged ||= x.includes('S'); worktree ||= x.includes('W'); source ||= x.includes('s'); }
      }
      if (staged && !worktree) return;
      const mode: Mode = source || staged ? 'all' : 'worktree';
      if (a.some((x) => x.startsWith('--pathspec-from-file'))) { j.gitScope(op, cwd, null, mode); return; }
      const paths = words(positional(a, new Set(['-s', '--source', '--conflict'])));
      if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
      if (!paths.length && (a.includes('-p') || a.includes('--patch'))) { j.gitScope(op, cwd, null, mode); return; }
      j.gitScope(op, cwd, paths, mode);
      return;
    }
    case 'reset':
      if (a.includes('--hard') || a.includes('--merge')) j.gitScope(`${op} ${a.includes('--hard') ? '--hard' : '--merge'}`, cwd, null, 'all');
      return;
    case 'switch':
      if (a.some((x) => x === '--discard-changes' || x === '--force') || flagIn(a.filter((x) => x !== '-c' && x !== '-C'), 'f', [])) j.gitScope(`${op} --discard-changes`, cwd, null, 'all');
      return;
    case 'clean': {
      const forces = a.filter((x) => /^-[A-Za-z]+$/.test(x)).join('').split('').filter((ch) => ch === 'f').length + a.filter((x) => x === '--force').length;
      const dry = flagIn(a, 'n', ['--dry-run']);
      const onlyIgnored = flagIn(a, 'X', []) && !flagIn(a, 'x', []);
      if (!forces || dry) return;
      const pos = positional(a, new Set(['-e', '--exclude']));
      const paths = pos.length ? words(pos) : ['.'];
      if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
      if (forces >= 2) for (const p of paths) { const d = j.abs(p, cwd); if (d !== null) j.nested(`${op} -ff`, d, true); }
      if (!onlyIgnored) j.gitScope(`${op} -f`, cwd, paths, 'untracked');
      return;
    }
    case 'rm': {
      if (!flagIn(a, 'f', ['--force']) || a.includes('--cached') || flagIn(a, 'n', ['--dry-run'])) return;
      const paths = words(positional(a, new Set(['--pathspec-from-file'])));
      if (paths === null) { j.unknown(op, 'pathspec собран подстановкой'); return; }
      j.gitScope(`${op} -f`, cwd, paths, 'all');
      return;
    }
    case 'worktree': {
      if (a[0] !== 'remove' || !flagIn(a.slice(1), 'f', ['--force'])) return;
      const pos = positional(a.slice(1), new Set()).map((k) => k + 1);
      const tree = words(pos, false);
      if (tree === null || tree.length !== 1) { j.unknown(op, 'дерево собрано подстановкой'); return; }
      const path = j.abs(tree[0], cwd);
      if (path === null) { j.unknown(op, 'каталог команды не определён'); return; }
      j.gitScope(`${op} remove --force`, path, null, 'any');
      return;
    }
    case 'apply': judgePatch(j, c, op, a, argIdx, cwd, true); return;
    default:
  }
}

/** Paths a unified diff touches, every candidate prefix stripped: the gate does not guess -p, it asks about all of them. */
function patchPaths(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^(?:\+\+\+|---) (\S+)/.exec(line) ?? /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (!m) continue;
    for (const raw of m.slice(1)) {
      if (!raw || raw === '/dev/null') continue;
      const parts = raw.split('/');
      for (let k = 0; k < parts.length; k++) out.add(parts.slice(k).join('/'));
    }
  }
  return [...out];
}

function judgePatch(j: Judge, c: Cmd, op: string, a: string[], argIdx: (k: number) => number, cwd: string | null, isGit: boolean): void {
  const readOnly = isGit
    ? a.some((x) => ['--check', '--stat', '--numstat', '--summary'].includes(x)) || (a.includes('--cached') && !a.includes('--index'))
    : a.some((x) => x === '--dry-run' || x === '-C' || x === '--check');
  if (readOnly) return;
  const reverse = flagIn(a, 'R', ['--reverse']);
  const name = `${op}${reverse ? ' -R' : ''}`;
  if (cwd === null) { j.unknown(name, 'каталог команды не определён'); return; }
  const repo = j.repos.guarded(cwd);
  if (!repo) return;
  let text: string | null = null;
  let stale = false;
  const valued = isGit ? new Set(['-p', '--directory', '--include', '--exclude', '-C']) : new Set(['-p', '-i', '--input', '-d', '--directory', '-o', '--output', '-F', '--fuzz', '-r', '-z', '-B', '-Y', '-V']);
  const input = isGit ? null : (() => { const k = a.findIndex((x) => x === '-i' || x === '--input'); return k >= 0 ? a[k + 1] ?? null : a.find((x) => x.startsWith('--input='))?.slice(8) ?? null; })();
  const files = isGit ? j.words(c, positional(a, valued).map(argIdx), true) : null;
  if (isGit && files === null) { j.unknown(name, 'файл патча собран подстановкой'); return; }
  const source = isGit ? (files && files.length && files[0] !== '-' ? files : null) : input !== null ? [input] : c.stdin !== null ? [c.stdin] : null;
  if (source) {
    const parts: string[] = [];
    for (const f of source) {
      const p = j.abs(f, cwd);
      if (p === null) { j.unknown(name, 'каталог команды не определён'); return; }
      if (j.written.has(physical(p))) stale = true;
      const b = j.read(p);
      if (b === null) { j.unknown(name, `патч ${basename(p)} не прочитан`); return; }
      parts.push(b.toString('utf8'));
    }
    text = parts.join('\n');
  } else if (c.heredocs.length) text = c.heredocs.join('');
  if (stale) { j.unknown(name, 'патч пишет эта же команда раньше — гейт прочитал бы старый файл'); return; }
  const specs = text === null ? null : [...new Set(patchPaths(text).flatMap((p) => [resolve(cwd, p), resolve(repo, p)])
    .filter((t) => within(physical(t), repo) && physical(t) !== repo).map((t) => literal(repo, t)))];
  if (specs !== null && !specs.length) return;
  const changedFiles = changed(specs === null ? cwd : repo, specs, 'worktree');
  if (changedFiles === null) { j.unknown(name, `git status не ответил в ${repo}`); return; }
  if (!changedFiles.length) return;
  if (reverse) j.deny(name, `обратный патч по файлам с незакоммиченной правкой (${repo})`, changedFiles);
  else j.unknown(name, `патч ложится на файлы с незакоммиченной правкой (${repo}) — откат это или правка, не доказать`);
}

const COPIERS = new Set(['cp', 'mv', 'install', 'ditto', 'rsync']);
const COPY_VALUED: Record<string, ReadonlySet<string>> = {
  cp: new Set(['-t', '--target-directory', '-S', '--suffix']), mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
  install: new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix', '-t', '--target-directory', '-f', '-B']),
  ditto: new Set(['--arch', '--bom']), rsync: new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--rsync-path', '--log-file', '--temp-dir', '-T', '--partial-dir', '--chmod', '--chown', '--backup-dir', '--suffix']),
};

function walk(dir: string, out: string[]): boolean {
  let names: string[];
  try { names = readdirSync(dir); } catch { return true; }
  for (const n of names) {
    if (n === '.git') continue;
    const p = join(dir, n);
    let d = false;
    try { d = statSync(p).isDirectory(); } catch { continue; }
    if (d) { if (!walk(p, out)) return false; } else { out.push(p); if (out.length > MAX_WALK) return false; }
  }
  return true;
}

function judgeCopy(j: Judge, c: Cmd, name: string): void {
  const rest = c.seg.rest;
  if (name === 'install' && rest.some((x) => x === '-d' || x === '--directory')) return;
  if (name === 'rsync' && rest.some((x) => x.startsWith('--files-from'))) { j.unknown(name, 'список файлов rsync приходит из файла'); return; }
  const pos = positional(rest, COPY_VALUED[name] ?? new Set());
  const words = j.words(c, pos, true);
  if (words === null) { j.unknown(name, 'путь собран подстановкой'); return; }
  const tIdx = rest.findIndex((x) => x === '-t' || x === '--target-directory');
  const tEq = rest.find((x) => x.startsWith('--target-directory='));
  let dst: string | undefined; let sources: string[];
  if (tIdx >= 0 || tEq) { dst = tEq ? tEq.slice(19) : rest[tIdx + 1]; sources = words; }
  else { dst = words[words.length - 1]; sources = words.slice(0, -1); }
  if (!dst || !sources.length || /^[^/]*:/.test(dst)) return;
  const dstAbs = j.abs(dst, c.seg.cwd);
  if (dstAbs === null) { j.unknown(name, 'каталог команды не определён'); return; }
  let dstIsDir = dst.endsWith('/') || sources.length > 1;
  try { dstIsDir ||= statSync(dstAbs).isDirectory(); } catch { dstIsDir ||= false; }
  for (const s of sources) {
    if (/^[^/]*:/.test(s)) continue;
    if (STDIN.test(s)) { j.overwrite(`${name} stdin`, dstIsDir ? join(dstAbs, 'stdin') : dstAbs, null, true); continue; }
    const src = j.abs(s, c.seg.cwd);
    if (src === null) { j.unknown(name, 'каталог команды не определён'); return; }
    const stale = j.written.has(physical(src));
    if (name === 'mv') {
      const from = j.repos.guarded(src);
      if (from !== null && j.repos.repoOf(dstIsDir ? dstAbs : dirname(dstAbs)) !== from) j.remove(`mv ${basename(src)}`, src, true);
    }
    let isDir = false;
    try { isDir = statSync(src).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      const target = dstIsDir ? join(dstAbs, basename(src)) : dstAbs;
      j.overwrite(`${name} ${basename(src)}`, target, stale ? null : j.read(src), stale);
      continue;
    }
    const files: string[] = [];
    if (!walk(src, files)) { j.unknown(name, `в ${basename(src)} больше ${MAX_WALK} файлов — цели не перебрать`); return; }
    for (const f of files) {
      const rel = relative(src, f);
      const content = stale ? null : j.read(f);
      for (const target of new Set([join(dstAbs, rel), join(dstAbs, basename(src), rel)])) j.overwrite(`${name} -R ${basename(src)}`, target, content, stale);
    }
  }
}

function judgeRemove(j: Judge, c: Cmd, name: string): void {
  const recursive = name === 'rm' && flagIn(c.seg.rest, 'r', ['--recursive']) || flagIn(c.seg.rest, 'R', []);
  const words = j.words(c, positional(c.seg.rest, new Set()), true);
  if (words === null) { j.unknown(name, 'путь собран подстановкой'); return; }
  for (const w of words) {
    const p = j.abs(w, c.seg.cwd);
    if (p === null) { j.unknown(name, 'каталог команды не определён'); return; }
    j.remove(name, p, recursive);
  }
}

/** Committed content written out through a redirect or a pipe into tee: git show <rev>:<path>, git cat-file. */
function committedProducer(c: Cmd, env: NodeJS.ProcessEnv): boolean {
  if (c.seg.name !== 'git') return false;
  const call = parseGit(c.seg.rest, c.seg.cwd, env);
  return call !== null && (call.verb === 'show' || call.verb === 'cat-file');
}

/** cat writing into `target`: its file words, else its `<` file, else what the pipe brings — committed content from git
 *  show; anything else in the pipe is the output of a command, not judged. */
function judgeCatInto(j: Judge, c: Cmd, target: string, op: string, from: Cmd | null): void {
  const own = j.words(c, positional(c.seg.rest, new Set()), true);
  if (own === null) { j.unknown(op, 'путь собран подстановкой'); return; }
  const words = own.length ? own : c.stdin !== null ? [c.stdin] : [];
  if (!words.length) { if (from && committedProducer(from, { ...j.env, ...from.seg.env })) j.committed(op, target); return; }
  const parts: Buffer[] = [];
  let stale = false;
  for (const w of words) {
    const p = j.abs(w, c.seg.cwd);
    if (p === null) { j.unknown(op, 'каталог команды не определён'); return; }
    stale ||= j.written.has(physical(p));
    const b = j.read(p);
    if (b === null) { j.overwrite(op, target, null, true); return; }
    parts.push(b);
  }
  j.overwrite(op, target, Buffer.concat(parts), stale);
}

const pipedFrom = (cmds: Cmd[], i: number): Cmd | null => {
  const scope = cmds[i].scope;
  const last = scope.slice(scope.lastIndexOf('/') + 1);
  if (!/^[|~]/.test(last)) return null;
  for (let k = i - 1; k >= 0; k--) {
    const s = cmds[k].scope;
    if (s.slice(0, s.lastIndexOf('/')) === scope.slice(0, scope.lastIndexOf('/')) && /^\|/.test(s.slice(s.lastIndexOf('/') + 1))) return cmds[k];
  }
  return null;
};

function judgeSegment(j: Judge, cmds: Cmd[], i: number): void {
  const c = cmds[i];
  const name = basename(c.seg.name);
  const env = { ...j.env, ...c.seg.env };
  if (name === 'xargs' || (name === 'find' && c.seg.argv.some((x) => /^-(exec|execdir|ok|okdir)$/.test(x)))) {
    const inner = c.seg.argv.slice(1).map((x) => basename(x));
    const verb = inner.find((x) => x === 'git' || COPIERS.has(x) || x === 'rm' || x === 'unlink' || x === 'patch');
    if (!verb) return;
    if (verb === 'git' && c.seg.argv.includes('stash')) { j.deny('git stash', 'стек stash общий для всех worktree сессии — субагент его не трогает', []); return; }
    if (verb === 'git' && !c.seg.argv.some((x) => JUDGED_WORD.test(` ${x} `))) return;
    const cwd = c.seg.cwd;
    if (cwd === null) { j.unknown(`${name} ${verb}`, 'каталог команды не определён'); return; }
    const repo = j.repos.guarded(cwd);
    if (!repo) return;
    const files = changed(cwd, null, 'any');
    if (files === null || files.length) j.unknown(`${name} ${verb}`, `пути приходят из ${name === 'xargs' ? 'stdin' : 'find'}, а в ${repo} есть незакоммиченное — что тронет команда, не доказать`);
    return;
  }
  if (SHELLS.has(name) && !c.seg.rest.some((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x)) && !c.seg.rest.some((x) => !x.startsWith('-'))) {
    const fed = pipedFrom(cmds, i);
    const text = [...c.heredocs, ...(fed ? [fed.seg.raw, ...fed.heredocs] : [])].join('\n');
    if (JUDGED_WORD.test(text)) j.unknown(`${name} из stdin`, 'скрипт приходит оболочке через stdin, его команды не разобраны');
    return;
  }
  if (name === 'git') judgeGit(j, c);
  else if (COPIERS.has(name)) judgeCopy(j, c, name);
  else if (name === 'rm' || name === 'unlink') judgeRemove(j, c, name);
  else if (name === 'patch') judgePatch(j, c, 'patch', c.seg.rest, (k) => k, c.seg.cwd, false);
  else if ((name === 'cat' || name === 'tee') && c.heredocs.length && (c.stdoutTo !== null || name === 'tee')) {
    const targets = name === 'tee' ? j.words(c, positional(c.seg.rest, new Set()), true) : [c.stdoutTo as string];
    if (targets === null) { j.unknown(name, 'путь собран подстановкой'); return; }
    for (const w of targets) { const t = j.abs(w, c.seg.cwd); if (t === null) j.unknown(name, 'каталог команды не определён'); else j.overwrite(`${name} <<here-doc ${basename(t)}`, t, Buffer.from(c.heredocs.join(''), 'utf8'), false); }
  } else if (name === 'cat' && c.stdoutTo !== null && !c.heredocs.length) {
    const t = j.abs(c.stdoutTo, c.seg.cwd);
    if (t === null) j.unknown('cat >', 'каталог команды не определён'); else judgeCatInto(j, c, t, `cat > ${basename(t)}`, pipedFrom(cmds, i));
  } else if (name === 'tee' && !flagIn(c.seg.rest, 'a', ['--append'])) {
    const from = pipedFrom(cmds, i);
    if (!from && c.stdin === null) return;
    const targets = j.words(c, positional(c.seg.rest, new Set()), true);
    if (targets === null) { j.unknown('tee', 'путь собран подстановкой'); return; }
    for (const w of targets) {
      const t = j.abs(w, c.seg.cwd);
      if (t === null) { j.unknown('tee', 'каталог команды не определён'); return; }
      if (!from) { const a = j.abs(c.stdin as string, c.seg.cwd); j.overwrite(`tee ${basename(t)}`, t, a === null ? null : j.read(a), a === null || j.written.has(physical(a))); continue; }
      if (committedProducer(from, env)) j.committed('git show | tee', t);
      else if (basename(from.seg.name) === 'cat' && !from.heredocs.length) judgeCatInto(j, from, t, `cat | tee ${basename(t)}`, pipedFrom(cmds, cmds.indexOf(from)));
    }
  }
  if (c.stdoutTo !== null && committedProducer(c, env)) {
    const t = j.abs(c.stdoutTo, c.seg.cwd);
    if (t === null) j.unknown('git show >', 'каталог команды не определён'); else j.committed(`git show > ${basename(t)}`, t);
  }
}

/** Text the parsers did not read: a judged word there is unknown — no gate saw that command. */
function unread(command: string, parse: { unknown: string[]; opaque: { text: string }[] }): string | null {
  const m = buildModel<null>(command, () => null);
  const texts = [...m.unparsed, ...m.deep, ...parse.unknown, ...parse.opaque.map((o) => o.text),
    ...(m.tags.includes('nested-shell-depth') || m.tags.includes('parse-error') ? [command] : [])];
  const t = texts.find((x) => JUDGED_WORD.test(x));
  return t === undefined ? null : t;
}

export function judgeBash(command: string, p: PreToolUsePayload, env: NodeJS.ProcessEnv): { hits: Hit[]; judged: number; op: string | null } {
  const repos = new Repos(p, env);
  const j = new Judge(repos, env);
  const parse = tokenize(command);
  const hidden = unread(command, parse);
  if (hidden !== null) j.unknown('нечитаемая часть команды', `разборщик не прочёл «${hidden.slice(0, 60)}», а там операция над файлами`);
  const segs = segmentsWithCwd(parse, p.cwd ?? null, env);
  const cmds = segs.map((s, i) => commandOf(parse, s, i));
  for (let i = 0; i < cmds.length; i++) {
    judgeSegment(j, cmds, i);
    for (const w of cmds[i].writes) { const a = j.abs(w, cmds[i].seg.cwd); if (a !== null) j.written.add(physical(a)); }
  }
  j.settle();
  return { hits: j.hits, judged: j.judged, op: j.firstOp };
}

// ---------- Write / Edit ----------

function resultOf(p: PreToolUsePayload, file: string): string | null {
  const input = p.tool_input as Record<string, unknown>;
  if (p.tool_name === 'Write') return typeof input.content === 'string' ? input.content : null;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const edits = p.tool_name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits as Record<string, unknown>[]
    : p.tool_name === 'Edit' ? [input] : [];
  if (!edits.length) return null;
  for (const e of edits) {
    const from = e.old_string; const to = e.new_string;
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !text.includes(from)) return null;
    text = e.replace_all === true ? text.split(from).join(to) : text.slice(0, text.indexOf(from)) + to + text.slice(text.indexOf(from) + from.length);
  }
  return text;
}

/** Was the file clean when this agent started? true/false from its SubagentStart snapshot; null — no snapshot of the repo. */
function cleanAtStart(stateDir: string, session: string, agent: string, repo: string, rel: string): boolean | null {
  let db;
  try { db = State.readOnly(stateDir); } catch { return null; }
  if (!db) return null;
  try {
    const row = db.prepare('SELECT snapshot FROM agent_window WHERE session_id = ? AND agent_id = ?').get(session, agent) as { snapshot: string | null } | undefined;
    if (!row?.snapshot) return null;
    const snap = JSON.parse(row.snapshot) as Record<string, Record<string, string>>;
    const key = Object.keys(snap).find((k) => physical(k) === repo);
    if (key === undefined || Object.keys(snap[key]).length >= SNAPSHOT_CAP) return null;
    return !(rel in snap[key]);
  } catch { return null; } finally { db.close(); }
}

/** The agent's own last named write — its Write or Edit, never a Bash call friction attributed by snapshots, which can
 *  carry the root's concurrent edit — is what the file holds now (tool_write, digest right after the call). */
function ownLatest(stateDir: string, session: string, agent: string, repo: string, rel: string, file: string): boolean {
  const now = windowDigest(file);
  if (now === null) return false;
  let db;
  try { db = State.readOnly(stateDir); } catch { return false; }
  if (!db) return false;
  try {
    const rows = db.prepare('SELECT repo, digest FROM tool_write WHERE session_id = ? AND writer = ? AND path = ? AND since IS NULL ORDER BY at DESC').all(session, agent, rel) as Array<{ repo: string; digest: string }>;
    return rows.find((r) => physical(r.repo) === repo)?.digest === now;
  } catch { return false; } finally { db.close(); }
}

/** Write/Edit whose result is a committed version of the path, over an uncommitted change: denied unless the change is the
 *  agent's own — the file was clean when it started and holds now what its own last named write left. */
export function judgeWrite(p: PreToolUsePayload, env: NodeJS.ProcessEnv, stateDir: string): { hits: Hit[]; judged: number; op: string | null } {
  const none = { hits: [] as Hit[], judged: 0, op: null };
  const input = p.tool_input as Record<string, unknown>;
  const raw = typeof input.file_path === 'string' ? input.file_path : null;
  if (raw === null) return none;
  const file = isAbsolute(raw) ? raw : resolve(p.cwd ?? '/', raw);
  const repos = new Repos(p, env);
  const repo = repos.guarded(file);
  if (!repo) return none;
  const next = resultOf(p, file);
  if (next === null) return none;
  const op = `${p.tool_name} ${basename(file)}`;
  const files = changed(repo, [literal(repo, file)], 'all', 5000);
  if (files === null) return { hits: [{ kind: 'unknown', op, why: `git status не ответил в ${repo}`, files: [] }], judged: 1, op };
  if (!files.length) return { hits: [], judged: 1, op };
  const oid = blobOid(Buffer.from(next, 'utf8'), repos.format(repo));
  const held = objectsExist(repo, [oid], 4000);
  if (held === null) return { hits: [{ kind: 'unknown', op, why: `git cat-file не ответил в ${repo}`, files: [] }], judged: 1, op };
  if (!held.has(oid)) return { hits: [], judged: 1, op };
  const rel = relative(repo, physical(file));
  const history = pathHistory(repo, rel, 4000);
  if (history === null) return { hits: [{ kind: 'unknown', op, why: `git log не ответил в ${repo}`, files: [] }], judged: 1, op };
  if (!history.has(oid)) return { hits: [], judged: 1, op };
  const atStart = cleanAtStart(stateDir, p.session_id, p.agent_id as string, repo, rel);
  if (atStart === null) return { hits: [{ kind: 'unknown', op, why: `файл возвращается к закоммиченной версии, а снимка старта агента по ${repo} нет — чья правка, не доказать`, files: [] }], judged: 1, op };
  if (atStart && ownLatest(stateDir, p.session_id, p.agent_id as string, repo, rel, file)) return { hits: [], judged: 1, op };
  return { hits: [{ kind: 'deny', op, why: `вернёт к закоммиченной версии правку ${atStart ? 'не этого агента — после его старта файл правил другой' : 'которая была до старта агента'} (${repo})`, files }], judged: 1, op };
}

// ---------- verdict ----------

const ADVICE = 'Сравнение «до/после» — в копии: git worktree add <scratchpad>/<имя> HEAD или файл рядом; свою правку откатывай Edit/Write; stash не трогай.';

function render(hits: Hit[], unknownAs: 'note' | 'enforce'): Verdict {
  const denies = hits.filter((h) => h.kind === 'deny');
  if (denies.length) {
    const lines = denies.slice(0, 5).map((h) => {
      const shown = h.files.slice(0, 5).join(', ');
      return `${h.op}: ${h.why}${h.files.length ? ` — ${shown}${h.files.length > 5 ? ` и ещё ${h.files.length - 5}` : ''}` : ''}`;
    });
    return { kind: 'deny', gate: NAME, reason: `${NAME}: ${lines.join('; ')}. Субагент не уничтожает незакоммиченную правку: прерванный агент её не вернёт (INC-SUBAGENT-REVERTS-WORKING-FILES). ${ADVICE}` };
  }
  const unknowns = hits.filter((h) => h.kind === 'unknown');
  if (!unknowns.length) return SILENT;
  const text = `${NAME}: ${unknowns.slice(0, 3).map((h) => `${h.op}: ${h.why}`).join('; ')}. ${ADVICE}`;
  return unknownAs === 'note' ? { kind: 'context', gate: NAME, text } : { kind: 'unknown', gate: NAME, reason: text };
}

/** One row per call that reached a protected repository, silent included, in harness.db (kind, operation, file count —
 *  no paths): the rollout stage is decided by these counts. A failed write is dropped — a measurement, never the verdict. */
function record(stateDir: string, p: PreToolUsePayload, v: Verdict, hits: Hit[], judged: number, judgedOp: string | null, now: number): void {
  if (v.kind === 'silent' && !judged) return;
  try {
    const st = State.open(stateDir);
    try {
      st.db.exec('CREATE TABLE IF NOT EXISTS agent_revert_events(at INTEGER, session_id TEXT, agent_id TEXT, kind TEXT, op TEXT, files INTEGER)');
      const top = hits.find((h) => h.kind === 'deny') ?? hits[0];
      st.db.prepare('INSERT INTO agent_revert_events(at, session_id, agent_id, kind, op, files) VALUES(?,?,?,?,?,?)')
        .run(now, p.session_id, p.agent_id ?? null, v.kind, (top?.op ?? judgedOp)?.split(' ').slice(0, 2).join(' ') ?? null, hits.reduce((n, h) => n + h.files.length, 0));
    } finally { st.close(); }
  } catch { return; }
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (p.hook_event_name !== 'PreToolUse' || typeof p.agent_id !== 'string' || !p.agent_id) return SILENT;
  const cfg = loadConfig(ctx.env).agentRevert;
  if (!cfg.enabled) return SILENT;
  let out: { hits: Hit[]; judged: number; op: string | null };
  if (ctx.event === 'pre-bash' && p.tool_name === 'Bash') {
    const command = (p.tool_input as Record<string, unknown> | undefined)?.command;
    if (typeof command !== 'string' || !command.trim()) return SILENT;
    out = judgeBash(command, p, withShellPaths(ctx.env, command, loadConfig(ctx.env).shellPaths));
  } else if (ctx.event === 'pre-write' && ['Write', 'Edit', 'MultiEdit'].includes(p.tool_name)) {
    out = judgeWrite(p, ctx.env, ctx.stateDir);
  } else return SILENT;
  const v = render(out.hits, cfg.unknown);
  record(ctx.stateDir, p, v, out.hits, out.judged, out.op, ctx.now());
  return v;
}

register({ name: NAME, events: ['pre-bash', 'pre-write'], killSwitch: KILL, observe: true, run: decide });
