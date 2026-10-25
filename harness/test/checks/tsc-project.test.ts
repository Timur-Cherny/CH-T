// REGRESSION: tsc-project failed on any error of the project, so a project carrying errors at HEAD (a frontend app has three in
// src/api/base.api.ts) blocked every Stop for edits that brought none.
// INVARIANT: fail ⟺ the working tree has an error whose (file, code, message) count exceeds HEAD's; lines do not count;
// the HEAD side is the commit's own tree, never the disk; a baseline that cannot be had is unknown, never pass.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, HARNESS_ROOT } from '../_env.ts';
import { initRepo, changed, TS_PATH, type Repo } from './_repo.ts';
import { run, newErrors, keyOf } from '../../src/checks/tsc-project.ts';
import { collect, type Diagnostic } from '../../src/checks/tsc-diagnostics.ts';
import { catBlobs } from '../../src/git.ts';
import { toolchainDir } from '../../src/toolchain.ts';
import type { CheckContext } from '../../src/checks/types.ts';

const sb = sandbox('harness-tsc-project-');
after(() => sb.cleanup());

// Fixtures check without the default libs and declare the globals the checker requires: faster than parsing lib.*.d.ts
// in every program. The TOOLCHAIN.lock cases below use the real libs and @types/node of the toolchain.
const OPTS = { strict: true, noEmit: true, noLib: true, types: [], target: 'es2022', module: 'esnext', moduleResolution: 'bundler' };
const TSCONFIG = JSON.stringify({ compilerOptions: OPTS, include: ['src', 'globals.d.ts'] });
const GLOBALS = ['Array<T>', 'Boolean', 'CallableFunction', 'Function', 'IArguments', 'NewableFunction', 'Number', 'Object', 'RegExp', 'String'].map((t) => `interface ${t} {}`).join('\n');
const BROKEN = `export const wrong: number = 'text';\n`;
const REAL_GIT = (process.env.PATH ?? '').split(':').map((d) => join(d, 'git')).find((p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }) ?? 'git';
const ctx = (stateDir = sb.stateDir, extra: Record<string, string> = {}): CheckContext => ({ env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: sb.home, ...extra }, stateDir, now: Date.now, deadlineMs: 120000 });

function project(name: string, files: Record<string, string>, opts: { commit?: boolean; tsconfig?: string; symlinks?: Record<string, string>; typescript?: boolean } = {}): Repo {
  const repo = initRepo(sb, name);
  repo.write('tsconfig.json', opts.tsconfig ?? TSCONFIG);
  repo.write('.gitignore', 'node_modules\n');
  repo.write('globals.d.ts', `${GLOBALS}\n`);
  if (opts.typescript !== false) {
    // The toolchain ships lib/ without bin/: the project copy gets the bin/tsc a real install has.
    const pkg = join(repo.root, 'node_modules', 'typescript');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    for (const part of ['package.json', 'lib']) symlinkSync(join(dirname(dirname(TS_PATH)), part), join(pkg, part));
    writeFileSync(join(pkg, 'bin', 'tsc'), "#!/usr/bin/env node\nconst ts = require('../lib/typescript.js');\nts.executeCommandLine(ts.sys, () => {}, process.argv.slice(2));\n", { mode: 0o755 });
  }
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  for (const [link, target] of Object.entries(opts.symlinks ?? {})) { mkdirSync(dirname(join(repo.root, link)), { recursive: true }); symlinkSync(target, join(repo.root, link)); }
  if (opts.commit !== false) repo.commitAll();
  return repo;
}

