// Сверка контракта полей телеметрии. Скилл, читающий журнал, объявляет поля строкой
//   <!-- telemetry-contract: <журнал> = поле,поле -->
// и каждое поле обязано встречаться в строках САМОЙ СВЕЖЕЙ версии adapter этого журнала.
// INVARIANT: сверка из нуля сравнений не выдаёт себя за зелёную — нет каталога, нет объявлений или нет строк журнала
// уходят в notApplicable с причиной, а объявление, которое не разобралось, — в problems.
// Чистый модуль: гейт не регистрирует и при импорте ничего не делает (meta/registry.test.ts импортирует scripts/*).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type Row = Readonly<Record<string, unknown>>;
export type RowsByJournal = Readonly<Record<string, readonly Row[]>>;
export interface Contract { skill: string; journal: string; fields: string[] }
export type Outcome =
  | { status: 'checked'; skill: string; journal: string; adapter: string | null; rows: number; missing: string[] }
  | { status: 'not_applicable'; skill: string; journal: string; reason: string };
export interface Report { problems: string[]; checked: number; notApplicable: string[]; outcomes: Outcome[] }

// Python-оригинал читал \w в юникоде; JS-овый \w — только ASCII, и кириллическое поле молча выпало бы из разбора.
const OPENER = /<!--\s*telemetry-contract\b/gu;
const DECLARATION = /<!--\s*telemetry-contract:\s*([\p{L}\p{N}_.-]+)\s*=\s*([\p{L}\p{N}_,\s]+?)\s*-->/gu;

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? skillFiles(join(dir, e.name)) : e.isFile() && e.name === 'SKILL.md' ? [join(dir, e.name)] : []))
    .sort();
}

export function readContracts(skillsDir: string): { contracts: Contract[]; malformed: string[] } {
  const contracts: Contract[] = []; const malformed: string[] = [];
  for (const file of skillFiles(skillsDir)) {
    const skill = basename(dirname(file));
    const text = readFileSync(file, 'utf8');
    let parsed = 0;
    for (const m of text.matchAll(DECLARATION)) {
      parsed++;
      const fields = m[2].split(',').map((f) => f.trim()).filter(Boolean);
      if (fields.length) contracts.push({ skill, journal: m[1], fields });
      else malformed.push(`${skill}: контракт на ${m[1]} не называет ни одного поля`);
    }
    const opened = text.match(OPENER)?.length ?? 0;
    if (opened > parsed) malformed.push(`${skill}: объявлений telemetry-contract ${opened}, разобрано ${parsed} — неразобранное не сверяется вовсе`);
  }
  return { contracts, malformed };
}

function compare(c: Contract, rows: readonly Row[]): Outcome {
  if (!rows.length) return { status: 'not_applicable', skill: c.skill, journal: c.journal, reason: `в ${c.journal} нет ни одной строки — сверять не с чем` };
  const newest = rows[rows.length - 1].adapter;
  const live = rows.filter((r) => r.adapter === newest);
  const keys = new Set(live.flatMap((r) => Object.keys(r)));
  return { status: 'checked', skill: c.skill, journal: c.journal, adapter: typeof newest === 'string' ? newest : null, rows: live.length, missing: c.fields.filter((f) => !keys.has(f)) };
}

export function checkContracts(skillsDir: string, rowsByJournal: RowsByJournal): Report {
  if (!isDir(skillsDir)) return { problems: [], checked: 0, notApplicable: [`нет каталога скиллов ${skillsDir}`], outcomes: [] };
  const { contracts, malformed } = readContracts(skillsDir);
  if (!contracts.length && !malformed.length) return { problems: [], checked: 0, notApplicable: [`ни один скилл в ${skillsDir} не объявил контракт`], outcomes: [] };
  const outcomes = contracts.map((c) => compare(c, Object.hasOwn(rowsByJournal, c.journal) ? rowsByJournal[c.journal] : []));
  const problems = [...malformed];
  for (const o of outcomes) {
    if (o.status === 'checked' && o.missing.length) problems.push(`${o.skill} → ${o.journal} (${o.adapter ?? 'без adapter'}) не пишет: ${o.missing.join(', ')}`);
  }
  return {
    problems,
    checked: outcomes.filter((o) => o.status === 'checked').length,
    notApplicable: outcomes.flatMap((o) => (o.status === 'not_applicable' ? [`${o.skill} → ${o.journal}: ${o.reason}`] : [])),
    outcomes,
  };
}
