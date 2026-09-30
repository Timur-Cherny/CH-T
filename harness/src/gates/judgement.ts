// Суждение гейта до перевода в Verdict: clean | unknown | deny. Общее для pg-session и data-boundary.
/** hint — как переписать; у разных deny свои подсказки, и при слиянии теряться не должна ни одна. */
export type Judgement = { kind: 'clean' } | { kind: 'deny'; reason: string; hint?: string } | { kind: 'unknown'; reason: string };
export const CLEAN: Judgement = { kind: 'clean' };

const RANK = { clean: 0, unknown: 1, deny: 2 } as const;
const SEP = '; ';

/** Строже — побеждает. При равном ранге причины копятся: первая найденная причина не заслоняет решающую
 *  (человек видел «подстановка», а запрос прятал `-c "$1"`). */
export function worst(a: Judgement, b: Judgement): Judgement {
  if (RANK[a.kind] !== RANK[b.kind]) return RANK[b.kind] > RANK[a.kind] ? b : a;
  if (a.kind === 'clean' || b.kind === 'clean') return a;
  const parts = a.reason.split(SEP);
  for (const p of b.reason.split(SEP)) if (!parts.includes(p)) parts.push(p);
  const reason = parts.join(SEP);
  if (a.kind === 'unknown' || b.kind === 'unknown') return { kind: 'unknown', reason };
  const hint = !a.hint ? b.hint : !b.hint || a.hint.includes(b.hint) ? a.hint : `${a.hint}\n${b.hint}`;
  return hint === undefined ? { kind: 'deny', reason } : { kind: 'deny', reason, hint };
}
