// INVARIANT (MCP по запросу, 16.09): bin/claude-mcp.sh подключает только обёртки bin/mcp-<имя>.sh, найденные
// на диске, и никогда прод (mcp-pg-*prod.sh — прод зовётся клиентом prodq.mjs по явному запросу); конфиг для
// --mcp-config собирается из абсолютных путей, -n печатает его и аргументы claude, не запуская claude.
// Набор имён читается с диска: новая обёртка попадает в проверку сама, без правки теста.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESS_ROOT } from '../_env.ts';

const BIN = join(HARNESS_ROOT, '..', 'bin');
const SCRIPT = join(BIN, 'claude-mcp.sh');
const run = (...args: string[]) => spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });

const onDisk = readdirSync(BIN).filter((f) => /^mcp-[a-z0-9-]+\.sh$/.test(f)).map((f) => f.slice('mcp-'.length, -'.sh'.length));
const prod = onDisk.filter((n) => /^pg-(?:[a-z0-9-]+-)?prod$/.test(n));
const plain = onDisk.filter((n) => !prod.includes(n)).sort();

describe('bin/claude-mcp.sh — MCP по запросу', () => {
  it('на диске есть и обычные обёртки, и прод — иначе проверка вырождается', () => {
    assert.ok(plain.length >= 2, `обычных обёрток: ${plain.length}`);
    assert.ok(prod.length >= 1, 'прод-обёрток нет');
  });

  it('--list печатает имена с диска без прод-обёрток', () => {
    const r = run('--list');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n').sort(), plain);
  });

  it('-n собирает конфиг из абсолютных путей к существующим обёрткам и передаёт аргументы после --', () => {
    const [a, b] = plain;
    const r = run('-n', a, b, a, '--', '-p', 'x y');
    assert.equal(r.status, 0, r.stderr);
    const [line, rest] = r.stdout.split('\n');
    const cfg = JSON.parse(line) as { mcpServers: Record<string, { type: string; command: string }> };
    assert.deepEqual(Object.keys(cfg.mcpServers), [a, b], 'повтор имени не даёт второй ключ');
    for (const [n, s] of Object.entries(cfg.mcpServers)) {
      assert.equal(s.type, 'stdio');
      assert.ok(isAbsolute(s.command), s.command);
      assert.equal(s.command, join(BIN, `mcp-${n}.sh`));
      assert.ok(existsSync(s.command), s.command);
    }
    assert.equal(rest.trim(), '-p x\\ y');
  });

  it('прод-обёртка отклоняется по имени, даже если файл есть', () => {
    for (const n of prod) {
      const r = run('-n', n);
      assert.notEqual(r.status, 0, n);
      assert.match(r.stderr, /прод/);
      assert.equal(r.stdout, '');
    }
  });

  it('неизвестное имя, мусор в имени, чужой флаг и пустой вызов — rc 2 без конфига', () => {
    for (const args of [['-n', 'no-such-server'], ['-n', 'a;b'], ['-n', 'pg-stand', '--bogus'], []]) {
      const r = run(...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
    }
  });

  it('без -n запускает claude — при пустом PATH это ошибка exec, а не тихий выход', () => {
    const r = run(plain[0]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
