// INVARIANT: имя файла миграции, имя класса и поле `name` несут ОДИН timestamp, и он снятый, а не назначенный.
// REGRESSION: две ветки, независимо выбравшие «круглое» число с запасом от соседей, получают одну миграцию.
// Кейсы перенесены из hooks/spec/migration-name-guard.test.sh один в один; сверх корпуса — обходы текстового
// поиска (литерал `name = '...'` внутри SQL) и отсутствие typescript, где bash-версия молча пропускала.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, identifiers, nextFreeMigrationStamp, writtenText, NAME, KILL } from '../../src/gates/migration-name.ts';
import { loadTypescript, parseSource } from '../../src/parsers/ts.ts';
import { route } from '../../src/main.ts';
import { GATES } from '../../src/gates/registry.ts';
import { sandbox, payload, HARNESS_ROOT, onlyGate } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';
import type { GateContext, Verdict } from '../../src/types.ts';

const REAL = '1788534985522';
const ROUND = '1786500000000';
const DIR = '/repo/apps/node/svc/migrations';
const ENV = { CLAUDE_HARNESS_TS: TS_PATH, HOME: '/nonexistent-home' };

function ctx(tool: string, field: string, path: string, body: string, env: Record<string, string> = ENV): GateContext {
  const input: Record<string, unknown> = { file_path: path };
  input[field] = body;
  return {
    event: 'pre-write',
    payload: payload('PreToolUse', { tool_name: tool, tool_input: input }) as never,
    env, root: HARNESS_ROOT, stateDir: '/tmp/unused-migration-name', now: Date.now,
  };
}
const verdict = (v: Verdict): string => v.kind;
const reason = (v: Verdict): string => ('reason' in v ? v.reason : '');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commitAll(repo: string, message: string): void {
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message]);
}

function migrationBody(stamp: string, slug: string): string {
  const cls = slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') + stamp;
  return `export class ${cls} implements MigrationInterface {\n  name = '${cls}';\n}`;
}

function repoWithMigration(sb: ReturnType<typeof sandbox>, stamp = '1804000000032', slug = 'base'): { repo: string; dir: string } {
  const repo = join(sb.dir, 'repo');
  const dir = join(repo, 'src', 'migration');
  mkdirSync(dir, { recursive: true });
  git(sb.dir, ['init', '-q', repo]);
  git(repo, ['checkout', '-qb', 'team/dev']);
  writeFileSync(join(dir, `${stamp}-${slug}.ts`), migrationBody(stamp, slug));
  commitAll(repo, 'base');
  return { repo, dir };
}

