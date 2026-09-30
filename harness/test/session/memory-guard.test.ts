// memory-guard: голодание памяти на Stop — предупреждение, не блок; здоровая машина — тишина.
// Молча ломалось (25.07.2026): сигнал free+inactive «видел» 3,7 GB при 0,07 GB свободных и трёх часах
// зависания; следующая редакция мерила абсолютный своп и кричала на здоровой машине с 1,6 GB шрама.
// INVARIANT: сигнал — доступная память сейчас и ПРИРОСТ свопа с прошлой остановки; занятый, но не растущий
// своп ничего не значит; нет обоих сигналов → unknown, не silent; kill-switch — ни строки в состояние.
// REGRESSION: маркер прошлого свопа живёт в State и обновляется каждым прогоном (первый — точка отсчёта).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide, defaults, NAME, KILL_SWITCH, MARKER_KEY, FREE_FLOOR_MB, SWAP_GROWTH_MAX_MB } from '../../src/session/memory-guard.ts';
import { route } from '../../src/main.ts';
import { State } from '../../src/state.ts';
import { GATES } from '../../src/gates/registry.ts';
import type { MemorySignal, SwapSignal, PressureSignal } from '../../src/platform.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';
import { sandbox, payload } from '../_env.ts';

const HEALTHY: MemorySignal = { available_mb: 4500, constrained_mb: null, load_per_core: 0.3 };
const STARVED: MemorySignal = { available_mb: 120, constrained_mb: null, load_per_core: 2.5 };
const NO_MEM: MemorySignal = { available_mb: null, constrained_mb: null, load_per_core: 0.3, missing_reason: 'process.availableMemory недоступен' };
const NO_SWAP: SwapSignal = { used_mb: null, missing_reason: 'sysctl vm.swapusage не ответил' };
const swap = (used_mb: number): SwapSignal => ({ used_mb });
const CALM: PressureSignal = { level: 1 };
const SQUEEZED: PressureSignal = { level: 2 };
const NO_PRESSURE: PressureSignal = { level: null, missing_reason: 'sysctl kern.memorystatus_vm_pressure_level не ответил' };

function ctxFor(stateDir: string, at = 1_700_000_000_000, session = 'session-1'): GateContext {
  return { event: 'stop', payload: payload('Stop', { session_id: session }) as unknown as HookPayload, env: {}, root: '/tmp/none/h', stateDir, now: () => at };
}
function judge(stateDir: string, mem: MemorySignal, sw: SwapSignal, at?: number, pr: PressureSignal = CALM): Verdict {
  return decide(ctxFor(stateDir, at), { memory: () => mem, swap: () => sw, pressure: () => pr });
}
function marker(stateDir: string): string | null {
  const st = State.open(stateDir); try { return st.marker(MARKER_KEY); } finally { st.close(); }
}
const text = (v: Verdict): string => (v as { text: string }).text;

describe('memory-guard: bash corpus (hooks/memory-guard.sh, 25.07 rules)', () => {
  it('is silent on a healthy machine and records the swap level as the baseline for the next stop', () => {
    const sb = sandbox();
    try {
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1600)), { kind: 'silent' });
      assert.equal(marker(sb.stateDir), '1600');
    } finally { sb.cleanup(); }
  });

  it('stays silent when swap is large but static — the scar of a past incident is not starvation', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1600));
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1600)), { kind: 'silent' });
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1750)), { kind: 'silent' }, `growth of 150 is below ${SWAP_GROWTH_MAX_MB}`);
    } finally { sb.cleanup(); }
  });

  it('stays silent when swap grows while the kernel reports no pressure — compression is not starvation', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1000));
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(3900)), { kind: 'silent' }, 'рост на 2,9 GB при зелёном давлении — здоровая машина под компрессией');
    } finally { sb.cleanup(); }
  });

  it('warns when the kernel reports pressure, and names the swap growth as a detail', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1000));
      const v = judge(sb.stateDir, HEALTHY, swap(1300), undefined, SQUEEZED);
      assert.equal(v.kind, 'context');
      assert.match(text(v), /давление памяти 2/);
      assert.match(text(v), /своп вырос на 300MB/);
      assert.doesNotMatch(text(v), /доступно/);
      assert.equal(marker(sb.stateDir), '1300', 'the new level becomes the next baseline');
    } finally { sb.cleanup(); }
  });

  it('does not report growth on the very first stop — the first reading is only a baseline', () => {
    const sb = sandbox();
    try {
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(5000)), { kind: 'silent' });
    } finally { sb.cleanup(); }
  });

  it('warns when available memory is below FREE_FLOOR_MB and names memory, not swap', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, STARVED, swap(1600));
      assert.equal(v.kind, 'context');
      assert.match(text(v), new RegExp(`доступно 120MB \\(порог ${FREE_FLOOR_MB}MB\\)`));
      assert.doesNotMatch(text(v), /своп вырос/);
      assert.equal((v as { gate: string }).gate, NAME);
    } finally { sb.cleanup(); }
  });

  it('lists both reasons when memory is low and swap is growing at the same time', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1000));
      const v = judge(sb.stateDir, STARVED, swap(1400));
      assert.match(text(v), /доступно 120MB/);
      assert.match(text(v), /своп вырос на 400MB/);
    } finally { sb.cleanup(); }
  });

  it('never blocks: the worst case is a context line, no deny/block verdict exists in this module', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(0));
      const v = judge(sb.stateDir, { ...STARVED, available_mb: 0 }, swap(9000));
      assert.equal(v.kind, 'context');
    } finally { sb.cleanup(); }
  });
});

