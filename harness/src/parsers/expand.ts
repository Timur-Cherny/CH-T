// What a shell word becomes before the command runs, read from the word's source text with its quotes: tilde, $VAR and
// ${VAR}, brace expansion and pathname expansion against the disk. Whatever the shell computes only at run time —
// $(…), `…`, $'…', positional and special parameters, an unquoted variable whose value would split, glob or brace,
// `**`, more than LIMIT words — is null, and the caller answers unknown instead of guessing.
// Pathname expansion follows zsh, the shell of the Bash tool: a pattern with no match fails the command, so it names no
// file ([]); a dotfile matches only a pattern that starts with a dot.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface Ch { c: string; q: boolean }
const LIMIT = 512;

function lex(src: string, env: NodeJS.ProcessEnv): Ch[] | null {
  const out: Ch[] = [];
  const push = (s: string, q: boolean): void => { for (const c of s) out.push({ c, q }); };
  let i = 0;
  if (src === '~' || src.startsWith('~/')) {
    if (env.HOME === undefined) return null;
    push(env.HOME, true); i = 1;
  } else if (src.startsWith('~')) return null;
  const param = (at: number, quoted: boolean): number | null => {
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(src.slice(at + 1)) ?? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(at + 1));
    if (!m) return null;
    const v = env[m[1]];
    if (v === undefined || (!quoted && /[\s*?[\]{}]/.test(v))) return null;
    push(v, true);
    return at + 1 + m[0].length;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) return null;
      push(src.slice(i + 1, e), true); i = e + 1; continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1])) { push(src[i + 1], true); i += 2; continue; }
        if (d === '`') return null;
        if (d === '$') { const n = param(i, true); if (n === null) return null; i = n; continue; }
        push(d, true); i++;
      }
      if (i >= src.length) return null;
      i++; continue;
    }
    if (c === '\\') { if (i + 1 >= src.length) return null; push(src[i + 1], true); i += 2; continue; }
    if (c === '`') return null;
    if (c === '$') { const n = param(i, false); if (n === null) return null; i = n; continue; }
    push(c, false); i++;
  }
  return out;
}

function range(body: Ch[]): Ch[][] | null {
  if (body.some((x) => x.q)) return null;
  const t = body.map((x) => x.c).join('');
  const lit = (s: string): Ch[] => [...s].map((c) => ({ c, q: true }));
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(t);
  if (num) {
    const [a, b] = [Number(num[1]), Number(num[2])];
    const step = Math.abs(Number(num[3] ?? 1)) || 1;
    if (Math.abs(b - a) / step > LIMIT) return null;
    const width = /^-?0\d/.test(num[1]) || /^-?0\d/.test(num[2]) ? Math.max(num[1].length, num[2].length) : 0;
    const out: Ch[][] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(lit(v < 0 ? `-${String(-v).padStart(width - 1, '0')}` : String(v).padStart(width, '0')));
    return out;
  }
  const chr = /^([A-Za-z])\.\.([A-Za-z])$/.exec(t);
  if (!chr) return null;
  const [a, b] = [chr[1].charCodeAt(0), chr[2].charCodeAt(0)];
  const out: Ch[][] = [];
  for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) out.push(lit(String.fromCharCode(v)));
  return out;
}

/** Unquoted `{a,b}` and `{x..y}`, leftmost first, recursively; a brace pair that is neither stays literal. */
function braces(chs: Ch[], budget: { n: number }): Ch[][] | null {
  for (let i = 0; i < chs.length; i++) {
    if (chs[i].q || chs[i].c !== '{') continue;
    let level = 0; let close = -1; const commas: number[] = [];
    for (let j = i + 1; j < chs.length; j++) {
      const x = chs[j];
      if (x.q) continue;
      if (x.c === '{') level++;
      else if (x.c === '}') { if (level === 0) { close = j; break; } level--; }
      else if (x.c === ',' && level === 0) commas.push(j);
    }
    if (close < 0) return [chs];
    let alts: Ch[][] | null = null;
    if (commas.length) {
      alts = []; let from = i + 1;
      for (const k of [...commas, close]) { alts.push(chs.slice(from, k)); from = k + 1; }
    } else alts = range(chs.slice(i + 1, close));
    if (!alts) continue;
    const out: Ch[][] = [];
    for (const a of alts) {
      const sub = braces([...chs.slice(0, i), ...a, ...chs.slice(close + 1)], budget);
      if (!sub) return null;
      budget.n += sub.length;
      if (budget.n > LIMIT) return null;
      out.push(...sub);
    }
    return out;
  }
  return [chs];
}

