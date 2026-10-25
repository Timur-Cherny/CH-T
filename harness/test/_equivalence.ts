// Equivalence classes for pre-bash gates: wrappers that do not change what the shell runs. A gate test takes a core
// command its gate denies and checks that no wrapper turns the verdict into a pass, and that the shim lets every
// wrapped form reach Node — a form the prefilter drops is never judged at all.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HARNESS_ROOT } from './_env.ts';

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** The program word replaced by an equivalent spelling: the first word of the core. */
const program = (c: string, spell: (w: string) => string): string => c.replace(/^\S+/, (w) => spell(w));
const ansi = (w: string): string => `$'${[...w].map((ch) => `\\x${ch.charCodeAt(0).toString(16)}`).join('')}'`;

export const WRAPPERS: ReadonlyArray<readonly [name: string, wrap: (c: string) => string]> = [
  ['as is', (c) => c], ['env', (c) => `env ${c}`], ['env -i', (c) => `env -i PATH=/usr/bin ${c}`], ['command', (c) => `command ${c}`],
  ['exec', (c) => `exec ${c}`], ['assignment', (c) => `FOO=1 ${c}`], ['nice', (c) => `nice ${c}`], ['timeout', (c) => `timeout 30 ${c}`],
  ['nohup', (c) => `nohup ${c}`], ['time', (c) => `time ${c}`], ['setsid', (c) => `setsid ${c}`], ['stdbuf', (c) => `stdbuf -oL ${c}`],
  ['sudo', (c) => `sudo ${c}`], ['sh -c', (c) => `sh -c ${sq(c)}`], ['bash -lc', (c) => `bash -lc ${sq(c)}`], ['eval', (c) => `eval ${sq(c)}`],
  ['pipe to sh', (c) => `echo ${sq(c)} | sh`], ['here-string to bash', (c) => `bash <<< ${sq(c)}`], ['subshell', (c) => `(${c})`],
  ['group', (c) => `{ ${c}; }`], ['and', (c) => `true && ${c}`], ['or', (c) => `${c} || true`], ['background', (c) => `${c} &`],
  ['if', (c) => `if true; then ${c}; fi`], ['for', (c) => `for i in 1; do ${c}; done`], ['function', (c) => `x() { ${c}; }; x`],
  ['backslash', (c) => `\\${c}`], ['quoted word', (c) => program(c, (w) => `"${w}"`)], ['split quotes', (c) => program(c, (w) => `${w[0]}''${w.slice(1)}`)],
  ['absolute path', (c) => program(c, (w) => `/usr/bin/${w}`)], ['ansi-c', (c) => program(c, ansi)],
  ['word from expansions', (c) => program(c, (w) => `a=${w.slice(0, 2)}; b=${w.slice(2)}; $a$b`)],
];

const PREFILTER = readFileSync(join(HARNESS_ROOT, 'bin', 'prefilter.regex'), 'utf8').trim();

/** As the shim (bin/hook): ANSI-C quoting always reaches Node; otherwise grep a copy without quotes and backslashes. */
export function reachesNode(payload: unknown): boolean {
  const json = JSON.stringify(payload);
  return json.includes("$'") || spawnSync('grep', ['-qE', PREFILTER], { input: json.replace(/["'\\]/g, '') }).status === 0;
}

/** Every core under every wrapper: the forms whose verdict is not in `expected`, and the forms the shim drops. */
export async function misses(cores: string[], judge: (cmd: string) => Promise<{ kind: string }> | { kind: string }, payloadOf: (cmd: string) => unknown, expected: ReadonlySet<string> = new Set(['deny'])): Promise<string[]> {
  const out: string[] = [];
  for (const core of cores) for (const [name, wrap] of WRAPPERS) {
    const cmd = wrap(core);
    const v = await judge(cmd);
    if (!expected.has(v.kind)) out.push(`${name}: ${v.kind} ← ${cmd}`);
    if (!reachesNode(payloadOf(cmd))) out.push(`${name}: prefilter drops ← ${cmd}`);
  }
  return out;
}
