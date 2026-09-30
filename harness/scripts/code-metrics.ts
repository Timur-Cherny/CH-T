// code-metrics — метрики формы TypeScript-кода по AST: длина функций, глубина вложенности, приведения типов,
// длина строк, доля коротких имён, дубли окон между файлами, невидимые байты. Ответ на «как пишут агенты»
// держится числами с объёмом выборки, а не впечатлением, и один скрипт даёт сравнимые строки для харнесса,
// движка, фронта и коннектора. Процессов не запускает, дерево не меняет. TypeScript берётся из node_modules
// рядом с каталогом (версия проекта), иначе из тулчейна харнесса. CLI только под сторожем isMain.
//   node scripts/code-metrics.ts <каталог> [--top N] [--long-fn N] [--long-line N] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { loadTypescript } from '../src/parsers/ts.ts';
import type { TsModule } from '../src/parsers/ts.ts';
import { isMainModule } from '../src/is-main.ts';

export interface FnRow { file: string; line: number; name: string; lines: number; params: number }
export interface DupRow { files: string[]; lines: number; first: string }
export interface NestRow { file: string; line: number; depth: number }
export interface OddByte { file: string; offset: number; byte: number }
export interface Metrics {
  root: string; files: number; lines: number; commentLines: number; longLines: number; veryLongLines: number;
  functions: number; longFunctions: FnRow[]; casts: number; anys: number; nonNull: number;
  declarations: number; shortNames: number; nesting: NestRow[]; duplicates: DupRow[]; oddBytes: OddByte[];
}
export interface Options { longFn?: number; longLine?: number; veryLongLine?: number; exclude?: ReadonlySet<string> }

export const EXCLUDE_DEFAULT: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'out', 'vendor']);
const DEFAULTS = { longFn: 40, longLine: 140, veryLongLine: 200 };

/** Исходники .ts/.tsx под корнем без сгенерированных каталогов и деклараций. */
export function listSources(root: string, exclude: ReadonlySet<string> = EXCLUDE_DEFAULT): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!exclude.has(n)) walk(p); continue; }
      const ext = extname(n);
      if ((ext === '.ts' || ext === '.tsx') && !n.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

const isCommentLine = (l: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(l);
const NESTING = new Set(['IfStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoStatement', 'SwitchStatement', 'TryStatement', 'ArrowFunction', 'FunctionExpression']);

function fnName(ts: TsModule, n: { name?: { getText(): string }; parent: unknown }): string {
  const own = n.name?.getText();
  if (own) return own;
  const p = n.parent as { kind: number; name?: { getText(): string } };
  if (ts.isVariableDeclaration(p as never) || ts.isPropertyAssignment(p as never) || ts.isPropertyDeclaration(p as never)) return p.name?.getText() ?? '<anon>';
  return '<anon>';
}

/** Дубли: окна по 4 содержательные строки, встречающиеся минимум в двух файлах; соседние окна одной пары склеиваются в run. */
function duplicates(texts: Map<string, string[]>): DupRow[] {
  const windows = new Map<string, string[]>();
  for (const [file, lines] of texts) {
    const L = lines.map((s) => s.trim());
    for (let i = 0; i + 4 <= L.length; i++) {
      const win = L.slice(i, i + 4);
      if (win.some((l) => l.length < 12 || isCommentLine(l) || l.startsWith('import ') || l.startsWith('export ') && l.endsWith('{'))) continue;
      const k = win.join('\n');
      if (!windows.has(k)) windows.set(k, []);
      windows.get(k)!.push(`${file}:${i + 1}`);
    }
  }
  const rows: DupRow[] = [];
  const runs = new Map<string, DupRow & { lastLines: number[] }>();
  for (const [k, where] of windows) {
    const files = where.map((w) => w.slice(0, w.lastIndexOf(':')));
    if (new Set(files).size < 2) continue;
    const lineNos = where.map((w) => Number(w.slice(w.lastIndexOf(':') + 1)));
    const key = files.join('|');
    const run = runs.get(key);
    if (run && run.lastLines.every((l, j) => lineNos[j] === l + 1)) { run.lines++; run.lastLines = lineNos; continue; }
    const row = { files: where, lines: 4, first: k.split('\n')[0], lastLines: lineNos };
    runs.set(key, row); rows.push(row);
  }
  return rows.map(({ files, lines, first }) => ({ files, lines, first })).sort((a, b) => b.lines - a.lines);
}

export function measure(root: string, ts: TsModule, opts: Options = {}): Metrics {
  const o = { ...DEFAULTS, ...opts };
  const files = listSources(root, opts.exclude);
  const m: Metrics = { root, files: files.length, lines: 0, commentLines: 0, longLines: 0, veryLongLines: 0, functions: 0, longFunctions: [], casts: 0, anys: 0, nonNull: 0, declarations: 0, shortNames: 0, nesting: [], duplicates: [], oddBytes: [] };
  const texts = new Map<string, string[]>();
  for (const f of files) {
    const rel = relative(root, f);
    const buf = readFileSync(f);
    for (let i = 0; i < buf.length && m.oddBytes.filter((b) => b.file === rel).length < 5; i++) { const c = buf[i]; if (c < 32 && c !== 9 && c !== 10 && c !== 13) m.oddBytes.push({ file: rel, offset: i, byte: c }); }
    const src = buf.toString('utf8');
    const lines = src.split('\n');
    texts.set(rel, lines);
    for (const l of lines) { m.lines++; if (l.length > o.longLine) m.longLines++; if (l.length > o.veryLongLine) m.veryLongLines++; if (isCommentLine(l)) m.commentLines++; }
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, extname(f) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let deepest: NestRow = { file: rel, line: 0, depth: 0 };
    const visit = (n: import('typescript').Node, depth: number): void => {
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
        const a = sf.getLineAndCharacterOfPosition(n.getStart()).line; const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
        m.functions++;
        const len = b - a + 1;
        if (len >= o.longFn) m.longFunctions.push({ file: rel, line: a + 1, name: fnName(ts, n as never), lines: len, params: n.parameters.length });
      }
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) m.casts++;
      if (n.kind === ts.SyntaxKind.AnyKeyword) m.anys++;
      if (ts.isNonNullExpression(n)) m.nonNull++;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { m.declarations++; if (n.name.text.length <= 3) m.shortNames++; }
      const d = depth + (NESTING.has(ts.SyntaxKind[n.kind]) ? 1 : 0);
      if (d > deepest.depth) deepest = { file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, depth: d };
      ts.forEachChild(n, (c) => visit(c, d));
    };
    visit(sf, 0);
    m.nesting.push(deepest);
  }
  m.longFunctions.sort((a, b) => b.lines - a.lines);
  m.nesting.sort((a, b) => b.depth - a.depth);
  m.duplicates = duplicates(texts);
  return m;
}