/** A directory with a `git` that runs `script` (sh) around the real one, found as $REAL_GIT; it wraps the parent's git only. */
function gitWrapper(name: string, script: string): string {
  const dir = join(sb.dir, `git-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

async function withParentGit<T>(wrap: string, vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const was = process.env.PATH;
  Object.assign(process.env, { PATH: `${wrap}:${was}`, REAL_GIT, ...vars });
  try { return await fn(); } finally { process.env.PATH = was; for (const k of Object.keys(vars)) delete process.env[k]; }
}

describe('tsc-project against the HEAD baseline', () => {
  it('passes an edit that adds no error while HEAD already carries one in another file', async () => {
    const repo = project('baseline-only', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/a.ts', 'export const a = 1;\nexport const b = a + 1;\n');
    const r = await run(changed(repo, 'src/a.ts'), ctx());
    assert.equal(r.verdict, 'pass', r.message ?? r.missing_reason);
  });

  it('fails on an error the edit brings, naming it and not the baseline one', async () => {
    const repo = project('new-in-edited', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/a.ts', `export const a: string = 2;\n`);
    const r = await run(changed(repo, 'src/a.ts'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/a\.ts\(1,14\): error TS2322/);
    assert.doesNotMatch(r.message ?? '', /src\/base\.ts/);
  });

  it('fails when the edit breaks a file it did not touch', async () => {
    const repo = project('breaks-unchanged', {
      'src/lib.ts': 'export function twice(x: number): number { return x * 2; }\n',
      'src/use.ts': "import { twice } from './lib';\nexport const four = twice(2);\n",
    });
    repo.write('src/lib.ts', 'export function twice(x: string): string { return x + x; }\n');
    const r = await run(changed(repo, 'src/lib.ts'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/use\.ts\(2,\d+\): error TS2345/);
  });

  it('passes when a baseline error only moved to another line', async () => {
    const repo = project('moved', { 'src/base.ts': BROKEN });
    repo.write('src/base.ts', `export const first = 1;\n\n${BROKEN}`);
    const r = await run(changed(repo, 'src/base.ts'), ctx());
    assert.equal(r.verdict, 'pass', r.message ?? r.missing_reason);
  });

  it('fails on a second copy of an error HEAD has once', async () => {
    const repo = project('second-copy', { 'src/base.ts': BROKEN });
    repo.write('src/base.ts', `${BROKEN}export const again: number = 'text';\n`);
    const r = await run(changed(repo, 'src/base.ts'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/base\.ts\(2,\d+\): error TS2322/);
  });

  it('fails on an error in a file HEAD does not have', async () => {
    const repo = project('untracked', { 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/fresh.ts', BROKEN);
    const r = await run(changed(repo, 'src/fresh.ts', '?'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/fresh\.ts/);
  });

  it('treats every error as new in a repository without a commit', async () => {
    const repo = project('no-head', { 'src/base.ts': BROKEN }, { commit: false });
    const r = await run(changed(repo, 'src/base.ts', '?'), ctx());
    assert.equal(r.verdict, 'fail');
  });

  it('reuses the baseline of a commit and computes a new one when HEAD moves', async () => {
    const repo = project('cached', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    const dir = join(sb.stateDir, 'tsc-project');
    const count = (): number => { try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
    const before = count();
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
    assert.equal(count(), before + 1);
    repo.commitAll('next');
    repo.write('src/a.ts', 'export const a = 3;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
    assert.equal(count(), before + 2);
  });

  it('is unknown, not pass, when the project has no TypeScript of its own or it does not load', async () => {
    const none = project('no-ts', { 'src/a.ts': 'export const a = 1;\n' }, { typescript: false });
    assert.equal((await run(changed(none, 'src/a.ts'), ctx())).verdict, 'unknown');
    const broken = project('broken-ts', { 'src/a.ts': 'export const a = 1;\n' }, { typescript: false });
    broken.write('node_modules/typescript/package.json', '{"name":"typescript","version":"5.9.3","main":"lib/typescript.js"}\n');
    broken.write('src/a.ts', BROKEN);
    assert.equal((await run(changed(broken, 'src/a.ts'), ctx())).verdict, 'unknown');
  });
});

describe('the HEAD side is the commit, not the disk', () => {
  it('passes a git rename that carries its baseline error, and a plain mv that git has not seen', async () => {
    const staged = project('renamed', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    staged.git('mv', 'src/base.ts', 'src/moved.ts');
    assert.equal((await run(changed(staged, 'src/moved.ts', 'R'), ctx())).verdict, 'pass');
    const plain = project('plain-mv', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    renameSync(join(plain.root, 'src/base.ts'), join(plain.root, 'src/moved.ts'));
    assert.equal((await run(changed(plain, 'src/moved.ts', '?'), ctx())).verdict, 'pass');
  });

  it('passes a rename that leaves a re-export shim at the old path', async () => {
    const repo = project('shim', { 'src/base.ts': BROKEN, 'src/use.ts': "import { wrong } from './base';\nexport const w = wrong;\n" });
    repo.git('mv', 'src/base.ts', 'src/core.ts');
    repo.write('src/base.ts', "export * from './core';\n");
    const r = await run(changed(repo, 'src/core.ts', 'R'), ctx());
    assert.equal(r.verdict, 'pass', r.message ?? r.missing_reason);
  });

  it('follows a renamed directory, and fails on the importer the rename left behind', async () => {
    const files = { 'src/legacy/x.ts': 'export function fmt(n: number): string { return `${n}`; }\n', 'src/b.ts': "import { fmt } from './legacy/x';\nexport const s = fmt('a');\n", 'src/c.ts': "import { fmt } from './legacy/x';\nexport const t = fmt(1);\n" };
    const done = project('dir-renamed', files);
    done.git('mv', 'src/legacy', 'src/modern');
    done.write('src/b.ts', "import { fmt } from './modern/x';\nexport const s = fmt('a');\n");
    done.write('src/c.ts', "import { fmt } from './modern/x';\nexport const t = fmt(1);\n");
    assert.equal((await run(changed(done, 'src/b.ts'), ctx())).verdict, 'pass');
    const forgot = project('dir-renamed-forgot', files);
    forgot.git('mv', 'src/legacy', 'src/modern');
    forgot.write('src/b.ts', "import { fmt } from './modern/x';\nexport const s = fmt('a');\n");
    const r = await run(changed(forgot, 'src/b.ts'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/c\.ts\(1,\d+\): error TS2307/);
  });

  it('fails when a deleted directory is still imported', async () => {
    const repo = project('dir-deleted', { 'src/legacy/x.ts': 'export const x = 1;\n', 'src/b.ts': "import { x } from './legacy/x';\nexport const y = x;\n", 'src/a.ts': 'export const a = 1;\n' });
    rmSync(join(repo.root, 'src/legacy'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'fail');
  });

  it('keeps a deleted file outside include out of the HEAD program, and a deleted file include reaches by ../ in it', async () => {
    const outside = project('outside-include', { 'legacy.d.ts': 'declare const LEGACY: number;\n', 'src/use.ts': 'export const v: number = LEGACY;\n', 'src/a.ts': 'export const a = 1;\n' });
    unlinkSync(join(outside.root, 'legacy.d.ts'));
    outside.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(outside, 'src/a.ts'), ctx())).verdict, 'pass');
    const app = JSON.stringify({ compilerOptions: OPTS, include: ['src', '../shared', '../globals.d.ts'] });
    const shared = project('shared-outside', { 'app/tsconfig.json': app, 'shared/env.d.ts': 'declare const API: string;\n', 'shared/other.d.ts': 'declare const OTHER: number;\n', 'app/src/use.ts': 'export const u: string = API;\n', 'app/src/a.ts': 'export const a = 1;\n' });
    rmSync(join(shared.root, 'shared/env.d.ts'));
    shared.write('app/src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(shared, 'app/src/a.ts'), ctx())).verdict, 'fail');
  });

  it('reads an extended tsconfig the edit changed from the commit', async () => {
    const base = (strict: boolean) => JSON.stringify({ compilerOptions: { ...OPTS, strict } });
    const repo = project('extends', { 'tsconfig.base.json': base(false), 'src/a.ts': 'export function f(x) { return x; }\n' }, { tsconfig: JSON.stringify({ extends: './tsconfig.base.json', include: ['src', 'globals.d.ts'] }) });
    repo.write('tsconfig.base.json', base(true));
    repo.write('src/a.ts', 'export function f(x) { return x; }\nexport const k = 1;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'fail');
  });

  it('sees a new error behind a symlinked directory, and keeps the error of a symlink replaced by a copy', async () => {
    const linked = project('symlink-dir', { 'shared/x.ts': 'export const n: number = 1;\n', 'src/a.ts': 'export const a = 1;\n' }, { symlinks: { 'src/shared': '../shared' } });
    linked.write('shared/x.ts', "export const n: number = 'x';\n");
    assert.equal((await run(changed(linked, 'shared/x.ts'), ctx())).verdict, 'fail');
    const copied = project('typechange', { 'common/x.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' }, { symlinks: { 'src/x.ts': '../common/x.ts' } });
    unlinkSync(join(copied.root, 'src/x.ts'));
    copyFileSync(join(copied.root, 'common/x.ts'), join(copied.root, 'src/x.ts'));
    assert.equal((await run(changed(copied, 'src/x.ts'), ctx())).verdict, 'pass');
  });

  it('reads an import spelled in another case from the commit on a case-insensitive disk', { skip: process.platform !== 'darwin' }, async () => {
    const repo = project('case', { 'lib/helper.ts': 'export function twice(x: number): number { return x * 2; }\n', 'src/use.ts': "import { twice } from '../lib/Helper';\nexport const four: number = twice(2);\n" });
    repo.write('lib/helper.ts', 'export function twice(x: string): string { return x + x; }\n');
    assert.equal((await run(changed(repo, 'lib/helper.ts'), ctx())).verdict, 'fail');
  });

  it('does not cache an edit that lands while the baseline is being built', async () => {
    const repo = project('race', { 'src/a.ts': 'export const a = 1;\n', 'src/g.ts': 'export const g = 1;\n' });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const marker = join(sb.dir, 'race-marker');
    writeFileSync(marker, '');
    const wrap = gitWrapper('race', `"$REAL_GIT" "$@"; rc=$?\ncase "$*" in *"ls-tree"*) if [ -f "$RACE_MARKER" ]; then rm -f "$RACE_MARKER"; printf "export const late: number = 'x';\\n" >> "$RACE_TARGET"; fi;; esac\nexit $rc`);
    await run(changed(repo, 'src/a.ts'), ctx(sb.stateDir, { PATH: `${wrap}:${dirname(process.execPath)}:${process.env.PATH}`, REAL_GIT, RACE_MARKER: marker, RACE_TARGET: join(repo.root, 'src/g.ts') }));
    const r = await run(changed(repo, 'src/g.ts'), ctx());
    assert.equal(r.verdict, 'fail', 'the edit of src/g.ts made during the baseline build was cached as HEAD');
  });

  // REGRESSION 07.10 (mac-hang-2026-10-07): the baseline read the commit with one `git cat-file blob` per file — six
  // duplicate runs on one worktree made ~2.5 thousand git processes a minute while the machine went down.
  it('reads the blobs of the commit in batches, not with one git process per file', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`]));
    const repo = project('batched-blobs', { ...files, 'src/base.ts': BROKEN });
    repo.write('src/m0.ts', 'export const m0 = 100;\n');
    const log = join(sb.dir, 'batched-git.log');
    const wrap = gitWrapper('batched', `printf '%s\\n' "$*" >> '${log}'\nexec "$REAL_GIT" "$@"`);
    const r = await run(changed(repo, 'src/m0.ts'), ctx(join(sb.dir, 'batched-state'), { PATH: `${wrap}:${dirname(process.execPath)}:${process.env.PATH}`, REAL_GIT }));
    assert.equal(r.verdict, 'pass', JSON.stringify(r));
    const reads = readFileSync(log, 'utf8').split('\n').filter((l) => /\bcat-file\b/.test(l));
    assert.ok(reads.length <= 3, `the baseline spawned ${reads.length} git cat-file processes for 32 files`);
  });

  it('returns blob texts byte-exact by id and leaves out an id git does not have', () => {
    const repo = project('cat-blobs', { 'src/ru.ts': 'export const t = "заказ — позиция";\n', 'src/empty.ts': '' });
    const ru = repo.git('rev-parse', 'HEAD:src/ru.ts').trim();
    const empty = repo.git('rev-parse', 'HEAD:src/empty.ts').trim();
    const got = catBlobs(repo.root, [ru, empty, '0'.repeat(40)], 2);
    assert.deepEqual([got.get(ru), got.get(empty), got.has('0'.repeat(40))], ['export const t = "заказ — позиция";\n', '', false]);
  });

  it('is unknown when a blob of the commit cannot be read, and does not cache that', async () => {
    const repo = project('lost-blob', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    const oid = repo.git('rev-parse', 'HEAD:src/base.ts').trim();
    const obj = join(repo.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), keep = join(sb.dir, `obj-${oid}`);
    copyFileSync(obj, keep);
    repo.write('src/base.ts', `export const first = 1;\n${BROKEN}`);
    unlinkSync(obj);
    assert.equal((await run(changed(repo, 'src/base.ts'), ctx())).verdict, 'unknown');
    copyFileSync(keep, obj);
    assert.equal((await run(changed(repo, 'src/base.ts'), ctx())).verdict, 'pass');
  });

  it('recomputes a cached baseline when an ignored file it read changed, so cached and fresh agree', async () => {
    const repo = project('env', { 'src/use.ts': "import { v } from './gen';\nexport const n: number = v;\n", 'src/a.ts': 'export const a = 1;\n' });
    repo.write('.gitignore', 'node_modules\nsrc/gen.ts\n');
    repo.commitAll('ignore gen');
    repo.write('src/gen.ts', 'export const v: number = 1;\n');
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
    repo.write('src/gen.ts', "export const v: string = 'x';\n");
    repo.write('src/a.ts', 'export const a = 3;\n');
    const cached = await run(changed(repo, 'src/a.ts'), ctx());
    const freshDir = join(sb.dir, 'state-env');
    mkdirSync(freshDir, { recursive: true });
    assert.equal(cached.verdict, (await run(changed(repo, 'src/a.ts'), ctx(freshDir))).verdict);
  });

  it('does not judge files git ignores: they are the environment of both sides', async () => {
    const repo = project('ignored-new', { 'src/a.ts': 'export const a = 1;\n' });
    repo.write('.gitignore', 'node_modules\n*.local.ts\n');
    repo.commitAll('ignore local');
    repo.write('src/dev.local.ts', BROKEN);
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
  });

  it('is unknown when the edit changes dependencies: HEAD on today\'s node_modules is not HEAD', async () => {
    const repo = project('deps', { 'package-lock.json': '{"v":1}\n', 'src/use.ts': "import { f } from 'dep';\nexport const r: number = f(1);\n", 'src/a.ts': 'export const a = 1;\n' });
    repo.write('node_modules/dep/package.json', '{"name":"dep","types":"index.d.ts"}\n');
    repo.write('node_modules/dep/index.d.ts', 'export declare function f(x: string): string;\n');
    repo.write('package-lock.json', '{"v":2}\n');
    const r = await run(changed(repo, 'src/a.ts'), ctx());
    assert.equal(r.verdict, 'unknown');
    assert.match(r.missing_reason ?? '', /package-lock\.json/);
  });

  it('judges a solution-style tsconfig by the projects it references, as tsc -b does', async () => {
    const app = JSON.stringify({ compilerOptions: OPTS, include: ['src', 'globals.d.ts'] });
    const repo = project('solution', { 'tsconfig.app.json': app, 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' }, { tsconfig: JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }) });
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
    repo.write('src/a.ts', "export const a: number = 'x';\n");
    const r = await run(changed(repo, 'src/a.ts'), ctx());
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /src\/a\.ts\(1,14\): error TS2322/);
  });
});

