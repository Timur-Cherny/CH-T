// memory-guard — событие Stop: голодание памяти. Никогда не блокирует — advisory (`context`) при
// голодании, тишина при норме, `unknown` когда сигналов нет (I1: нет данных ≠ здорово).
// История bash-оригинала (25.07.2026): редакция «free+inactive» молчала три часа зависания; редакция
// «free и абсолютный своп» кричала на здоровой машине с 1,6 GB давно занятого свопа (шрам инцидента).
// Starvation is what the kernel reports as memory pressure, not how much swap grew: under macOS memory
// compression pages swap out while pressure stays normal, so growth alone fires on a healthy machine.
// Swap growth survives only as a detail inside the warning; on its own it never raises one.
// Память — platform.memory() (process.availableMemory: свободные + переиспользуемые страницы), а не
// os.freemem (69 MB при 4,6 GB доступных). Прошлое значение свопа — маркер в State (одна база на машину),
// вместо файла ~/.claude/.memory-guard-swap. Компрессор (vm_stat) и «едоки» (top) не переносятся:
// платформа этих инструментов не даёт, а regex по их выводу — тот же класс ошибок.
// Pressure and low memory are states, not deltas: without a delivery marker level 2 repeated on every
// Stop (23.09, 6+ idle turns). A session hears a level once; again only when it rises or after recovery.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../gates/registry.ts';
import { memory as platformMemory, swap as platformSwap, pressure as platformPressure, type MemorySignal, type SwapSignal, type PressureSignal } from '../platform.ts';
import { State } from '../state.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'memory-guard';
export const KILL_SWITCH = 'CLAUDE_SKIP_MEMORY_GUARD';
export const FREE_FLOOR_MB = 200;
export const SWAP_GROWTH_MAX_MB = 200;
export const PRESSURE_NORMAL = 1;
export const MARKER_KEY = 'memory-guard.swap_used_mb';
export const DELIVERED_KEY_PREFIX = 'memory-guard.delivered:';

interface Delivered { level: number; low: boolean }

export interface MemoryGuardDeps {
  memory: () => MemorySignal;
  swap: () => SwapSignal;
  pressure: () => PressureSignal;
}

export const defaults: MemoryGuardDeps = { memory: platformMemory, swap: platformSwap, pressure: platformPressure };

/** Прирост свопа относительно прошлой остановки; первый замер — точка отсчёта, прирост 0. */
export function swapGrowth(stateDir: string, usedMb: number, at: number): number {
  const st = State.open(stateDir);
  try {
    return st.tx(() => {
      const prev = st.marker(MARKER_KEY);
      st.setMarker(MARKER_KEY, String(usedMb), at);
      return prev === null ? 0 : usedMb - Number(prev);
    });
  } finally { st.close(); }
}

/** Whether starvation is new to the session; a missing reading is not recovery and keeps what was delivered. */
export function freshStarvation(stateDir: string, sessionId: string, level: number | null, low: boolean | null, at: number): boolean {
  const key = DELIVERED_KEY_PREFIX + sessionId;
  const st = State.open(stateDir);
  try {
    return st.tx(() => {
      const raw = st.marker(key);
      const prev: Delivered = raw ? JSON.parse(raw) as Delivered : { level: PRESSURE_NORMAL, low: false };
      const next: Delivered = {
        level: level === null ? prev.level : Math.max(level, PRESSURE_NORMAL),
        low: low === null ? prev.low : low,
      };
      st.setMarker(key, JSON.stringify(next), at);
      return next.level > prev.level || (next.low && !prev.low);
    });
  } finally { st.close(); }
}

export function decide(ctx: GateContext, deps: MemoryGuardDeps = defaults): Verdict {
  const mem = deps.memory();
  const sw = deps.swap();
  const missing: string[] = [];
  const starved: string[] = [];

  const pr = deps.pressure();

  if (mem.available_mb === null) missing.push(`память: ${mem.missing_reason ?? 'available_mb = null'}`);
  else if (mem.available_mb < FREE_FLOOR_MB) starved.push(`доступно ${mem.available_mb}MB (порог ${FREE_FLOOR_MB}MB)`);

  if (pr.level === null) missing.push(`давление: ${pr.missing_reason ?? 'level = null'}`);
  else if (pr.level > PRESSURE_NORMAL) starved.push(`ядро сообщает давление памяти ${pr.level} (норма ${PRESSURE_NORMAL})`);

  let growth: number | null = null;
  if (sw.used_mb === null) missing.push(`своп: ${sw.missing_reason ?? 'used_mb = null'}`);
  else growth = swapGrowth(ctx.stateDir, sw.used_mb, ctx.now());
  if (starved.length && growth !== null && growth > SWAP_GROWTH_MAX_MB) starved.push(`своп вырос на ${growth}MB с прошлой проверки`);

  const low = mem.available_mb === null ? null : mem.available_mb < FREE_FLOOR_MB;
  const fresh = (starved.length > 0 || existsSync(join(ctx.stateDir, 'harness.db')))
    && freshStarvation(ctx.stateDir, ctx.payload.session_id ?? '', pr.level, low, ctx.now());

  if (starved.length) {
    if (!fresh) return { kind: 'silent' };
    return {
      kind: 'context', gate: NAME,
      text: `⚠️ memory-guard: машина голодает — ${starved.join('; ')}. Следующая тяжёлая команда, скорее всего, повиснет на своп-вводе (случай 25.07: три чтения одного файла не уложились в 2 минуты).`,
    };
  }
  if (missing.length) return { kind: 'unknown', reason: `нет сигнала — ${missing.join('; ')}`, gate: NAME };
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL_SWITCH, run: decide };
register(gate);
