// Старый токенизатор закрытой грамматики — остаётся под флагом CLAUDE_HARNESS_SHELL_PARSER=legacy на время
// прогона по транскриптам (см. context-packs/2026-09-16-LOCAL-shell-parser-own.md, шаг 7): обе модели считаются
// и сравниваются, после недели без переходов файл удаляется. Здесь ничего не правится.
// Граница объявлена: $(…) и `…` — непрозрачные токены; sh -c / bash -c / eval — один уровень рекурсии; глубже,
// незакрытые кавычки, here-string `<<<` — `unknown` с причиной. Here-doc разбирается: тело снимается с ограничителем
// и кладётся в `heredocs` своего сегмента; ограничитель в кавычках = подстановок нет.
import { expansionAt, hasExpansion, effective } from './argv.ts';
import type { Segment, OpaqueSpan, ShellParse, TokenizeOptions } from './argv.ts';

const SEPARATORS = new Set([';', '\n', '|', '&', '(', ')']);
const MAX_DEPTH = 1;

export function tokenizeLegacy(cmd: string, depth = 0, opts: TokenizeOptions = {}): ShellParse {
  const segments: Segment[] = [];
  const unknown: string[] = [];
  const opaque: OpaqueSpan[] = [];
  const bySerial = new Map<number, Segment>();
  let segUnknown: string[] = [];
  let segOpaque: OpaqueSpan[] = [];
  let dyn: number[] = [];
  let pending: HereDoc[] = [];
  let argv: string[] = [];
  let src: string[] = [];
  let word = '';
  let hasWord = false;
  let wordDyn = false;
  let wordStart = 0;
  let serial = 0;
  let segStart = 0;
  let i = 0;
  const n = cmd.length;

  const flushWord = () => {
    if (!hasWord) return;
    if (wordDyn) dyn.push(argv.length);
    argv.push(word); src.push(cmd.slice(wordStart, Math.min(i, n))); word = ''; hasWord = false; wordDyn = false;
  };
  const flushSeg = (end: number) => {
    flushWord();
    if (argv.length) {
      const slice = cmd.slice(segStart, end);
      const raw = slice.trim();
      const seg: Segment = { argv, raw, at: segStart + slice.indexOf(raw), depth, heredocs: [], unknown: [...segUnknown], opaque: segOpaque, dynamic: dyn, src };
      segments.push(seg);
      bySerial.set(serial, seg);
    }
    unknown.push(...segUnknown);
    serial++;
    argv = []; src = []; segStart = end; segUnknown = []; segOpaque = []; dyn = [];
  };
  const note = (kind: string, text: string) => {
    const span = { kind, text };
    segUnknown.push(kind); segOpaque.push(span); opaque.push(span);
  };
  const noteOn = (owner: Segment | undefined, kind: string, text: string) => {
    const span = { kind, text };
    if (owner) { owner.unknown.push(kind); owner.opaque.push(span); }
    unknown.push(kind); opaque.push(span);
  };
  /** Тела ожидающих here-doc: от строки после `\n` до строки-ограничителя. Возвращает позицию за ней. */
  const consumeHeredocs = (start: number): number => {
    let pos = start;
    for (const h of pending) {
      const lines: string[] = [];
      let closed = false;
      while (pos <= n) {
        let eol = cmd.indexOf('\n', pos);
        const last = eol < 0;
        if (last) eol = n;
        const line = cmd.slice(pos, eol);
        const body = h.strip ? line.replace(/^\t+/, '') : line;
        pos = eol + 1;
        if (body === h.delim) { closed = true; break; }
        lines.push(body);
        if (last) break;
      }
      const text = lines.length ? lines.join('\n') + '\n' : '';
      const owner = bySerial.get(h.owner);
      if (owner) owner.heredocs.push(text); else noteOn(undefined, 'here-doc-orphan', text);
      if (!closed) noteOn(owner, 'here-doc-unterminated', text);
      else if (h.expand && hasExpansion(text)) noteOn(owner, 'here-doc-expansion', text);
    }
    pending = [];
    return Math.min(pos, n);
  };
  const substitution = (from: number): number => {
    const k = cmd[from] === '`' ? cmd.indexOf('`', from + 1) : closeParen(cmd, from + 1);
    return k < 0 ? n - 1 : k;
  };

  while (i < n) {
    const ch = cmd[i];
    if (!hasWord) wordStart = i;
    if (ch === '\\' && i + 1 < n) { word += cmd[i + 1]; hasWord = true; i += 2; continue; }
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) { note('unterminated-single-quote', cmd.slice(i + 1)); word += cmd.slice(i + 1); hasWord = true; i = n; break; }
      const body = cmd.slice(i + 1, j);
      if (opts.expandedByOuter && hasExpansion(body)) wordDyn = true;
      word += body; hasWord = true; i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1; let buf = '';
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n) { buf += cmd[j + 1]; j += 2; continue; }
        if ((cmd[j] === '$' && cmd[j + 1] === '(') || cmd[j] === '`') {
          const k = substitution(j);
          note('command-substitution', cmd.slice(j, k + 1)); wordDyn = true;
          buf += cmd.slice(j, k + 1); j = k + 1; continue;
        }
        if (expansionAt(cmd, j, 'dq')) wordDyn = true;
        buf += cmd[j]; j++;
      }
      if (j >= n) note('unterminated-double-quote', buf);
      word += buf; hasWord = true; i = Math.min(j + 1, n); continue;
    }
    if ((ch === '$' && cmd[i + 1] === '(') || ch === '`') {
      const k = substitution(i);
      note('command-substitution', cmd.slice(i, k + 1)); wordDyn = true;
      word += cmd.slice(i, k + 1); hasWord = true; i = k + 1; continue;
    }
    if ((ch === '<' || ch === '>') && cmd[i + 1] === '(') {
      const k = closeParen(cmd, i + 1);
      const end = k < 0 ? n - 1 : k;
      note('command-substitution', cmd.slice(i, end + 1)); wordDyn = true;
      word += cmd.slice(i, end + 1); hasWord = true; i = end + 1; continue;
    }
    if (expansionAt(cmd, i, 'bare')) { wordDyn = true; word += ch; hasWord = true; i++; continue; }
    if (ch === '<' && cmd[i + 1] === '<') {
      flushWord();
      if (cmd[i + 2] === '<') { const eol = cmd.indexOf('\n', i + 3); note('here-string', cmd.slice(i + 3, eol < 0 ? n : eol)); i += 3; continue; }
      let j = i + 2;
      const strip = cmd[j] === '-'; if (strip) j++;
      while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++;
      const d = readDelimiter(cmd, j);
      if (!d) { note('here-doc', cmd.slice(j)); i = j; continue; }
      pending.push({ delim: d.delim, strip, expand: d.expand, owner: serial });
      i = d.next; continue;
    }
    if (ch === '#' && !hasWord) { const j = cmd.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (SEPARATORS.has(ch)) {
      if (ch === '&' && i > 0 && cmd[i - 1] === '>') { word += ch; hasWord = true; i++; continue; }
      flushSeg(i);
      while (i < n && SEPARATORS.has(cmd[i])) {
        if (cmd[i] === '\n' && pending.length) { i = consumeHeredocs(i + 1); continue; }
        i++;
      }
      segStart = i; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flushWord(); i++; continue; }
    word += ch; hasWord = true; i++;
  }
  flushSeg(n);
  if (pending.length) { for (const h of pending) noteOn(bySerial.get(h.owner), 'here-doc-unterminated', ''); pending = []; }

  const expanded: Segment[] = [];
  for (const seg of segments) {
    expanded.push(seg);
    const { name, rest } = effective(seg.argv);
    const isShell = name === 'sh' || name === 'bash' || name === 'zsh' || name === 'dash';
    const restAt = seg.argv.length - rest.length;
    const inners: Array<{ text: string; outer: boolean }> = [];
    if (isShell && rest.includes('-c')) { const k = rest.indexOf('-c') + 1; if (rest[k] !== undefined) inners.push({ text: rest[k], outer: seg.dynamic.includes(restAt + k) }); }
    if (name === 'eval') inners.push({ text: rest.join(' '), outer: seg.dynamic.some((x) => x >= restAt) });
    if (isShell) for (const h of seg.heredocs) inners.push({ text: h, outer: seg.unknown.includes('here-doc-expansion') });
    if (!inners.length) continue;
    if (depth >= MAX_DEPTH) {
      const span = { kind: 'nested-shell-depth', text: inners.map((x) => x.text).join('\n') };
      unknown.push(span.kind); seg.opaque.push(span); opaque.push(span);
      continue;
    }
    for (const inner of inners) {
      const sub = tokenizeLegacy(inner.text, depth + 1, { expandedByOuter: inner.outer });
      expanded.push(...sub.segments); unknown.push(...sub.unknown); opaque.push(...sub.opaque);
    }
  }
  return { segments: expanded, unknown: [...new Set(unknown)], opaque };
}