describe('a project whose TypeScript is pinned by TOOLCHAIN.lock', () => {
  const NODE_TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2024', lib: ['es2024'], module: 'nodenext', moduleResolution: 'nodenext', skipLibCheck: true, types: ['node'] }, include: ['src'] });
  const HEADER = "import { readFileSync } from 'node:fs';\nimport type * as TS from 'typescript';\nexport const kind: TS.SyntaxKind | undefined = undefined;\n";
  const TEXT = `${HEADER}export const text: string = readFileSync('x', 'utf8');\n`;
  const WRONG = `${HEADER}export const text: number = readFileSync('x', 'utf8');\n`;
  const live = { CLAUDE_HARNESS_TOOLCHAIN: toolchainDir(process.env) ?? '' };
  const locked = (name: string): Repo => project(name, { 'TOOLCHAIN.lock': readFileSync(join(HARNESS_ROOT, 'TOOLCHAIN.lock'), 'utf8'), 'src/a.ts': TEXT }, { typescript: false, tsconfig: NODE_TSCONFIG });

  it('checks it with the toolchain of the check env: node: and typescript types resolve on both sides, a new error fails', async () => {
    const repo = locked('lock-fail');
    const head = collect(repo.root, repo.root, repo.git('rev-parse', 'HEAD').trim());
    assert.ok(head.ok, head.ok ? '' : head.reason);
    assert.deepEqual(head.diagnostics.map((d) => d.display), []);
    repo.write('src/a.ts', WRONG);
    const was = process.env.CLAUDE_HARNESS_TOOLCHAIN;
    process.env.CLAUDE_HARNESS_TOOLCHAIN = join(sb.dir, 'not-the-check-env');
    try {
      const r = await run(changed(repo, 'src/a.ts'), ctx(join(sb.dir, 'state-lock-fail'), live));
      assert.equal(r.verdict, 'fail', r.message ?? r.missing_reason);
      assert.match(r.message ?? '', /src\/a\.ts\(4,14\): error TS2322/);
      assert.doesNotMatch(r.message ?? '', /TS2307|TS2318|TS2688/);
    } finally { if (was === undefined) delete process.env.CLAUDE_HARNESS_TOOLCHAIN; else process.env.CLAUDE_HARNESS_TOOLCHAIN = was; }
  });
  it('passes an edit that adds no error', async () => {
    const repo = locked('lock-pass');
    repo.write('src/a.ts', `${TEXT}export const size = text.length;\n`);
    const r = await run(changed(repo, 'src/a.ts'), ctx(join(sb.dir, 'state-lock-pass'), live));
    assert.equal(r.verdict, 'pass', r.message ?? r.missing_reason);
  });
  it('is unknown with the toolchain reason when the lock is not installed — never pass', async () => {
    const repo = locked('lock-missing');
    repo.write('src/a.ts', WRONG);
    const r = await run(changed(repo, 'src/a.ts'), ctx(join(sb.dir, 'state-lock-missing'), { CLAUDE_HARNESS_TOOLCHAIN: join(sb.dir, 'no-toolchain') }));
    assert.equal(r.verdict, 'unknown');
    assert.match(r.missing_reason ?? '', /тулчейн харнесса: typescript@\S+ не установлен/);
  });
  it('is unknown when the edit changes TOOLCHAIN.lock: HEAD on another toolchain is not HEAD', async () => {
    const repo = locked('lock-edited');
    repo.write('TOOLCHAIN.lock', `${readFileSync(join(HARNESS_ROOT, 'TOOLCHAIN.lock'), 'utf8')}\n`);
    repo.write('src/a.ts', WRONG);
    const r = await run(changed(repo, 'src/a.ts'), ctx(join(sb.dir, 'state-lock-edited'), live));
    assert.equal(r.verdict, 'unknown', r.message ?? r.missing_reason);
  });
});

