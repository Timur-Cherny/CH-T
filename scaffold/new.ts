// brain new — generators for the elements of the contour, each born in the shape the meta tests demand and wired
// where the router, the shim and the skill map look for it. A generated rule is inert for everything but its own
// target and answers unknown there until it is written: a generator never produces a silent pass.
//   brain new list
//   brain new <skill|gate|checker|agent|runtime|spec|preset> <name> [--purpose "…"] [--description "…"]
//             [--trigger <command>] [--event pre-bash|pre-write] [--root <repo>] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, 'templates');
export const KINDS = ['skill', 'gate', 'checker', 'agent', 'runtime', 'spec', 'preset'] as const;
export type Kind = typeof KINDS[number];
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A trigger is a command word or a path fragment: it lands in TS string literals and in the shim regex. */
const TRIGGER = /^[A-Za-z0-9_.\/+-]{2,60}$/;
/** Free text lands in comments, YAML and a Markdown table: one line, no comment terminator, no table pipe. */
const TEXT = /^[^\n\r|`]*$/;

export interface Options { kind: Kind; name: string; root: string; purpose: string; description: string; trigger: string; event: string; dryRun: boolean; today: string }
export interface Planned { path: string; body: string; mode: 'create' | 'update' }

const upper = (name: string): string => name.replace(/-/g, '_').toUpperCase();
const title = (name: string): string => name.split('-').map((w, i) => (i ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ');

export function fill(template: string, o: Options): string {
  const vars: Record<string, string> = {
    name: o.name, title: title(o.name), purpose: o.purpose, description: o.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
    kill: `CLAUDE_SKIP_${upper(o.name)}`, CONST: upper(o.name), trigger: o.trigger, event: o.event, date: o.today,
    failure: '<что проходило молча до этого элемента — факт, не гипотеза>', invariant: '<утверждение, которое тест держит всегда>',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

const tmpl = (file: string, o: Options): string => fill(readFileSync(join(TEMPLATES, file), 'utf8'), o);

function insertBefore(text: string, marker: string, line: string, file: string): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`${file}: не найдена метка «${marker.trim()}» — вставь строку руками: ${line.trim()}`);
  return text.slice(0, at) + line + text.slice(at);
}

const create = (root: string, rel: string, body: string): Planned => {
  if (existsSync(join(root, rel))) throw new Error(`${rel} уже существует`);
  return { path: rel, body, mode: 'create' };
};
const update = (root: string, rel: string, change: (t: string) => string): Planned => {
  const p = join(root, rel);
  if (!existsSync(p)) throw new Error(`${rel} не найден — генератор запускается из корня CH-T (--root)`);
  return { path: rel, body: change(readFileSync(p, 'utf8')), mode: 'update' };
};

/** Every file the generator writes, computed before anything is written: a failed step leaves the tree untouched. */
export function plan(o: Options): Planned[] {
  const r = o.root;
  switch (o.kind) {
    case 'skill': return [
      create(r, `skills/${o.name}/SKILL.md`, tmpl('skill.md.tmpl', o)),
      create(r, `skills/${o.name}/evals/evals.json`, tmpl('skill.evals.json.tmpl', o)),
      existsSync(join(r, 'skills/README.md'))
        ? update(r, 'skills/README.md', (t) => (t.includes('\n## Свои\n') ? t : `${t.replace(/\n*$/, '\n')}\n## Свои\n\n| Скилл | Идти сюда, когда |\n|---|---|\n`).replace(/\n*$/, `\n| \`${o.name}\` | ${o.description} |\n`))
        : create(r, 'skills/README.md', `# Скиллы\n\n## Свои\n\n| Скилл | Идти сюда, когда |\n|---|---|\n| \`${o.name}\` | ${o.description} |\n`),
    ];
    case 'gate': {
      if (!['pre-bash', 'pre-write'].includes(o.event)) throw new Error('--event: генератор знает pre-bash и pre-write; гейт post/stop пишется по образцу sweep-gates.ts');
      const out = [
        create(r, `harness/src/gates/${o.name}.ts`, tmpl(o.event === 'pre-write' ? 'gate-write.ts.tmpl' : 'gate.ts.tmpl', o)),
        create(r, `harness/test/gates/${o.name}.test.ts`, tmpl(o.event === 'pre-write' ? 'gate-write.test.ts.tmpl' : 'gate.test.ts.tmpl', o)),
        update(r, 'harness/src/gates/index.ts', (t) => insertBefore(t, '// Литеральная запись файла из Bash', `import './${o.name}.ts';\n`, 'index.ts')),
      ];
      if (o.event === 'pre-bash') {
        const word = o.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
        out.push(update(r, 'harness/src/gates/prefilters.ts', (t) => insertBefore(t, '  // indirection:', `  // ${o.name}\n  '(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)',\n`, 'prefilters.ts')));
      }
      return out;
    }
    case 'checker': return [
      create(r, `harness/src/checks/${o.name}.ts`, tmpl('checker.ts.tmpl', o)),
      create(r, `harness/test/checks/${o.name}.test.ts`, tmpl('checker.test.ts.tmpl', o)),
      update(r, 'harness/src/checks/index.ts', (t) => `${t.replace(/\n*$/, '\n')}import './${o.name}.ts';\n`),
    ];
    case 'agent': return [create(r, `agents/${o.name}.md`, tmpl('agent.md.tmpl', o))];
    case 'runtime': return [
      create(r, `runtimes/${o.name}.ts`, tmpl('runtime.ts.tmpl', o)),
      create(r, `runtimes/${o.name}.test.ts`, tmpl('runtime.test.ts.tmpl', o)),
    ];
    case 'spec': return [create(r, `specs/SPEC_${upper(o.name)}.md`, tmpl('spec.md.tmpl', o))];
    case 'preset': return [
      create(r, `presets/${o.name}/README.md`, tmpl('preset.md.tmpl', o)),
      create(r, `presets/${o.name}/harness.config.fragment.json`, '{\n  "_comment": "Поля harness.config.json, которые нужны пресету; контракт — harness/src/config.ts."\n}\n'),
      create(r, `presets/${o.name}/bin/.gitkeep`, ''),
      create(r, `presets/${o.name}/skills/.gitkeep`, ''),
    ];
  }
}

