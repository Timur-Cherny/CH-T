// Разбор команды оболочки для гейтов: ShellParse (сегменты-команды с argv, here-doc, неразобранными частями).
// По умолчанию — свой парсер по грамматике (lexer.ts → parser.ts → model.ts); CLAUDE_HARNESS_SHELL_PARSER=legacy
// возвращает старый токенизатор (legacy.ts) на время прогона по транскриптам. Гейт над результатом обязан
// трактовать unknown как «доказать безопасность нельзя», не как pass (I1).
import { tokenizeLegacy } from './legacy.ts';
import { tokenizeAst } from './model.ts';
import { effective } from './argv.ts';
import type { ShellParse, TokenizeOptions } from './argv.ts';

export { expansionAt, hasExpansion, effective } from './argv.ts';
export type { Segment, OpaqueSpan, ShellParse, TokenizeOptions, ExpansionContext } from './argv.ts';
export { closeParen } from './legacy.ts';

export const useLegacyParser = (): boolean => process.env.CLAUDE_HARNESS_SHELL_PARSER === 'legacy';

export function tokenize(cmd: string, depth = 0, opts: TokenizeOptions = {}): ShellParse {
  return useLegacyParser() ? tokenizeLegacy(cmd, depth, opts) : tokenizeAst(cmd, depth, opts);
}

/** Команды всех сегментов (в том числе внутри sh -c). */
export function commands(parse: ShellParse): Array<{ name: string; argv: string[]; rest: string[]; depth: number }> {
  return parse.segments.map((s) => { const e = effective(s.argv); return { name: e.name, argv: s.argv, rest: e.rest, depth: s.depth }; });
}

/** Слово встречается как отдельный токен в любом сегменте (kubectl exec pod -- psql …). */
export function mentions(parse: ShellParse, word: string | RegExp): boolean {
  const re = word instanceof RegExp ? word : new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return parse.segments.some((s) => s.argv.some((t) => re.test(t) || re.test(t.split('/').pop() ?? t)));
}
