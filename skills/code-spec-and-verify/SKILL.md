---
name: code-spec-and-verify
description: >
  Lifecycle harness for any non-trivial code change: define what "correct" means
  before writing code, then prove it after. Use this whenever you start
  implementing something substantive — a new feature, engine or business logic,
  an event/message/queue handler, a state machine, or anything touching shared
  state, concurrency, money, inventory, or a multi-step workflow — to lock down a
  contract, invariants, and failure modes up front; and again once it passes the
  happy path or e2e, to run an adversarial audit (concurrency, idempotency,
  ordering, partial failure, edge cases) against those same invariants before
  calling it done. Trigger even when the user just says "implement X", "add Y", or
  "fix this bug" without asking for verification — a green happy path is not
  correctness, and the cheapest moment to catch an edge-case bug is before it
  ships, not after a fix-loop. Skip only for trivial one-liners, pure questions,
  config tweaks, or throwaway scripts.
---

# Spec and Verify

A change is finished when you can *show* it's correct, not when it runs once. This
skill puts two gates around a non-trivial change with a single shared spine — a
list of **invariants** — that you write at the start and check at the end.

```
Gate 1 — Define   │ contract + invariants + failure modes   ─┐
   └─ spec-critic │ adversary attacks the SPEC                │
Implement         │ handle each failure mode                  │  same list
Gate 2 — Verify   │ adversary attacks the CODE                │  flows through
   └─ race-auditor│ + mutation check: does the test catch it? ─┘
```

## Why this exists (read this — it's the whole point)

The root cause of both **wasted tokens** and **bugs that fail on the first edge
case** is the same: under-specification at the start. A vague task → the model
guesses → it breaks on an input nobody named → a fix-loop → re-reading files →
more tokens. Spending a little effort to define correctness *before* coding is
both cheaper and higher quality.

Three ideas drive everything below:

- **Reasoning is expensive; machinery is nearly free.** A green e2e run proves one
  path, once, at high cost. An invariant encoded as an assertion or property test
  proves a *class* of properties, forever, for almost nothing. Whenever you can,
  move correctness from "the model re-reasons each time" to "a check enforces it."
- **The invariants are the spine.** The properties you list at Gate 1 are the exact
  checklist the adversarial audit attacks at Gate 2. That's why this is one skill
  and not two: the artifact written up front is what makes the audit precise
  instead of generic.
- **Both gates need an adversary.** A spec written by whoever is about to write the
  code is optimistic by construction — it describes the shape already in mind and
  inherits every assumption that shape rests on. Gate 2 attacks the code; **Gate 1
  must attack the spec**, or Gate 2 spends its effort on the wrong checklist.

## Match the effort to the change

Don't bureaucratize a typo fix. Calibrate:

- **Trivial** (one-liner, rename, comment, config value): skip this skill. In a data-driven
  system (task options, operation types, a migration that rewrites configuration) a
  config value *is* behaviour and never trivial — see `code-config-driven`; an SQL switch
  of one order type to a new set of stages can break that type's returns exactly through
  this door.
- **A migration, a schema change, an external contract (DTO of a public API, a producer
  payload) or a change across more than one repository is critical**, whatever it feels
  like. The friction classifier rates only a subagent's window and only paths
  (`migrations/`, `contract(s)/`, `.proto`, OpenAPI — `harness/src/friction.ts:41`); the
  root's own diff and a contract living in `dto/` are rated by judgement, so raise the
  level, never lower it.
- **Substantial** (new feature, handler, logic that mutates state, anything with
  branches or external calls): both gates, lightweight. `spec-critic` optional.
- **Critical** (concurrency, money, inventory, irreversible side effects, anything
  many callers depend on): both gates, **both adversaries**, codify the invariants
  as real tests, mutation-check those tests, and — for domain-critical changes —
  prove them live in a real environment.

When unsure, lean toward running it — the cost is a few minutes of thinking, and
the thing it prevents is a production edge-case bug.

## Gate 1 — Define (before writing code)

Produce a short block. Keep it tight — this is a thinking tool, not paperwork.

```
## Contract
- Inputs: <what comes in, types, ranges>
- Outputs: <what goes out, success and error shapes>
- Preconditions: <what must be true before>
- Postconditions: <what's guaranteed after>
- Non-goals: <2-3 things this change explicitly does NOT do — the scope-creep guard>
- Acceptance (product-scoped changes): <2-4 Given/When/Then scenarios — e2e blanks for Gate 2>

## Invariants (always true, before and after every operation)
- <e.g. reserved + available = total>
- <e.g. a serial number is minted at most once>
- <e.g. sum(moves) ≤ reserved quantity>
For each: name the ENFORCEMENT POINT. An invariant nobody checks is decoration.
When an invariant rests on a stored value, also name its CARRIER and who else
writes it. A column a second code path rebinds, or that two owners can share, is
not evidence — and that is decided by reading its writers, not by testing it.

## Failure modes (≥5; bias toward concurrency & edges)
1. <input boundary: zero / empty / negative / max / duplicate / just-deleted>
2. <message arrives twice (replay) → does state double-apply?>
3. <events arrive out of order → does a late event corrupt or get dropped?>
4. <two actors touch one resource at once → check-then-act race?>
5. <step N of M throws → is partial state consistent or orphaned?>
6. <staged rollout: is each INTERMEDIATE state safe? does this change need its
   migration/data/peer-service deployed WITH it, or does shipping it alone wedge a
   live flow? what's the rollback, and what TRIGGERS it — decided now, not during
   the incident?>
   For each: decide → handle now / assert / explicitly out of scope.
```