describe('memory-guard: one delivery per session for one level of starvation', () => {
  const stop = (stateDir: string, pr: PressureSignal, mem: MemorySignal = HEALTHY, session = 'session-1'): Verdict =>
    decide(ctxFor(stateDir, undefined, session), { memory: () => mem, swap: () => swap(1000), pressure: () => pr });
  const level = (n: number): PressureSignal => ({ level: n });

  it('stays silent on the second stop when pressure holds at the same level', () => {
    const sb = sandbox();
    try {
      assert.equal(stop(sb.stateDir, level(2)).kind, 'context');
      assert.deepEqual(stop(sb.stateDir, level(2)), { kind: 'silent' }, 'тот же уровень — находка уже в сессии');
      assert.deepEqual(stop(sb.stateDir, level(2)), { kind: 'silent' });
    } finally { sb.cleanup(); }
  });

  it('speaks again when pressure rises from 2 to 4, and stays silent when it falls back to 2', () => {
    const sb = sandbox();
    try {
      stop(sb.stateDir, level(2));
      const v = stop(sb.stateDir, level(4));
      assert.equal(v.kind, 'context');
      assert.match(text(v), /давление памяти 4/);
      assert.deepEqual(stop(sb.stateDir, level(2)), { kind: 'silent' }, 'спад с 4 до 2 — не новая деградация');
      assert.equal(stop(sb.stateDir, level(4)).kind, 'context', 'новый подъём с 2 до 4 — снова говорит');
    } finally { sb.cleanup(); }
  });

  it('speaks again after pressure returns to normal and degrades anew: 2 → 1 → 2', () => {
    const sb = sandbox();
    try {
      assert.equal(stop(sb.stateDir, level(2)).kind, 'context');
      assert.deepEqual(stop(sb.stateDir, level(1)), { kind: 'silent' });
      assert.equal(stop(sb.stateDir, level(2)).kind, 'context');
    } finally { sb.cleanup(); }
  });

  it('does not treat a missing pressure reading as recovery: 2 → null → 2 stays silent', () => {
    const sb = sandbox();
    try {
      stop(sb.stateDir, level(2));
      assert.equal(stop(sb.stateDir, NO_PRESSURE).kind, 'unknown', 'пропуск сигнала — unknown, а не выздоровление');
      assert.deepEqual(stop(sb.stateDir, level(2)), { kind: 'silent' });
    } finally { sb.cleanup(); }
  });

  it('delivers low available memory once, and again only after memory recovers', () => {
    const sb = sandbox();
    try {
      assert.equal(stop(sb.stateDir, CALM, STARVED).kind, 'context');
      assert.deepEqual(stop(sb.stateDir, CALM, STARVED), { kind: 'silent' });
      assert.equal(stop(sb.stateDir, level(2), STARVED).kind, 'context', 'к нехватке добавилось давление — новый сигнал');
      assert.deepEqual(stop(sb.stateDir, CALM, HEALTHY), { kind: 'silent' });
      assert.equal(stop(sb.stateDir, CALM, STARVED).kind, 'context');
    } finally { sb.cleanup(); }
  });

  it('keeps delivery per session: another session at the same level hears it once too', () => {
    const sb = sandbox();
    try {
      stop(sb.stateDir, level(2), HEALTHY, 'session-a');
      assert.equal(stop(sb.stateDir, level(2), HEALTHY, 'session-b').kind, 'context');
      assert.deepEqual(stop(sb.stateDir, level(2), HEALTHY, 'session-a'), { kind: 'silent' });
    } finally { sb.cleanup(); }
  });
});