const pct = (a: number, b: number): string => (b ? `${(100 * a / b).toFixed(1)} %` : '—');

/** Таблица для человека: те же строки для любого каталога, чтобы сравнивать репозитории между собой. */
export function render(m: Metrics, top = 10): string {
  const out: string[] = [];
  out.push(`каталог ${m.root}: файлов ${m.files}, строк ${m.lines}, функций ${m.functions}`);
  out.push(`  строк комментариев ${m.commentLines} (${pct(m.commentLines, m.lines)}) · строк длиннее порога ${m.longLines} (${pct(m.longLines, m.lines)}), из них очень длинных ${m.veryLongLines}`);
  out.push(`  функций длиннее порога ${m.longFunctions.length} из ${m.functions} (${pct(m.longFunctions.length, m.functions)}) · приведения as ${m.casts} · any ${m.anys} · non-null ! ${m.nonNull}`);
  out.push(`  коротких имён (≤3 символа) ${m.shortNames} из ${m.declarations} объявлений (${pct(m.shortNames, m.declarations)}) · дублей между файлами ${m.duplicates.length} · невидимых байтов ${m.oddBytes.length}`);
  out.push('  самые длинные функции:');
  for (const r of m.longFunctions.slice(0, top)) out.push(`    ${String(r.lines).padStart(5)} строк  ${r.file}:${r.line}  ${r.name}(${r.params})`);
  out.push('  самая глубокая вложенность:');
  for (const r of m.nesting.slice(0, Math.min(top, 5))) out.push(`    глубина ${r.depth}  ${r.file}:${r.line}`);
  if (m.duplicates.length) { out.push('  дубли (run строк, где):'); for (const d of m.duplicates.slice(0, top)) out.push(`    ${String(d.lines).padStart(3)}  ${d.files.join('  <->  ')}\n         ${d.first.slice(0, 100)}`); }
  for (const b of m.oddBytes.slice(0, top)) out.push(`  невидимый байт 0x${b.byte.toString(16)} в ${b.file} @${b.offset}`);
  return out.join('\n');
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = args.find((a) => !a.startsWith('--') && a !== flag('--top') && a !== flag('--long-fn') && a !== flag('--long-line'));
  if (!root) { console.error(`использование: node ${basename(process.argv[1])} <каталог> [--top N] [--long-fn N] [--long-line N] [--json]`); process.exit(2); }
  const loaded = loadTypescript(root, process.env);
  if (!loaded.ts) { console.error(`typescript не загружен: ${loaded.missing_reason}`); process.exit(2); }
  const m = measure(root, loaded.ts, { longFn: Number(flag('--long-fn') ?? DEFAULTS.longFn), longLine: Number(flag('--long-line') ?? DEFAULTS.longLine) });
  console.log(args.includes('--json') ? JSON.stringify(m, null, 2) : render(m, Number(flag('--top') ?? 10)));
}
