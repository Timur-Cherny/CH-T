# Failure taxonomy — seeded from real incidents, not from a textbook

Generic failure-mode lists ("check nulls, check concurrency") produce generic specs. This
catalog is different: **every entry below is a bug that actually shipped or actually blocked a
release in this codebase.** Each one is stated twice — as the general pattern, and as the concrete
instance it came from — because the pattern is what transfers and the instance is what makes it
believable.

Use at Gate 1: read the categories relevant to what you're touching and ask *"can this one bite
here?"* That question is far more productive than "name five failure modes" from a blank page.

---

## A. The storage engine enforces something you assumed it deferred

**Pattern.** You reorder or batch operations believing a constraint is checked at commit. It is
checked per statement, and your intermediate state is illegal even though your final state is fine.

**Instance.** A move filled the target unit before draining the source. Both rows held the same
serial for the duration of one statement. `stock_serial_live_unique_idx` is a **partial** unique
index — Postgres enforces it per statement and a partial index **cannot be deferred**. Result: 23505
on every serialised move. Fix was ordering: drain source, then fill target.

**Spec question.** For every constraint your change relies on: is it deferrable, and did you check,
or did you assume? Partial indexes, exclusion constraints, and triggers are the usual traps.

---

## B. The inherited default is not the default you assumed

**Pattern.** You build on a mechanism that "has retries" / "has a timeout" / "is transactional" and
never read what the value actually is in *this* installation.

**Instance.** Status-callback delivery was documented as retrying. `retry.max` was **0** in all 20
job migrations — every callback got exactly one attempt, and a single blip lost the notification
silently.

**Spec question.** Name each inherited default your correctness depends on, and cite where you read
it. "It retries" without a number is not a spec line.

---

## C. The uniqueness key is coarser than the thing it identifies

**Pattern.** A dedup or idempotency key groups together things that are genuinely distinct. The
second distinct event is swallowed as a duplicate. This fails *silently* and looks like correct
deduplication.

**Instance.** The status-delivery ledger deduped on `(companyId, orderId, status)`. An order with
several legs produces the same status for each leg — legs 2..n were dropped as duplicates. Fix:
widen to `(companyId, orderId, referenceId, status)`.

**Spec question.** Write out the key. Then name two different real events that would collide on it.
If you can name one, the key is too coarse.

---

## D. The framework hook runs at the wrong point in the lifecycle

**Pattern.** You pick an extension point by name ("middleware", "interceptor", "hook") and assume the
context you need is populated there. It isn't, and the failure is a **silent no-op** rather than a
crash.

**Instance.** A middleware bound by the root module to stamp `request_id` onto audit rows: `req.id` is
undefined at that point because pino assigns it later. The middleware ran, wrote nothing, and nobody
noticed. Proven empirically (log the value at both points) before rewriting it as an interceptor.

**Spec question.** For each framework extension point: what proves the data you need exists there?
Prefer a five-line empirical check over reasoning about framework internals.

---

## E. Check-then-act without a lock (get-or-create, reserve, close)

**Pattern.** `SELECT` then `INSERT`/`UPDATE` with no lock, no unique constraint, no version column.
Two callers both pass the check.

**Instances.** Customer and `order_contacts` get-or-create produced duplicate rows under
concurrent order creation (closed with atomic upsert + an advisory lock for the create path).
Oversell of a SKU had the same shape one level up.

**Spec question.** For every read-modify-write: what makes the interleaving impossible — a DB
constraint, `SELECT ... FOR UPDATE`, an advisory lock, or an optimistic version? "The caller only
does this once" is not an answer; find the callers and count them.

---

## F. The raw-query result shape is not the ORM result shape

**Pattern.** A raw query returns a different structure than the typed API you're used to, and a
truthiness or `.length` check on it is always true. The guard looks present and never fires.

