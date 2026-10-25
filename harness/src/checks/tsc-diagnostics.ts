// Errors of one TypeScript project for tsc-project, built by the project's own compiler and never a fallback one.
// With a commit the program is the one that commit holds: tracked paths come from the commit's tree and blobs, paths
// git ignores (node_modules, generated code) are the environment and come from disk, any other path does not exist —
// an edit landing mid-build cannot leak into the commit side. Runs as a child a budget can kill; answers in a file:
//   node tsc-diagnostics.ts <projectDir> <repo> <out.json> [<commit>]
import { createRequire } from 'node:module';
import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { catBlobs, git } from '../git.ts';
import { isMainModule } from '../is-main.ts';
import { toolchainRoot, verifyTypescript } from '../toolchain.ts';

export interface Diagnostic { file: string; code: number; message: string; display: string }
export interface Input { path: string; size: number; mtimeMs: number }
export type Collected =
  | { ok: true; ts: { version: string; dir: string }; diagnostics: Diagnostic[]; inputs: Input[] }
  | { ok: false; reason: string };

/** The project's TypeScript pinned by a TOOLCHAIN.lock next to its tsconfig.json: the verified toolchain tree. */
export function lockedTypescript(projectDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return existsSync(join(projectDir, 'TOOLCHAIN.lock')) && verifyTypescript(env, projectDir).ok ? toolchainRoot(env, projectDir) : null;
}

/** The directory whose node_modules holds the project's TypeScript, searched from the project up to the repository, else the one its TOOLCHAIN.lock pins. */
export function projectTypescript(projectDir: string, repo: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (let d = projectDir; ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'typescript', 'package.json'))) return d;
    const up = relative(repo, d);
    if (!up || up.startsWith('..') || isAbsolute(up) || dirname(d) === d) return lockedTypescript(projectDir, env);
  }
}

interface Entry { path: string; mode: string; oid: string }
const SCRIPTS = /\.(?:[cm]?[jt]sx?|json)$/;
type Found = { kind: 'file'; entry: Entry } | { kind: 'dir'; path: string } | { kind: 'outside'; abs: string } | null;

/** The commit as a read-only file system over git objects; a blob git cannot give is an error, never an absent file.
 *  The first blob read fetches every script and JSON blob of the tree in batches (catBlobs): a process per file was
 *  ~2.5 thousand git a minute on 07.10 and took the machine down with the duplicate jobs. */