interface HereDoc { delim: string; strip: boolean; expand: boolean; owner: number }

/** Ограничитель here-doc: `EOF`, `'EOF'`, `"EOF"`, `\EOF`. Кавычка/экранирование = подстановок в теле нет. */
function readDelimiter(s: string, from: number): { delim: string; expand: boolean; next: number } | null {
  let i = from;
  let delim = '';
  let quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { const k = s.indexOf(c, i + 1); if (k < 0) return null; delim += s.slice(i + 1, k); quoted = true; i = k + 1; continue; }
    if (c === '\\' && i + 1 < s.length) { delim += s[i + 1]; quoted = true; i += 2; continue; }
    if (/[\s;|&<>()]/.test(c)) break;
    delim += c; i++;
  }
  return delim ? { delim, expand: !quoted, next: i } : null;
}

/** Закрывающая скобка подстановки, открытой в `open`, или -1. Скобка в кавычках, экранированная, во вложенной
 *  подстановке и в теле here-doc — не закрывающая: `$(echo ')'; psql …)` обрывался на кавычке, а апостроф в теле
 *  `-m "$(cat <<'EOF' … EOF\n)"` открывал строку до конца команды и прятал всё, что стоит за коммитом. */
export function closeParen(s: string, open: number): number {
  let depth = 0;
  const bodies: Array<{ delim: string; strip: boolean }> = [];
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === '\n' && bodies.length) { k = skipBodies(s, k + 1, bodies) - 1; bodies.length = 0; continue; }
    if (c === '<' && s[k + 1] === '<' && s[k + 2] !== '<') {
      let j = k + 2;
      const strip = s[j] === '-'; if (strip) j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      const d = readDelimiter(s, j);
      if (d) { bodies.push({ delim: d.delim, strip }); k = d.next - 1; continue; }
    }
    if (c === '\\') { k++; continue; }
    if (c === "'") { const j = s.indexOf("'", k + 1); if (j < 0) return -1; k = j; continue; }
    if (c === '"') {
      let j = k + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { const e = closeParen(s, j + 1); if (e < 0) return -1; j = e + 1; continue; }
        j++;
      }
      if (j >= s.length) return -1;
      k = j; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** Позиция за телами here-doc, начатыми с `pos`. Ограничитель внутри `$(…)` бывает записан как `EOF)` — тогда
 *  возвращается позиция скобки, чтобы её посчитал вызывающий. */
function skipBodies(s: string, pos: number, bodies: Array<{ delim: string; strip: boolean }>): number {
  for (const h of bodies) {
    while (pos < s.length) {
      let eol = s.indexOf('\n', pos);
      if (eol < 0) eol = s.length;
      const line = s.slice(pos, eol);
      const lead = h.strip ? line.length - line.replace(/^\t+/, '').length : 0;
      const body = line.slice(lead);
      if (body === h.delim) { pos = eol + 1; break; }
      if (body.startsWith(`${h.delim})`)) { pos += lead + h.delim.length; return pos; }
      pos = eol + 1;
    }
  }
  return Math.min(pos, s.length);
}