**Instance.** TypeORM's raw `UPDATE ... RETURNING` resolves to `[rows, rowCount]`. A `.length` check
on that array is always `2` — the compare-and-swap it was guarding never actually gated anything.
Destructure `[rows]`.

**Spec question.** For every raw query whose result gates a decision: what exactly does the driver
return, and did you log it once to be sure?

---

## G. A connection or channel captured at bootstrap, never re-acquired

**Pattern.** A long-lived resource is grabbed once at startup and cached. On first close it is never
re-established, and everything downstream fails until the process restarts.

**Instance.** The auth service captures its RabbitMQ channel at bootstrap with no reconnect. After
the first channel close, `POST /users` returns 500 until the pod restarts — and `user.created` is
lost, desynchronising downstream services.

**Spec question.** Every cached connection: what happens on its first close? Is there a reconnect
path, and has it been exercised, or only assumed?

---

## H. The fix introduces a new intermediate state (regression-by-repair)

**Pattern.** A correctness fix adds a state transition. The new *intermediate* state is reachable by
input the original code never saw, and it swallows or corrupts the next event. This category is
dangerous precisely because it appears **after** the original bug is proven fixed.

**Instances**, all three from one frontend fix round, all found only by adversarially auditing the fix
itself:
- re-probing a gate anchor after every closed line re-armed the gate and ate the next product scan
- a buffered scan carried an already-consumed lot onto the next line of the same SKU
- a terminal action had no in-flight latch, so a double tap finished twice

**Spec question.** After the fix: enumerate the states the change adds. For each, what arrives next,
and is it handled? Then re-run the adversarial pass **on the fix**, not just on the original code.

---

## I. Parent moved, children left behind (structural split)

**Pattern.** An operation on a container is implemented as an operation on the container row, and the
contained rows are not carried along — or vice versa. Downstream logic then sees a valid-looking but
empty or orphaned structure.

**Instance.** Relocating a whole container in place moved the container row; its children went to a
phantom quantity-0 container, and dispatch then reserved the empty one.

**Spec question.** Does your change touch a parent/child structure? State explicitly what happens to
children, and add an invariant that forbids a live parent with a stranded child.

---

## J. Client-side retry that never resumes

**Pattern.** A retry policy is suspended by a condition the developer never reproduces, so a failed
first request never retries and the UI sits in a permanent intermediate state.

**Instance.** react-query v3 pauses retries in a hidden tab. A failed first request plus a
backgrounded tab equals eternal `loading`, across every `useFetchRequest` with `retry: 1`.

**Spec question.** For every client fetch with retry: under what conditions does the retry *not* fire,
and what does the user see then?

---

## K. Migration identity is not the filename

**Pattern.** The migration runner matches on something other than what you think, so a rename,
reorder, or cherry-pick silently re-runs or silently skips.

**Instance.** TypeORM matches applied migrations **by class name**. Renaming a migration file without
updating the `migrations` table makes it run a second time; two branches minting the same timestamp
makes one silently skip.

**Spec question.** If you renamed, reordered, or back-ported a migration: what does the runner key on,
and does the deployed environment's `migrations` table need an `UPDATE` **before** the rollout?

---

## L. Reconciliation that ignores an open obligation

**Pattern.** A total is computed from settled records and quietly excludes records that are still in
flight, so the number is right today and wrong the moment something hangs.

**Instance.** A sales report read 32 units sold for a SKU; actual was 30 sales plus an unclosed return
still sitting in `ready_to_ship` plus a cancellation that was never subtracted.

**Spec question.** Any aggregate your change produces or consumes: which in-flight states are
included, which excluded, and is that written down where the consumer will see it?

---

## Using this list

Do **not** paste all twelve into a spec. Pick the ones the change can actually touch — usually two to
four — and answer their spec questions concretely. A failure mode with a named mechanism is handled;
a failure mode with a category name is decoration.

When a **new** incident happens, add it here. The value of this file is that it is local history, and
it decays if it stops being fed.
