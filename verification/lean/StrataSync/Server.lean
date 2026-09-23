/-
  Server-side sync: a model of

    packages/server/src/utils/async-mutex.ts            (AsyncMutex)
    packages/server/src/websocket/client-session.ts     (sendDeltaAction, onLiveDelta,
                                                         flushBufferedActions, G narrowing,
                                                         fillGapBefore)
    packages/server/src/websocket/sync-websocket.ts     (handleSubscribe ordering)
    packages/server/src/websocket/replay.ts             (replaySyncActions paging)
    packages/server/src/mutate/mutate-service.ts        (processTransaction: commit → publish,
                                                         clientTxId dedup)
    packages/server/src/dao/sync-dao.ts                 (insert-order advisory lock,
                                                         getEarliestSyncId, getSyncActionsThrough)
    packages/server/src/bootstrap/cursor.ts             (keyset pagination)
    packages/server/src/core/errors.ts                  (isSyncCursorStale)

  Sections
    1. AsyncMutex: mutual exclusion and FIFO grant order under every
       interleaving of acquire / release.
    2. Session egress (`sendDeltaAction`): whatever order deltas arrive in, the
       frames a client sees have strictly increasing sync ids (no duplicates),
       and a strictly increasing input above the cursor is delivered in full.
    3. BUG (fixed): the post-commit publish awaited `onAfterMutation` first, so
       two concurrent mutations could publish out of commit order and a live
       session silently dropped the lower id forever. Counterexample + the
       corrected model (publish in the same atomic step as commit).
    4. Snapshot/subscribe handoff: install subscription → paged replay →
       flush buffer → live. Under every interleaving with concurrent commits,
       the client receives exactly the ids in (C, n], in order, once each.
       Plus the counterexample for the opposite order (replay before install).
    5. BUG (fixed): a concurrent duplicate submission of one clientTxId lost
       the insert race and reported failure, because the dedup check did not
       recognise the driver error shape (DrizzleQueryError{cause:
       PostgresError{constraint_name}}). Exhaustive over all interleavings of
       two submissions: one row, and both succeed with its id.
    6. BUG (fixed, liveness): WebSocket stale-cursor boundary disagreed with
       `isSyncCursorStale` (forced a needless bootstrap at earliest - 1).
    7. Bootstrap keyset pagination under concurrent inserts/deletes: never
       repeats a key, never skips a key that is present throughout.
    8. Sync-group scoping: a live session's groups only ever narrow, and a
       group-scoped delta is only framed for a group the session holds.
    9. BUG (fixed): cross-process publish order. A publish from another process
       can overtake a lower committed id; the session now treats a live delta
       as a notification and reads the skipped ids from `sync_actions` first.
       Exhaustive over schedules where allocated ids commit, roll back and
       publish in any order the insert-order lock allows (and a counterexample
       showing the lock is required).
   10. BUG (fixed): an empty `sync_actions` (retention pruned everything)
       reported every cursor fresh. The floor is now one above the sequence
       high-water mark.
   11. BUG (fixed): composite keyset pagination skipped a row with a NULL in a
       later cursor field at a page boundary (and stopped on a NULL boundary
       row). Generic keyset exactness for any strict total order, NULLS LAST
       instance.

  Async interleavings are modelled explicitly: each `await` in the TypeScript
  is a boundary between atomic steps, and theorems quantify over every
  schedule of those steps.
-/

namespace StrataSync.Server

/-! ## 1. AsyncMutex

```ts
const previous = this.tail;
this.tail = previous.then(() => current).catch(() => current);
await previous;
try { return await task(); } finally { release(); }
```

Ticket `i` (the `i`-th `runExclusive` call) awaits `previous`, which resolves
only after ticket `i-1` released *and* its own `previous` resolved — i.e. after
every earlier ticket is done. We model each ticket's status and let the
scheduler pick any enabled step in any order. -/

inductive TStatus | waiting | running | done
  deriving DecidableEq, Repr

/-- Ticket `i` may start once every earlier ticket is `done` (the promise chain). -/
def canStart (l : List TStatus) (i : Nat) : Prop :=
  l[i]? = some TStatus.waiting ∧ ∀ j, j < i → l[j]? = some TStatus.done

inductive MutexStep : List TStatus → List TStatus → Prop
  /-- `runExclusive` called: a new ticket joins the tail. -/
  | enqueue (l) : MutexStep l (l ++ [.waiting])
  /-- `await previous` resolves; the task body starts. -/
  | start (l i) : canStart l i → MutexStep l (l.set i .running)
  /-- `finally release()`. -/
  | finish (l i) : l[i]? = some TStatus.running → MutexStep l (l.set i .done)

/-- Reachable shape: `done* (running)? waiting*`. -/
inductive Shape : List TStatus → Prop
  | nil : Shape []
  | done {l} : Shape l → Shape (.done :: l)
  | running {l} : (∀ s ∈ l, s = .waiting) → Shape (.running :: l)
  | waiting {l} : (∀ s ∈ l, s = .waiting) → Shape l → Shape (.waiting :: l)

theorem Shape.all_waiting : ∀ {l : List TStatus}, (∀ s ∈ l, s = .waiting) → Shape l
  | [], _ => .nil
  | s :: l, h => by
    have hs : s = .waiting := h s (by simp)
    have hl : ∀ x ∈ l, x = .waiting := fun x hx => h x (by simp [hx])
    subst hs
    exact .waiting hl (Shape.all_waiting hl)