function commitView(repo: string, commit: string, caseSensitive: boolean) {
  const fold = (p: string): string => (caseSensitive ? p : p.toLowerCase());
  const tree = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], 60000);
  if (tree.rc !== 0) throw new Error(`git ls-tree ${commit.slice(0, 7)}: ${tree.stderr.trim().split('\n')[0] || `rc ${tree.rc}`}`);
  const files = new Map<string, Entry>(), dirs = new Map<string, string>([['', '']]);
  const kids = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  const kid = (d: string) => { let k = kids.get(fold(d)); if (!k) kids.set(fold(d), k = { files: new Set(), dirs: new Set() }); return k; };
  for (const rec of tree.stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ') as [string, string, string];
    const path = rec.slice(tab + 1);
    if (type === 'commit') { dirs.set(fold(path), path); kid(posix.dirname(path) === '.' ? '' : posix.dirname(path)).dirs.add(posix.basename(path)); continue; }
    files.set(fold(path), { path, mode, oid });
    let child = path;
    for (let d = posix.dirname(path); ; d = posix.dirname(d)) {
      const dir = d === '.' ? '' : d;
      if (child === path) kid(dir).files.add(posix.basename(child)); else kid(dir).dirs.add(posix.basename(child));
      if (dirs.has(fold(dir)) && child !== path) break;
      dirs.set(fold(dir), dir);
      if (!dir) break;
      child = dir;
    }
  }
  const ignoredList = git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], 60000);
  if (ignoredList.rc !== 0) throw new Error(`git ls-files --ignored: ${ignoredList.stderr.trim().split('\n')[0] || `rc ${ignoredList.rc}`}`);
  const ignored = new Set<string>(), envDirs = new Set<string>();
  for (const raw of ignoredList.stdout.split('\0')) {
    if (!raw) continue;
    const p = raw.replace(/\/$/, '');
    ignored.add(fold(p));
    for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d)) envDirs.add(fold(d));
    envDirs.add('');
  }
  const isIgnored = (rel: string): boolean => {
    for (let p = rel; p && p !== '.'; p = posix.dirname(p)) if (ignored.has(fold(p))) return true;
    return false;
  };
  const blobs = new Map<string, string>();
  let fetched = false;
  const blob = (oid: string): string => {
    if (!fetched) {
      fetched = true;
      const wanted = [...new Set([...files.values()].filter((e) => e.mode !== '160000' && SCRIPTS.test(e.path)).map((e) => e.oid))];
      for (const [id, text] of catBlobs(repo, wanted)) blobs.set(id, text);
    }
    let text = blobs.get(oid);
    if (text === undefined) {
      const r = git(repo, ['cat-file', 'blob', oid], 60000);
      if (r.rc !== 0) throw new Error(`git cat-file ${oid.slice(0, 7)}: ${r.stderr.trim().split('\n')[0] || `rc ${r.rc}`}`);
      blobs.set(oid, text = r.stdout);
    }
    return text;
  };
  const find = (rel: string): Found => {
    let parts = rel.split('/').filter(Boolean), hops = 0;
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/'), e = files.get(fold(prefix));
      if (e && e.mode === '120000') {
        if (++hops > 16) return null;
        const target = blob(e.oid);
        if (posix.isAbsolute(target)) return { kind: 'outside', abs: posix.join(target, ...parts.slice(i + 1)) };
        const joined = posix.normalize(posix.join(posix.dirname(e.path), target, ...parts.slice(i + 1)));
        if (joined === '..' || joined.startsWith('../')) return { kind: 'outside', abs: resolve(repo, joined) };
        parts = joined === '.' ? [] : joined.split('/');
        i = -1;
        continue;
      }
      if (e) return i === parts.length - 1 ? { kind: 'file', entry: e } : null;
      if (!dirs.has(fold(prefix))) return null;
    }
    return { kind: 'dir', path: dirs.get(fold(parts.join('/'))) ?? parts.join('/') };
  };
  return { find, blob, isIgnored, envDir: (rel: string) => envDirs.has(fold(rel)), children: (dir: string) => kids.get(fold(dir)) };
}