**Don't write failure modes from a blank page.** Read
`references/failure-taxonomy.md` — twelve categories, each one a bug that actually
shipped or actually blocked a release in this codebase, stated as both the general
pattern and the concrete instance. Pick the two-to-four that can bite *here* and
answer their spec questions concretely. Asking "can category A bite this change?"
produces far better modes than "name five ways this breaks."

**Then hand the draft to `spec-critic`.** Its whole job is to find the invariant
you're missing, the one you can't actually enforce, the failure mode you named
without a mechanism, and — highest yield — the **assumption about existing
behaviour that turns out to be false when someone reads the code.** Give it the
draft block plus the files it should check against. Treat its findings like any
adversarial output: verify the premise before acting, and reject the ones that
don't hold, with a reason.

**Gate 1 is iterative.** A requirement you surface mid-spec — from the user, from
`spec-critic`, or from reading the code — is a signal to UPDATE the
contract/invariants/failure-modes, not to bolt a special case onto code you've
already started. Re-spec, then code: a new line here is tiny next to a wrong
abstraction discovered after implementation.

**Check the extensibility horizon.** If the requirement hints at growth ("courier
today, but also pickup points, cities, and more later"), don't hardcode the current dimension
— make that seam a parameter now. A spec that fits only the first example is the
same under-specification trap, one layer up.

Then implement, handling each failure mode you committed to.

## Gate 2 — Verify (once it works on the happy path / e2e is green)

Green happy-path proves the code runs, not that it's correct. Now attack it
against the spine from Gate 1.

1. **Run the adversarial audit.** Delegate to the `race-auditor` agent with the diff
   and the Gate 1 invariants/failure modes — its whole job is to *construct a
   failing scenario*, not to confirm. Only a non-domain change may be audited
   inline, using the failure-modes list as the checklist; a domain-level diff
   needs the agent run, and each finding closes with a red test or a rejection
   that cites `file:line` of the refuting mechanism. The bar for a finding is a concrete
   step-by-step interleaving or input sequence, not a vague "could be racy."

   For **critical** changes, run it perspective-diverse rather than once: separate
   passes for *idempotency/replay*, *ordering*, and *partial-failure + rollback*.
   Three lenses find what three identical passes cannot — redundancy catches
   flakiness, diversity catches blind spots.

2. **Triage the findings — verify the verifier.** An adversarial finding can itself
   be wrong: built on a misread of the OLD behavior, or on a trigger that isn't
   actually reachable. Before fixing, check each finding's premise against the code
   and refute the ones that don't hold, to the same "show the concrete path" bar.
   Fix the confirmed ones; for each rejected one, say why. Don't blindly fix all N —
   a wrong fix to a phantom bug is its own regression.

3. **For every invariant, try to break it.** Walk the read-modify-write paths
   (check-then-act, SELECT-then-UPDATE without a lock or version, get-or-create)
   and ask: what interleaving drives the state to violate this?

4. **Re-audit the FIX, not just the original code.** A correctness fix adds state
   transitions, and the new *intermediate* states are reachable by input the
   original code never saw. This is category H in the taxonomy and it is the single
   most common way a verified change still ships a bug — three regressions in one
   frontend fix round, all introduced by the repair, none present before it.
   Enumerate the states your fix adds; for each, ask what arrives next.

5. **Codify what's cheap to keep — then prove the test actually catches it.**
   For critical invariants, leave behind an assertion or property/example test so
   the invariant is enforced forever instead of re-checked by hand next time.

   **A test that passes both before and after the fix proves nothing.** Verify by
   inversion: revert the fix (or mutate the guard), confirm the new test **fails**,
   restore. A subagent inverts only on a copy — `git worktree add <tmp> HEAD` or a
   temporary file beside the original — never in the live tree: an interrupted verifier
   leaves the fixed files reverted to HEAD.
   An un-inverted test is an unverified test. This is the cheapest step in
   the whole skill and the one most often skipped.

6. **For domain-critical changes, prove it live.** The strongest evidence is a run
   in a real environment that verifies the invariant in actual state/DB
   (prove-then-snapshot), not only a unit pass. Stamp the snapshot with date +
   commit and trust it afterwards instead of re-deriving.

6a. **Lifecycle acceptance — mandatory when the change touches a state carrier.**
   A "state carrier" is any row whose value is evidence for a domain claim: stock
   quantity, a provenance link, a status, an options snapshot. Mechanisms verified
   one at a time pass while the *transitions between them* corrupt state — that is
   where the bugs live, and no amount of per-mechanism green catches them.

   Before you may call such a change done, one test must:

   - **Reach the state through the system's own methods, starting before the
     transition.** Hand-inserting the "correct" row is the failure mode this rule
     exists to stop: a fixture built by hand encodes the model you *believe* and
     hides every merge, rebind and copy the real path performs.
   - **Run the whole chain in one scenario**, not each hop in its own test.
   - **Include the adversarial shapes of the domain**: two orders of the same SKU,
     quantities merging into one row and splitting out of it, and the operation
     repeated.
   - **Assert conservation after every transition** — quantity, and whatever the
     change claims about provenance.
   - **Run the migration against unfinished work** carrying the pre-change
     configuration, not only against a clean database.

   Then ask the question that decides whether the design is sound at all:
   **on what grounds does this row prove what I claim, and does that ground
   survive every operation the system performs on it?** A column another code path
   rewrites, or that two owners can share, is not evidence. Mutation testing does
   not answer this: it proves the test notices the filter being removed, never
   that the filter stands on a correct model of the data.

7. **Report honestly.** State which dimensions you actually checked and could *not*
   break ("idempotency holds because it dedups on key X"), not just the bugs found.
   "I couldn't break it and here's why" is a real result; silence is not. If you
   skipped a step, say which — a verdict that hides its gaps is worse than no
   verdict, because it gets trusted.

## Output shape

End a Gate-2 pass with a compact verdict:

```
Verified against 4 invariants, 6 failure modes. Adversary: race-auditor ×3 lenses.
- ✅ Idempotency: dedups on message_id before applying — replay is a no-op.
- ✅ Boundary: empty order list returns early, no division.
- ⚠️ Race (confirmed): two pickers can both pass the `available ≥ qty` check
  before either decrements (engine/pick.go:88, check-then-act). Scenario: ...
  Fix direction: SELECT ... FOR UPDATE or optimistic version on the stock row.
- ✗ Rejected finding: "outbox double-publish" — premise wrong, publisher already
  claims rows with UPDATE ... WHERE status='pending' RETURNING (outbox.ts:52).
- Added: TestReserveInvariant property test encoding reserved+available=total.
  Inverted: reverted the FOR UPDATE, test FAILS as expected, restored. ✅
- NOT checked: behaviour under partition between engine and connector — needs
  two live nodes, out of reach here.
```

## Provenance check — before you write down what existing code "means"

Applies whenever you describe behaviour you did not just write: a comment on code
you are refactoring, an invariant lifted from a running system, a spec that says
"the system already does X, so X is the rule".

**Observed ≠ designed.** Behaviour can fall out of a language quirk, a truthiness
test, a default, an ordering — and read as deliberate afterwards. Write it down as
intent and the note becomes the source of truth: the next reader (or you, an hour
later) builds on it, and nobody re-derives it.

One command decides it:

```bash
git log -S '<the deciding token>' --format='%h %ad %s' --date=short -- <file>
```

Then read the commit that introduced it. Three outcomes, three different notes:

| What the commit shows | How to write it |
|---|---|
| Message or spec states the rule | Assert it. Cite the commit. |
| Rule appeared with no mention, as part of other work | "Observed, not specified — provenance `<sha>`." Do not phrase it as intent. |
| Behaviour predates the file / can't be traced | "Observed. Unverified whether designed." |

**A comment that explains why something is correct, written by someone who only
read the code, is a hypothesis wearing the clothes of a decision.** If you cannot
name where the decision was made, say so in the note itself.

Two smells that mean "check the provenance now": the code distinguishes cases the
domain does not (empty vs absent, zero vs null, `[]` vs `undefined`), and a nearby
older comment contradicts the current behaviour.

## Common traps

- **Don't pad with ceremony.** If the contract is obvious, one line each is fine.
  The value is in the invariants and failure modes, not the formatting.
- **Don't let Gate 2 become a victory lap.** Its job is to *try to break* the code.
  If you didn't attempt a concrete failing scenario, you didn't verify.
- **Don't skip the inversion check.** An uninverted test is a test you hope works.
- **Don't skip the test-codification on critical paths.** A bug you fix without
  leaving a guard behind will quietly come back on the next refactor.
- **Don't treat an adversary's report as ground truth.** Both `spec-critic` and
  `race-auditor` are instructed to be relentless; relentless produces false
  positives. Verify premises before acting — that's step 2, and it applies to both
  gates.
