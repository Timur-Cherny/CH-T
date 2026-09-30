#!/usr/bin/env node
// MCP-сервер Postgres «только чтение» для контуров WMS.
//
// ЗАЧЕМ СВОЙ. У @modelcontextprotocol/server-postgres@0.6.2 барьер
// `BEGIN TRANSACTION READ ONLY` обходится текстом самого запроса — проверено
// на dev 20.08: одиночный `create temp table` отбивается, а `COMMIT; create
// temp table` проходит. Роль прода при этом с полными правами.
//
// ТРИ ЗАЩИТЫ, каждую держит Postgres или протокол, а не разбор строки:
//   1. Расширенный протокол (именованный statement) — «cannot insert multiple
//      commands into a prepared statement». Закрывает `COMMIT; <запись>`.
//   2. Холостой запрос сразу после BEGIN — «transaction read-write mode must be
//      set before any query». Закрывает `SET TRANSACTION READ WRITE`.
//   3. Проверка режима ПОСЛЕ запроса: если транзакция всё же стала read-write,
//      вызов помечается ошибкой. Не предотвращает, но делает неизвестный обход
//      громким вместо молчаливого.
// PG_RO_REQUIRE_STANDBY=1 добавляет четвёртую: запрос выполняется только на
// реплике. Проверку несёт тот самый холостой запрос — лишнего round-trip нет, а
// подмена адреса на мастер перестаёт быть тихой: канал отказывает, а не читает
// не тот инстанс.
// Имя statement уникально на вызов; PREPARE транзакционен, поэтому ROLLBACK
// его убирает и на пуле ничего не копится.
//
// ROLLBACK ждём: соединение с незакрытой транзакцией, вернувшееся в пул,
// продолжило бы её на следующем вызове — вместе с чужим режимом доступа.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const dsn = process.argv[2];
if (!dsn) { console.error('usage: readonly-server.mjs <postgres-dsn>'); process.exit(1); }

const STATEMENT_TIMEOUT = process.env.PG_RO_STATEMENT_TIMEOUT ?? '30s';
const REQUIRE_STANDBY = process.env.PG_RO_REQUIRE_STANDBY === '1';
const pool = new pg.Pool({ connectionString: dsn });
let seq = 0;

const server = new McpServer({ name: 'pg-readonly', version: '1.0.0' });

server.tool(
  'query',
  'Run a read-only SQL query. Exactly one statement per call: the extended protocol rejects multiple commands, and the transaction is locked into read-only mode before the statement runs.',
  { sql: z.string().min(1).describe('A single SQL statement') },
  async ({ sql }) => {
    const client = await pool.connect();
    let dirty = false;
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const warm = await client.query(REQUIRE_STANDBY ? 'SELECT pg_is_in_recovery() AS standby' : 'SELECT 1');
      if (REQUIRE_STANDBY && warm.rows[0]?.standby !== true) {
        return { content: [{ type: 'text', text: 'pg-readonly: инстанс не реплика (pg_is_in_recovery = false) — канал объявлен читающим со standby, запрос отклонён' }], isError: true };
      }
      const res = await client.query({ name: `ro_${++seq}`, text: sql, values: [] });
      const mode = await client.query("SELECT current_setting('transaction_read_only') AS ro");
      if (mode.rows[0]?.ro !== 'on') {
        dirty = true;
        return { content: [{ type: 'text', text: 'pg-readonly: транзакция вышла из режима только чтения — запрос отклонён как небезопасный' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(res.rows ?? [], null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: String(e.message ?? e) }], isError: true };
    } finally {
      try {
        await client.query('ROLLBACK');
        client.release(dirty ? new Error('transaction left read-only mode') : undefined);
      } catch (e) {
        client.release(e);
      }
    }
  },
);

await server.connect(new StdioServerTransport());