describe('memory-guard: missing signals', () => {
  it('answers unknown naming both missing signals when neither memory nor swap can be read', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, NO_MEM, NO_SWAP);
      assert.equal(v.kind, 'unknown');
      const reason = (v as { reason: string }).reason;
      assert.match(reason, /availableMemory/);
      assert.match(reason, /vm\.swapusage/);
      assert.equal(existsSync(join(sb.stateDir, 'harness.db')), false, 'no swap reading → nothing to store');
    } finally { sb.cleanup(); }
  });

  it('answers unknown for the one missing signal when the other is healthy — a half-read is not a clean bill', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, HEALTHY, NO_SWAP);
      assert.equal(v.kind, 'unknown');
      assert.match((v as { reason: string }).reason, /своп/);
      assert.doesNotMatch((v as { reason: string }).reason, /память/);
      const w = judge(sb.stateDir, NO_MEM, swap(100));
      assert.equal(w.kind, 'unknown');
      assert.match((w as { reason: string }).reason, /память/);
    } finally { sb.cleanup(); }
  });

  it('still warns on the signal it has when the other one is missing — starvation outranks missing data', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, STARVED, NO_SWAP);
      assert.equal(v.kind, 'context');
      assert.match(text(v), /доступно 120MB/);
      judge(sb.stateDir, NO_MEM, swap(100));
      const w = judge(sb.stateDir, NO_MEM, swap(900), undefined, SQUEEZED);
      assert.equal(w.kind, 'context', 'давление есть — предупреждаем, даже когда счётчик памяти молчит');
      assert.match(text(w), /давление памяти 2/);
      assert.match(text(w), /своп вырос на 800MB/);
      assert.deepEqual(judge(sb.stateDir, NO_MEM, swap(4000), undefined, NO_PRESSURE).kind, 'unknown', 'без обоих сигналов голода рост свопа сам по себе ничего не значит');
    } finally { sb.cleanup(); }
  });
});

describe('memory-guard: routing on `stop`', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  // Соседние гейты события stop гасятся своими выключателями: проверяется поведение ЭТОГО гейта, не их.
  const siblingsOff = Object.fromEntries(GATES.filter((g) => g.events.includes('stop') && g.name !== NAME).map((g) => [g.killSwitch, '1']));
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT: '/tmp/none/h', ...siblingsOff };

  it('kill-switch via route(): silent, gate body never runs, no database is created in the state dir', async () => {
    const orig = defaults.memory;
    defaults.memory = () => { throw new Error('gate body ran despite kill-switch'); };
    try {
      assert.equal(KILL_SWITCH, 'CLAUDE_SKIP_MEMORY_GUARD', 'the bash kill-switch name is kept verbatim');
      const v = await route('stop', payload('Stop') as unknown as HookPayload, { ...env, CLAUDE_SKIP_MEMORY_GUARD: '1' });
      assert.deepEqual(v, { kind: 'silent' });
      assert.deepEqual(readdirSync(sb.stateDir), []);
      // Без выключателя шпион срабатывает: тело исполнилось, провал стал unknown → context на stop.
      const c = await route('stop', payload('Stop') as unknown as HookPayload, env);
      assert.equal(c.kind, 'context');
      assert.match(text(c), /unknown\(memory-guard\): gate body ran/);
    } finally { defaults.memory = orig; }
  });

  it('lifts unknown to a context line on stop (never silent) when the platform gives no signals', async () => {
    const origM = defaults.memory; const origS = defaults.swap; const origP = defaults.pressure;
    defaults.memory = () => NO_MEM; defaults.swap = () => NO_SWAP; defaults.pressure = () => NO_PRESSURE;
    try {
      const v = await route('stop', payload('Stop') as unknown as HookPayload, env);
      assert.equal(v.kind, 'context');
      assert.match(text(v), /unknown\(memory-guard\): нет сигнала/);
    } finally { defaults.memory = origM; defaults.swap = origS; defaults.pressure = origP; }
  });

  it('runs the real platform signals without throwing and returns one of silent/context/unknown', async () => {
    const v = await route('stop', payload('Stop') as unknown as HookPayload, env);
    assert.ok(['silent', 'context'].includes(v.kind), JSON.stringify(v));
  });
});
