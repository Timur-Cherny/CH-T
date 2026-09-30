// Deterministic prefilter of /memory-review (0 tokens): picks the notes worth reading out of the whole corpus.
//   node scripts/memory-prefilter.ts <memory-dir> [work-repo ...]      TSV: FLAG <tab> file <tab> evidence
//   STALE    a merge-status marker (in the note or only in its MEMORY.md line) and, next to it, a commit that already
//            sits in a live line of its repository — git has the answer, the note has not caught up
//   MAYBE    the same marker, but the landed commit is cited elsewhere in the note (a branch base, a tip used as a
//            reference): the quoted marker line in the evidence decides whether the note is worth opening
//   ASKPROD  the note says production lacks something whose commit is already in a release tag — git cannot
//            tell what production runs, so this is a question for the owner, never a rewrite
//   ORPHAN   a note without an index line, or an index line without a note
//   AGE60    more than 60 days since the last change · HOT — 3+ mentions in the worklogs · DUP — same subject twice
//   INFO     the denominators of the run: a zero above proves nothing until this line says what was looked at
// A commit counts as landed when it is an ancestor of a live line or when the line carries the same patch under
// another hash (a cherry-pick from dev into a release shares no ancestry with main — only `git cherry` sees it).
// Live lines: the protectedBranches and integrationBranches of the site config where a repository has them (a commit
// in a legacy fork or in somebody's feature branch has not landed); elsewhere the branch each remote HEAD points at. Markers are searched in prose
// only — inline code and fenced blocks are quotations, a line naming several status emoji is a legend.
// Regex here runs over natural-language prose and markdown frontmatter, which have no grammar to parse.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { git } from '../src/git.ts';
import { loadConfig } from '../src/config.ts';
import { isMainModule } from '../src/is-main.ts';

export type Flag = 'STALE' | 'MAYBE' | 'ASKPROD' | 'ORPHAN' | 'AGE60' | 'HOT' | 'DUP' | 'INFO';
export interface Row { flag: Flag; file: string; evidence: string }
export interface PrefilterOptions { memDir: string; repos: string[]; env?: NodeJS.ProcessEnv; now?: () => number }
export interface Outcome { rc: number; stdout: string; stderr: string }

const EDGE_L = String.raw`(?<![\p{L}\p{N}_])`; const EDGE_R = String.raw`(?![\p{L}\p{N}_])`;
const REF = '§REF§'; const CODE = '§';
const MERGE = new RegExp(`${EDGE_L}(?:${[
  String.raw`не\s+запушен[аоы]?`, String.raw`не\s+закоммичен[аоы]?`, String.raw`не\s+см[её]рж[а-яё]*`, String.raw`не\s+влит[аоы]?`,
  String.raw`не\s+слит[аоы]?`, String.raw`черновик[а-яё]*`, String.raw`не\s+заводить`, String.raw`не\s+обкатан[аоы]?`,
  String.raw`в\s+${REF}\s+нет`, String.raw`в\s+(?:[\w.-]+/)?main\s+нет`, String.raw`открыт[аоы]?\s+(?:MR\s+)?!\d+`,
  String.raw`!\d+(?:/!\d+)*\s+открыт[аоы]?`, String.raw`жд[её]т\s+слова`, String.raw`ждут\s+слова`, String.raw`до\s+слова\s+\p{Lu}\p{L}+`,
].join('|')})${EDGE_R}`, 'iu');
const MERGE_EXACT = /(?<![\p{L}\p{N}_])(?:DRAFT|ЛОКАЛЬНО)(?![\p{L}\p{N}_])|⏸|🔵|🟡/u;
const PROD = new RegExp(`${EDGE_L}(?:на\\s+прод[еу]?\\s+(?:(?:\\d+(?:\\.\\d+)*|[^\\s.,;:]+)\\s+){0,3}?нет|на\\s+прод[еу]?\\s+не\\s+выкачен[аоы]?)${EDGE_R}`, 'iu');
const STATUS_EMOJI = ['✅', '🔵', '🟡', '⏸'];
const HASH = /(?<![\p{L}\p{N}_])[0-9a-f]{7,40}(?![\p{L}\p{N}_])/gu;
const BRANCH = /^(?:[\w.-]+\/)*(?:main|dev|master)$/;
const MAX_HASHES = 24;
const NEAR_LINES = 2;