theorem Shape.append_waiting : ∀ {l : List TStatus}, Shape l → Shape (l ++ [.waiting])
  | _, .nil => .waiting (by simp) .nil
  | _, .done h => .done h.append_waiting
  | _, .running h => .running (by
      intro s hs; simp at hs; rcases hs with hs | hs
      · exact h s hs
      · exact hs)
  | _, .waiting h hs => .waiting (by
      intro s hs'; simp at hs'; rcases hs' with hs' | hs'
      · exact h s hs'
      · exact hs') hs.append_waiting

theorem Shape.start : ∀ {l : List TStatus} {i : Nat}, Shape l → canStart l i →
    Shape (l.set i .running)
  | _, 0, .nil, h => by simp [canStart] at h
  | _, i+1, .nil, h => by simp [canStart] at h
  | _, 0, .done _, h => by simp [canStart] at h
  | _, i+1, .done hl, h => by
      have h' : canStart _ i := ⟨by simpa using h.1, fun j hj => by
        simpa using h.2 (j+1) (by omega)⟩
      simpa using Shape.done (hl.start h')
  | _, 0, .running _, h => by simp [canStart] at h
  | _, i+1, .running hw, h => by simpa using h.2 0 (by omega)
  | _, 0, .waiting hw _, _ => by simpa using Shape.running hw
  | _, i+1, .waiting _ _, h => by simpa using h.2 0 (by omega)

theorem Shape.finish : ∀ {l : List TStatus} {i : Nat}, Shape l → l[i]? = some TStatus.running →
    Shape (l.set i .done)
  | _, 0, .nil, h => by simp at h
  | _, i+1, .nil, h => by simp at h
  | _, 0, .done _, h => by simp at h
  | _, i+1, .done hl, h => by simpa using Shape.done (hl.finish (by simpa using h))
  | _, 0, .running hw, _ => by simpa using Shape.done (Shape.all_waiting hw)
  | _, i+1, .running hw, h => by
      have : ∀ s ∈ _, s = TStatus.waiting := hw
      have hm := List.mem_of_getElem? (by simpa using h)
      exact absurd (this _ hm) (by decide)
  | _, 0, .waiting _ _, h => by simp at h
  | _, i+1, .waiting hw _, h => by
      have hm := List.mem_of_getElem? (by simpa using h)
      exact absurd (hw _ hm) (by decide)

/-- Every reachable ticket list has the shape `done* (running)? waiting*`. -/
theorem mutex_shape {l l' : List TStatus} (h : Shape l) (s : MutexStep l l') : Shape l' := by
  cases s with
  | enqueue => exact h.append_waiting
  | start i hc => exact h.start hc
  | finish i hr => exact h.finish hr

theorem Shape.running_unique : ∀ {l : List TStatus}, Shape l →
    ∀ (i j : Nat), l[i]? = some TStatus.running → l[j]? = some TStatus.running → i = j
  | _, .nil, i, _, h, _ => by simp at h
  | _, .done hl, i, j, hi, hj => by
      cases i with
      | zero => simp at hi
      | succ i => cases j with
        | zero => simp at hj
        | succ j => simpa using hl.running_unique i j (by simpa using hi) (by simpa using hj)
  | _, .running hw, i, j, hi, hj => by
      cases i with
      | zero => cases j with
        | zero => rfl
        | succ j => exact absurd (hw _ (List.mem_of_getElem? (by simpa using hj))) (by decide)
      | succ i => exact absurd (hw _ (List.mem_of_getElem? (by simpa using hi))) (by decide)
  | _, .waiting hw _, i, j, hi, hj => by
      cases i with
      | zero => simp at hi
      | succ i => exact absurd (hw _ (List.mem_of_getElem? (by simpa using hi))) (by decide)

/-- **Mutual exclusion**: in every reachable state at most one task body runs. -/
theorem mutex_exclusion {l : List TStatus} (h : Shape l) (i j : Nat)
    (hi : l[i]? = some TStatus.running) (hj : l[j]? = some TStatus.running) : i = j :=
  h.running_unique i j hi hj

theorem Shape.fifo : ∀ {l : List TStatus}, Shape l →
    ∀ (i j : Nat), i < j → l[j]? ≠ some TStatus.waiting → l[j]? ≠ none → l[i]? = some TStatus.done
  | _, .nil, _, j, _, _, h => by simp at h
  | _, .done hl, i, j, hij, h1, h2 => by
      cases i with
      | zero => rfl
      | succ i => cases j with
        | zero => omega
        | succ j => simpa using hl.fifo i j (by omega) (by simpa using h1) (by simpa using h2)
  | _, .running hw, i, j, hij, h1, h2 => by
      cases j with
      | zero => omega
      | succ j =>
        simp at h1 h2
        cases hjj : ‹List TStatus›[j]? with
        | none => simp_all
        | some s =>
          have := hw s (List.mem_of_getElem? hjj)
          simp_all
  | _, .waiting hw _, i, j, hij, h1, h2 => by
      cases j with
      | zero => simp at h1
      | succ j =>
        simp at h1 h2
        cases hjj : ‹List TStatus›[j]? with
        | none => simp_all
        | some s =>
          have := hw s (List.mem_of_getElem? hjj)
          simp_all

/-- **FIFO fairness**: if a later ticket has started (or finished), every
earlier ticket has already finished — tasks run in `runExclusive` call order. -/
theorem mutex_fifo {l : List TStatus} (h : Shape l) (i j : Nat) (hij : i < j)
    (hj : l[j]? = some TStatus.running ∨ l[j]? = some TStatus.done) : l[i]? = some TStatus.done := by
  apply h.fifo i j hij <;> rcases hj with hj | hj <;> simp [hj]

/-! ## 2. Session egress (`ClientSession.sendDeltaAction`)

```ts
const syncId = SyncId.parse(action.syncId);
if (syncId <= this.afterSyncId) return;
...
if (syncId > this.afterSyncId) this.afterSyncId = syncId;
this.socket.send(buildDeltaFrame(...));
```

The session state that matters for ordering is `(afterSyncId, framesSent)`. -/

structure Egress where
  cursor : Nat
  out : List Nat
  deriving DecidableEq, Repr

def send (s : Egress) (id : Nat) : Egress :=
  if s.cursor < id then ⟨id, s.out ++ [id]⟩ else s

def sendAll (s : Egress) (ids : List Nat) : Egress := ids.foldl send s

def Mono (s : Egress) : Prop := s.out.Pairwise (· < ·) ∧ ∀ x ∈ s.out, x ≤ s.cursor

theorem send_mono {s : Egress} (h : Mono s) (id : Nat) : Mono (send s id) := by
  unfold send
  split
  · rename_i hlt
    show (s.out ++ [id]).Pairwise (· < ·) ∧ ∀ x ∈ s.out ++ [id], x ≤ id
    refine ⟨?_, ?_⟩
    · rw [List.pairwise_append]
      refine ⟨h.1, by simp, ?_⟩
      intro a ha b hb
      simp at hb; subst hb
      have := h.2 a ha; omega
    · intro x hx
      simp at hx
      rcases hx with hx | hx
      · have := h.2 x hx; omega
      · omega
  · exact h

theorem sendAll_mono : ∀ (ids : List Nat) {s : Egress}, Mono s → Mono (sendAll s ids)
  | [], _, h => h
  | id :: ids, _, h => sendAll_mono ids (send_mono h id)

/-- **Observed sync ids are strictly increasing** (hence duplicate-free), for
*any* arrival order of deltas from replay, buffer flush, live stream and
catch-up. -/
theorem egress_strictly_increasing (ids : List Nat) (c : Nat) :
    (sendAll ⟨c, []⟩ ids).out.Pairwise (· < ·) :=
  (sendAll_mono ids ⟨by simp, by simp⟩).1

/-- A strictly increasing input above the cursor is delivered in full. -/
theorem sendAll_increasing : ∀ (ids : List Nat) (c : Nat) (out : List Nat),
    ids.Pairwise (· < ·) → (∀ x ∈ ids, c < x) →
    (sendAll ⟨c, out⟩ ids).out = out ++ ids
  | [], _, _, _, _ => by simp [sendAll]
  | id :: ids, c, out, hp, hc => by
    have hlt : c < id := hc id (by simp)
    simp only [sendAll, List.foldl_cons]
    have : send ⟨c, out⟩ id = ⟨id, out ++ [id]⟩ := by simp [send, hlt]
    rw [this]
    rw [List.pairwise_cons] at hp
    have := sendAll_increasing ids id (out ++ [id]) hp.2 (fun x hx => hp.1 x hx)
    simp [sendAll] at this ⊢
    exact this

/-! ## 3. BUG (fixed): publish order vs commit order

`SyncDao.createSyncAction` takes `pg_advisory_xact_lock` so ids are allocated in
commit order. But `processTransaction` then ran

```ts
const workResult = await this.db.transaction(...);   // commit: id allocated
...
await modelConfig.mutate.onAfterMutation(...);        // <-- await
MutateService.publishSyncAction(workResult.syncAction, onAction);
```

so commit and publish were separate atomic steps. Two concurrent requests A, B:
A commits id 1, B commits id 2, B's hook is fast and publishes 2, A publishes 1.
A live session delivers 2 (cursor := 2), then drops 1 (`1 <= afterSyncId`).
The client's cursor is 2, so no later replay returns id 1 either: lost.

Scope of the fix: it makes publish order equal commit order *within one
process* (the in-process `DeltaBus`), since nothing awaits between the
transaction resolving and `onAction`. Across processes fanned out through
Redis pub/sub, two publishers can still interleave out of id order; §9 makes
the session tolerate that. -/

/-- A mutation request's atomic steps. -/
inductive MStep | commit (req : Nat) | publish (req : Nat)
  deriving DecidableEq, Repr

structure PubState where
  nextId : Nat
  /-- id allocated to each committed request (by request index) -/
  ids : List (Nat × Nat)
  published : List Nat
  deriving Repr

def lookupId (ids : List (Nat × Nat)) (req : Nat) : Option Nat :=
  (ids.find? (·.1 == req)).map (·.2)

/-- Buggy model: commit and publish are separate steps (an `await` between). -/
def buggyStep (s : PubState) : MStep → PubState
  | .commit r => { s with nextId := s.nextId + 1, ids := s.ids ++ [(r, s.nextId + 1)] }
  | .publish r => match lookupId s.ids r with
    | some id => { s with published := s.published ++ [id] }
    | none => s

def runBuggy (sched : List MStep) : PubState := sched.foldl buggyStep ⟨0, [], []⟩

/-- A live session (cursor 0) fed the published stream. -/
def liveReceives (published : List Nat) : List Nat := (sendAll ⟨0, []⟩ published).out

/-- The schedule A.commit, B.commit, B.publish, A.publish loses id 1. -/
theorem bug_publish_after_hook_loses_delta :
    let s := runBuggy [.commit 0, .commit 1, .publish 1, .publish 0]
    s.published = [2, 1] ∧ liveReceives s.published = [2] := by decide

/-- Fixed model (`publishSyncAction` now runs synchronously right after the
transaction resolves, before any further `await`): commit and publish are one
atomic step, so the published stream is the commit stream. -/
def fixedStep (s : PubState) (r : Nat) : PubState :=
  { nextId := s.nextId + 1, ids := s.ids ++ [(r, s.nextId + 1)],
    published := s.published ++ [s.nextId + 1] }

def runFixed (from_ : PubState) (reqs : List Nat) : PubState := reqs.foldl fixedStep from_

theorem runFixed_published : ∀ (reqs : List Nat) (s : PubState),
    (∀ x ∈ s.published, x ≤ s.nextId) → s.published.Pairwise (· < ·) →
    (runFixed s reqs).published.Pairwise (· < ·) ∧
      ∀ x ∈ (runFixed s reqs).published, x ≤ (runFixed s reqs).nextId
  | [], s, hb, hp => ⟨hp, hb⟩
  | r :: rs, s, hb, hp => by
    apply runFixed_published rs (fixedStep s r)
    · intro x hx
      simp [fixedStep] at hx ⊢
      rcases hx with hx | hx
      · have := hb x hx; omega
      · omega
    · simp only [fixedStep]
      rw [List.pairwise_append]
      refine ⟨hp, by simp, ?_⟩
      intro a ha b hb'
      simp at hb'; subst hb'
      have := hb a ha; omega

/-- **Fixed**: under every schedule of concurrent requests the published stream
is strictly increasing, so a live session receives every id exactly once. -/
theorem fixed_live_receives_all (reqs : List Nat) :
    liveReceives (runFixed ⟨0, [], []⟩ reqs).published =
      (runFixed ⟨0, [], []⟩ reqs).published := by
  have h := runFixed_published reqs ⟨0, [], []⟩ (by simp) (by simp)
  have hpos : ∀ s : PubState, (∀ x ∈ s.published, 0 < x) →
      ∀ rs : List Nat, ∀ x ∈ (runFixed s rs).published, 0 < x := by
    intro s hs rs
    induction rs generalizing s with
    | nil => exact hs
    | cons r rs ih =>
      apply ih
      intro x hx
      simp [fixedStep] at hx
      rcases hx with hx | hx
      · exact hs x hx
      · omega
  unfold liveReceives
  have := sendAll_increasing _ 0 [] h.1 (hpos _ (by simp) reqs)
  simpa using this

/-! ## 4. Snapshot / subscribe handoff

`handleSubscribe` (under the socket mutex):
`beginReplay(C)` → `installDeltaSubscription()` → `replaySyncActions` (pages of
`getSyncActions(cursor, groups, k)`, stop on a short page) →
`flushBufferedActions()` → phase `live`.

Concurrently, mutations commit (and — with §3 fixed — publish atomically).
While `replaying`, `onLiveDelta` buffers (it is a synchronous bus callback, not
behind the mutex); once `live`, it sends. Ids are `1..n` in commit order
(advisory lock), so the committed log at any instant is exactly `[1..n]`.

`rng a len = [a+1, …, a+len]`. -/

def rng (a : Nat) : Nat → List Nat
  | 0 => []
  | k + 1 => rng a k ++ [a + k + 1]

theorem rng_append (a x : Nat) : ∀ y, rng a x ++ rng (a + x) y = rng a (x + y)
  | 0 => by simp [rng]
  | y + 1 => by
    rw [show x + (y + 1) = (x + y) + 1 by omega]
    simp only [rng]
    rw [← List.append_assoc, rng_append a x y]
    congr 2
    omega

theorem mem_rng {a k x : Nat} : x ∈ rng a k ↔ a < x ∧ x ≤ a + k := by
  induction k with
  | zero => simp [rng]
  | succ k ih => simp [rng, ih]; omega

theorem rng_pairwise (a : Nat) : ∀ k, (rng a k).Pairwise (· < ·)
  | 0 => by simp [rng]
  | k + 1 => by
    simp only [rng]
    rw [List.pairwise_append]
    refine ⟨rng_pairwise a k, by simp, ?_⟩
    intro x hx y hy
    simp at hy; rw [mem_rng] at hx; omega

/-- Delivering `[a+1..a+len]` from cursor `c ≥ a`: ids `≤ c` are dropped (they
were already delivered by replay), the rest are delivered. -/
theorem send_rng (a c : Nat) (out : List Nat) (hac : a ≤ c) : ∀ len,
    sendAll ⟨c, out⟩ (rng a len) =
      if c ≤ a + len then ⟨a + len, out ++ rng c (a + len - c)⟩ else ⟨c, out⟩
  | 0 => by
    by_cases h : c ≤ a + 0
    · have : c = a := by omega
      subst this; simp [rng, sendAll]
    · simp only [h, ite_false]; simp [rng, sendAll]
  | len + 1 => by
    have ih := send_rng a c out hac len
    have hfold : sendAll ⟨c, out⟩ (rng a (len + 1)) =
        send (sendAll ⟨c, out⟩ (rng a len)) (a + len + 1) := by
      simp [sendAll, rng, List.foldl_append]
    rw [hfold, ih]
    by_cases h1 : c ≤ a + len
    · have h2 : c ≤ a + (len + 1) := by omega
      have h3 : a + len < a + len + 1 := by omega
      simp only [h1, h2, ite_true]
      simp only [send, h3, ite_true]
      have e1 : a + (len + 1) = a + len + 1 := by omega
      have e2 : a + len + 1 - c = (a + len - c) + 1 := by omega
      have e3 : c + (a + len - c) + 1 = a + len + 1 := by omega
      rw [e1, e2]
      simp only [rng, List.append_assoc, e3]
    · simp only [h1, ite_false]
      by_cases h2 : c ≤ a + (len + 1)
      · have hc : c = a + len + 1 := by omega
        simp only [h2, ite_true]
        subst hc
        simp [send]
        refine ⟨by omega, ?_⟩
        rw [show a + (len + 1) - (a + len + 1) = 0 by omega]
        rfl
      · have : ¬ (c < a + len + 1) := by omega
        simp only [h2, ite_false]
        simp [send, this]

inductive Phase | idle | replaying | drained | live
  deriving DecidableEq, Repr

structure HS where
  /-- committed (and published) ids are `1..n` -/
  n : Nat
  /-- `session.afterSyncId` -/
  c : Nat
  /-- frames sent to the client -/
  out : List Nat
  /-- `bufferedActions` -/
  buf : List Nat
  /-- `n` at the moment the subscription was installed -/
  m : Nat
  phase : Phase
  deriving Repr

/-- Atomic steps. `page k` is one `getSyncActions(cursor, groups, k)` + sends. -/
inductive HEvent | commit | install | page (k : Nat) | flush
  deriving DecidableEq, Repr

def hstep (s : HS) : HEvent → HS
  | .commit =>
    let id := s.n + 1
    match s.phase with
    | .idle => { s with n := id }
    | .replaying | .drained =>
      -- onLiveDelta: `syncId <= afterSyncId` filter, then buffer
      if s.c < id then { s with n := id, buf := s.buf ++ [id] } else { s with n := id }
    | .live => let e := send ⟨s.c, s.out⟩ id; { s with n := id, c := e.cursor, out := e.out }
  | .install => match s.phase with
    | .idle => { s with phase := .replaying, m := s.n }
    | _ => s
  | .page k => match s.phase with
    | .replaying =>
      if 0 < k then
        let got := min k (s.n - s.c)       -- rows with id > cursor, limit k
        let e := sendAll ⟨s.c, s.out⟩ (rng s.c got)
        { s with c := e.cursor, out := e.out,
                 phase := if got < k then .drained else .replaying }
      else s
    | _ => s
  | .flush => match s.phase with
    | .drained =>
      -- buffer is strictly increasing here, so `toSorted` is the identity
      let e := sendAll ⟨s.c, s.out⟩ s.buf
      { s with c := e.cursor, out := e.out, buf := [], phase := .live }
    | _ => s

def hrun (s : HS) (evs : List HEvent) : HS := evs.foldl hstep s

def HInv (C : Nat) (s : HS) : Prop :=
  C ≤ s.c ∧ s.c ≤ s.n ∧ s.out = rng C (s.c - C) ∧
  (s.phase = .idle → s.buf = [] ∧ s.c = C) ∧
  (s.phase = .replaying → s.buf = rng s.m (s.n - s.m) ∧ s.m ≤ s.n) ∧
  (s.phase = .drained → s.buf = rng s.m (s.n - s.m) ∧ s.m ≤ s.c) ∧
  (s.phase = .live → s.buf = [] ∧ s.c = s.n)

theorem hstep_inv (C : Nat) (s : HS) (h : HInv C s) (ev : HEvent) : HInv C (hstep s ev) := by
  obtain ⟨h1, h2, h3, hi, hr, hd, hl⟩ := h
  cases ev with
  | commit =>
    cases hp : s.phase with
    | idle =>
      have ⟨hb, hc⟩ := hi hp
      simp only [hstep, hp, HInv]
      exact ⟨h1, by omega, h3, fun _ => ⟨hb, hc⟩, by simp, by simp, by simp⟩
    | replaying =>
      have ⟨hb, hm⟩ := hr hp
      have hlt : s.c < s.n + 1 := by omega
      simp only [hstep, hp, hlt, ite_true, HInv]
      refine ⟨h1, by omega, h3, by simp, ?_, by simp, by simp⟩
      intro _
      refine ⟨?_, by omega⟩
      rw [hb, show s.n + 1 - s.m = (s.n - s.m) + 1 by omega]
      simp only [rng]; congr 2; omega
    | drained =>
      have ⟨hb, hm⟩ := hd hp
      have hlt : s.c < s.n + 1 := by omega
      simp only [hstep, hp, hlt, ite_true, HInv]
      refine ⟨h1, by omega, h3, by simp, by simp, ?_, by simp⟩
      intro _
      refine ⟨?_, hm⟩
      rw [hb, show s.n + 1 - s.m = (s.n - s.m) + 1 by omega]
      simp only [rng]; congr 2; omega
    | live =>
      have ⟨hb, hc⟩ := hl hp
      have hlt : s.c < s.n + 1 := by omega
      simp only [hstep, hp, send, hlt, ite_true, HInv]
      refine ⟨by omega, by omega, ?_, by simp, by simp, by simp, fun _ => ⟨hb, by simp⟩⟩
      rw [h3, show s.n + 1 - C = (s.c - C) + 1 by omega]
      simp only [rng]; congr 2; omega
  | install =>
    cases hp : s.phase with
    | idle =>
      have ⟨hb, hc⟩ := hi hp
      simp only [hstep, hp, HInv]
      refine ⟨h1, h2, h3, by simp, fun _ => ⟨by simp [hb, rng], by omega⟩, by simp, by simp⟩
    | _ => simp only [hstep, hp]; exact ⟨h1, h2, h3, hi, hr, hd, hl⟩
  | page k =>
    cases hp : s.phase with
    | replaying =>
      have ⟨hb, hm⟩ := hr hp
      simp only [hstep, hp]
      split
      · rename_i hk
        have hsend := send_rng s.c s.c s.out (Nat.le_refl _) (min k (s.n - s.c))
        have hle : s.c ≤ s.c + min k (s.n - s.c) := by omega
        simp only [hle, ite_true] at hsend
        rw [hsend]
        have hout : s.out ++ rng s.c (s.c + min k (s.n - s.c) - s.c) =
            rng C (s.c + min k (s.n - s.c) - C) := by
          rw [h3, show s.c + min k (s.n - s.c) - s.c = min k (s.n - s.c) by omega]
          have := rng_append C (s.c - C) (min k (s.n - s.c))
          rw [show C + (s.c - C) = s.c by omega] at this
          rw [this]; congr 1; omega
        by_cases hg : min k (s.n - s.c) < k
        · simp only [hg, ite_true, HInv]
          refine ⟨by omega, by omega, hout, by simp, by simp, fun _ => ⟨hb, by omega⟩, by simp⟩
        · simp only [hg, ite_false, HInv]
          refine ⟨by omega, by omega, hout, by simp, fun _ => ⟨hb, hm⟩, by simp, by simp⟩
      · exact ⟨h1, h2, h3, hi, hr, hd, hl⟩
    | _ => simp only [hstep, hp]; exact ⟨h1, h2, h3, hi, hr, hd, hl⟩
  | flush =>
    cases hp : s.phase with
    | drained =>
      have ⟨hb, hm⟩ := hd hp
      simp only [hstep, hp, hb]
      have hsend := send_rng s.m s.c s.out hm (s.n - s.m)
      have hle : s.c ≤ s.m + (s.n - s.m) := by omega
      simp only [hle, ite_true] at hsend
      rw [hsend]
      simp only [HInv]
      refine ⟨by omega, by omega, ?_, by simp, by simp, by simp, fun _ => ⟨by simp, by omega⟩⟩
      rw [h3, show s.m + (s.n - s.m) - s.c = s.n - s.c by omega]
      have := rng_append C (s.c - C) (s.n - s.c)
      rw [show C + (s.c - C) = s.c by omega] at this
      rw [show s.m + (s.n - s.m) - C = (s.c - C) + (s.n - s.c) by omega, this]
    | _ => simp only [hstep, hp]; exact ⟨h1, h2, h3, hi, hr, hd, hl⟩

theorem hrun_inv (C : Nat) : ∀ (evs : List HEvent) (s : HS), HInv C s → HInv C (hrun s evs)
  | [], _, h => h
  | e :: es, s, h => hrun_inv C es (hstep s e) (hstep_inv C s h e)

/-- Initial state: client bootstrapped at cursor `C`, `n₀ ≥ C` ids committed. -/
def hinit (C n₀ : Nat) : HS := ⟨n₀, C, [], [], 0, .idle⟩

theorem hinit_inv (C n₀ : Nat) (h : C ≤ n₀) : HInv C (hinit C n₀) := by
  simp [HInv, hinit, rng]; omega

/-- **Handoff theorem.** Under every interleaving of commits with the subscribe
sequence, once the session is `live` the client has received exactly
`[C+1, …, n]` — every committed id above its bootstrap cursor, in order, once
each — and it keeps that property for every later commit. -/
theorem handoff_exact (C n₀ : Nat) (h : C ≤ n₀) (evs : List HEvent)
    (hlive : (hrun (hinit C n₀) evs).phase = .live) :
    (hrun (hinit C n₀) evs).out = rng C ((hrun (hinit C n₀) evs).n - C) := by
  have ⟨_, _, h3, _, _, _, hl⟩ := hrun_inv C evs _ (hinit_inv C n₀ h)
  rw [h3, (hl hlive).2]

/-- Whatever the schedule, the frames are strictly increasing (no duplicate)
and never skip: they are always a prefix-closed range above `C`. -/
theorem handoff_prefix (C n₀ : Nat) (h : C ≤ n₀) (evs : List HEvent) :
    ∃ k, (hrun (hinit C n₀) evs).out = rng C k := by
  have ⟨_, _, h3, _⟩ := hrun_inv C evs _ (hinit_inv C n₀ h)
  exact ⟨_, h3⟩

/-- Why `installDeltaSubscription()` must precede replay: with the opposite
order a commit landing between the last replay page and the install is neither
replayed nor buffered. Model: replay first (pages allowed in `idle`), then
install. The schedule page, commit, install, flush leaves id 1 missing. -/
def hstepWrongOrder (s : HS) : HEvent → HS
  | .page k => match s.phase with
    | .idle =>
      let got := min k (s.n - s.c)
      let e := sendAll ⟨s.c, s.out⟩ (rng s.c got)
      { s with c := e.cursor, out := e.out }
    | _ => s
  | .install => match s.phase with
    | .idle => { s with phase := .drained, m := s.n }
    | _ => s
  | ev => hstep s ev

theorem bug_replay_before_install_drops :
    let s := [HEvent.page 1000, .commit, .install, .flush, .commit].foldl
      hstepWrongOrder (hinit 0 0)
    s.phase = .live ∧ s.n = 2 ∧ s.out = [2] := by decide

/-! ## 5. BUG (fixed): idempotent mutations under a concurrent duplicate

```ts
const existing = await this.dao.findSyncActionByClientTx(clientId, clientTxId);
if (existing) return duplicate(existing.id);
try { await this.db.transaction(... createSyncAction ...) }   // unique(clientId, clientTxId)
catch (error) {
  if (isSyncDedupUniqueConstraintError(error)) {
    const duplicate = await this.dao.findSyncActionByClientTx(...);
    if (duplicate) return duplicate(duplicate.id);
  }
  return failure;
}
```

`isSyncDedupUniqueConstraintError` read `error.code` / `error.constraint`.
drizzle-orm 1.x throws `DrizzleQueryError` with the driver error in `cause`,
and postgres.js names the field `constraint_name` (checked against Postgres 16:
`DrizzleQueryError{cause: PostgresError{code: "23505", constraint_name}}`).
So the loser of a duplicate-submission race reported failure for a
transaction that is in fact committed. -/

structure DbError where
  wrapped : Bool
  /-- `true`: field is `constraint` (node-postgres); `false`: `constraint_name` (postgres.js) -/
  pgField : Bool
  deriving DecidableEq, Repr

def classifyBuggy (e : DbError) : Bool := !e.wrapped && e.pgField
def classifyFixed (_ : DbError) : Bool := true  -- walks `cause`, accepts both fields

/-- The error the production stack actually produces. -/
def drizzlePostgresJsError : DbError := ⟨true, false⟩

inductive Resp | pending | ok (id : Nat) | fail
  deriving DecidableEq, Repr

/-- Per-request program counter: 0 = pre-check, 1 = transaction, 2 = catch, 3 = done. -/
structure Req where
  pc : Nat
  sawExisting : Option Nat
  errored : Bool
  resp : Resp
  deriving DecidableEq, Repr

structure DS where
  rows : List Nat          -- ids of sync_actions rows with this (clientId, clientTxId)
  nextId : Nat
  a : Req
  b : Req
  published : List Nat
  deriving DecidableEq, Repr

def req0 : Req := ⟨0, none, false, .pending⟩

def reqStep (classify : DbError → Bool) (rows : List Nat) (nextId : Nat) (r : Req) :
    Req × List Nat × Nat × List Nat :=
  match r.pc with
  | 0 => match rows.head? with
    | some id => ({ r with pc := 3, sawExisting := some id, resp := .ok id }, rows, nextId, [])
    | none => ({ r with pc := 1 }, rows, nextId, [])
  | 1 =>
    if rows.isEmpty then
      -- insert + commit + publish (atomic, §3)
      ({ r with pc := 3, resp := .ok (nextId + 1) }, rows ++ [nextId + 1], nextId + 1, [nextId + 1])
    else ({ r with pc := 2, errored := true }, rows, nextId, [])  -- unique violation, rolled back
  | 2 =>
    if classify drizzlePostgresJsError then
      match rows.head? with
      | some id => ({ r with pc := 3, resp := .ok id }, rows, nextId, [])
      | none => ({ r with pc := 3, resp := .fail }, rows, nextId, [])
    else ({ r with pc := 3, resp := .fail }, rows, nextId, [])
  | _ => (r, rows, nextId, [])

def dstep (classify : DbError → Bool) (s : DS) (who : Bool) : DS :=
  if who then
    let (a, rows, n, p) := reqStep classify s.rows s.nextId s.a
    { s with a := a, rows := rows, nextId := n, published := s.published ++ p }
  else
    let (b, rows, n, p) := reqStep classify s.rows s.nextId s.b
    { s with b := b, rows := rows, nextId := n, published := s.published ++ p }

def drun (classify : DbError → Bool) (sched : List Bool) : DS :=
  sched.foldl (dstep classify) ⟨[], 0, req0, req0, []⟩

def boolLists : Nat → List (List Bool)
  | 0 => [[]]
  | n + 1 => (boolLists n).flatMap (fun l => [true :: l, false :: l])

/-- All interleavings of `x` steps of A (`true`) and `y` steps of B (`false`). -/
def interleavings (x y : Nat) : List (List Bool) :=
  (boolLists (x + y)).filter (fun l => l.count true == x)

/-- One row, one published delta, and both requests answered `ok` with its id. -/
def dedupOk (s : DS) : Bool :=
  match s.rows, s.published with
  | [id], [id'] => id == id' && s.a.resp == .ok id && s.b.resp == .ok id
  | _, _ => false

theorem bug_dedup_race_reports_failure :
    let s := drun classifyBuggy [true, false, true, false, false]
    s.rows = [1] ∧ s.a.resp = .ok 1 ∧ s.b.resp = .fail := by decide

/-- **Fixed**: every interleaving of two same-key submissions (3 steps each)
yields exactly one row, one delta, and two `ok` responses carrying its id. -/
theorem dedup_fixed_all_interleavings :
    (interleavings 3 3).all (fun sched => dedupOk (drun classifyFixed sched)) = true := by
  decide

theorem interleavings_count : (interleavings 3 3).length = 20 := by decide

/-! ## 6. BUG (fixed, liveness): WebSocket stale-cursor boundary

`isSyncCursorStale(after, earliest) := after > 0 ∧ earliest > 0 ∧ after + 1 < earliest`
is exact: a client is stale iff some id it has not seen, in `(after, earliest)`,
may have been pruned. `handleSubscribe` used `after < earliest` instead. -/

def isSyncCursorStale (after earliest : Nat) : Bool :=
  0 < after && 0 < earliest && after + 1 < earliest

def wsStaleBuggy (after earliest : Nat) : Bool :=
  0 < after && 0 < earliest && after < earliest

/-- With retained ids starting at `earliest`, the ids the client still needs
that might be gone are exactly those strictly between `after` and `earliest`. -/
theorem stale_exact (after earliest : Nat) (ha : 0 < after) (he : 0 < earliest) :
    isSyncCursorStale after earliest = true ↔ ∃ id, after < id ∧ id < earliest := by
  simp [isSyncCursorStale, ha, he]
  constructor
  · intro h; exact ⟨after + 1, by omega, h⟩
  · rintro ⟨id, h1, h2⟩; omega

theorem bug_ws_stale_boundary :
    wsStaleBuggy 9 10 = true ∧ ¬ ∃ id, 9 < id ∧ id < 10 := by
  refine ⟨by decide, ?_⟩
  rintro ⟨id, h1, h2⟩; omega

/-- The two predicates only ever disagree at that boundary, and the buggy one
is the conservative side: it never missed a stale cursor (safety held). -/
theorem ws_stale_buggy_conservative (after earliest : Nat) :
    isSyncCursorStale after earliest = true → wsStaleBuggy after earliest = true := by
  simp [isSyncCursorStale, wsStaleBuggy]; omega

/-! ## 7. Bootstrap keyset pagination (`streamModel`, simple cursor)

Each page is read at its own instant, against whatever the table holds then
(`snap`: sorted keys present). Page = first `k` keys `> cursor`; the next
cursor is the page's last key; a short page stops. -/

structure Pg where
  cursor : Nat
  emitted : List Nat
  done : Bool
  deriving Repr

def pageOf (k : Nat) (cursor : Nat) (snap : List Nat) : List Nat :=
  (snap.filter (fun x => decide (cursor < x))).take k

def pgStep (k : Nat) (s : Pg) (snap : List Nat) : Pg :=
  if s.done then s else
    let p := pageOf k s.cursor snap
    { cursor := p.foldl max s.cursor, emitted := s.emitted ++ p, done := decide (p.length < k) }

def pgRun (k : Nat) (snaps : List (List Nat)) : Pg := snaps.foldl (pgStep k) ⟨0, [], false⟩

theorem foldl_max_ge : ∀ (l : List Nat) (c : Nat), c ≤ l.foldl max c ∧ ∀ y ∈ l, y ≤ l.foldl max c
  | [], c => by simp
  | y :: ys, c => by
    have ih := foldl_max_ge ys (max c y)
    simp only [List.foldl_cons]
    refine ⟨by have := ih.1; omega, ?_⟩
    intro z hz
    simp at hz
    rcases hz with hz | hz
    · have := ih.1; omega
    · exact ih.2 z hz

theorem foldl_max_lt : ∀ (l : List Nat) (c x : Nat), c < x → (∀ y ∈ l, y < x) → l.foldl max c < x
  | [], _, _, h, _ => h
  | y :: ys, c, x, h, hy => by
    simp only [List.foldl_cons]
    apply foldl_max_lt ys _ x
    · have := hy y (by simp); omega
    · intro z hz; exact hy z (by simp [hz])

theorem not_mem_take_gt {l : List Nat} (hs : l.Pairwise (· < ·)) (k x : Nat)
    (hx : x ∈ l) (hn : x ∉ l.take k) : ∀ y ∈ l.take k, y < x := by
  have hsplit := List.take_append_drop k l
  rw [← hsplit] at hs hx
  rw [List.pairwise_append] at hs
  rw [List.mem_append] at hx
  rcases hx with hx | hx
  · exact absurd hx hn
  · intro y hy; exact hs.2.2 y hy x hx

def PgInv (stable : List Nat) (s : Pg) : Prop :=
  s.emitted.Pairwise (· < ·) ∧ (∀ e ∈ s.emitted, e ≤ s.cursor) ∧
  (∀ x ∈ stable, x ≤ s.cursor → 0 < x → x ∈ s.emitted) ∧
  (s.done = true → ∀ x ∈ stable, 0 < x → x ∈ s.emitted)

theorem pgStep_inv (k : Nat) (stable : List Nat) (s : Pg) (snap : List Nat)
    (hs : snap.Pairwise (· < ·)) (hst : ∀ x ∈ stable, x ∈ snap)
    (h : PgInv stable s) : PgInv stable (pgStep k s snap) := by
  unfold pgStep
  split
  · exact h
  · rename_i hnd
    obtain ⟨h1, h2, h3, _⟩ := h
    have hfs : (snap.filter (fun x => decide (s.cursor < x))).Pairwise (· < ·) := hs.filter _
    have hps : (pageOf k s.cursor snap).Pairwise (· < ·) :=
      hfs.sublist (List.take_sublist _ _)
    have hpgt : ∀ y ∈ pageOf k s.cursor snap, s.cursor < y := by
      intro y hy
      have := (List.take_sublist _ _).subset hy
      simp [List.mem_filter] at this; exact this.2
    have hmax := foldl_max_ge (pageOf k s.cursor snap) s.cursor
    -- a stable key above the cursor that is not on the page lies above the new cursor
    have hmiss : ∀ x ∈ stable, s.cursor < x → x ∉ pageOf k s.cursor snap →
        (pageOf k s.cursor snap).foldl max s.cursor < x := by
      intro x hx hcx hn
      have hxf : x ∈ snap.filter (fun x => decide (s.cursor < x)) := by
        simp [List.mem_filter]; exact ⟨hst x hx, hcx⟩
      exact foldl_max_lt _ _ _ hcx (not_mem_take_gt hfs k x hxf hn)
    refine ⟨?_, ?_, ?_, ?_⟩
    · simp only
      rw [List.pairwise_append]
      refine ⟨h1, hps, ?_⟩
      intro a ha b hb
      have := h2 a ha; have := hpgt b hb; omega
    · intro e he
      show e ≤ (pageOf k s.cursor snap).foldl max s.cursor
      simp only [List.mem_append] at he
      rcases he with he | he
      · have := h2 e he; have := hmax.1; omega
      · exact hmax.2 e he
    · intro x hx hle hpos
      simp only [List.mem_append]
      by_cases hc : x ≤ s.cursor
      · exact Or.inl (h3 x hx hc hpos)
      · by_cases hin : x ∈ pageOf k s.cursor snap
        · exact Or.inr hin
        · have := hmiss x hx (by omega) hin; simp only at hle; omega
    · intro hdone x hx hpos
      simp only [decide_eq_true_eq] at hdone
      simp only [List.mem_append]
      by_cases hc : x ≤ s.cursor
      · exact Or.inl (h3 x hx hc hpos)
      · right
        -- short page: `take k` returned the whole filtered list
        have hlen : (snap.filter (fun x => decide (s.cursor < x))).length < k := by
          have := @List.length_take _ k (snap.filter (fun x => decide (s.cursor < x)))
          unfold pageOf at hdone; omega
        unfold pageOf
        rw [List.take_of_length_le (by omega)]
        simp [List.mem_filter]; exact ⟨hst x hx, by omega⟩

/-- **Keyset pagination is exact under concurrent writes**: for any sequence of
table states (arbitrary inserts/deletes between pages), the emitted keys are
strictly increasing (never repeated) and, once paging stops, every key present
in all those states was emitted (never skipped). -/
theorem pagination_exact (k : Nat) (stable : List Nat) :
    ∀ (snaps : List (List Nat)), (∀ snap ∈ snaps, snap.Pairwise (· < ·)) →
    (∀ snap ∈ snaps, ∀ x ∈ stable, x ∈ snap) →
    ∀ s, PgInv stable s → PgInv stable (snaps.foldl (pgStep k) s)
  | [], _, _, _, h => h
  | snap :: rest, hs, hst, s, h => by
    apply pagination_exact k stable rest (fun x hx => hs x (by simp [hx]))
      (fun x hx => hst x (by simp [hx]))
    exact pgStep_inv k stable s snap (hs snap (by simp)) (hst snap (by simp)) h

theorem pagination_run (k : Nat) (stable : List Nat)
    (snaps : List (List Nat)) (hs : ∀ snap ∈ snaps, snap.Pairwise (· < ·))
    (hst : ∀ snap ∈ snaps, ∀ x ∈ stable, x ∈ snap) :
    (pgRun k snaps).emitted.Pairwise (· < ·) ∧
    ((pgRun k snaps).done = true → ∀ x ∈ stable, 0 < x → x ∈ (pgRun k snaps).emitted) := by
  have := pagination_exact k stable snaps hs hst ⟨0, [], false⟩
    ⟨by simp, by simp, fun x _ hle hpos => by simp at hle; omega, by simp⟩
  exact ⟨this.1, this.2.2.2⟩

/-! ## 8. Sync-group scoping in a live session

* A `G` action narrows: `groups := groups.filter (∈ latest)`. Reauthorisation
  narrows the same way. Nothing in a subscription ever widens `groups`
  (gaining a group requires a new subscribe, i.e. a partial bootstrap).
* `sendDeltaAction` frames a group-scoped action only if
  `groups.includes(action.groupId)`; `groupId = null` rows are global. -/

inductive GEv | narrow (latest : List Nat) | delta (groupId : Option Nat)
  deriving DecidableEq, Repr

structure GS where
  groups : List Nat
  framed : List (Option Nat × List Nat)  -- (groupId, groups at send time)

def gstep (s : GS) : GEv → GS
  | .narrow latest => { s with groups := s.groups.filter (fun g => latest.contains g) }
  | .delta none => { s with framed := s.framed ++ [(none, s.groups)] }
  | .delta (some g) =>
    if s.groups.contains g then { s with framed := s.framed ++ [(some g, s.groups)] } else s

def GInv (G0 : List Nat) (s : GS) : Prop :=
  (∀ g ∈ s.groups, g ∈ G0) ∧ ∀ p ∈ s.framed, ∀ g, p.1 = some g → g ∈ p.2 ∧ g ∈ G0

theorem gstep_inv (G0 : List Nat) (s : GS) (h : GInv G0 s) (e : GEv) : GInv G0 (gstep s e) := by
  obtain ⟨h1, h2⟩ := h
  cases e with
  | narrow l =>
    refine ⟨?_, ?_⟩
    · intro g hg
      simp only [gstep, List.mem_filter] at hg
      exact h1 g hg.1
    · simpa [gstep] using h2
  | delta og =>
    cases og with
    | none =>
      refine ⟨by simpa [gstep] using h1, ?_⟩
      intro p hp g hg
      simp only [gstep, List.mem_append, List.mem_singleton] at hp
      rcases hp with hp | hp
      · exact h2 p hp g hg
      · rw [hp] at hg; simp at hg
    | some x =>
      by_cases hc : s.groups.contains x = true
      · simp only [gstep, hc, ite_true]
        refine ⟨h1, ?_⟩
        intro p hp g hg
        simp only [List.mem_append, List.mem_singleton] at hp
        rcases hp with hp | hp
        · exact h2 p hp g hg
        · rw [hp] at hg ⊢
          simp at hg
          rw [← hg]
          have : x ∈ s.groups := by simpa using hc
          exact ⟨this, h1 x this⟩
      · simp only [gstep, hc]
        exact ⟨h1, h2⟩

/-- **No leak**: under any sequence of narrows and deltas, every framed
group-scoped delta was for a group the session held at that moment, and that
group was granted at subscribe time. -/
theorem no_leaked_group_delta (G0 : List Nat) : ∀ (evs : List GEv),
    GInv G0 (evs.foldl gstep ⟨G0, []⟩) := by
  intro evs
  suffices ∀ s, GInv G0 s → GInv G0 (evs.foldl gstep s) from
    this _ ⟨fun _ h => h, by simp⟩
  induction evs with
  | nil => exact fun _ h => h
  | cons e es ih => exact fun s h => ih _ (gstep_inv G0 s h e)

/-! ## 9. BUG (fixed): cross-process publish order

§3 made publish order equal commit order inside one process. With Redis (or
any multi-process fan-out) two processes still publish independently: A
commits 1, B commits 2, B's publish reaches a third process first. The
session there sent 2, set `afterSyncId := 2`, and then dropped 1 as
`<= afterSyncId`; the client's reconnect cursor is past 1, so no replay
returns it either — permanent loss.

Fix (`ClientSession.sendDeltaAction` / `fillGapBefore` /
`deliverLiveDelta`): a live delta is a notification. Before sending id `i`
with `i > scannedThrough + 1`, read `sync_actions` for `(scannedThrough, i)`
(filtered by the session's groups, `SyncDao.getSyncActionsThrough`), send
those rows in id order, then `i`, and set `scannedThrough := i`. A delta for a
group the session does not hold is not sent, but if it is exactly
`scannedThrough + 1` it advances the horizon (no read needed next time).

Why reading is enough — no horizon/delay is needed: `createSyncAction`
allocates ids under `pg_advisory_xact_lock`, held until commit (and Postgres
makes a commit visible before it releases the transaction's locks). So at most
one allocated id is in flight, it is the highest allocated, and when id `i`
is committed every lower id that will ever commit is already visible; ids
consumed by rolled-back transactions never become visible and are correctly
skipped. That precondition is essential — `bug_gap_fill_needs_commit_ordered_ids`
shows the same session losing an id when two ids may be in flight at once
(e.g. without the lock, or with a sequence `CACHE > 1`).

Model. Ids are allocated `1, 2, …` (`alloc`); an allocated id may `commit`
(becomes visible and its publish is queued in `pending`) or `rollback`, in any
order the lock allows (`locked = false`: any order at all). `recv i` delivers
any queued publish to the session — arbitrary cross-process reordering — and
`drop i` loses one (Redis is best-effort). `vis` is the session's group
filter. The gap read and the frame sends are one atomic step: under the lock
the visible set in `(scanned, i)` cannot grow once `i` is committed, so a later
read would return the same rows. -/

structure XS where
  next : Nat
  inflight : List Nat
  committed : List Nat
  pending : List Nat
  scanned : Nat
  out : List Nat
  deriving Repr

inductive XEv | alloc | commit (i : Nat) | rollback (i : Nat) | recv (i : Nat) | drop (i : Nat)
  deriving DecidableEq, Repr

def xinit : XS := ⟨0, [], [], [], 0, []⟩

def recvBuggy (vis : Nat → Bool) (s : XS) (i : Nat) : XS :=
  if vis i && decide (s.scanned < i) then { s with scanned := i, out := s.out ++ [i] } else s

def gapIds (vis : Nat → Bool) (s : XS) (i : Nat) : List Nat :=
  (rng s.scanned (i - s.scanned - 1)).filter (fun c => decide (c ∈ s.committed) && vis c)

def recvFixed (vis : Nat → Bool) (s : XS) (i : Nat) : XS :=
  if i ≤ s.scanned then s
  else if vis i then { s with scanned := i, out := s.out ++ gapIds vis s i ++ [i] }
  else if i = s.scanned + 1 then { s with scanned := i }
  else s

def xstep (locked : Bool) (recv : (Nat → Bool) → XS → Nat → XS) (vis : Nat → Bool)
    (s : XS) : XEv → XS
  | .alloc =>
    if locked && !s.inflight.isEmpty then s
    else { s with next := s.next + 1, inflight := s.inflight ++ [s.next + 1] }
  | .commit i =>
    if i ∈ s.inflight then
      { s with inflight := s.inflight.filter (· ≠ i), committed := s.committed ++ [i],
               pending := s.pending ++ [i] }
    else s
  | .rollback i =>
    if i ∈ s.inflight then { s with inflight := s.inflight.filter (· ≠ i) } else s
  | .recv i =>
    if i ∈ s.pending then recv vis { s with pending := s.pending.filter (· ≠ i) } i else s
  | .drop i => { s with pending := s.pending.filter (· ≠ i) }

def xrun (locked : Bool) (recv : (Nat → Bool) → XS → Nat → XS) (vis : Nat → Bool)
    (evs : List XEv) : XS :=
  evs.foldl (xstep locked recv vis) xinit

/-- The old session (cursor-only filter): B's 2 overtakes A's 1, and 1 is lost. -/
theorem bug_cross_process_publish_order_drops :
    let s := xrun true recvBuggy (fun _ => true)
      [.alloc, .commit 1, .alloc, .commit 2, .recv 2, .recv 1]
    s.committed = [1, 2] ∧ s.out = [2] ∧ s.scanned = 2 := by decide

/-- Gap fill alone is unsound when ids can commit out of order: 2 commits
while 1 is still in flight, the read finds nothing below 2, and 1 then
commits below the cursor. The advisory lock rules this schedule out. -/
theorem bug_gap_fill_needs_commit_ordered_ids :
    let s := xrun false recvFixed (fun _ => true)
      [.alloc, .alloc, .commit 2, .recv 2, .commit 1, .recv 1]
    s.committed = [2, 1] ∧ s.out = [2] ∧ s.scanned = 2 := by decide

theorem cross_process_fixed_example :
    let s := xrun true recvFixed (fun _ => true)
      [.alloc, .commit 1, .alloc, .commit 2, .recv 2, .recv 1]
    s.out = [1, 2] := by decide

/-- Invariant of the fixed session under the insert-order lock. -/
structure XInv (vis : Nat → Bool) (s : XS) : Prop where
  committed_le : ∀ c ∈ s.committed, c ≤ s.next
  inflight_gt : ∀ f ∈ s.inflight, f ≤ s.next ∧ s.scanned < f ∧ ∀ c ∈ s.committed, c < f
  one_inflight : s.inflight.length ≤ 1
  scanned_le : s.scanned ≤ s.next
  pending_committed : ∀ p ∈ s.pending, p ∈ s.committed
  no_loss : ∀ c ∈ s.committed, vis c = true → c ≤ s.scanned → c ∈ s.out
  out_sorted : s.out.Pairwise (· < ·)
  out_ok : ∀ x ∈ s.out, x ≤ s.scanned ∧ x ∈ s.committed ∧ vis x = true

theorem singleton_of_length_le_one {l : List Nat} {i : Nat} (h : l.length ≤ 1) (hi : i ∈ l) :
    l = [i] := by
  match l, h, hi with
  | [a], _, hi => simp at hi; simp [hi]
  | _ :: _ :: _, h, _ => simp at h

theorem recvFixed_inv (vis : Nat → Bool) (s : XS) (h : XInv vis s) (i : Nat)
    (hi : i ∈ s.committed) : XInv vis (recvFixed vis s i) := by
  have hin := h.committed_le i hi
  have hinf : ∀ f ∈ s.inflight, i < f := fun f hf => (h.inflight_gt f hf).2.2 i hi
  unfold recvFixed
  by_cases hle : i ≤ s.scanned
  · simp only [hle, ite_true]; exact h
  simp only [hle, ite_false]
  by_cases hv : vis i = true
  · simp only [hv, ite_true]
    have hgap : ∀ x ∈ gapIds vis s i, s.scanned < x ∧ x < i ∧ x ∈ s.committed ∧ vis x = true := by
      intro x hx
      simp only [gapIds, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hx
      have := mem_rng.mp hx.1
      exact ⟨by omega, by omega, hx.2.1, hx.2.2⟩
    refine ⟨h.committed_le, ?_, h.one_inflight, by simpa using hin, h.pending_committed, ?_, ?_, ?_⟩
    · intro f hf
      exact ⟨(h.inflight_gt f hf).1, hinf f hf, (h.inflight_gt f hf).2.2⟩
    · intro c hc hvc hci
      simp only [List.mem_append, List.mem_singleton]
      by_cases h1 : c ≤ s.scanned
      · exact Or.inl (Or.inl (h.no_loss c hc hvc h1))
      · by_cases h2 : c = i
        · exact Or.inr h2
        · left; right
          simp only [gapIds, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq]
          exact ⟨mem_rng.mpr ⟨by omega, by simp at hci; omega⟩, hc, hvc⟩
    · rw [List.pairwise_append, List.pairwise_append]
      refine ⟨⟨h.out_sorted, (rng_pairwise _ _).filter _, ?_⟩, by simp, ?_⟩
      · intro a ha b hb
        have := (h.out_ok a ha).1; have := (hgap b hb).1; omega
      · intro a ha b hb
        simp at hb; subst hb
        simp only [List.mem_append] at ha
        rcases ha with ha | ha
        · have := (h.out_ok a ha).1; omega
        · exact (hgap a ha).2.1
    · intro x hx
      dsimp only at hx ⊢
      simp only [List.mem_append, List.mem_singleton] at hx
      rcases hx with (hx | hx) | hx
      · have := h.out_ok x hx; exact ⟨by omega, this.2⟩
      · have := hgap x hx; exact ⟨by omega, this.2.2⟩
      · subst hx; exact ⟨Nat.le_refl _, hi, hv⟩
  · simp only [hv, Bool.false_eq_true, ite_false]
    by_cases hs : i = s.scanned + 1
    · simp only [hs, ite_true]
      refine ⟨h.committed_le, ?_, h.one_inflight, by simp; omega, h.pending_committed, ?_,
        h.out_sorted, ?_⟩
      · intro f hf
        dsimp only at hf ⊢
        exact ⟨(h.inflight_gt f hf).1, by have := hinf f hf; omega, (h.inflight_gt f hf).2.2⟩
      · intro c hc hvc hci
        dsimp only at hc hci ⊢
        by_cases h1 : c ≤ s.scanned
        · exact h.no_loss c hc hvc h1
        · have : c = i := by omega
          subst this; simp_all
      · intro x hx
        dsimp only at hx ⊢
        have := h.out_ok x hx; exact ⟨by omega, this.2⟩
    · simp only [hs, ite_false]; exact h

theorem xstep_inv (vis : Nat → Bool) (s : XS) (h : XInv vis s) (e : XEv) :
    XInv vis (xstep true recvFixed vis s e) := by
  cases e with
  | alloc =>
    by_cases hnil : s.inflight = []
    · have e : xstep true recvFixed vis s .alloc =
          { s with next := s.next + 1, inflight := [s.next + 1] } := by
        simp [xstep, hnil]
      rw [e]
      refine ⟨fun c hc => by have := h.committed_le c hc; dsimp only; omega, ?_, by simp,
        by have := h.scanned_le; dsimp only; omega, h.pending_committed, h.no_loss, h.out_sorted,
        h.out_ok⟩
      intro f hf
      dsimp only at hf ⊢
      simp at hf; subst hf
      refine ⟨Nat.le_refl _, by have := h.scanned_le; omega, ?_⟩
      intro c hc; have := h.committed_le c hc; omega
    · have e : xstep true recvFixed vis s .alloc = s := by
        simp [xstep, hnil]
      rw [e]; exact h
  | commit i =>
    simp only [xstep]
    split
    · rename_i hi
      have hone := singleton_of_length_le_one h.one_inflight hi
      have hfil : s.inflight.filter (· ≠ i) = [] := by rw [hone]; simp
      have ⟨hin, hsc, _⟩ := h.inflight_gt i hi
      refine ⟨?_, ?_, ?_, h.scanned_le, ?_, ?_, h.out_sorted, ?_⟩
      · intro c hc; dsimp only at hc ⊢; simp at hc; rcases hc with hc | hc
        · exact h.committed_le c hc
        · omega
      · rw [hfil]; simp
      · rw [hfil]; simp
      · intro p hp; simp at hp ⊢; rcases hp with hp | hp
        · exact Or.inl (h.pending_committed p hp)
        · exact Or.inr hp
      · intro c hc hvc hcs; dsimp only at hc hcs ⊢; simp at hc; rcases hc with hc | hc
        · exact h.no_loss c hc hvc hcs
        · omega
      · intro x hx; have := h.out_ok x hx
        exact ⟨this.1, by simp [this.2.1], this.2.2⟩
    · exact h
  | rollback i =>
    simp only [xstep]
    split
    · refine ⟨h.committed_le, ?_, ?_, h.scanned_le, h.pending_committed, h.no_loss,
        h.out_sorted, h.out_ok⟩
      · intro f hf; exact h.inflight_gt f ((List.mem_filter.mp hf).1)
      · exact Nat.le_trans (List.length_filter_le _ _) h.one_inflight
    · exact h
  | recv i =>
    simp only [xstep]
    split
    · rename_i hi
      refine recvFixed_inv vis { s with pending := s.pending.filter (· ≠ i) } ?_ i
        (h.pending_committed i hi)
      exact ⟨h.committed_le, h.inflight_gt, h.one_inflight, h.scanned_le,
        fun p hp => h.pending_committed p ((List.mem_filter.mp hp).1), h.no_loss, h.out_sorted,
        h.out_ok⟩
    · exact h
  | drop i =>
    exact ⟨h.committed_le, h.inflight_gt, h.one_inflight, h.scanned_le,
      fun p hp => h.pending_committed p ((List.mem_filter.mp hp).1), h.no_loss, h.out_sorted,
      h.out_ok⟩

theorem xrun_inv (vis : Nat → Bool) (evs : List XEv) : XInv vis (xrun true recvFixed vis evs) := by
  suffices ∀ s, XInv vis s → XInv vis (evs.foldl (xstep true recvFixed vis) s) from
    this _ ⟨by simp [xinit], by simp [xinit], by simp [xinit], by simp [xinit], by simp [xinit],
      by simp [xinit], by simp [xinit], by simp [xinit]⟩
  induction evs with
  | nil => exact fun _ h => h
  | cons e es ih => exact fun s h => ih _ (xstep_inv vis s h e)

/-- **Fixed**: under every schedule of allocations, commits, rollbacks, and
reordered or lost publishes, the frames are strictly increasing, are all
committed ids the session may see, and never skip one: every committed
visible id at or below the client's cursor (the last frame) was sent. -/
theorem cross_process_never_skips (vis : Nat → Bool) (evs : List XEv) :
    let s := xrun true recvFixed vis evs
    s.out.Pairwise (· < ·) ∧
    (∀ x ∈ s.out, x ∈ s.committed ∧ vis x = true) ∧
    ∀ last, s.out.getLast? = some last →
      ∀ c ∈ s.committed, vis c = true → c ≤ last → c ∈ s.out := by
  have h := xrun_inv vis evs
  refine ⟨h.out_sorted, fun x hx => (h.out_ok x hx).2, ?_⟩
  intro last hl c hc hv hcl
  have := (h.out_ok last (List.mem_of_getLast? hl)).1
  exact h.no_loss c hc hv (by omega)

/-- Liveness per notification: once a visible id's own publish is received,
it has been delivered. -/
theorem cross_process_recv_delivers (vis : Nat → Bool) (evs : List XEv) (i : Nat)
    (hp : i ∈ (xrun true recvFixed vis evs).pending) (hv : vis i = true) :
    i ∈ (xstep true recvFixed vis (xrun true recvFixed vis evs) (.recv i)).out := by
  have h := xrun_inv vis evs
  have hc := h.pending_committed i hp
  simp only [xstep, hp, ite_true, recvFixed]
  split
  · exact h.no_loss i hc hv (by assumption)
  · simp

/-! ## 10. BUG (fixed): stale cursor once retention empties `sync_actions`

`getEarliestSyncId` returned 0 for an empty table and `isSyncCursorStale`
treats 0 as "nothing retained, nothing missed". After retention deletes every
row, a client with an old cursor was told it was current and silently missed
the pruned actions. Fix: on an empty table the floor is one above the id
sequence's high-water mark (`pg_sequence_last_value`); every id at or below it
may have been committed and pruned. Retention prunes a prefix: the retained
rows are the committed ids above some `p`. `hw` bounds every allocated id. -/

def earliestBuggy (retained : List Nat) (_hw : Nat) : Nat := retained.head?.getD 0

def earliestFixed (retained : List Nat) (hw : Nat) : Nat :=
  match retained.head? with
  | some e => e
  | none => if hw = 0 then 0 else hw + 1

theorem bug_stale_empty_table_misses_pruned :
    let committed := [1, 2, 3]
    let retained := committed.filter (fun c => decide (3 < c))
    retained = [] ∧ isSyncCursorStale 1 (earliestBuggy retained 3) = false ∧
      (2 ∈ committed ∧ 2 ∉ retained ∧ 1 < 2) := by decide

/-- **Fixed**: whenever an id the client has not applied was pruned, the
cursor is reported stale — with rows retained or not. -/
theorem stale_fixed_sound (committed : List Nat) (hw p after : Nat)
    (hhw : ∀ c ∈ committed, c ≤ hw) (ha : 0 < after)
    (c : Nat) (hc : c ∈ committed) (hpruned : c ≤ p) (hafter : after < c) :
    isSyncCursorStale after (earliestFixed (committed.filter (fun x => decide (p < x))) hw)
      = true := by
  have hchw := hhw c hc
  unfold earliestFixed
  split
  · rename_i e he
    have hmem : e ∈ committed.filter (fun x => decide (p < x)) := List.mem_of_head? he
    have hpe : p < e := by simpa using (List.mem_filter.mp hmem).2
    simp [isSyncCursorStale]; omega
  · have : hw ≠ 0 := by omega
    simp [isSyncCursorStale, this]; omega

/-- A client level with the high-water mark is not sent to bootstrap. -/
theorem stale_fixed_level_is_live (hw : Nat) :
    isSyncCursorStale hw (earliestFixed [] hw) = false := by
  by_cases h : hw = 0
  · simp [earliestFixed, isSyncCursorStale, h]
  · simp [earliestFixed, isSyncCursorStale, h]

/-! ## 11. BUG (fixed): composite keyset pagination with NULLs

`CompositeCursorStrategy` keyset condition was the OR-of-ANDs of SQL `>`/`=`.
Its fields are arbitrary configured columns (not necessarily the NOT NULL
primary key), e.g. `["listId", "sortOrder", "id"]` with a nullable
`sortOrder`. Rows sort `ASC` = `NULLS LAST`, but `NULL > v` and `NULL = v` are
UNKNOWN, so the row after a page boundary whose next field is NULL was
excluded; and a boundary row with a NULL field stopped paging outright.

Fix: order `ASC NULLS LAST` explicitly, compare with `col > v OR col IS NULL`
(nothing sorts after a NULL cursor value) and `IS NOT DISTINCT FROM`, keep
NULLs in the cursor, and match nothing after an all-NULL cursor.
Precondition (for any keyset pagination): the field tuple is unique, NULLs
equal — here: every snapshot is strictly sorted by the key order.

First a generic keyset theorem for any strict total key order (§7 is the
`Nat` instance), then the two-column NULLS LAST instance. -/

section Keyset
variable {α : Type}

structure KPg (α : Type) where
  cursor : Option α
  emitted : List α
  done : Bool

def kAfter (lt : α → α → Bool) : Option α → α → Bool
  | none, _ => true
  | some c, x => lt c x

def kPage (lt : α → α → Bool) (k : Nat) (c : Option α) (snap : List α) : List α :=
  (snap.filter (kAfter lt c)).take k

def kStep (lt : α → α → Bool) (k : Nat) (s : KPg α) (snap : List α) : KPg α :=
  if s.done then s else
    let p := kPage lt k s.cursor snap
    { cursor := match p.getLast? with
        | some z => some z
        | none => s.cursor,
      emitted := s.emitted ++ p,
      done := decide (p.length < k) }

/-- A strict total order on keys: what `ORDER BY` sorts by. -/
structure StrictTotal (lt : α → α → Bool) : Prop where
  irrefl : ∀ a, lt a a = false
  trans : ∀ a b c, lt a b = true → lt b c = true → lt a c = true
  total : ∀ a b, a ≠ b → lt a b = true ∨ lt b a = true

theorem StrictTotal.asymm {lt : α → α → Bool} (o : StrictTotal lt) (a b : α)
    (h : lt a b = true) : lt b a = false := by
  cases hb : lt b a
  · rfl
  · have := o.trans a b a h hb; rw [o.irrefl] at this; exact absurd this (by decide)

/-- Not after the cursor means at or before it. -/
theorem StrictTotal.le_of_not_after {lt : α → α → Bool} (o : StrictTotal lt) (c e : α)
    (h : lt c e = false) : e = c ∨ lt e c = true := by
  by_cases hec : e = c
  · exact Or.inl hec
  · rcases o.total e c hec with h' | h'
    · exact Or.inr h'
    · rw [h] at h'; exact absurd h' (by decide)

theorem pairwise_last {lt : α → α → Bool} {l : List α} {z : α}
    (hs : l.Pairwise (fun a b => lt a b = true)) (hz : l.getLast? = some z) :
    ∀ y ∈ l, y = z ∨ lt y z = true := by
  obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hz
  rw [List.pairwise_append] at hs
  intro y hy
  simp only [List.mem_append, List.mem_singleton] at hy
  rcases hy with hy | hy
  · exact Or.inr (hs.2.2 y hy z (by simp))
  · exact Or.inl hy

theorem not_mem_take_after {lt : α → α → Bool} {l : List α}
    (hs : l.Pairwise (fun a b => lt a b = true)) (k : Nat) (x : α)
    (hx : x ∈ l) (hn : x ∉ l.take k) : ∀ y ∈ l.take k, lt y x = true := by
  have hsplit := List.take_append_drop k l
  rw [← hsplit] at hs hx
  rw [List.pairwise_append] at hs
  rw [List.mem_append] at hx
  rcases hx with hx | hx
  · exact absurd hx hn
  · intro y hy; exact hs.2.2 y hy x hx

def KInv (lt : α → α → Bool) (stable : List α) (s : KPg α) : Prop :=
  s.emitted.Pairwise (fun a b => lt a b = true) ∧
  (∀ e ∈ s.emitted, kAfter lt s.cursor e = false) ∧
  (∀ x ∈ stable, kAfter lt s.cursor x = false → x ∈ s.emitted) ∧
  (s.done = true → ∀ x ∈ stable, x ∈ s.emitted)

theorem kStep_inv {lt : α → α → Bool} (o : StrictTotal lt) (k : Nat) (stable : List α)
    (s : KPg α) (snap : List α)
    (hs : snap.Pairwise (fun a b => lt a b = true)) (hst : ∀ x ∈ stable, x ∈ snap)
    (h : KInv lt stable s) : KInv lt stable (kStep lt k s snap) := by
  unfold kStep
  split
  · exact h
  obtain ⟨h1, h2, h3, _⟩ := h
  have hfs : (snap.filter (kAfter lt s.cursor)).Pairwise (fun a b => lt a b = true) :=
    hs.filter _
  have hps : (kPage lt k s.cursor snap).Pairwise (fun a b => lt a b = true) :=
    hfs.sublist (List.take_sublist _ _)
  have hpa : ∀ y ∈ kPage lt k s.cursor snap, kAfter lt s.cursor y = true := by
    intro y hy
    exact (List.mem_filter.mp ((List.take_sublist _ _).subset hy)).2
  -- everything already emitted sorts before every page row
  have hcross : ∀ e ∈ s.emitted, ∀ y ∈ kPage lt k s.cursor snap, lt e y = true := by
    intro e he y hy
    have hce := h2 e he
    have hcy := hpa y hy
    cases hc : s.cursor with
    | none => rw [hc] at hce; simp [kAfter] at hce
    | some c =>
      rw [hc] at hce hcy; simp only [kAfter] at hce hcy
      rcases o.le_of_not_after c e hce with rfl | hec
      · exact hcy
      · exact o.trans _ _ _ hec hcy
  refine ⟨?_, ?_, ?_, ?_⟩
  · simp only
    rw [List.pairwise_append]
    exact ⟨h1, hps, hcross⟩
  · intro e he
    simp only [List.mem_append] at he
    dsimp only
    split
    · rename_i z hz
      have hzl := pairwise_last hps hz
      have hzm : z ∈ kPage lt k s.cursor snap := List.mem_of_getLast? hz
      simp only [kAfter]
      rcases he with he | he
      · exact o.asymm _ _ (hcross e he z hzm)
      · rcases hzl e he with rfl | hez
        · exact o.irrefl e
        · exact o.asymm _ _ hez
    · rename_i hz
      rcases he with he | he
      · exact h2 e he
      · have : kPage lt k s.cursor snap = [] := List.getLast?_eq_none_iff.mp hz
        rw [this] at he; simp at he
  · intro x hx hna
    simp only [List.mem_append]
    cases hxa : kAfter lt s.cursor x with
    | false => exact Or.inl (h3 x hx hxa)
    | true =>
      right
      by_cases hin : x ∈ kPage lt k s.cursor snap
      · exact hin
      · exfalso
        have hxf : x ∈ snap.filter (kAfter lt s.cursor) := List.mem_filter.mpr ⟨hst x hx, hxa⟩
        have hbefore := not_mem_take_after hfs k x hxf hin
        revert hna
        dsimp only
        split
        · rename_i z hz
          simp only [kAfter]
          rw [hbefore z (List.mem_of_getLast? hz)]; simp
        · rw [hxa]; simp
  · intro hdone x hx
    simp only [decide_eq_true_eq] at hdone
    simp only [List.mem_append]
    cases hxa : kAfter lt s.cursor x with
    | false => exact Or.inl (h3 x hx hxa)
    | true =>
      right
      have hlen : (snap.filter (kAfter lt s.cursor)).length < k := by
        have := @List.length_take _ k (snap.filter (kAfter lt s.cursor))
        unfold kPage at hdone; omega
      unfold kPage
      rw [List.take_of_length_le (by omega)]
      exact List.mem_filter.mpr ⟨hst x hx, hxa⟩

/-- **Keyset pagination is exact for any strict total key order**, under
arbitrary inserts/deletes between pages: emitted keys strictly increase, and
once paging stops every key present throughout was emitted. -/
theorem keyset_exact {lt : α → α → Bool} (o : StrictTotal lt) (k : Nat) (stable : List α) :
    ∀ (snaps : List (List α)), (∀ snap ∈ snaps, snap.Pairwise (fun a b => lt a b = true)) →
    (∀ snap ∈ snaps, ∀ x ∈ stable, x ∈ snap) →
    ∀ s, KInv lt stable s → KInv lt stable (snaps.foldl (kStep lt k) s)
  | [], _, _, _, h => h
  | snap :: rest, hs, hst, s, h => by
    apply keyset_exact o k stable rest (fun x hx => hs x (by simp [hx]))
      (fun x hx => hst x (by simp [hx]))
    exact kStep_inv o k stable s snap (hs snap (by simp)) (hst snap (by simp)) h

theorem keyset_run {lt : α → α → Bool} (o : StrictTotal lt) (k : Nat) (stable : List α)
    (snaps : List (List α)) (hs : ∀ snap ∈ snaps, snap.Pairwise (fun a b => lt a b = true))
    (hst : ∀ snap ∈ snaps, ∀ x ∈ stable, x ∈ snap) :
    let r := snaps.foldl (kStep lt k) ⟨none, [], false⟩
    r.emitted.Pairwise (fun a b => lt a b = true) ∧ (r.done = true → ∀ x ∈ stable, x ∈ r.emitted) := by
  have := keyset_exact o k stable snaps hs hst ⟨none, [], false⟩
    ⟨by simp, by simp, fun x _ h => by simp [kAfter] at h, by simp⟩
  exact ⟨this.1, this.2.2.2⟩

end Keyset

/-! Composite keys `(listId, sortOrder)` where `sortOrder` is nullable. -/

abbrev Key := Option Nat × Option Nat

/-- `ASC NULLS LAST` on one column. -/
def optLt : Option Nat → Option Nat → Bool
  | some a, some b => decide (a < b)
  | some _, none => true
  | none, _ => false

/-- The `ORDER BY a ASC NULLS LAST, b ASC NULLS LAST` order. -/
def keyLt (a b : Key) : Bool := optLt a.1 b.1 || (a.1 == b.1 && optLt a.2 b.2)

theorem optLt_irrefl (a : Option Nat) : optLt a a = false := by
  cases a <;> simp [optLt]

theorem optLt_trans (a b c : Option Nat) : optLt a b = true → optLt b c = true → optLt a c = true := by
  cases a <;> cases b <;> cases c <;> simp [optLt] <;> omega

theorem optLt_total (a b : Option Nat) (h : a ≠ b) : optLt a b = true ∨ optLt b a = true := by
  cases a <;> cases b <;> simp_all [optLt] <;> omega

theorem keyLt_strictTotal : StrictTotal keyLt where
  irrefl a := by simp [keyLt, optLt_irrefl]
  trans a b c hab hbc := by
    simp only [keyLt, Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq] at *
    rcases hab with hab | ⟨e1, hab⟩ <;> rcases hbc with hbc | ⟨e2, hbc⟩
    · exact Or.inl (optLt_trans _ _ _ hab hbc)
    · rw [e2] at hab; exact Or.inl hab
    · rw [e1]; exact Or.inl hbc
    · exact Or.inr ⟨e1.trans e2, optLt_trans _ _ _ hab hbc⟩
  total a b h := by
    simp only [keyLt, Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq]
    by_cases h1 : a.1 = b.1
    · have h2 : a.2 ≠ b.2 := fun h2 => h (Prod.ext h1 h2)
      rcases optLt_total _ _ h2 with h3 | h3
      · exact Or.inl (Or.inr ⟨h1, h3⟩)
      · exact Or.inr (Or.inr ⟨h1.symm, h3⟩)
    · rcases optLt_total _ _ h1 with h3 | h3
      · exact Or.inl (Or.inl h3)
      · exact Or.inr (Or.inl h3)

/-- Fixed SQL, per field: `col > v OR col IS NULL` (nothing is after a NULL
cursor value), and `IS NOT DISTINCT FROM` for the equal prefix. -/
def sqlAfterNullSafe : Option Nat → Option Nat → Bool
  | none, _ => false
  | some v, some c => decide (v < c)
  | some _, none => true

def whereFixed (cur row : Key) : Bool :=
  sqlAfterNullSafe cur.1 row.1 || (cur.1 == row.1 && sqlAfterNullSafe cur.2 row.2)

/-- The fixed keyset condition is exactly "sorts after the cursor". -/
theorem whereFixed_eq_keyLt (cur row : Key) : whereFixed cur row = keyLt cur row := by
  obtain ⟨a, b⟩ := cur; obtain ⟨c, d⟩ := row
  cases a <;> cases b <;> cases c <;> cases d <;> rfl

/-- Old SQL: three-valued `>`/`=` (UNKNOWN on NULL filters the row out), a NULL
cursor value drops its branch *and* its prefix term, no branch means no
condition, and a boundary row with a NULL field stops paging. -/
def sqlGt (v : Nat) : Option Nat → Bool
  | some c => decide (v < c)
  | none => false

def whereBuggy (cur row : Key) : Bool :=
  let b0 : List Bool := match cur.1 with
    | some v => [sqlGt v row.1]
    | none => []
  let b1 : List Bool := match cur.2 with
    | some v => [(match cur.1 with | some u => row.1 == some u | none => true) && sqlGt v row.2]
    | none => []
  let bs := b0 ++ b1
  bs.isEmpty || bs.any id

structure BPg where
  cursor : Option Key
  emitted : List Key
  done : Bool
  deriving Repr

def bStep (k : Nat) (s : BPg) (snap : List Key) : BPg :=
  if s.done then s else
    let p := (snap.filter (fun r => match s.cursor with
      | none => true
      | some c => whereBuggy c r)).take k
    let stopOnNull := match p.getLast? with
      | some (some _, some _) => false
      | some _ => true
      | none => false
    { cursor := p.getLast?.or s.cursor,
      emitted := s.emitted ++ p,
      done := decide (p.length < k) || stopOnNull }

def tbl1 : List Key := [(some 1, some 1), (some 1, none), (some 2, some 1)]
def tbl2 : List Key := [(some 1, none), (some 2, some 1)]

/-- A NULL in a later field just past a page boundary is skipped. -/
theorem bug_composite_null_skipped_at_boundary :
    ([tbl1, tbl1, tbl1, tbl1].foldl (bStep 1) ⟨none, [], false⟩).emitted =
      [(some 1, some 1), (some 2, some 1)] := by decide

/-- A NULL in the boundary row stops paging and truncates the model. -/
theorem bug_composite_null_boundary_stops :
    let r := [tbl2, tbl2, tbl2].foldl (bStep 1) ⟨none, [], false⟩
    r.done = true ∧ r.emitted = [(some 1, none)] := by decide

theorem composite_fixed_examples :
    ([tbl1, tbl1, tbl1, tbl1].foldl (kStep keyLt 1) ⟨none, [], false⟩).emitted = tbl1 ∧
    ([tbl2, tbl2, tbl2].foldl (kStep keyLt 1) ⟨none, [], false⟩).emitted = tbl2 := by decide

/-- **Fixed**: NULL-safe composite keyset pagination (sorted `ASC NULLS LAST`,
keys unique) never repeats a key and, once it stops, has emitted every key
present throughout. -/
theorem composite_keyset_exact (k : Nat) (stable : List Key) (snaps : List (List Key))
    (hs : ∀ snap ∈ snaps, snap.Pairwise (fun a b => keyLt a b = true))
    (hst : ∀ snap ∈ snaps, ∀ x ∈ stable, x ∈ snap) :
    let r := snaps.foldl (kStep whereFixed k) ⟨none, [], false⟩
    r.emitted.Pairwise (fun a b => keyLt a b = true) ∧
      (r.done = true → ∀ x ∈ stable, x ∈ r.emitted) := by
  have e : whereFixed = keyLt := funext fun a => funext fun b => whereFixed_eq_keyLt a b
  rw [e]
  exact keyset_run keyLt_strictTotal k stable snaps hs hst

end StrataSync.Server
