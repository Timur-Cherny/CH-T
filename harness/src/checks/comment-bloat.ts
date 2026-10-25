// Acceptance of added comments (port of hooks/comment-bloat-check.sh) over the TS AST: (1) a contiguous block longer
// than COMMENT_MAX_BLOCK (5) lines outside the header COMMENT_HEADER_LINES (15); (2) twice as many comment lines as code
// lines on a change of 4+ code lines; (3) edit history inside a comment: dates, before/after wording, commit hashes;
// (4) any comment inside the body of a function, method, accessor, constructor or arrow, describe/it/forEach callbacks
// included: names carry the meaning, the gist goes above the function. Tool directives matched by text prefix
// (@ts-expect-error, eslint-disable…) and a comment above a function declared inside the body do not count; a comment
// of a nested function counts once, in the innermost one; (5) a comment inside a parameter list, paren to paren;
// (6) a SQL comment inside a SQL string literal: it travels to the database and the query logs. Comments are found
// structurally: a regex literal `/\/\/ x/` and a string holding a history word are not comments. Regexes here run only
// on the natural-language text of a comment, which has no grammar. Files outside the TS/JS family are skipped: there is
// no parser for them, and text parsing is forbidden (ADR v4, K1). Kill-switch: CLAUDE_SKIP_COMMENT_CHECK.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type * as TS from 'typescript';
import { loadTypescript, parseSource, commentRanges, commentsByLine } from '../parsers/ts.ts';
import { addedLines } from './diff-added.ts';
import { registerChecker } from './registry.ts';
import type { CommentRange } from '../parsers/ts.ts';
import type { ChangedFile, CheckContext, CheckResult, Checker } from './types.ts';

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const HISTORY = new RegExp([
  String.raw`\b\d{1,2}\.\d{2}\.\d{2,4}\b`,
  String.raw`(?<![\p{L}\p{N}_])(?:раньше|ранее|было|теперь|до\s+этого|коммит)(?![\p{L}\p{N}_])`,
  String.raw`(?<![\p{L}\p{N}_])(?:previous(?:ly)?|used\s+to|we\s+now|formerly)(?![\p{L}\p{N}_])`,
  String.raw`\bcommit\s+[0-9a-f]{7,}\b`,
  String.raw`\b[0-9a-f]{8,40}\b`,
].join('|'), 'iu');
type Scope = { label: string; where: 'body' | 'params' };
const DIRECTIVE = /^\/[/*]\**\s*(?:@ts-(?:expect-error|ignore)|eslint-(?:disable|enable)|biome-ignore|prettier-ignore|(?:istanbul|c8|v8) ignore|@vite-ignore|webpack[A-Z]|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|noinspection)/;

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && EXT.has(extname(file.path)); }

function intEnv(v: string | undefined, dflt: number): number { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : dflt; }

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const maxBlock = intEnv(ctx.env.COMMENT_MAX_BLOCK, 5); const header = intEnv(ctx.env.COMMENT_HEADER_LINES, 15);
  let text: string;
  try { text = readFileSync(file.absPath, 'utf8'); } catch (e) { return { verdict: 'unknown', missing_reason: `файл не читается: ${(e as Error).message.split('\n')[0]}` }; }
  const added = addedLines(file, text);
  if (!added.lines) return { verdict: 'unknown', missing_reason: added.reason };
  if (!added.lines.size) return { verdict: 'pass' };
  const loaded = loadTypescript(file.absPath, ctx.env);
  if (!loaded.ts) return { verdict: 'unknown', missing_reason: loaded.missing_reason };
  const { sf, errors } = parseSource(loaded.ts, text, file.absPath);
  if (errors.length) return { verdict: 'unknown', missing_reason: `файл не разобран: ${errors[0]}` };
  const ts = loaded.ts;
  const ranges = commentRanges(ts, sf);
  const byLine = commentsByLine(ts, sf, ranges);
  const lines = text.split('\n');
  const problems: string[] = [];

  const sorted = [...added.lines].sort((a, b) => a - b);
  let block = 0; let start = 0; let prev = -1;
  const flush = (): void => {
    if (block > maxBlock && start > header) problems.push(`строки ${start}-${start + block - 1}: сплошной комментарий на ${block} строк (порог ${maxBlock})`);
    block = 0;
  };
  for (const n of sorted) {
    const isComment = byLine.get(n)?.startsWithComment === true;
    if (!isComment || n !== prev + 1) flush();
    if (isComment) { if (block === 0) start = n; block++; }
    prev = n;
  }
  flush();

  let c = 0; let k = 0;
  for (const n of sorted) {
    if (byLine.get(n)?.startsWithComment) c++;
    else if ((lines[n - 1] ?? '').trim()) k++;
  }
  if (k >= 4 && c >= 2 * k) problems.push(`в правке ${c} строк комментариев на ${k} строк кода`);

  for (const n of sorted) {
    const t = byLine.get(n)?.commentText; if (!t) continue;
    const hit = HISTORY.exec(t);
    if (hit) problems.push(`строка ${n}: «${hit[0]}» — история правки, ей место в отчёте`);
  }

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const addedLine = (l: number): boolean => added.lines!.has(l);
  const isFunction = (n: TS.Node): n is TS.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
    || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  const fnInit = (e: TS.Expression | undefined): boolean => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const owner = new Map<CommentRange, Scope>();
  const aboveFunction = new Set<number>();
  const claim = (from: number, to: number, scope: Scope): void => {
    let lo = 0; let hi = ranges.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ranges[mid].pos < from) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < ranges.length && ranges[i].pos < to; i++) if (ranges[i].end <= to) owner.set(ranges[i], scope);
  };
  const visit = (n: TS.Node): void => {
    if ((isFunction(n) && !ts.isArrowFunction(n) && !ts.isFunctionExpression(n))
      || (ts.isVariableStatement(n) && n.declarationList.declarations.every((d) => fnInit(d.initializer)))
      || ((ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) && fnInit(n.initializer))) {
      for (const r of ts.getLeadingCommentRanges(sf.text, n.pos) ?? []) aboveFunction.add(r.pos);
    }
    if (isFunction(n) && n.body) {
      const named = (ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) ? n.parent.name : n.name)?.getText(sf);
      const call = ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent) ? n.parent : undefined;
      const first = call?.arguments?.[0];
      const callee = call && (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText(sf).slice(0, 40));
      const label = named ? `функция ${named}` : call ? `колбэк ${callee}(${first && ts.isStringLiteralLike(first) ? `'${first.text.slice(0, 60)}'` : '…'})`
        : ts.isConstructorDeclaration(n) ? 'конструктор' : 'функция <anon>';
      const open = ts.isArrowFunction(n) && !ts.isBlock(n.body) ? n.equalsGreaterThanToken.end : n.body.getStart(sf) + 1;
      const close = ts.isBlock(n.body) ? n.body.end - 1 : n.body.end;
      claim(open, close, { label: `${label} (строки ${lineOf(open)}-${lineOf(close)})`, where: 'body' });
      const kids = n.getChildren(sf);
      const po = kids.find((x) => x.kind === ts.SyntaxKind.OpenParenToken); const pc = kids.find((x) => x.kind === ts.SyntaxKind.CloseParenToken);
      claim(po && pc ? po.end : n.parameters.pos, po && pc ? pc.getStart(sf) : n.parameters.end, { label, where: 'params' });
    }
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const raw = n.getText(sf);
      if (/\b(select|insert|update|delete|with|create|alter|grant)\b/i.test(raw)) {
        const first = lineOf(n.getStart(sf));
        raw.split('\n').forEach((line, i) => {
          const l = first + i; const t = line.trim();
          if (addedLine(l) && (/^--/.test(t) || /\/\*.*\*\//.test(t))) problems.push(`строка ${l}: комментарий внутри SQL — он уходит в базу и в логи запросов, а не читателю кода`);
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const found = new Map<Scope, number[]>();
  for (const r of ranges) {
    const scope = owner.get(r);
    if (!scope || aboveFunction.has(r.pos) || DIRECTIVE.test(sf.text.slice(r.pos, r.end))) continue;
    let touched = false;
    for (let l = lineOf(r.pos); l <= lineOf(r.end - 1); l++) touched ||= addedLine(l);
    if (touched) found.set(scope, [...(found.get(scope) ?? []), lineOf(r.pos)]);
  }
  for (const [scope, at] of found) {
    const where = `на строк${at.length > 1 ? 'ах' : 'е'} ${at.join(', ')}`;
    problems.push(scope.where === 'body'
      ? `${scope.label}: комментарий внутри тела ${where} — смысл несут имена, суть — комментарий над функцией`
      : `${scope.label}: комментарий внутри списка параметров ${where} — имя и тип параметра говорят сами`);
  }

  if (!problems.length) return { verdict: 'pass' };
  const msg = [`Комментарии в ${file.path} не прошли приёмку:`, ...problems.slice(0, 8).map((p) => `  • ${p}`), '',
    '  Внутри тела функции и в параметрах комментариев нет: смысл — в именах, суть — комментарием над функцией;',
    '  в тестах назначение — в имени describe/it. Директивы инструментов (@ts-expect-error, eslint-disable) не в счёт.',
    '  Над функцией и в шапке — только то, что код не говорит сам: контракт, инвариант, грабли; без пересказа и истории.'].join('\n');
  return { verdict: 'fail', message: msg.slice(0, 4096) };
}

export const checker: Checker = { name: 'comment-bloat', tier: 'sync', killSwitch: 'CLAUDE_SKIP_COMMENT_CHECK', applies, run };
registerChecker(checker);
