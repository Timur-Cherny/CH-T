// INVARIANT: the harness type-checks natively. The toolchain of harness/TOOLCHAIN.lock is the compiler of
// harness/tsconfig.json together with the lib.*.d.ts and @types/node it ships; nothing is borrowed from another tree.
// Broke silently: the toolchain held typescript.js alone, so a `TS` namespace used without its import went unnoticed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { HARNESS_ROOT } from '../_env.ts';
import { collect, projectTypescript } from '../../src/checks/tsc-diagnostics.ts';
import { toolchainRoot } from '../../src/toolchain.ts';

const UNRESOLVED = new Set([2307, 2318, 2580, 2688, 2792]);

describe('harness type check', () => {
  it('takes the harness compiler from the toolchain of its TOOLCHAIN.lock', () => {
    assert.equal(projectTypescript(HARNESS_ROOT, dirname(HARNESS_ROOT)), toolchainRoot(process.env));
  });
  it('resolves typescript, node: modules and the default libs — no unresolved module, type package or global type', () => {
    const r = collect(HARNESS_ROOT, dirname(HARNESS_ROOT), null);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.deepEqual(r.diagnostics.filter((d) => UNRESOLVED.has(d.code)).map((d) => d.display), []);
  });
});
