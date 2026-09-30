// INVARIANT R9 (сигнал): сломанный тулчейн виден при старте сессии, а не только как unknown в каждом гейте.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/session/toolchain-signal.ts';
import { readLock, toolchainDir } from '../../src/toolchain.ts';
import type { GateContext } from '../../src/types.ts';

const sb = sandbox('harness-tcsig-');
after(() => sb.cleanup());

const ctxFor = (env: NodeJS.ProcessEnv): GateContext => ({
  event: 'session-start', payload: payload('SessionStart', { source: 'startup' }, sb.dir) as never,
  env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 0,
});

describe(NAME, () => {
  it('prints the install hint when the toolchain is absent', () => {
    const v = decide(ctxFor({ HOME: sb.home }));
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /\[тулчейн\].*не установлен.*toolchain\.ts --install/);
  });
  it('prints the mismatch when the installed entry differs from the lock', () => {
    const dir = join(sb.dir, 'tc');
    const t = readLock(HARNESS_ROOT).typescript;
    mkdirSync(join(dir, `typescript@${t.version}`, 'package', 'lib'), { recursive: true });
    writeFileSync(join(dir, `typescript@${t.version}`, t.entry), 'tampered');
    const v = decide(ctxFor({ CLAUDE_HARNESS_TOOLCHAIN: dir }));
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /не совпадает с TOOLCHAIN\.lock/);
  });
  it('stays silent when the live toolchain matches the lock', () => {
    assert.equal(decide(ctxFor({ CLAUDE_HARNESS_TOOLCHAIN: toolchainDir(process.env) ?? '' })).kind, 'silent');
  });
});
