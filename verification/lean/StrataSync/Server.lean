/-
  Server-side sync: a model of

    packages/server/src/utils/async-mutex.ts            (AsyncMutex)
    packages/server/src/websocket/client-session.ts     (sendDeltaAction, onLiveDelta,
                                                         flushBufferedActions, G narrowing)
    packages/server/src/websocket/sync-websocket.ts     (handleSubscribe ordering)
    packages/server/src/websocket/replay.ts             (replaySyncActions paging)
    packages/server/src/mutate/mutate-service.ts        (processTransaction: commit → publish,
                                                         clientTxId dedup)
    packages/server/src/dao/sync-dao.ts                 (insert-order advisory lock)
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
Redis pub/sub, two publishers can still interleave out of id order; that
residual race is outside this model. -/

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

end StrataSync.Server
