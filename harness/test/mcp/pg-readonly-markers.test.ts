// INVARIANT (INC-PG-READONLY-BYPASS): ни одна прод-обёртка не стартует, если из
// mcp/pg-server/readonly-server.mjs пропала любая из трёх защит — замок режима, пост-проверка режима,
// расширенный протокол; закомментированная не в счёт.
// Молча ломалось: узел объявлял эту проверку своим regression_guard, а обёртка смотрела только наличие файла.
// Кейсы перенесены из hooks/spec/pg-readonly-markers.test.sh один в один; «пропуск» несобравшейся фикстуры стал ассертом.
// Набор обёрток читается с диска, а подключение общей bin/lib/pg-prod-guard.sh — такой же ассерт:
// собственная копия проверки в новой прод-обёртке разошлась бы с оригиналом молча.
// Обёртка, объявившая PG_RO_REQUIRE_STANDBY=1, проверяется отдельно: без обеих половин защиты в сервере
// флаг — просто переменная окружения, а чтение молча уходит на мастер вместо реплики.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, HARNESS_ROOT } from '../_env.ts';

const REPO = join(HARNESS_ROOT, '..');
const BIN = join(REPO, 'bin');
const SERVER = readFileSync(join(REPO, 'mcp', 'pg-server', 'readonly-server.mjs'), 'utf8');
const LOCK_CALL = "await client.query('BEGIN TRANSACTION READ ONLY');";

/** Прод-обёртки берутся с диска: новая появляется в наборе сама, без правки теста. */
const WRAPPERS = readdirSync(BIN).filter((f) => /^mcp-pg-(?:[a-z0-9-]+-)?prod\.sh$/.test(f)).sort();

const sb = sandbox('harness-pg-markers-');
after(() => sb.cleanup());

/** Обёртка в режиме MCP_PG_CHECK_ONLY: маркеры сверены, до ~/.pgpass, сети и exec не доходит. */
function probe(wrapper: string, name: string, text: string): { rc: number; stderr: string } {
  const entry = join(sb.dir, name);
  writeFileSync(entry, text);
  const r = spawnSync('bash', [join(BIN, wrapper)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: sb.home, MCP_PG_ENTRY: entry, MCP_PG_CHECK_ONLY: '1' }, timeout: 20000 });
  return { rc: r.status ?? -1, stderr: r.stderr ?? '' };
}
const refusal = (tag: string, what: string) => `${tag}: в сервере нет защиты «${what}» — старт отменён`;

const GUARDS: Array<[fixture: string, marker: string, what: string]> = [
  ['nolock', 'BEGIN TRANSACTION READ ONLY', 'замок режима транзакции'],
  ['nocheck', "current_setting('transaction_read_only')", 'пост-проверка режима после запроса'],
  ['noproto', 'name: `ro_', 'расширенный протокол (именованный statement)'],
];

/** Проверяются только у обёрток, которые сами объявили чтение со standby. */
const STANDBY_GUARDS: Array<[fixture: string, marker: string, what: string]> = [
  ['noflag', 'PG_RO_REQUIRE_STANDBY', 'переключатель обязательной реплики'],
  ['norecovery', 'pg_is_in_recovery()', 'проверка, что инстанс — реплика'],
];

describe('bin/mcp-pg-*prod.sh readonly-server guard markers', () => {
  it('finds the prod wrappers on disk', () => {
    assert.ok(WRAPPERS.includes('mcp-pg-prod.sh'), `набор обёрток не собрался: ${WRAPPERS.join(', ') || '(пусто)'}`);
    assert.ok(WRAPPERS.length >= 1);
  });

  for (const wrapper of WRAPPERS) {
    const tag = wrapper.replace(/\.sh$/, '');

    describe(wrapper, () => {
      it('sources the shared guard library instead of copying the check', () => {
        const text = readFileSync(join(BIN, wrapper), 'utf8');
        assert.match(text, /lib\/pg-prod-guard\.sh/, 'обёртка не подключает общую проверку — копия разойдётся с оригиналом молча');
        assert.match(text, /pg_guard_entry/, 'обёртка не вызывает pg_guard_entry');
      });

      it('lets the full server through the marker check', () => {
        const r = probe(wrapper, `${tag}-full.mjs`, SERVER);
        assert.equal(r.rc, 0, `полный сервер отвергнут: ${r.stderr}`);
        assert.equal(r.stderr, '');
      });

      for (const [fixture, marker, what] of GUARDS) {
        it(`refuses to start a server with the «${what}» guard removed (${fixture})`, () => {
          const stripped = SERVER.replaceAll(marker, '// ВЫРЕЗАНО');
          assert.ok(stripped !== SERVER && !stripped.includes(marker), `фикстура не собралась: маркера «${marker}» нет в сервере`);
          const r = probe(wrapper, `${tag}-${fixture}.mjs`, stripped);
          assert.equal(r.rc, 1, `сервер без защиты «${what}» допущен к старту: прод читается без барьера, и никто не узнает`);
          assert.ok(r.stderr.includes(refusal(tag, what)), r.stderr);
        });
      }

      const declaresStandby = readFileSync(join(BIN, wrapper), 'utf8').includes('PG_RO_REQUIRE_STANDBY=1');

      for (const [fixture, marker, what] of declaresStandby ? STANDBY_GUARDS : []) {
        it(`refuses to start a server that cannot enforce the replica («${what}», ${fixture})`, () => {
          const stripped = SERVER.replaceAll(marker, '/* ВЫРЕЗАНО */');
          assert.ok(stripped !== SERVER && !stripped.includes(marker), `фикстура не собралась: маркера «${marker}» нет в сервере`);
          const r = probe(wrapper, `${tag}-${fixture}.mjs`, stripped);
          assert.equal(r.rc, 1, `канал объявлен читающим с реплики, но сервер этого не проверяет: чтение уйдёт на мастер молча`);
          assert.ok(r.stderr.includes(refusal(tag, what)), r.stderr);
        });
      }

      it('does not count a commented-out read-only lock as a guard', () => {
        const commented = SERVER.replace(LOCK_CALL, `// ${LOCK_CALL}`);
        assert.notEqual(commented, SERVER, `фикстура не собралась: в сервере нет строки ${LOCK_CALL}`);
        const r = probe(wrapper, `${tag}-commented.mjs`, commented);
        assert.equal(r.rc, 1, 'закомментированная защита засчитана');
        assert.ok(r.stderr.includes(refusal(tag, 'замок режима транзакции')), r.stderr);
      });
    });
  }
});