export function collect(projectDir: string, repo: string, commit: string | null): Collected {
  const tsDir = projectTypescript(projectDir, repo);
  if (!tsDir) return { ok: false, reason: 'TypeScript проекта не найден между проектом и корнем репозитория' };
  const fromLock = tsDir === lockedTypescript(projectDir);
  let ts: typeof TS;
  try { ts = createRequire(join(tsDir, 'package.json'))('typescript') as typeof TS; } catch (e) { return { ok: false, reason: `TypeScript проекта не загружается: ${String((e as Error).message).split('\n')[0]}` }; }
  if (typeof ts?.createProgram !== 'function') return { ok: false, reason: 'TypeScript проекта не загружается: нет createProgram' };
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const roots = [...new Set([repo, realpathSync(repo)])].sort((a, b) => b.length - a.length);
  const relOf = (f: string): string | null => {
    for (const root of roots) { const r = relative(root, f); if (!r.startsWith('..') && !isAbsolute(r)) return r.split(sep).join('/'); }
    return null;
  };
  const inputs = new Map<string, Input>();
  const note = (path: string): void => {
    if (inputs.has(path) || !existsSync(path)) return;
    const s = statSync(path, { throwIfNoEntry: false });
    if (s) inputs.set(path, { path, size: s.size, mtimeMs: s.mtimeMs });
  };

  let host: Pick<TS.CompilerHost, 'fileExists' | 'readFile' | 'directoryExists' | 'getDirectories' | 'realpath'> = ts.sys;
  let readDirectory: TS.ParseConfigHost['readDirectory'] = ts.sys.readDirectory;
  if (commit) {
    const matchFiles = (ts as unknown as { matchFiles?: (...a: unknown[]) => string[] }).matchFiles;
    if (typeof matchFiles !== 'function') return { ok: false, reason: `TypeScript ${ts.version} без matchFiles — include на коммите не сопоставить` };
    const v = commitView(repo, commit, caseSensitive);
    const commitSide = (f: string): Found | 'disk' => {
      const r = relOf(f);
      if (r === null || v.isIgnored(r)) return 'disk';
      return v.find(r);
    };
    const diskFile = (p: string): boolean => { const ok = ts.sys.fileExists(p); if (ok) note(p); return ok; };
    const fileExists = (f: string): boolean => { const w = commitSide(f); return w === 'disk' ? diskFile(f) : w?.kind === 'file' || (w?.kind === 'outside' && diskFile(w.abs)); };
    const readFile = (f: string): string | undefined => {
      const w = commitSide(f);
      const disk = w === 'disk' ? f : w?.kind === 'outside' ? w.abs : null;
      if (disk) { const text = ts.sys.readFile(disk); if (text !== undefined) note(disk); return text; }
      return w?.kind === 'file' ? v.blob(w.entry.oid) : undefined;
    };
    const directoryExists = (d: string): boolean => {
      const r = relOf(d);
      if (r === null || v.isIgnored(r)) return ts.sys.directoryExists(d);
      const w = v.find(r);
      if (w?.kind === 'dir') return true;
      if (w?.kind === 'outside') return ts.sys.directoryExists(w.abs);
      return v.envDir(r) && ts.sys.directoryExists(d);
    };
    const treeAndIgnoredEntries = (d: string): { files: string[]; directories: string[] } => {
      const r = relOf(d);
      const fromDisk = (p: string) => { try { const all = readdirSync(p, { withFileTypes: true }); return { files: all.filter((x) => !x.isDirectory()).map((x) => x.name), directories: all.filter((x) => x.isDirectory()).map((x) => x.name) }; } catch { return { files: [], directories: [] }; } };
      if (r === null || v.isIgnored(r)) return fromDisk(d);
      const w = v.find(r);
      if (w?.kind === 'outside') return fromDisk(w.abs);
      const out = { files: new Set<string>(), directories: new Set<string>() };
      if (w?.kind === 'dir') {
        const k = v.children(w.path);
        for (const n of k?.dirs ?? []) out.directories.add(n);
        for (const n of k?.files ?? []) { const f = v.find(posix.join(w.path, n)); if (f?.kind === 'dir') out.directories.add(n); else out.files.add(n); }
      }
      if (w?.kind === 'dir' || v.envDir(r)) {
        const disk = fromDisk(d);
        for (const n of disk.files) if (v.isIgnored(posix.join(r, n))) out.files.add(n);
        for (const n of disk.directories) { const p = posix.join(r, n); if (v.isIgnored(p) || v.envDir(p)) out.directories.add(n); }
      }
      return { files: [...out.files], directories: [...out.directories] };
    };
    const realpath = (f: string): string => {
      const r = relOf(f);
      if (r === null || v.isIgnored(r)) return ts.sys.realpath?.(f) ?? f;
      const w = v.find(r);
      if (w?.kind === 'file') return join(repo, w.entry.path);
      if (w?.kind === 'dir') return join(repo, w.path);
      if (w?.kind === 'outside') return ts.sys.realpath?.(w.abs) ?? w.abs;
      return f;
    };
    host = { fileExists, readFile, directoryExists, getDirectories: (d) => treeAndIgnoredEntries(d).directories, realpath };
    readDirectory = (root, exts, excl, incl, depth) => matchFiles(root, exts, excl, incl, caseSensitive, projectDir, depth, treeAndIgnoredEntries, realpath);
  }

  const configPath = join(projectDir, 'tsconfig.json');
  if (!host.fileExists(configPath)) return { ok: true, ts: { version: ts.version, dir: tsDir }, diagnostics: [], inputs: [...inputs.values()] };
  const parse = (path: string): TS.ParsedCommandLine | string => {
    let unrecoverable: string | null = null;
    const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, {
      useCaseSensitiveFileNames: caseSensitive, getCurrentDirectory: () => projectDir,
      fileExists: host.fileExists, readFile: host.readFile, readDirectory,
      onUnRecoverableConfigFileDiagnostic: (d) => { unrecoverable = ts.flattenDiagnosticMessageText(d.messageText, ' '); },
    });
    return parsed ?? `${relOf(path) ?? path} не разобран: ${unrecoverable ?? 'без диагностики'}`;
  };
  const root = parse(configPath);
  if (typeof root === 'string') return { ok: false, reason: root };
  // A solution-style tsconfig (files: [], references) is judged as the union of the projects it references, like tsc -b.
  const configs = !root.fileNames.length && root.projectReferences?.length ? root.projectReferences.map((ref) => parse(ts.resolveProjectReferencePath(ref))) : [root];
  const failed = configs.find((c): c is string => typeof c === 'string');
  if (failed) return { ok: false, reason: failed };
  const compiler = ts.createCompilerHost(root.options, true);
  Object.assign(compiler, {
    fileExists: host.fileExists, readFile: host.readFile, directoryExists: host.directoryExists, getDirectories: host.getDirectories, realpath: host.realpath,
    getSourceFile: (fileName: string, languageVersion: TS.ScriptTarget | TS.CreateSourceFileOptions) => { const text = host.readFile(fileName); return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion); },
  });
  if (fromLock) {
    for (const parsed of configs as TS.ParsedCommandLine[]) parsed.options.typeRoots ??= [join(tsDir, 'node_modules', '@types')];
    const anchor = join(tsDir, 'index.ts');
    compiler.resolveModuleNameLiterals = (literals, containingFile, redirected, options, sourceFile) => literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(sourceFile, literal, options);
      const own = ts.resolveModuleName(literal.text, containingFile, options, compiler, undefined, redirected, mode);
      return own.resolvedModule ? own : ts.resolveModuleName(literal.text, anchor, options, compiler, undefined, redirected, mode);
    });
  }
  const portable = (text: string): string => roots.reduce((t, r) => t.split(`${r}/`).join('<repo>/'), text);
  const seen = new Set<string>(), diagnostics: Diagnostic[] = [];
  for (const parsed of configs as TS.ParsedCommandLine[]) {
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences, host: compiler, configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed) });
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const message = portable(ts.flattenDiagnosticMessageText(d.messageText, ' '));
      const file = d.file ? (relOf(d.file.fileName) ?? d.file.fileName) : '';
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      const display = `${file}${pos ? `(${pos.line + 1},${pos.character + 1})` : ''}${file ? ': ' : ''}error TS${d.code}: ${message}`;
      if (seen.has(display)) continue;
      seen.add(display);
      diagnostics.push({ file, code: d.code, message, display });
    }
  }
  if (commit) note(join(tsDir, 'node_modules', 'typescript', 'package.json'));
  return { ok: true, ts: { version: ts.version, dir: tsDir }, diagnostics, inputs: [...inputs.values()] };
}

// exitCode, not exit(): a pipe on macOS flushes asynchronously and exit() would cut what is still buffered.
if (isMainModule(import.meta.url)) {
  const [projectDir, repo, out, commit] = process.argv.slice(2);
  if (!projectDir || !repo || !out) { process.stderr.write('usage: tsc-diagnostics.ts <projectDir> <repo> <out.json> [<commit>]\n'); process.exitCode = 64; }
  else {
    try {
      const r = collect(resolve(projectDir), resolve(repo), commit || null);
      if (r.ok) writeFileSync(out, JSON.stringify(r));
      else { process.stderr.write(`${r.reason}\n`); process.exitCode = 3; }
    } catch (e) {
      process.stderr.write(`${String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' ')}\n`);
      process.exitCode = 2;
    }
  }
}
