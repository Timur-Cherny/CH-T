// Public export of the harness: the tracked files a private manifest names, the public templates, a settings.json built
// from the hooks block of the manifest's settings source — then a leak scan (manifest deny patterns plus tokens of the site config) and a
// control-byte scan over every exported file. Any hit fails the export before a byte is written.
//   node scripts/export.ts --out <dir> [--brain <root>] [--manifest <file>] [--config <file>] [--replace] [--test] [--allow-dirty]
// The export is the committed state: an uncommitted change in its scope refuses it (--allow-dirty marks the source +dirty).
// The out dir is cleaned (all but .git) only when it holds a previous export (EXPORT.json) or --replace is given;
// the brain root, its ancestors and $HOME are refused.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.ts';
import { spawnTool } from '../src/platform.ts';
import { isMainModule } from '../src/is-main.ts';

export interface Manifest {
  version: string;
  include: string[];
  exclude: string[];
  templates: Record<string, string>;
  settings: { from: string; comment: string };
  deny: string[];
}
export interface Tracked { path: string; mode: string }
export interface Leak { path: string; line: number; pattern: string; text: string }
export interface Tree { files: Map<string, { body: Buffer; exec: boolean }> }

const HARNESS = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const BINARY = /\.(wasm|png|jpe?g|gz|tgz)$/;
const TOKEN_MARK = /[/._-]/;

export function readManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
  if (typeof m.version !== 'string' || !m.version || !strings(m.include) || !strings(m.exclude) || !strings(m.deny)) throw new Error(`${path}: version, include, exclude, deny обязательны`);
  if (!m.templates || typeof m.templates !== 'object' || !m.settings || typeof m.settings.from !== 'string') throw new Error(`${path}: templates и settings.from обязательны`);
  return m as Manifest;
}

/** Tokens of the site config that name the site: string values under non-underscore keys, split on blanks and regex
 *  alternation; free text (workDocs.text) is prose and stays out. */
export function configTokens(config: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, key: string): void => {
    if (key.startsWith('_') || key === 'text') return;
    if (typeof v === 'string') { for (const t of v.split(/[\s|()"'`]+/)) if (t.length >= 6 && TOKEN_MARK.test(t) && /[A-Za-z]/.test(t)) out.add(t); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(config, '');
  return [...out].sort();
}

export function denyPatterns(manifest: Manifest, tokens: string[]): RegExp[] {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...manifest.deny.map((d) => new RegExp(d, 'iu')), ...tokens.map((t) => new RegExp(esc(t), 'iu'))];
}

export function selects(path: string, manifest: Manifest): boolean {
  const hit = (list: string[]): boolean => list.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
  return hit(manifest.include) && !hit(manifest.exclude);
}

export function scan(tree: Tree, patterns: RegExp[]): { leaks: Leak[]; control: string[] } {
  const leaks: Leak[] = [];
  const control: string[] = [];
  for (const [path, f] of tree.files) {
    if (BINARY.test(path)) continue;
    const text = f.body.toString('latin1');
    if (CONTROL.test(text)) control.push(path);
    const lines = f.body.toString('utf8').split('\n');
    for (const re of patterns) {
      if (re.test(path)) leaks.push({ path, line: 0, pattern: re.source, text: path });
      lines.forEach((l, i) => { if (re.test(l)) leaks.push({ path, line: i + 1, pattern: re.source, text: l.trim().slice(0, 160) }); });
    }
  }
  return { leaks, control };
}

export function tracked(brain: string): Tracked[] {
  const r = git(brain, ['ls-files', '-s', '-z'], 30000);
  if (r.rc !== 0) throw new Error(`git ls-files: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean).map((rec) => { const [meta, path] = rec.split('\t'); return { path, mode: meta.split(' ')[0] }; });
}

export function build(brain: string, manifest: Manifest, files: Tracked[]): Tree {
  const tree: Tree = { files: new Map() };
  const sources = new Set(Object.values(manifest.templates));
  const picked = files.filter((f) => selects(f.path, manifest) && !sources.has(f.path));
  const exact = manifest.include.filter((e) => !e.endsWith('/'));
  const missing = exact.filter((e) => !picked.some((f) => f.path === e));
  if (missing.length) throw new Error(`в мозге нет файлов манифеста: ${missing.join(', ')}`);
  for (const f of picked) tree.files.set(f.path, { body: readFileSync(join(brain, f.path)), exec: f.mode === '100755' });
  for (const [to, from] of Object.entries(manifest.templates)) tree.files.set(to, { body: readFileSync(join(brain, from)), exec: false });
  const hooks = (JSON.parse(readFileSync(join(brain, manifest.settings.from), 'utf8')) as { hooks: unknown }).hooks;
  tree.files.set('settings.json', { body: Buffer.from(JSON.stringify({ _comment: manifest.settings.comment, hooks }, null, 2) + '\n'), exec: false });
  const pkgPath = 'harness/package.json';
  const pkg = tree.files.get(pkgPath);
  if (pkg) {
    const j = JSON.parse(pkg.body.toString('utf8')) as Record<string, unknown>;
    tree.files.set(pkgPath, { body: Buffer.from(JSON.stringify({ name: 'claude-harness', version: manifest.version, ...Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'name' && k !== 'version')) }, null, 2) + '\n'), exec: false });
  }
  return tree;
}

/** Refuses an out dir that is the brain, holds it, is $HOME or the root; cleans a previous export or a --replace target. */
export function prepareOut(out: string, brain: string, replace: boolean, home: string | undefined): void {
  const o = resolve(out);
  const b = resolve(brain);
  if (o === sep || o === resolve(home ?? sep) || b === o || b.startsWith(o + sep)) throw new Error(`каталог выгрузки ${o} — корень, HOME, мозг или его предок`);
  if (!existsSync(o)) { mkdirSync(o, { recursive: true }); return; }
  const entries = readdirSync(o).filter((n) => n !== '.git');
  if (!entries.length) return;
  if (!existsSync(join(o, 'EXPORT.json')) && !replace) throw new Error(`${o} не пуст и не прошлая выгрузка (нет EXPORT.json) — нужен --replace`);
  for (const n of entries) rmSync(join(o, n), { recursive: true, force: true });
}

export function write(out: string, tree: Tree, meta: Record<string, unknown>): void {
  const sums: Record<string, string> = {};
  for (const [path, f] of [...tree.files].sort(([a], [b]) => a.localeCompare(b))) {
    const p = join(out, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.body);
    if (f.exec) chmodSync(p, 0o755);
    sums[path] = createHash('sha256').update(f.body).digest('hex');
  }
  writeFileSync(join(out, 'EXPORT.json'), JSON.stringify({ ...meta, files: sums }, null, 2) + '\n');
}

export function runSuite(out: string, env: NodeJS.ProcessEnv): { rc: number; tests: number; pass: number; fail: number } {
  const r = spawnTool('node', ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=4', '--test-reporter=tap', 'test/**/*.test.ts'],
    { cwd: join(out, 'harness'), timeoutMs: 900_000, env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}` } });
  const num = (k: string): number => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? 0);
  return { rc: r.rc, tests: num('tests'), pass: num('pass'), fail: num('fail') };
}

