import pg from 'pg';
const sql = process.env.SQL;
const write = process.env.ALLOW_WRITE === '1';
const { PG_DEV_HOST: host, PG_DEV_PORT: port, PG_DEV_DB: database, PG_DEV_USER: user } = process.env;
const c = new pg.Client({ host, port: +port, database, user });
await c.connect();
await c.query(write ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
try {
  const r = await c.query(sql);
  if (write) { await c.query('COMMIT'); } else { await c.query('ROLLBACK'); }
  console.log(JSON.stringify(r.rows ?? r, null, 1));
  if (r.rowCount !== undefined) console.error('rowCount=' + r.rowCount);
} catch (e) { await c.query('ROLLBACK').catch(()=>{}); console.error('ERR: ' + e.message); process.exitCode = 1; }
await c.end();