describe('migration-name', () => {
  it('has a working typescript for the corpus — without it every content case would be vacuously unknown', () => {
    const loaded = loadTypescript(`${DIR}/x.ts`, ENV);
    assert.ok(loaded.ts, `typescript не загружен (${'missing_reason' in loaded ? loaded.missing_reason : ''}) — задать CLAUDE_HARNESS_TS`);
  });

  describe('останавливает', () => {
    it('denies the 01.10 collision shape: the same counter stamp in another worktree, still untracked', () => {
      const sb = sandbox('harness-migration-worktree-');
      try {
        const { repo, dir } = repoWithMigration(sb);
        const other = join(sb.dir, 'other');
        git(repo, ['worktree', 'add', '-q', '-b', 'feature/a', other]);
        const otherDir = join(other, 'src', 'migration');
        writeFileSync(join(otherDir, '1804000000033-a.ts'), migrationBody('1804000000033', 'a'));

        const path = join(dir, '1804000000033-b.ts');
        const v = decide(ctx('Write', 'content', path, migrationBody('1804000000033', 'b'), ENV));
        assert.equal(verdict(v), 'deny');
        assert.match(reason(v), /1804000000033-a\.ts/);
        assert.match(reason(v), new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } finally {
        sb.cleanup();
      }
    });

    it('denies a stamp already present on a team/dev-like ref under another slug', () => {
      const sb = sandbox('harness-migration-ref-');
      try {
        const { repo, dir } = repoWithMigration(sb);
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        writeFileSync(join(dir, '1804000000033-ref-slug.ts'), migrationBody('1804000000033', 'ref-slug'));
        commitAll(repo, 'ref migration');
        git(repo, ['update-ref', 'refs/remotes/source/team/dev', 'HEAD']);
        git(repo, ['checkout', '-qb', 'feature/candidate', base]);

        const v = decide(ctx('Write', 'content', join(dir, '1804000000033-other-slug.ts'), migrationBody('1804000000033', 'other-slug'), ENV));
        assert.equal(verdict(v), 'deny');
        assert.match(reason(v), /1804000000033-ref-slug\.ts/);
        assert.match(reason(v), /team\/dev/);
      } finally {
        sb.cleanup();
      }
    });

    it('denies a stamp once added on a local branch even after that branch renames the migration', () => {
      const sb = sandbox('harness-migration-branch-rename-');
      try {
        const { repo, dir } = repoWithMigration(sb);
        git(repo, ['checkout', '-qb', 'feature/rename']);
        const first = join(dir, '1804000000033-a.ts');
        const renamed = join(dir, '1804000000034-a.ts');
        writeFileSync(first, migrationBody('1804000000033', 'a'));
        commitAll(repo, 'add branch migration');
        git(repo, ['mv', first, renamed]);
        commitAll(repo, 'rename branch migration');
        git(repo, ['checkout', '-q', 'team/dev']);

        const v = decide(ctx('Write', 'content', join(dir, '1804000000033-b.ts'), migrationBody('1804000000033', 'b'), ENV));
        assert.equal(verdict(v), 'deny');
        assert.match(reason(v), /1804000000033-a\.ts/);
        assert.match(reason(v), /feature\/rename/);
      } finally {
        sb.cleanup();
      }
    });

    it('denies a new stamp not greater than the max stamp on main/dev refs', () => {
      const sb = sandbox('harness-migration-order-');
      try {
        const { dir } = repoWithMigration(sb, '1804000000032', 'max-on-dev');
        const v = decide(ctx('Write', 'content', join(dir, '1804000000031-too-old.ts'), migrationBody('1804000000031', 'too-old'), ENV));
        assert.equal(verdict(v), 'deny');
        assert.match(reason(v), /не больше максимального 1804000000032/);
        assert.match(reason(v), /next-migration-stamp\.ts/);
      } finally {
        sb.cleanup();
      }
    });

    it('answers unknown when git cannot prove collisions for a new migration', () => {
      const sb = sandbox('harness-migration-norepo-');
      try {
        const dir = join(sb.dir, 'repo', 'src', 'migration');
        mkdirSync(dir, { recursive: true });
        const v = decide(ctx('Write', 'content', join(dir, `${REAL}-add-column.ts`), migrationBody(REAL, 'add-column'), ENV));
        assert.equal(verdict(v), 'unknown');
        assert.match(reason(v), /collision\/ordering не проверены/);
        assert.match(reason(v), /rev-parse/);
      } finally {
        sb.cleanup();
      }
    });

    it('does not use five trailing zeroes as a universal hand-picked signal in counter repositories', () => {
      const sb = sandbox('harness-migration-round-counter-');
      try {
        const { dir } = repoWithMigration(sb, '1786499999999', 'previous');
        const v = decide(ctx('Write', 'content', join(dir, `${ROUND}-add-column.ts`), migrationBody(ROUND, 'add-column'), ENV));
        assert.equal(verdict(v), 'silent', reason(v));
      } finally {
        sb.cleanup();
      }
    });

    it('denies a class carrying a different timestamp than the file name', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, 'export class AddColumn1700000000001 implements MigrationInterface {}'));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /класс/);
    });

    it('denies a `name` field that drifted from the file name — it is the row in the migrations table', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, "name = 'AddColumn1700000000001';"));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /поле name/);
    });

    it('denies a file name outside <timestamp13>-<kebab>.ts — TypeORM orders migrations by that number', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/add-column.ts`, 'x'));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /не в форме/);
    });

    it('still denies a knex-style name in a directory that already holds TypeORM migrations — the directory decides, not the file', () => {
      const sb = sandbox('harness-migration-mixed-');
      const dir = join(sb.dir, 'engine', 'migrations');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${REAL}-base.ts`), migrationBody(REAL, 'base'));
      writeFileSync(join(dir, '20260821120000_stray.ts'), 'exports.up = async () => {};');
      const v = decide(ctx('Write', 'content', join(dir, '20261011120000_add_route_plan.ts'), 'exports.up = async () => {};'));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /не в форме/);
    });

    it('denies a class whose stem does not match the file name even when the timestamp agrees', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, `export class SomethingElse${REAL} implements MigrationInterface {}`));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /ожидается «AddColumn/);
    });
  });

  describe('пропускает', () => {
    it('stays silent when the same migration path already exists on a team/dev-like ref', () => {
      const sb = sandbox('harness-migration-same-ref-');
      try {
        const { repo, dir } = repoWithMigration(sb);
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        writeFileSync(join(dir, '1804000000033-ref-slug.ts'), migrationBody('1804000000033', 'ref-slug'));
        commitAll(repo, 'ref migration');
        git(repo, ['update-ref', 'refs/remotes/source/team/dev', 'HEAD']);
        git(repo, ['checkout', '-qb', 'feature/edit-ref', base]);

        const v = decide(ctx('Write', 'content', join(dir, '1804000000033-ref-slug.ts'), migrationBody('1804000000033', 'ref-slug'), ENV));
        assert.equal(verdict(v), 'silent', reason(v));
      } finally {
        sb.cleanup();
      }
    });

    it('stays silent when a new migration uses max+1 over the main/dev refs', () => {
      const sb = sandbox('harness-migration-max-plus-one-');
      try {
        const { dir } = repoWithMigration(sb, '1804000000032', 'max-on-dev');
        const v = decide(ctx('Write', 'content', join(dir, '1804000000033-next.ts'), migrationBody('1804000000033', 'next'), ENV));
        assert.equal(verdict(v), 'silent', reason(v));
      } finally {
        sb.cleanup();
      }
    });

    it('helper returns max+1 over refs and untracked worktree files, preserving the counter convention', () => {
      const sb = sandbox('harness-migration-helper-');
      try {
        const { repo, dir } = repoWithMigration(sb, '1804000000032', 'base');
        writeFileSync(join(dir, '1804000000034-ref.ts'), migrationBody('1804000000034', 'ref'));
        commitAll(repo, 'ref max');
        git(repo, ['update-ref', 'refs/remotes/source/team/dev', 'HEAD']);
        const other = join(sb.dir, 'helper-worktree');
        git(repo, ['worktree', 'add', '-q', '-b', 'feature/helper', other]);
        writeFileSync(join(other, 'src', 'migration', '1804000000035-worktree.ts'), migrationBody('1804000000035', 'worktree'));

        assert.deepEqual(nextFreeMigrationStamp(repo, 'src/migration', ENV), { ok: true, stamp: '1804000000036' });
        const cli = spawnSync('sh', [join(HARNESS_ROOT, 'bin', 'run'), 'scripts/next-migration-stamp.ts', '--repo', repo, '--dir', 'src/migration'], { cwd: HARNESS_ROOT, encoding: 'utf8', env: { ...process.env, ...ENV, CLAUDE_HARNESS_NODE: process.execPath } });
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(cli.stdout.trim(), '1804000000036');
      } finally {
        sb.cleanup();
      }
    });

    it('stays silent on a taken timestamp with class and name agreeing', () => {
      const sb = sandbox('harness-migration-ok-');
      const next = String(BigInt(REAL) - 1n);
      try {
        const { dir } = repoWithMigration(sb, next, 'previous');
        const body = `export class AddColumn${REAL} implements MigrationInterface {\n  name = 'AddColumn${REAL}';\n}`;
        assert.equal(verdict(decide(ctx('Write', 'content', join(dir, `${REAL}-add-column.ts`), body))), 'silent');
      } finally {
        sb.cleanup();
      }
    });

    it('stays silent in a knex migrations directory — knex orders by its own YYYYMMDDHHMMSS_name stamp', () => {
      const sb = sandbox('harness-migration-knex-');
      const dir = join(sb.dir, 'dispatcher', 'migrations');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '20260821120000_add_batching_enabled_for_settings_table.ts'), 'exports.up = async () => {};');
      writeFileSync(join(dir, '20220511113645_create_table_contact.js'), 'exports.up = async () => {};');
      assert.equal(verdict(decide(ctx('Write', 'content', join(dir, '20261011120000_add_route_plan.ts'), 'exports.up = async () => {};'))), 'silent');
    });

    it('stays silent outside a migrations directory — a service class named anything is not this gate business', () => {
      assert.equal(verdict(decide(ctx('Write', 'content', '/repo/src/service.ts', 'export class Foo {}'))), 'silent');
    });

    it('stays silent on an edit of the migration body that declares no class and no name', () => {
      const sb = sandbox('harness-migration-existing-edit-');
      try {
        const { dir } = repoWithMigration(sb, REAL, 'add-column');
        const v = decide(ctx('Edit', 'new_string', join(dir, `${REAL}-add-column.ts`), "await queryRunner.query('ALTER TABLE x ADD y int');"));
        assert.equal(verdict(v), 'silent');
      } finally {
        sb.cleanup();
      }
    });

    it('stays silent for a tool that writes nothing — Bash carrying a migration path is not a write', () => {
      assert.equal(verdict(decide(ctx('Bash', 'content', `${DIR}/${ROUND}-x.ts`, 'ls'))), 'silent');
    });

    it('does not read `name` out of a SQL string literal — the text search did, and denied a correct migration', () => {
      const sb = sandbox('harness-migration-sql-literal-');
      try {
        const { dir } = repoWithMigration(sb, String(BigInt(REAL) - 1n), 'previous');
        const body = `export class AddColumn${REAL} implements MigrationInterface {\n`
          + `  public async up(q: QueryRunner): Promise<void> {\n`
          + `    await q.query("ALTER TABLE t ADD CONSTRAINT c CHECK (name = 'AddColumn1700000000001')");\n`
          + '  }\n}';
        const v = decide(ctx('Write', 'content', join(dir, `${REAL}-add-column.ts`), body));
        assert.equal(verdict(v), 'silent', reason(v));
      } finally {
        sb.cleanup();
      }
    });
  });

  describe('нет данных — не тишина', () => {
    it('answers unknown when typescript is nowhere near the file: the file name is proven, the class is not', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, `export class Whatever${REAL} implements MigrationInterface {}`, { HOME: '/nonexistent-home' }));
      assert.equal(verdict(v), 'unknown');
      assert.match(reason(v), /не проверены/);
    });

    it('still denies the file-name half when typescript is missing — half a contract proven is still a violation', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/add-column.ts`, 'x', { HOME: '/nonexistent-home' }));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /не в форме/);
    });

    it('answers unknown for a Write without content — what lands in the file is not knowable', () => {
      const p = payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${DIR}/${REAL}-a.ts` } });
      const v = decide({ event: 'pre-write', payload: p as never, env: ENV, root: HARNESS_ROOT, stateDir: '/tmp/unused', now: Date.now });
      assert.equal(verdict(v), 'unknown');
    });

    it('reports the projected text per tool: Write takes content, Edit takes new_string, MultiEdit joins the edits', () => {
      const w = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'a' } } as never);
      const e = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { new_string: 'b' } } as never);
      const m = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { edits: [{ new_string: 'c' }, { new_string: 'd' }] } } as never);
      assert.deepEqual([w, e, m].map((x) => (x.kind === 'text' ? x.text : x.kind)), ['a', 'b', 'c\nd']);
    });
  });

  describe('разбор', () => {
    it('takes the class name and the `name` value from the AST in both forms — class field and bare assignment', () => {
      const loaded = loadTypescript(`${DIR}/x.ts`, ENV);
      assert.ok(loaded.ts);
      const parse = (text: string) => identifiers(loaded.ts!, parseSource(loaded.ts!, text, 'm.ts').sf);
      assert.deepEqual(parse(`export class A${REAL} implements MigrationInterface {\n  name = 'A${REAL}';\n}`), { cls: `A${REAL}`, name: `A${REAL}` });
      assert.deepEqual(parse(`name = 'A${REAL}';`), { cls: null, name: `A${REAL}` });
      assert.deepEqual(parse('const q = "name = \'A1\'";'), { cls: null, name: null });
    });
  });

  describe('роутер', () => {
    it('is registered on pre-write with its own kill-switch', () => {
      const gate = GATES.find((g) => g.name === NAME);
      assert.ok(gate, 'гейт не зарегистрирован — роутер его не вызовет');
      assert.deepEqual(gate.events, ['pre-write']);
      assert.equal(gate.killSwitch, KILL);
    });

    it(`writes nothing and stays silent under ${KILL}=1, and denies the same payload without it`, async () => {
      const sb = sandbox('harness-migration-kill-');
      const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH, ...onlyGate(NAME) };
      const p = payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${DIR}/bad.ts`, content: 'y' } });
      assert.equal((await route('pre-write', p as never, { ...base, [KILL]: '1' })).kind, 'silent');
      assert.equal((await route('pre-write', p as never, base)).kind, 'deny');
      sb.cleanup();
    });
  });
});
