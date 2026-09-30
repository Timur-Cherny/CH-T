// A memory corpus with the git facts that decide it: an "engine" whose live lines rel/main and rel/dev the site config
// of the sandbox names, a
// feature branch that never landed, a dev commit cherry-picked into rel/main under another hash, and a release tag; a "brain" whose only live line is what its remote HEAD names.
// Notes are written by the caller — every case of the prefilter is one note and the verdict git gives about it.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Sandbox } from '../_env.ts';
import { resetConfigCache } from '../../src/config.ts';

export interface Corpus { mem: string; engine: string; brain: string; landed: string; landed7: string; open: string; picked: string; twin: string; lookalike: string; merge: string; brainLanded: string; note: (name: string, description: string, body: string, index?: string | null) => void; age: (name: string, days: number, now: number) => void }

export function corpus(sb: Sandbox): Corpus {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const site = join(sb.home, '.claude', 'harness.config.json');
  mkdirSync(join(sb.home, '.claude'), { recursive: true });
  writeFileSync(site, JSON.stringify({ protectedBranches: ['rel/main'], integrationBranches: ['rel/dev'] }));
  process.env.CLAUDE_HARNESS_CONFIG = site; resetConfigCache();
  let tick = 0;
  const sh = (cwd: string, ...args: string[]): string => {
    const at = `2026-09-01T00:00:${String(tick++ % 60).padStart(2, '0')}Z`;
    return execFileSync('git', args, { cwd, env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, encoding: 'utf8' }).trim();
  };
  const repo = (name: string, remote: string, branch: string): string => {
    const bare = join(sb.dir, `${name}.git`); const work = join(sb.dir, name);
    mkdirSync(bare); mkdirSync(work);
    sh(bare, 'init', '-q', '--bare');
    sh(work, 'init', '-q'); sh(work, 'checkout', '-q', '-b', branch); sh(work, 'remote', 'add', remote, bare);
    return work;
  };
  const commit = (work: string, file: string): string => { writeFileSync(join(work, file), `${file}\n`); sh(work, 'add', '.'); sh(work, 'commit', '-qm', file); return sh(work, 'rev-parse', 'HEAD'); };

  const engine = repo('engine', 'source', 'rel/main');
  const landed = commit(engine, 'landed.txt');
  sh(engine, 'tag', 'v1.0.0'); sh(engine, 'push', '-q', 'source', 'rel/main', 'v1.0.0');
  sh(engine, 'branch', 'rel/dev'); sh(engine, 'push', '-q', 'source', 'rel/dev');
  sh(engine, 'checkout', '-q', '-b', 'feature/x');
  const open = commit(engine, 'open.txt');
  sh(engine, 'push', '-q', 'source', 'feature/x');
  sh(engine, 'checkout', '-q', '-b', 'feature/y', 'rel/main');
  const picked = commit(engine, 'picked.txt');
  sh(engine, 'checkout', '-q', 'rel/main'); commit(engine, 'moved.txt'); sh(engine, 'cherry-pick', picked);
  const twin = sh(engine, 'rev-parse', 'HEAD');
  sh(engine, 'push', '-q', 'source', 'rel/main', 'feature/y');
  sh(engine, 'checkout', '-q', '-b', 'feature/z', 'feature/x');
  writeFileSync(join(engine, 'other.txt'), 'same subject, another patch\n'); sh(engine, 'add', '.'); sh(engine, 'commit', '-qm', 'picked.txt');
  const lookalike = sh(engine, 'rev-parse', 'HEAD');
  sh(engine, 'merge', '-q', '--no-ff', '-m', 'merge y into z', 'feature/y');
  const merge = sh(engine, 'rev-parse', 'HEAD');
  sh(engine, 'push', '-q', 'source', 'feature/z');

  const brain = repo('brain', 'secret', 'main');
  const brainLanded = commit(brain, 'brain.txt');
  sh(brain, 'push', '-q', 'secret', 'main'); sh(brain, 'remote', 'set-head', 'secret', 'main');

  const mem = join(sb.dir, 'memory'); mkdirSync(mem);
  const index: string[] = ['# Memory index', ''];
  const flush = (): void => writeFileSync(join(mem, 'MEMORY.md'), `${index.join('\n')}\n`);
  flush();
  return {
    mem, engine, brain, landed, landed7: landed.slice(0, 7), open, picked, twin, lookalike, merge, brainLanded,
    note: (name, description, body, line = '') => {
      writeFileSync(join(mem, `${name}.md`), `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: project\n---\n\n${body}\n`);
      if (line !== null) { index.push(`- [${name}](${name}.md) — ${line || description}`); flush(); }
    },
    age: (name, days, now) => { const t = (now - days * 86_400_000) / 1000; utimesSync(join(mem, `${name}.md`), t, t); },
  };
}