/** Uncommitted or untracked paths inside the export scope: exact includes, include dirs, template sources. */
export function dirty(brain: string, manifest: Manifest): string[] {
  const r = git(brain, ['status', '--porcelain', '-z', '--untracked-files=all'], 30000);
  if (r.rc !== 0) throw new Error(`git status: ${r.stderr.trim()}`);
  const scope = [...manifest.include, ...Object.values(manifest.templates), manifest.settings.from];
  const inScope = (p: string): boolean => scope.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e)) && !manifest.exclude.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
  return r.stdout.split('\0').filter((rec) => rec.length > 3).map((rec) => rec.slice(3)).filter(inScope);
}

function arg(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const out = arg(argv, '--out');
  if (!out) { process.stderr.write('использование: export.ts --out <dir> [--brain <root>] [--manifest <file>] [--config <file>] [--replace] [--test] [--allow-dirty]\n'); return 64; }
  const brain = resolve(arg(argv, '--brain') ?? join(HARNESS, '..'));
  const manifest = readManifest(arg(argv, '--manifest') ?? join(brain, 'harness.export.json'));
  const configFile = arg(argv, '--config') ?? join(brain, 'harness.config.json');
  const tokens = existsSync(configFile) ? configTokens(JSON.parse(readFileSync(configFile, 'utf8'))) : [];
  const unclean = dirty(brain, manifest);
  if (unclean.length && !argv.includes('--allow-dirty')) {
    process.stdout.write(`выгрузка остановлена: в её составе незакоммиченные правки — ${unclean.join(', ')}\n`);
    return 1;
  }
  const tree = build(brain, manifest, tracked(brain));
  const { leaks, control } = scan(tree, denyPatterns(manifest, tokens));
  if (leaks.length || control.length) {
    for (const l of leaks) process.stdout.write(`УТЕЧКА ${l.path}:${l.line} /${l.pattern}/ ${l.text}\n`);
    for (const c of control) process.stdout.write(`УПРАВЛЯЮЩИЙ БАЙТ ${c}\n`);
    process.stdout.write(`выгрузка остановлена: утечек ${leaks.length}, файлов с управляющими байтами ${control.length}; ничего не записано\n`);
    return 1;
  }
  prepareOut(out, brain, argv.includes('--replace'), env.HOME);
  const head = git(brain, ['rev-parse', 'HEAD']).stdout.trim() + (unclean.length ? '+dirty' : '');
  write(out, tree, { version: manifest.version, source: head, deny_patterns: manifest.deny.length + tokens.length });
  process.stdout.write(`выгружено: ${tree.files.size} файлов, версия ${manifest.version}, источник ${head.slice(0, 12)}, запретов ${manifest.deny.length + tokens.length}, утечек 0\n`);
  if (!argv.includes('--test')) return 0;
  const s = runSuite(out, env);
  process.stdout.write(`сьют выгрузки: tests ${s.tests}, pass ${s.pass}, fail ${s.fail}\n`);
  return s.fail === 0 && s.tests > 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env);
