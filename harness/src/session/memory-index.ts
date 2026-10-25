// Stop-часть memory-integrity: связность индекса памяти ТЕКУЩЕГО проекта (каталог берётся от transcript_path).
// Нота без строки в MEMORY.md потеряется — её не увидят в начале сессии; строка индекса на несуществующий
// файл ведёт в никуда; висячие [[ссылки]] легальны и перечисляются только когда их больше пяти.
// Не блокирует — печатает (context), как оригинал. Kill-switch общий с проверкой шапки при записи
// (та живёт в pre-write гейте другой группы). Regex — по строкам без грамматики: строка индекса `(имя.md)`
// и wiki-ссылка `[[имя]]`.
// The index is per project, links are not: notes link to notes of other projects (most project memories are
// symlinks into one shared memory directory), so a link target is looked up in every project's memory. Checking only
// the own directory reported live cross-project links as dead (21.10: 11 of 11).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { register } from '../gates/registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'memory-index';
export const KILL = 'CLAUDE_SKIP_MEMORY_INTEGRITY';
export const DEAD_LINKS_TOLERATED = 5;

export interface IndexReport { orphans: string[]; dangling: string[]; deadLinks: number; deadLinkNames: string[]; indexMissing: boolean }

// Memory directories of the other projects next to this one; statSync follows the symlinks.
export function siblingMemories(memDir: string): string[] {
  const root = dirname(dirname(memDir));
  let projects: string[];
  try { projects = readdirSync(root); } catch { return []; }
  const own = dirname(memDir);
  return projects.map((p) => join(root, p, 'memory')).filter((d) => {
    if (dirname(d) === own) return false;
    try { return statSync(d).isDirectory(); } catch { return false; }
  });
}

export function inspect(memDir: string, linkDirs: readonly string[] = []): IndexReport | null {
  let names: string[];
  try { names = readdirSync(memDir).filter((n) => n.endsWith('.md') && statSync(join(memDir, n)).isFile()); } catch { return null; }
  const notes = names.filter((n) => n !== 'MEMORY.md').sort();
  const idxPath = join(memDir, 'MEMORY.md');
  if (!existsSync(idxPath)) return { orphans: notes, dangling: [], deadLinks: 0, deadLinkNames: [], indexMissing: true };
  const idx = readFileSync(idxPath, 'utf8');
  const orphans = notes.filter((n) => !idx.includes(`(${n})`));
  const referenced = [...new Set([...idx.matchAll(/\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]))];
  const dangling = referenced.filter((n) => !existsSync(join(memDir, n)));
  const links = new Set<string>();
  for (const n of names) for (const m of readFileSync(join(memDir, n), 'utf8').matchAll(/\[\[([a-z0-9-]+)\]\]/g)) links.add(m[1]);
  const dirs = [memDir, ...linkDirs];
  const deadLinkNames = [...links].filter((l) => !dirs.some((d) => existsSync(join(d, `${l}.md`)))).sort();
  return { orphans, dangling, deadLinks: deadLinkNames.length, deadLinkNames, indexMissing: false };
}

// Sibling memories are read only when the own directory alone crosses the threshold: a clean Stop pays nothing.
export function decide(ctx: GateContext): Verdict {
  const tr = (ctx.payload as { transcript_path?: unknown }).transcript_path;
  if (typeof tr !== 'string' || !tr) return { kind: 'unknown', reason: 'в payload нет transcript_path — каталог памяти проекта неизвестен', gate: NAME };
  const memDir = join(dirname(tr), 'memory');
  const own = inspect(memDir);
  const rep = own && own.deadLinks > DEAD_LINKS_TOLERATED ? inspect(memDir, siblingMemories(memDir)) : own;
  if (rep === null) return { kind: 'silent' }; // у проекта нет памяти — норма
  const out: string[] = [];
  if (rep.indexMissing) { if (rep.orphans.length) out.push(`  индекса MEMORY.md нет — все ${rep.orphans.length} нот(ы) без строки в индексе`); }
  else {
    for (const n of rep.orphans) out.push(`  сирота, нет строки в индексе: ${n}`);
    for (const n of rep.dangling) out.push(`  строка индекса ведёт в никуда: ${n}`);
    if (rep.deadLinks > DEAD_LINKS_TOLERATED) out.push(`  висячих ссылок ${rep.deadLinks}: ${rep.deadLinkNames.join(', ')} — пора либо написать записи, либо снять ссылки`);
  }
  if (!out.length) return { kind: 'silent' };
  return { kind: 'context', text: ['⚠️ [memory-integrity] связность индекса:', ...out].join('\n'), gate: NAME };
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL, run: decide };
register(gate);
