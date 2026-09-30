// INVARIANT: файл, который команда пишет литеральным текстом, судится теми же гейтами записи, что Write и Edit.
// Проба 16.09: манифест с ALTER ROLE … SET через `cat > ds.yaml <<'EOF'` — silent, тот же через Write — deny:
// барьер зависел от инструмента записи. Содержимое, которого в команде нет (cp, sed -i, подстановка), не судится —
// граница модели, объявленная в README.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';
import { literalWrites, decide, KILL } from '../../src/gates/bash-writes.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-bw-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH };
const ctx = (p: Record<string, unknown>, extra: Record<string, string> = {}): GateContext => ({ event: 'pre-bash', payload: p as unknown as HookPayload, env: { ...env, ...extra }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now });
const bash = (command: string, extra: Record<string, string> = {}) => decide(ctx(bashPayload(command, { cwd: sb.dir }), extra));
const MANIFEST = "command:\n  - sh\n  - -c\n  - ALTER ROLE app SET statement_timeout = '30s';\n";
const ALTER = "ALTER ROLE app SET statement_timeout = '30s';";

async function deny(v: Promise<Verdict>, re: RegExp): Promise<string> {
  const r = await v; assert.equal(r.kind, 'deny', JSON.stringify(r));
  const reason = (r as { reason: string }).reason; assert.match(reason, re); return reason;
}
async function silent(v: Promise<Verdict>): Promise<void> { assert.deepEqual(await v, { kind: 'silent' }); }

describe('bash-writes — a file written with literal text goes through the pre-write gates', () => {
  it('lists literal writes — here-doc, echo, printf, tee, a pipe into tee — and skips content that is not in the command', () => {
    const w = (cmd: string) => literalWrites(cmd, sb.dir).map((x) => [x.path.slice(sb.dir.length + 1), x.text]);
    assert.deepEqual(w(`cat > ds.yaml <<'EOF'\n${MANIFEST}EOF`), [['ds.yaml', MANIFEST]]);
    assert.deepEqual(w(`cat <<'EOF' | tee a.sql b.sql\n${ALTER}\nEOF`), [['a.sql', `${ALTER}\n`], ['b.sql', `${ALTER}\n`]]);
    assert.deepEqual(w(`echo "${ALTER}" >> x.sql`), [['x.sql', `${ALTER}\n`]]);
    assert.deepEqual(w(`printf '%s\\n' "${ALTER}" > x.sql`), [['x.sql', `${ALTER}\n`]]);
    assert.deepEqual(w(`tee x.sql <<'EOF'\n${ALTER}\nEOF`), [['x.sql', `${ALTER}\n`]]);
    assert.deepEqual(w(`cat > ds.yaml 2> err.log <<'EOF'\n${MANIFEST}EOF`), [['ds.yaml', MANIFEST]], 'редирект stderr содержимого не получает');
    assert.deepEqual(w('cat template.yaml > ds.yaml'), [], 'содержимое файла не в команде');
    assert.deepEqual(w('echo "$MANIFEST" > ds.yaml'), [], 'подстановка — текст неизвестен');
    assert.deepEqual(w('psql -c "SELECT 1" > out.txt'), [], 'вывод программы — не литерал');
  });
  it('REGRESSION проба 16.09: the manifest Write denies is denied through a here-doc, echo and tee too, and the reason names the file', async () => {
    const reason = await deny(bash(`cat > ds.yaml <<'EOF'\n${MANIFEST}EOF`), /ALTER ROLE … SET statement_timeout/);
    assert.match(reason, /^ds\.yaml, который пишет команда: /);
    await deny(bash(`echo "${ALTER}" > x.sql`), /ALTER ROLE/);
    await deny(bash(`cat <<'EOF' | tee -a x.sql\n${ALTER}\nEOF`), /ALTER ROLE/);
    await silent(bash(`cat > x.sql <<'EOF'\nSELECT 1;\nEOF`));
  });
  it('keeps the exemptions and the reach of the inner gates: a note in .md passes, a memory note without a header and a migration with a hand-picked timestamp are denied', async () => {
    await silent(bash(`cat > NOTE.md <<'EOF'\n${ALTER}\nEOF`));
    const mem = join(sb.dir, '.claude', 'projects', 'proj', 'memory'); mkdirSync(mem, { recursive: true });
    await deny(bash(`cat > ${join(mem, 'bad-note.md')} <<'EOF'\nтело без шапки\nEOF`), /^bad-note\.md, который пишет команда/);
    const mig = join(sb.dir, 'apps', 'svc', 'migrations', '1786500000000-add-column.ts');
    await deny(bash(`cat > ${mig} <<'EOF'\nexport class AddColumn1786500000000 implements MigrationInterface {}\nEOF`), /1786500000000-add-column\.ts, который пишет команда/);
  });
  it('is switched off by its own kill-switch and skips an inner gate under that gate’s switch; live, the verdict carries the inner gate', async () => {
    const p = bashPayload(`cat > ds.yaml <<'EOF'\n${MANIFEST}EOF`, { cwd: sb.dir }) as unknown as HookPayload;
    assert.deepEqual(await route('pre-bash', p, { ...env, [KILL]: '1' }), { kind: 'silent' });
    assert.deepEqual(await route('pre-bash', p, { ...env, CLAUDE_SKIP_PG_SESSION_GUARD: '1' }), { kind: 'silent' });
    const live = await route('pre-bash', p, env);
    assert.equal(live.kind, 'deny', JSON.stringify(live));
    assert.equal((live as { gate: string }).gate, 'pg-session');
  });
});