describe('git failing is not an answer', () => {
  it('reads a git killed while reading HEAD as unknown, not as a repository without commits', async () => {
    const repo = project('head-killed', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/a.ts', 'export const a = 2;\n');
    const wrap = gitWrapper('head-killed', `case "$*" in *"rev-parse --verify -q HEAD^{commit}"*) kill -9 $$;; esac\nexec "$REAL_GIT" "$@"`);
    const clean = ctx();
    const r = await withParentGit(wrap, {}, () => run(changed(repo, 'src/a.ts'), clean));
    assert.notEqual(r.verdict, 'fail');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx())).verdict, 'pass');
  });

  it('answers a HEAD that moved during the check with a fresh start, not a verdict', async () => {
    const repo = project('switch', { 'src/base.ts': BROKEN, 'src/a.ts': 'export const a = 1;\n' });
    const main = repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    repo.git('checkout', '-q', '-b', 'other');
    repo.write('src/extra.ts', "export const other: number = 'committed on other';\n");
    repo.commitAll('other');
    repo.git('checkout', '-q', main);
    repo.write('src/a.ts', 'export const a = 2;\n');
    const flag = join(sb.dir, 'switched');
    const wrap = gitWrapper('switch', `case "$*" in *"ls-files --others"*) if [ ! -f "$SWITCH_FLAG" ]; then touch "$SWITCH_FLAG"; "$REAL_GIT" -C "$SWITCH_REPO" checkout -q other; fi;; esac\nexec "$REAL_GIT" "$@"`);
    const clean = ctx();
    const r = await withParentGit(wrap, { SWITCH_FLAG: flag, SWITCH_REPO: repo.root }, () => run(changed(repo, 'src/a.ts'), clean));
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.transient, 'unstarted', r.missing_reason);
  });

  it('survives an unreadable entry in the baseline cache while pruning it', async () => {
    const dir = join(sb.dir, 'state-prune', 'tsc-project');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(join(dir, `filler${i}.json`), '{}');
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling.json'));
    const repo = project('prune', { 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/a.ts', 'export const a = 2;\n');
    assert.equal((await run(changed(repo, 'src/a.ts'), ctx(dirname(dir)))).verdict, 'pass');
  });
});