/** The text a status may live in, line for line: quotations become placeholders, fenced and legend lines go blank. */
export function prose(text: string): string {
  const unfenced = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, (block) => block.replace(/[^\n]/gu, ''));
  const unquoted = unfenced.replace(/`([^`\n]*)`/gu, (_m, inner: string) => (BRANCH.test(inner.trim()) ? REF : CODE));
  return unquoted.split('\n').map((l) => (STATUS_EMOJI.filter((e) => l.includes(e)).length < 2 ? l : '')).join('\n');
}
interface Spot { marker: string; line: number }
function spot(text: string, find: (t: string) => string | null): Spot | null {
  const lines = prose(text).split('\n');
  for (let i = 0; i < lines.length; i++) { const marker = find(lines[i]); if (marker) return { marker, line: i }; }
  return null;
}
/** Hashes cited within NEAR_LINES of the marker and inside its paragraph — the commits the status is about. */
function citedNear(text: string, at: number): Set<string> {
  const lines = text.split('\n'); let from = at; let to = at;
  while (from > 0 && at - from < NEAR_LINES && lines[from - 1].trim()) from--;
  while (to < lines.length - 1 && to - at < NEAR_LINES && lines[to + 1].trim()) to++;
  return new Set(hashes(lines.slice(from, to + 1).join('\n')));
}
function excerpt(line: string): string { const t = line.replace(/^description:\s*/u, '').trim(); return t.length > 170 ? `${t.slice(0, 170)}…` : t; }
export function mergeMarker(text: string): string | null { return MERGE.exec(text)?.[0] ?? MERGE_EXACT.exec(text)?.[0] ?? null; }
export function prodMarker(text: string): string | null { return PROD.exec(text)?.[0] ?? null; }
/** Candidates only — git decides what is a commit. A short hash of digits alone is real (one in thirty), so digit
 * runs of 7–12 stay in, after the mixed ones; 13 and up are timestamps, letters alone are words. */
export function hashes(text: string): string[] {
  const found = [...new Set((text.match(HASH) ?? []).filter((h) => /\d/.test(h) && (/[a-f]/.test(h) || h.length <= 12)))];
  return [...found.filter((h) => /[a-f]/.test(h)), ...found.filter((h) => !/[a-f]/.test(h))].slice(0, MAX_HASHES);
}

const siteLines = (): string[] => { const c = loadConfig(process.env); return [...c.protectedBranches, ...c.integrationBranches]; };

/** The site's protected and integration branches when the repository has them, in that order; otherwise whatever its
 *  remote HEADs point at. */
export function liveLines(repo: string, branches: string[] = siteLines()): string[] {
  const r = git(repo, ['for-each-ref', '--format=%(refname:short)\t%(symref:short)', 'refs/remotes'], 8000);
  if (r.rc !== 0) return [];
  const refs = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const names = refs.map(([name]) => name);
  const named = branches.flatMap((b) => names.filter((n) => n.slice(n.indexOf('/') + 1) === b));
  if (named.length) return named;
  const heads = refs.map(([, target]) => target).filter(Boolean);
  return heads.length ? [...new Set(heads)] : refs.map(([name]) => name).filter((n) => /(^|\/)(main|master)$/.test(n));
}

interface Fate { hash: string; repo: string; line: string | null; tag: string | null; twin: string | null }

/** The hash under which `line` carries the same patch, '?' when only the equivalence is known, null when there is none. */
function twinIn(repo: string, hash: string, line: string): string | null {
  if (git(repo, ['rev-list', '--parents', '-n', '1', hash], 5000).stdout.trim().split(/\s+/u).length !== 2) return null;
  if (!git(repo, ['cherry', line, hash, `${hash}^`], 15000).stdout.startsWith('-')) return null;
  const subject = git(repo, ['log', '-1', '--format=%s', hash], 5000).stdout.trim();
  return (subject && git(repo, ['log', line, '-F', `--grep=${subject}`, '-n', '1', '--format=%h'], 8000).stdout.trim()) || '?';
}

function fateOf(hash: string, repos: string[], lines: Map<string, string[]>): Fate | null {
  for (const repo of repos) {
    if (git(repo, ['cat-file', '-e', `${hash}^{commit}`], 5000).rc !== 0) continue;
    const live = lines.get(repo) ?? [];
    let line = live.find((l) => git(repo, ['merge-base', '--is-ancestor', hash, l], 8000).rc === 0) ?? null;
    let twin: string | null = null;
    if (!line) for (const l of live) { twin = twinIn(repo, hash, l); if (twin) { line = l; break; } }
    const tagged = twin && twin !== '?' ? twin : hash;
    const tag = line ? git(repo, ['for-each-ref', '--contains', tagged, '--sort=v:refname', '--count=1', '--format=%(refname:short)', 'refs/tags'], 8000).stdout.trim() || null : null;
    return { hash, repo: basename(repo), line, tag, twin };
  }
  return null;
}

interface Note { name: string; text: string; description: string; indexLine: string }

function readNotes(memDir: string, index: string): Note[] {
  const lines = index.split('\n');
  return readdirSync(memDir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort().map((name) => {
    const text = readFileSync(join(memDir, name), 'utf8');
    const description = /^description:\s*"?([^"\n]+)/mu.exec(text.slice(0, 1200))?.[1] ?? '';
    return { name, text, description, indexLine: lines.find((l) => l.includes(`(${name})`)) ?? '' };
  });
}

function staleRows(notes: Note[], repos: string[], rows: Row[]): string {
  const lines = new Map(repos.map((r) => [r, liveLines(r)] as const));
  let marked = 0; let cited = 0; let known = 0; let landed = 0; let twins = 0;
  for (const n of notes) {
    const inBody = spot(n.text, mergeMarker); const inIndex = inBody ? null : spot(n.indexLine, mergeMarker);
    const prod = spot(n.text, prodMarker) ?? spot(n.indexLine, prodMarker);
    const merge = inBody ?? inIndex;
    if (!merge && !prod) continue;
    marked++;
    const fates = hashes(`${n.text}\n${n.indexLine}`).map((h) => { cited++; return fateOf(h, repos, lines); }).filter((f): f is Fate => f !== null);
    known += fates.length;
    const inLive = fates.filter((f) => f.line !== null); landed += inLive.length; twins += inLive.filter((f) => f.twin).length;
    if (!inLive.length) continue;
    const show = (f: Fate): string => `${f.hash}${f.twin ? `≈${f.twin}` : ''}→${f.repo}:${f.line}${f.tag ? ` [${f.tag}]` : ''}`;
    if (merge) {
      const source = inBody ? n.text : n.indexLine;
      const close = citedNear(source, merge.line);
      const near = inLive.filter((f) => close.has(f.hash)); const far = inLive.filter((f) => !close.has(f.hash));
      const outside = fates.filter((f) => f.line === null).map((f) => f.hash);
      const where = `${inBody ? '' : ' (только строка индекса)'} · «${excerpt(source.split('\n')[merge.line])}»`;
      const rest = `${far.length ? `; ещё в живых линиях: ${far.slice(0, 5).map(show).join(', ')}` : ''}${outside.length ? `; вне живых линий: ${outside.slice(0, 5).join(', ')}` : ''}`;
      if (near.length) rows.push({ flag: 'STALE', file: n.name, evidence: `маркер «${merge.marker}»${where} — рядом ${near.slice(0, 5).map(show).join(', ')}${rest}` });
      else rows.push({ flag: 'MAYBE', file: n.name, evidence: `маркер «${merge.marker}»${where} — рядом приземлившихся коммитов нет${rest}` });
    }
    const released = inLive.filter((f) => f.tag !== null);
    if (prod && released.length) rows.push({ flag: 'ASKPROD', file: n.name, evidence: `маркер «${prod.marker}», а коммит уже в релизном теге: ${released.slice(0, 5).map(show).join(', ')} — что на проде, git не знает` });
  }
  const seen = repos.map((r) => `${basename(r)}: ${(lines.get(r) ?? []).join(',') || 'живых линий нет'}`).join('; ');
  return `с маркером статуса ${marked}; хешей в них ${cited}, известны репозиториям ${known}, в живых линиях ${landed} (из них близнецами ${twins}); репозиториев ${repos.length}${repos.length ? ` (${seen})` : ' — STALE, MAYBE и ASKPROD не проверялись'}`;
}

function ageRows(memDir: string, notes: Note[], now: number, rows: Row[]): void {
  const real = realpathSync(memDir);
  const top = git(real, ['rev-parse', '--show-toplevel'], 3000);
  const root = top.rc === 0 ? top.stdout.trim() : null;
  const dirty = new Set<string>();
  if (root) for (const e of git(real, ['status', '--porcelain', '-z', '-uall', '--', '.'], 15000).stdout.split('\0')) if (e.length > 3) dirty.add(e.slice(3));
  for (const n of notes) {
    const abs = join(real, n.name);
    const committed = root && !dirty.has(relative(root, abs)) ? Number(git(real, ['log', '-1', '--format=%ct', '--', n.name], 5000).stdout.trim()) * 1000 : 0;
    const days = Math.floor((now - (committed || statSync(abs).mtimeMs)) / 86_400_000);
    if (days > 60) rows.push({ flag: 'AGE60', file: n.name, evidence: `${days} дней без правки` });
  }
}

const STOP = new Set(`и для по на не в с от до при the a of to in for wms задача фикс фиксы код баг статус наш наша них это или как что уже есть нет тест тесты
order orders status update create inbound outbound customer sorting django claude движок движка стенд стенде заказ заказа заказы флоу ветка ветки коммит
запушено закоммичено миграция миграции контракт корп юзера доказан живой`.split(/\s+/u));

/** Same subject twice: the words two notes share must be rare in the corpus, or every note of one domain pairs up. */
export function dupPairs(notes: Array<{ name: string; description: string }>): Row[] {
  const words = notes.map((n) => new Set((`${n.name.slice(0, -3).replace(/-/gu, ' ')} ${n.description}`.toLowerCase().match(/[a-zа-яё]{4,}/gu) ?? []).filter((w) => !STOP.has(w))));
  const df = new Map<string, number>();
  for (const ws of words) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = (w: string): boolean => (df.get(w) ?? 0) <= Math.max(2, Math.ceil(notes.length * 0.04));
  const rows: Row[] = [];
  for (let a = 0; a < notes.length; a++) for (let b = a + 1; b < notes.length; b++) {
    const common = [...words[a]].filter((w) => words[b].has(w) && rare(w)).sort();
    if (common.length >= 4) rows.push({ flag: 'DUP', file: `${notes[a].name} + ${notes[b].name}`, evidence: `общие редкие слова: ${common.slice(0, 6).join(', ')}` });
  }
  return rows;
}

export function prefilter(opts: PrefilterOptions): Row[] {
  const env = opts.env ?? process.env; const now = (opts.now ?? Date.now)();
  const indexPath = join(opts.memDir, 'MEMORY.md');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const notes = readNotes(opts.memDir, index);
  const rows: Row[] = [];
  const looked = staleRows(notes, opts.repos.filter((r) => existsSync(join(r, '.git'))), rows);
  if (index) {
    for (const n of notes) if (!n.indexLine) rows.push({ flag: 'ORPHAN', file: n.name, evidence: 'нет в MEMORY.md' });
    for (const m of index.matchAll(/\]\(([^)\s]+\.md)\)/gu)) if (!existsSync(join(opts.memDir, m[1]))) rows.push({ flag: 'ORPHAN', file: 'MEMORY.md', evidence: `строка индекса без файла: ${m[1]}` });
  }
  ageRows(opts.memDir, notes, now, rows);
  const worklogs = env.HOME ? ['worklog.md', 'worklog-small.md'].map((f) => join(env.HOME as string, '.claude', f)).filter(existsSync).map((f) => readFileSync(f, 'utf8').split('\n')) : [];
  for (const n of notes) {
    const slug = n.name.slice(0, -3); const hits = worklogs.reduce((sum, ls) => sum + ls.filter((l) => l.includes(slug)).length, 0);
    if (hits >= 3) rows.push({ flag: 'HOT', file: n.name, evidence: `${hits} упоминаний в worklog` });
  }
  rows.push(...dupPairs(notes));
  rows.push({ flag: 'INFO', file: '-', evidence: `нот ${notes.length}; ${looked}` });
  return rows;
}

export function run(argv: string[], opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): Outcome {
  const [memDir, ...repos] = argv;
  if (!memDir) return { rc: 2, stdout: '', stderr: 'memory-prefilter: usage: memory-prefilter.ts <memory-dir> [work-repo ...]\n' };
  if (!existsSync(memDir) || !statSync(memDir).isDirectory()) return { rc: 2, stdout: '', stderr: `memory-prefilter: каталога памяти нет: ${memDir}\n` };
  const missing = repos.filter((r) => !existsSync(join(r, '.git')));
  const rows = prefilter({ memDir, repos, ...opts });
  return { rc: 0, stdout: `${rows.map((r) => `${r.flag}\t${r.file}\t${r.evidence}`).join('\n')}\n`, stderr: missing.map((r) => `memory-prefilter: не git-репозиторий, пропущен: ${r}\n`).join('') };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const out = run(process.argv.slice(2), { env: process.env });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
