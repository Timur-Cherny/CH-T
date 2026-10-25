// Аргументы psql без запуска: откуда берётся SQL (-c, -f, <), строка подключения (conninfo), метакоманды
// в тексте. Общее для pg-session и data-boundary: гейт не импортирует другой гейт ради разбора аргументов.
export const PSQL_LIKE: ReadonlySet<string> = new Set(['psql', 'pgcli']);
const VALUE_SHORT = new Set(['c', 'd', 'f', 'h', 'p', 'U', 'v', 'F', 'L', 'o', 'P', 'R', 'T']);
const VALUE_LONG = new Set(['command', 'dbname', 'file', 'host', 'port', 'username', 'set', 'variable', 'field-separator', 'log-file', 'output', 'pset', 'record-separator', 'table-attr']);

/** Значение ключа в conninfo `k=v k2='v 2'` (libpq keyword/value form). */
export function conninfoValue(s: string, key: string): string | null {
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const eq = s.indexOf('=', i);
    if (eq < 0) return null;
    const k = s.slice(i, eq).trim();
    i = eq + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
    let v = '';
    if (s[i] === "'") {
      i++;
      while (i < s.length && s[i] !== "'") { if (s[i] === '\\' && i + 1 < s.length) i++; v += s[i]; i++; }
      i++;
    } else { while (i < s.length && !/\s/.test(s[i])) { v += s[i]; i++; } }
    if (k === key) return v;
  }
  return null;
}

export type SqlSource = { kind: 'inline'; sql: string } | { kind: 'file'; path: string } | { kind: 'stdin' };
/** at — индекс токена в args, где лежит значение источника (для флага «собран подстановкой»). */
export type SqlSourceAt = SqlSource & { at: number };

/** Аргументы после токена psql/pgcli → источники SQL с позицией значения. */
export function psqlSourceTokens(args: string[]): SqlSourceAt[] {
  const out: SqlSourceAt[] = [];
  const opt = (name: string, value: string | undefined, at: number): void => {
    if (value === undefined) return;
    if (name === 'c' || name === 'command') out.push({ kind: 'inline', sql: value, at });
    if (name === 'f' || name === 'file') out.push(value === '-' ? { kind: 'stdin', at } : { kind: 'file', path: value, at });
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') break;
    if (t === '<') { if (args[i + 1] !== undefined) { i++; out.push({ kind: 'file', path: args[i], at: i }); } continue; }
    if (t.startsWith('<') && !t.startsWith('<<')) { out.push({ kind: 'file', path: t.slice(1), at: i }); continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (!VALUE_LONG.has(name)) continue;
      if (eq < 0) { i++; opt(name, args[i], i); } else opt(name, t.slice(eq + 1), i);
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (!VALUE_SHORT.has(c)) continue;
        const attached = t.slice(k + 1);
        if (attached.length) opt(c, attached, i); else { i++; opt(c, args[i], i); }
        break;
      }
    }
  }
  return out;
}

export function psqlSources(args: string[]): SqlSource[] {
  return psqlSourceTokens(args).map(({ at: _at, ...src }) => src as SqlSource);
}

export interface PsqlText { sql: string; copies: string[]; shells: string[]; opaque: string[] }

/** Метакоманды psql — не SQL: `\copy` судится как COPY, `\!` и `\o|`/`\g|` — как shell, `\i`/`\gexec` непрозрачны. */
export function splitPsqlMeta(text: string): PsqlText {
  const out: PsqlText = { sql: '', copies: [], shells: [], opaque: [] };
  const sql: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\\([A-Za-z!]+)\s?(.*)$/.exec(line);
    if (!m) { sql.push(line); continue; }
    const [, cmd, rest] = m;
    if (cmd === 'copy') out.copies.push(rest);
    else if (cmd === '!') out.shells.push(rest);
    else if ((cmd === 'o' || cmd === 'out' || cmd === 'g') && rest.trim().startsWith('|')) out.shells.push(rest.trim().slice(1));
    else if (['i', 'ir', 'include', 'include_relative', 'gexec'].includes(cmd)) out.opaque.push(`\\${cmd}`);
  }
  out.sql = sql.join('\n');
  return out;
}
