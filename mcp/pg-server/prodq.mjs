// stdio-клиент к прод-обёрткам: единственный разрешённый путь к прод-базам.
// Контур задаёт обёртка в PG_WRAPPER: по умолчанию WMS (mcp-pg-prod.sh),
// Django (база `market`) — PG_WRAPPER=$HOME/.claude/bin/mcp-pg-django-prod.sh.
// Барьер read-only живёт в сервере, который поднимает обёртка, а не здесь.
// SQL берётся из файла (аргумент) или из env SQL. Один вызов — один statement.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

const sql = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : process.env.SQL;
if (!sql) { console.error('usage: prodq.mjs <file.sql>  (или SQL=...)'); process.exit(1); }

const wrapper = process.env.PG_WRAPPER ?? `${process.env.HOME}/.claude/bin/mcp-pg-prod.sh`;
const transport = new StdioClientTransport({ command: wrapper, args: [], stderr: 'inherit' });
const client = new Client({ name: 'prodq', version: '1.0.0' });
await client.connect(transport);
const res = await client.callTool({ name: 'query', arguments: { sql } });
const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
if (res.isError) { console.error('ERR: ' + text); process.exitCode = 1; } else { console.log(text); }
await client.close();
