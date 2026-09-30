// Приёмка добавленных комментариев (порт hooks/comment-bloat-check.sh) по TS-AST: (1) сплошной блок длиннее
// COMMENT_MAX_BLOCK (5) строк вне шапки COMMENT_HEADER_LINES (15); (2) комментариев вдвое больше кода при ≥4 строках
// кода; (3) история правки внутри комментария — даты, «раньше/теперь/было», хеши коммитов. Комментарий определяется
// структурно (regex-литерал `/\/\/ x/` и строка 'раньше' — не комментарии). Regex здесь — только по естественному
// тексту комментария (формулировки истории), у него нет грамматики. Файлы вне TS/JS-семейства не проверяются:
// парсера у них нет, а текстовый разбор запрещён (К1). Kill-switch: CLAUDE_SKIP_COMMENT_CHECK.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { loadTypescript, parseSource, commentsByLine } from '../parsers/ts.ts';
import { addedLines } from './diff-added.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult, Checker } from './types.ts';

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const HISTORY = new RegExp([
  String.raw`\b\d{1,2}\.\d{2}\.\d{2,4}\b`,
  String.raw`(?<![\p{L}\p{N}_])(?:раньше|ранее|было|теперь|до\s+этого|коммит)(?![\p{L}\p{N}_])`,
  String.raw`(?<![\p{L}\p{N}_])(?:previous(?:ly)?|used\s+to|we\s+now|formerly)(?![\p{L}\p{N}_])`,
  String.raw`\bcommit\s+[0-9a-f]{7,}\b`,
  String.raw`\b[0-9a-f]{8,40}\b`,
].join('|'), 'iu');

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
  const byLine = commentsByLine(loaded.ts, sf);
  const lines = text.split('\n');
  const problems: string[] = [];

  // (1) сплошной блок добавленных строк-комментариев вне шапки
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

  // (2) комментариев вдвое больше кода
  let c = 0; let k = 0;
  for (const n of sorted) {
    if (byLine.get(n)?.startsWithComment) c++;
    else if ((lines[n - 1] ?? '').trim()) k++;
  }
  if (k >= 4 && c >= 2 * k) problems.push(`в правке ${c} строк комментариев на ${k} строк кода`);

  // (3) история правки в тексте добавленных комментариев (в том числе хвостовых)
  for (const n of sorted) {
    const t = byLine.get(n)?.commentText; if (!t) continue;
    const hit = HISTORY.exec(t);
    if (hit) problems.push(`строка ${n}: «${hit[0]}» — история правки, ей место в отчёте`);
  }

  // (4) комментарии внутри тела функции — пересказ шагов; (5) комментарий внутри списка параметров — имя и тип
  // говорят сами; (6) комментарий SQL внутри строкового литерала с SQL — уезжает клиенту и в логи запросов.
  // Колбэк аргументом вызова (describe, it, forEach) — не «функция» в смысле (4): его тело — список случаев.
  const maxInBody = intEnv(ctx.env.COMMENT_MAX_IN_BODY, 1);
  const ts = loaded.ts;
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const addedLine = (l: number): boolean => added.lines!.has(l);
  const visit = (n: TS.Node): void => {
    const callback = (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent));
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n)) && n.body && !callback) {
      const name = (n as { name?: { getText(f: TS.SourceFile): string } }).name?.getText(sf) ?? '<anon>';
      const a = lineOf(n.body.getStart(sf)); const b = lineOf(n.body.getEnd());
      const inBody: number[] = [];
      for (let l = a + 1; l < b; l++) if (addedLine(l) && byLine.get(l)?.startsWithComment) inBody.push(l);
      const blocks = inBody.filter((l, i) => i === 0 || l !== inBody[i - 1] + 1).length;
      if (blocks > maxInBody) problems.push(`функция ${name} (строки ${a}-${b}): ${blocks} комментариев внутри тела — пересказ шагов; оставить не больше ${maxInBody}, остальное вынести в имя или удалить`);
      if (n.parameters.length) {
        const pa = lineOf(n.parameters[0].getStart(sf)); const pb = lineOf(n.parameters[n.parameters.length - 1].getEnd());
        for (let l = pa; l <= pb; l++) if (addedLine(l) && byLine.get(l)?.commentText) problems.push(`строка ${l}: комментарий внутри списка параметров функции ${name} — имя и тип параметра говорят сами`);
      }
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

  if (!problems.length) return { verdict: 'pass' };
  const msg = [`Комментарии в ${file.path} не прошли приёмку:`, ...problems.slice(0, 8).map((p) => `  • ${p}`), '',
    '  Оставить: что код не говорит сам — контракт, инвариант, грабли.', '  Убрать: пересказ логики, историю правки, обоснование выбора.',
    '  Если комментарий действительно нужен — сократить, а не доказывать.'].join('\n');
  return { verdict: 'fail', message: msg.slice(0, 4096) };
}

export const checker: Checker = { name: 'comment-bloat', tier: 'sync', killSwitch: 'CLAUDE_SKIP_COMMENT_CHECK', applies, run };
registerChecker(checker);