const isGlob = (x: Ch): boolean => !x.q && (x.c === '*' || x.c === '?' || x.c === '[');
const escape = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function segmentRegex(seg: Ch[]): RegExp | null {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const x = seg[i];
    if (x.q || !isGlob(x)) { re += escape(x.c); continue; }
    if (x.c === '*') { if (seg[i + 1] && !seg[i + 1].q && seg[i + 1].c === '*') return null; re += '[^/]*'; continue; }
    if (x.c === '?') { re += '[^/]'; continue; }
    let j = i + 1; let cls = '';
    if (seg[j] && !seg[j].q && (seg[j].c === '!' || seg[j].c === '^')) { cls += '^'; j++; }
    if (seg[j] && seg[j].c === ']') { cls += '\\]'; j++; }
    while (j < seg.length && !(seg[j].c === ']' && !seg[j].q)) { cls += seg[j].c === '\\' ? '\\\\' : seg[j].c; j++; }
    if (j >= seg.length) { re += '\\['; continue; }
    re += `[${cls}]`; i = j;
  }
  return new RegExp(`^${re}$`);
}

function glob(chs: Ch[], cwd: string | null): string[] | null {
  const absolute = chs[0]?.c === '/';
  if (!absolute && cwd === null) return null;
  const segs: Ch[][] = [[]];
  for (const x of chs) { if (x.c === '/' ) segs.push([]); else segs[segs.length - 1].push(x); }
  let bases = [absolute ? '/' : (cwd as string)];
  let globbed = false;
  for (const seg of segs) {
    if (!seg.length) continue;
    if (!seg.some(isGlob)) { bases = bases.map((b) => join(b, seg.map((x) => x.c).join(''))); continue; }
    const re = segmentRegex(seg);
    if (!re) return null;
    globbed = true;
    const dot = seg[0].c === '.';
    const next: string[] = [];
    for (const b of bases) {
      let names: string[];
      try { names = readdirSync(b); } catch { continue; }
      for (const n of names.sort()) if ((dot || !n.startsWith('.')) && re.test(n)) next.push(join(b, n));
    }
    if (next.length > LIMIT) return null;
    bases = next;
  }
  if (!globbed) return [chs.map((x) => x.c).join('')];
  const found = bases.filter((b) => { try { statSync(b); return true; } catch { return false; } });
  return absolute ? found : found.map((b) => relative(cwd as string, b));
}

/** The words the shell passes for one source word, or null when they cannot be known before the run. `glob: false` keeps
 *  pathname patterns as they are (a git pathspec that git itself matches). A relative pattern matches against `cwd` and
 *  stays relative, as the shell passes it: `git -C dir` reads those words from dir, not from the shell's directory. */
export function expandWord(src: string, env: NodeJS.ProcessEnv, cwd: string | null, opts: { glob: boolean }): string[] | null {
  const chs = lex(src, env);
  if (!chs) return null;
  const words = braces(chs, { n: 0 });
  if (!words) return null;
  const out: string[] = [];
  for (const w of words) {
    if (opts.glob && w.some(isGlob)) {
      const g = glob(w, cwd);
      if (!g) return null;
      out.push(...g);
    } else out.push(w.map((x) => x.c).join(''));
    if (out.length > LIMIT) return null;
  }
  return out;
}

/** Absolute form of a word the shell resolved against `cwd`; null when the word is relative and the directory unknown. */
export function absolute(word: string, cwd: string | null): string | null {
  if (word.startsWith('/')) return word;
  return cwd === null ? null : resolve(cwd, word);
}