const NEXT: Record<Kind, string[]> = {
  skill: ['Заполни «Когда идти сюда» и «Шаги»: триггер — конкретная ситуация, шаг — проверяемое действие.', 'Две строки evals: где скилл обязан сработать и где не должен.', 'Подключить: ln -s "$PWD/skills/<имя>" ~/.claude/skills/'],
  gate: ['Спека: brain new spec <имя> → spec-critic по редакции.', 'Тест красный до правки: кейсы deny по разным причинам, silent по разным, unknown.', 'Правило в decide(): только парсеры (shell/sql/ts), без regex по SQL/TS.', 'Прогон: cd harness && ~/.claude/harness/bin/run --test test/gates/<имя>.test.ts test/meta/*.test.ts', 'race-auditor по диффу.'],
  checker: ['Правило в judge(); добавленные строки — addedLines() из diff-added.ts.', 'Прогон: cd harness && ~/.claude/harness/bin/run --test test/checks/<имя>.test.ts test/meta/registry.test.ts'],
  agent: ['Метод — проверяемые шаги; выход — находки по убыванию важности и «## Трение».', 'Подключить: ln -s "$PWD/agents/<имя>.md" ~/.claude/agents/'],
  runtime: ['Сверь документацию хуков клиента и впиши дату сверки в шапку адаптера.', 'Добавь адаптер в bin/brain: ADAPTERS, install (запись хуков клиента), launch_argv.', 'Тесты: N/A-таблица покрывает реестр; отказ на неразобранном входе; commit-msg-guard и owner-files доходят.'],
  spec: ['Заполни «Проблема» фактами (файл:строка, счёт, воспроизведение).', 'spec-critic по редакции, затем исполнитель, затем race-auditor.'],
  preset: ['Перенеси обёртки каналов в bin/, скиллы домена в skills/, поля конфига — во фрагмент.', 'README пресета: что ставится и как снимается.'],
};

function regeneratePrefilter(root: string): Promise<string | null> {
  const src = join(root, 'harness/src/gates/prefilters.ts');
  return import(`${pathToFileURL(src).href}?t=${Date.now()}`).then((m: { prefilterSource: () => string }) => {
    const regex = join(root, 'harness/bin/prefilter.regex');
    writeFileSync(regex, `${m.prefilterSource()}\n`);
    return relative(root, regex);
  });
}

function arg(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  if (!argv.length || argv[0] === 'list' || argv[0] === '--help') {
    out(`brain new <вид> <имя> — виды: ${KINDS.join(', ')}\n`
      + 'Порядок, которым собран сам контур: spec → spec-critic → исполнитель → race-auditor → verification-report.\n'
      + 'Подробно — scaffold/README.md.\n');
    return argv.length ? 0 : 64;
  }
  const [kind, name] = argv;
  if (!KINDS.includes(kind as Kind)) { out(`неизвестный вид «${kind}»; brain new list\n`); return 64; }
  if (!name || !NAME.test(name) || name.length > 40) { out('имя: kebab-case, латиница, до 40 знаков (например pg-readonly)\n'); return 64; }
  const o: Options = {
    kind: kind as Kind, name, root: resolve(arg(argv, '--root') ?? join(HERE, '..')),
    purpose: arg(argv, '--purpose') ?? '<одной фразой: зачем этот элемент>',
    description: arg(argv, '--description') ?? `<когда идти сюда: конкретные триггеры для ${name}>`,
    trigger: arg(argv, '--trigger') ?? name, event: arg(argv, '--event') ?? 'pre-bash',
    dryRun: argv.includes('--dry-run'), today: new Date().toISOString().slice(0, 10),
  };
  if (!TRIGGER.test(o.trigger)) { out('--trigger: команда или часть пути — латиница, цифры, . _ / + -, 2–60 знаков\n'); return 64; }
  if (!TEXT.test(o.purpose) || !TEXT.test(o.description) || o.purpose.includes('*/')) { out('--purpose/--description: одна строка без | ` и */\n'); return 64; }
  let planned: Planned[];
  try { planned = plan(o); } catch (e) { out(`brain new: ${(e as Error).message}\n`); return 1; }
  for (const p of planned) out(`${p.mode === 'create' ? '+' : '~'} ${p.path}\n`);
  if (o.dryRun) { out('(--dry-run: ничего не записано)\n'); return 0; }
  for (const p of planned) { mkdirSync(dirname(join(o.root, p.path)), { recursive: true }); writeFileSync(join(o.root, p.path), p.body); }
  if (o.kind === 'gate' && o.event === 'pre-bash') out(`~ ${await regeneratePrefilter(o.root)}\n`);
  out(`\nДальше:\n${NEXT[o.kind].map((s, i) => `  ${i + 1}. ${s.replace(/<имя>/g, name)}`).join('\n')}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; });
}