describe('newErrors', () => {
  const d = (file: string, message: string, code = 1): Diagnostic => ({ file, code, message, display: `${file}: ${message}` });
  const base = (...ds: Diagnostic[]): Map<string, number> => { const m = new Map<string, number>(); for (const x of ds) m.set(keyOf(x), (m.get(keyOf(x)) ?? 0) + 1); return m; };
  it('reports only what exceeds the baseline count of the same error', () => {
    assert.deepEqual(newErrors(base(d('a', 'm')), [d('a', 'm')], new Map()), []);
    assert.deepEqual(newErrors(base(d('a', 'm')), [d('a', 'm'), { ...d('a', 'm'), display: 'two' }], new Map()).map((x) => x.display), ['two']);
    assert.equal(newErrors(base(d('a', 'm')), [d('b', 'm')], new Map()).length, 1);
  });
  it('keeps an error whose message only prints a type that grew elsewhere, and still counts a second one as new', () => {
    // a frontend app MoveResult.component.tsx: styles[`container${q}`] errs before and after; the styles object gained keys.
    const was = d('m.tsx', "expression of type '`container${string}`' can't index type '{ a: 1; }'.", 7053);
    const now = d('m.tsx', "expression of type '`container${string}`' can't index type '{ a: 1; b: 2; }'.", 7053);
    assert.deepEqual(newErrors(base(was), [now], new Map()), []);
    assert.equal(newErrors(base(was), [now, now], new Map()).length, 1);
    assert.equal(newErrors(base(was), [{ ...now, file: 'other.tsx' }], new Map()).length, 1);
  });
  it('carries a baseline error over a rename, the paths its message prints included, whatever the file name holds', () => {
    assert.deepEqual(newErrors(base(d('src/a|b.ts', 'm')), [d('src/c.ts', 'm')], new Map([['src/a|b.ts', 'src/c.ts']])), []);
    const msg = (p: string) => `Type 'typeof import("<repo>/${p}")' is not assignable.`;
    assert.deepEqual(newErrors(base(d('src/ns.ts', msg('src/a'))), [d('src/ns.ts', msg('src/b'))], new Map([['src/a.ts', 'src/b.ts']])), []);
  });
});
