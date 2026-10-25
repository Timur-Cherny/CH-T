// What a Bash command may have done to HEAD, read from its words — the evidence capture-commits attributes commits by.
// Asymmetric on purpose: `proof` is only a HEAD-moving git verb, placed in the directory it ran in (`cd`, `-C`, shell
// scopes by segmentsWithCwd); `presence` is anything else that could have moved HEAD there — an unknown git verb or
// alias, a script, a wrapper the parser does not open (`python3 -c '…'`), with every absolute path written inside it.
// Proof makes a commit a session's own; presence of another session only makes it one of several. A read is neither.
import { basename, resolve } from 'node:path';
import { tokenize } from './parsers/shell.ts';
import { segmentsWithCwd } from './gates/git-argv.ts';

export interface CallIntent { proof: string[]; presence: string[]; opaque: boolean }

const MOVES_HEAD = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'reset', 'checkout', 'switch', 'worktree', 'bisect', 'symbolic-ref', 'update-ref', 'filter-branch', 'filter-repo', 'clone']);
const KEEPS_HEAD = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'branch', 'tag', 'fetch', 'push', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'blame', 'annotate', 'grep', 'describe', 'shortlog', 'whatchanged', 'config', 'remote', 'reflog', 'for-each-ref', 'name-rev', 'merge-base', 'cherry', 'show-ref', 'stash', 'add', 'rm', 'mv', 'restore', 'apply', 'notes', 'gc', 'prune', 'fsck', 'count-objects', 'clean', 'help', 'version', 'var', 'check-ignore', 'range-diff', 'format-patch', 'difftool']);
const READS_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo', 'printf', 'pwd', 'test', '[', 'true', 'false', 'stat', 'file', 'which', 'type', 'date', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'awk', 'sed', 'diff', 'cmp', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'sleep', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'tee', 'column', 'comm', 'paste', 'nl', 'od', 'xxd', 'tree', 'ps', 'pgrep', 'lsof', 'curl', 'wget', 'export', 'unset', 'printenv', 'whoami', 'hostname', 'uname']);
const ABSOLUTE_IN_WORD = /(?:^|[\s'"=:(])(\/[^\s'";&|()<>]+)/g;

/** `$NAME/rest`, `${NAME}/rest` or `~/rest` with the value absolute in the hook environment → that path; else as is. */
export function expandPathVar(token: string, env: NodeJS.ProcessEnv): string {
  const m = /^(?:\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))|(~))(\/.*)?$/.exec(token);
  const value = m ? (m[3] ? env.HOME : env[m[1] ?? m[2]!]) : undefined;
  return value && value.startsWith('/') ? value + (m![4] ?? '') : token;
}

export function callIntent(command: string, cwd: string, env: NodeJS.ProcessEnv): CallIntent {
  const out: CallIntent = { proof: [], presence: [], opaque: false };
  const place = (base: string, word: string, vars: NodeJS.ProcessEnv): string | null => {
    const x = expandPathVar(word, vars);
    if (/[$`]/.test(x) || x.startsWith('~')) { out.opaque = true; return null; }
    return resolve(base, x);
  };
  // A null cwd: a `cd` went somewhere unseen, or a branch may have skipped it.
  for (const seg of segmentsWithCwd(tokenize(command), cwd, env)) {
    const cmd = basename(seg.name);
    const rest = seg.rest;
    if (cmd === 'cd' || cmd === 'chdir' || cmd === 'pushd') {
      const to = rest.find((t) => !t.startsWith('-'));
      if (to !== undefined) place(seg.cwd ?? cwd, to, seg.env);
      continue;
    }
    if (cmd === 'git') {
      let at: string | null = seg.cwd; let verb = '';
      for (let i = 0; i < rest.length && !verb; i++) {
        const t = rest[i]!;
        if (t === '-C') at = at === null ? null : place(at, rest[++i] ?? '.', seg.env);
        else if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') i++;
        else if (!t.startsWith('-')) verb = t;
      }
      if (KEEPS_HEAD.has(verb)) continue;
      if (at === null) { out.opaque = true; continue; }
      (MOVES_HEAD.has(verb) ? out.proof : out.presence).push(at);
      continue;
    }
    if (READS_ONLY.has(cmd) || (cmd === 'find' && !rest.some((t) => /^-(exec|execdir|ok|okdir|delete)$/.test(t)))) continue;
    if (seg.cwd !== null) out.presence.push(seg.cwd); else out.opaque = true;
    for (const word of seg.argv) for (const m of word.matchAll(ABSOLUTE_IN_WORD)) out.presence.push(m[1]!);
    if (seg.argv.some((word) => /\$|(^|\s)~/.test(word))) out.opaque = true;
  }
  return out;
}