/** One note per case of the prefilter, plus the worklogs of the sandbox HOME that make one of them hot. */
export function standardCorpus(sb: Sandbox, NOW: number): Corpus {
  const c = corpus(sb);
  c.note('merged-says-not', 'приёмка короба, фикс в MR, статус устарел', `Фикс \`${c.landed7}\` в MR !1 (dev) и !2 (release), не влит.`);
  c.note('still-open', 'подбор тележкой, правка ждёт ревью', `Правка \`${c.open.slice(0, 8)}\` в MR !3, не влита; ветка от базы без изменений.`);
  c.note('quoted-marker', 'разбор заголовков коммитов', `Заголовок \`feat(engine): x [DRAFT]\` остался от \`${c.landed7}\`.\n\n\`\`\`\nне влит — так писали в шаблоне\n\`\`\`\n`);
  c.note('index-only', 'хотфикс чтения строк заказа', `Правка \`${c.landed.slice(0, 8)}\` снимает полный скан.`, 'хотфикс чтения строк: MR !4 dev, !5 main, не смёржены');
  c.note('index-with-hash', 'пауза запроса после простоя', 'Причина найдена по плану запроса.', `хотфикс ${c.landed.slice(0, 8)}: MR !7 dev, !8 main, не смёржены`);
  c.note('tracker-legend', 'где лежит задачник и как читать статусы', `Легенда трекера: ✅ done · 🔵 in progress · 🟡 started · ⏸ parked. Формат задан в \`${c.landed7}\`.`);
  c.note('prod-absent', 'отмена этапа и каскад', `Фикс \`${c.landed7}\` вошёл в релиз, на проде его нет.`);
  c.note('brain-line', 'обёртка канала чтения', `Ветка с \`${c.brainLanded.slice(0, 7)}\` в main не влита.`);
  c.note('ref-in-backticks', 'ожидание событий после коммита', `Коммиты \`${c.landed7}\` лежат в release, в \`rel/main\` нет.`);
  c.note('not-a-ref', 'скрипты запуска', `Команда из \`${c.landed7}\`: в \`package.json\` нет нужного скрипта.`);
  c.note('base-is-not-the-work', 'экран сборки, правка на ревью', `Ветка от \`${c.landed7}\`, база без изменений.\n\nСама правка \`${c.open.slice(0, 8)}\` в MR !6, не влита.`);
  c.note('twin-says-not', 'этикетка короба, правка из dev', `Правка \`${c.picked.slice(0, 8)}\` из dev-ветки в MR !9, не влита.`);
  c.note('same-subject-other-patch', 'печать листа подбора', `Коммит \`${c.lookalike.slice(0, 8)}\` с той же темой, что и в main, не влит.`);
  c.note('merge-is-not-a-patch', 'слияние веток сборки', `Мерж \`${c.merge.slice(0, 8)}\` в MR !10, не влит.`);
  c.note('unindexed', 'черновая заметка без строки индекса', 'Просто текст.', null);
  c.note('old-note', 'давно не правленная заметка', 'Просто текст.');
  c.age('old-note', 100, NOW);
  c.note('hot-note', 'часто упоминаемая заметка', 'Просто текст.');
  c.note('scripts-language-a', 'python скрипт в node репозитории отвергнут, язык скрипта задаёт репозиторий', 'Текст.');
  c.note('scripts-language-b', 'язык скрипта определяет репозиторий: python в node проекте отвергнут', 'Текст.');
  for (const n of ['a', 'b', 'c']) c.note(`domain-${n}`, `возврат короба на проде после стадии упаковки, вариант ${n}`, 'Текст.');
  writeFileSync(join(c.mem, 'MEMORY.md'), `${'- [ghost](ghost.md) — строка без файла\n'}`, { flag: 'a' });
  mkdirSync(join(sb.home, '.claude'), { recursive: true });
  writeFileSync(join(sb.home, '.claude', 'worklog.md'), 'hot-note раз\nhot-note два\n');
  writeFileSync(join(sb.home, '.claude', 'worklog-small.md'), 'hot-note три\n');
  return c;
}
