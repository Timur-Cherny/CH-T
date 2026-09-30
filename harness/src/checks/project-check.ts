// Контракт проекта «файл → rc»: .claude/check.sh <file> в корне репозитория (сохранён из v3:
// .claude/check.sh, hooks/changed-file-check.sh:80-86). Скрипта нет — проверки нет, это не unknown:
// проект не объявил пофайловую проверку. Ненулевой rc → fail с хвостом вывода.
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { spawnTool } from '../platform.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult } from './types.ts';

export function checkScript(repo: string): string | null {
  const p = join(repo, '.claude', 'check.sh');
  try { accessSync(p, constants.X_OK); return p; } catch { return null; }
}

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && checkScript(file.repo) !== null; }

export function budgetMs(ctx: CheckContext): number { return Math.min(ctx.deadlineMs, Number(ctx.env.CHECK_TIMEOUT ?? 90) * 1000); }

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const script = checkScript(file.repo);
  if (!script) return { verdict: 'unknown', missing_reason: '.claude/check.sh исчез между applies и run' };
  const r = spawnTool('bash', [script, file.path], { cwd: file.repo, timeoutMs: budgetMs(ctx), env: ctx.env });
  if (r.rc === 124) return { verdict: 'unknown', missing_reason: 'check.sh превысил таймаут', transient: 'timeout' };
  if (r.rc !== 0) {
    const printed = (r.stdout + r.stderr).trim().split('\n').slice(0, 12).join('\n');
    const said = printed || `check.sh ${r.signal ? `убит сигналом ${r.signal}` : `завершился с rc=${r.rc}`} без вывода`;
    return { verdict: 'fail', message: `${file.path}: ${said}`.slice(0, 4096) };
  }
  return { verdict: 'pass' };
}

registerChecker({ name: 'project-check', tier: 'sync', killSwitch: 'CLAUDE_SKIP_CHECK', applies, run, budgetMs });
