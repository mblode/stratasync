/-
  Client outbox: a model of

    packages/client/src/outbox-manager.ts   (queueTransaction, flushBatch,
      dispatchBatch/sendQueue, sendBatch, handleTransportFailure,
      processPendingTransactions, seedBatchIndex)
    packages/server/src/mutate/mutate-service.ts (dedup by clientTxId; only
      the contract the client relies on)

  Transactions are named by their `batchIndex`, which `queueTransaction`
  stamps from a strictly increasing counter, so "queue order" is `<` on ids
  and the queue after `n` mutations is `List.range n`.

  Every `await` in the TypeScript is a point where another task can run, so
  each model is a state machine whose steps are the atomic segments between
  awaits; an arbitrary `List Step` is an arbitrary interleaving (the batch
  timer, a reconnect drain, and new mutations all racing).

  Sections
    1. `seedBatchIndex`: a fresh runtime never re-issues an index at or below
       one already persisted.
    2. Ordered delivery across transient transport failures.
       BUG (fixed): a later mutation overtook an earlier one whose REST call
       failed, until the next reconnect. Counterexample + corrected model.
    3. At most one send per transaction across a reconnect drain racing the
       batch timer.
       BUG (fixed): the drain re-read the persisted outbox and resent
       transactions that the in-memory batch (or an in-flight send) owned.
       Counterexample + corrected model.
    4. Server-side dedup makes any duplicate that remains (crash replay,
       cross-tab) harmless: what the server applies is the deduped log.
-/

namespace StrataSync.Outbox

/-! ## 1. `seedBatchIndex`

```
for (const tx of persisted)
  if (tx.batchIndex !== undefined && tx.batchIndex >= this.nextBatchIndex)
    this.nextBatchIndex = tx.batchIndex + 1;
```
-/

def seedStep (n : Nat) : Option Nat → Nat
  | some i => if i ≥ n then i + 1 else n
  | none => n

def seed (next : Nat) (persisted : List (Option Nat)) : Nat :=
  persisted.foldl seedStep next

theorem seedStep_ge (n : Nat) (b : Option Nat) : n ≤ seedStep n b := by
  cases b with
  | none => simp [seedStep]
  | some i => simp only [seedStep]; split <;> omega

theorem seed_ge (next : Nat) (ps : List (Option Nat)) : next ≤ seed next ps := by
  induction ps generalizing next with
  | nil => simp [seed]
  | cons b ps ih =>
    simp only [seed, List.foldl_cons]
    exact Nat.le_trans (seedStep_ge next b) (ih _)

/-- Every persisted index is strictly below the seeded counter, so the next
    stamped transaction sorts after everything already in the outbox. -/
theorem seed_gt (next : Nat) (ps : List (Option Nat)) (i : Nat)
    (h : some i ∈ ps) : i < seed next ps := by
  induction ps generalizing next with
  | nil => simp at h
  | cons b ps ih =>
    simp only [seed, List.foldl_cons]
    rcases List.mem_cons.mp h with h | h
    · subst h
      have : i < seedStep next (some i) := by simp only [seedStep]; split <;> omega
      exact Nat.lt_of_lt_of_le this (seed_ge _ _)
    · exact ih _ h

/-- Seeding is monotone: it never lowers the counter a runtime already used. -/
theorem seed_monotone (next : Nat) (ps : List (Option Nat)) :
    next ≤ seed next ps := seed_ge next ps

/-! ## 2. Ordered delivery across transient transport failures

What the server sees is the log `delivered` of successfully sent
transactions. The invariant the per-model semantics rely on (`update X`
must not reach the server before `create X`; the server rejects it as
"not found" and the client rolls it back) is that the successful deliveries
respect queue order: `delivered` is a prefix of the queue.

Steps (sends are serialized by `sendQueue`, so one send is one step):
* `enqueue`   `queueTransaction`: persist, push onto `pendingBatch`.
* `flushOk`   batch timer / `flush()` sends the pending batch; server acks.
* `flushFail` same, but `transport.mutate` throws (timeout, 5xx).
              `handleTransportFailure` requeues the batch in storage.
* `replay`    `processPendingTransactions` on reconnect: resend what is
              queued in storage, in outbox order.
-/

inductive OStep
  | enqueue
  | flushOk
  | flushFail
  | replay
  deriving DecidableEq, Repr

/-- `Ordered d`: the delivered log is exactly the first `d.length` queued
    transactions, in order. -/
def Ordered (d : List Nat) : Prop := d = List.range d.length

instance (d : List Nat) : Decidable (Ordered d) := by
  unfold Ordered; infer_instance

/-! ### 2a. Original code -/

structure OrigO where
  next : Nat
  pending : List Nat
  /-- requeued in storage by `handleTransportFailure`, only resent on replay -/
  stranded : List Nat
  delivered : List Nat
  deriving DecidableEq, Repr

def OrigO.init : OrigO := ⟨0, [], [], []⟩

def OrigO.step (s : OrigO) : OStep → OrigO
  | .enqueue => { s with next := s.next + 1, pending := s.pending ++ [s.next] }
  -- `sendBatch(transactions)` sends exactly the batch it was given.
  | .flushOk => { s with pending := [], delivered := s.delivered ++ s.pending }
  | .flushFail => { s with pending := [], stranded := s.stranded ++ s.pending }
  | .replay => { s with stranded := [], delivered := s.delivered ++ s.stranded }

def OrigO.run (steps : List OStep) : OrigO := steps.foldl OrigO.step OrigO.init

/-- create X (id 0) times out; update X (id 1) is sent on the next timer tick
    while the socket stays up, so no reconnect replay happens in between. -/
def bugOrderTrace : List OStep := [.enqueue, .flushFail, .enqueue, .flushOk]

theorem bug_order_trace_delivers : (OrigO.run bugOrderTrace).delivered = [1] := by
  decide

/-- The original outbox violates ordered delivery. -/
theorem bug_ordered_delivery :
    ¬ ∀ steps, Ordered (OrigO.run steps).delivered :=
  fun h => absurd (h bugOrderTrace) (by decide)

/-! ### 2b. Fixed code: the retry backlog

`handleTransportFailure` records the failed batch in `retryBacklog`;
`sendBatch` prepends it (`takeRetryBacklog`); `replayPersisted` clears it and
sends the unclaimed queued rows in outbox order. -/

structure FixO where
  next : Nat
  pending : List Nat
  backlog : List Nat
  delivered : List Nat
  deriving DecidableEq, Repr

def FixO.init : FixO := ⟨0, [], [], []⟩

/-- What `replayPersisted` reads: queued rows (not yet delivered) that no
    in-memory sender claims (claimed = `pendingBatch`). -/
def FixO.replaySet (s : FixO) : List Nat :=
  (List.range s.next).filter (fun i => !(s.delivered.contains i) && !(s.pending.contains i))

def FixO.step (s : FixO) : OStep → FixO
  | .enqueue => { s with next := s.next + 1, pending := s.pending ++ [s.next] }
  | .flushOk =>
    { s with pending := [], backlog := [], delivered := s.delivered ++ (s.backlog ++ s.pending) }
  | .flushFail => { s with pending := [], backlog := s.backlog ++ s.pending }
  | .replay => { s with backlog := [], delivered := s.delivered ++ s.replaySet }

def FixO.run (steps : List OStep) : FixO := steps.foldl FixO.step FixO.init

/-- The queue is partitioned, in order, into delivered ++ owed ++ pending. -/
def FixO.Inv (s : FixO) : Prop := s.delivered ++ s.backlog ++ s.pending = List.range s.next

theorem ordered_of_prefix {l r : List Nat} {n : Nat} (h : l ++ r = List.range n) :
    Ordered l := by
  have hlen : l.length ≤ n := by
    have := congrArg List.length h
    simp at this; omega
  have := congrArg (List.take l.length) h
  rw [List.take_left' rfl, List.take_range, Nat.min_eq_left hlen] at this
  exact this

/-- On a partition of the queue, the replay read is exactly the backlog. -/
theorem FixO.replaySet_eq (s : FixO) (h : s.Inv) : s.replaySet = s.backlog := by
  have hnd : (s.delivered ++ s.backlog ++ s.pending).Nodup := h ▸ List.nodup_range
  rw [List.nodup_append, List.nodup_append] at hnd
  obtain ⟨⟨_, _, hdb⟩, _, hdp⟩ := hnd
  unfold FixO.replaySet
  rw [← h, List.filter_append, List.filter_append]
  have h1 : (s.delivered.filter fun i => !(s.delivered.contains i) && !(s.pending.contains i)) = [] := by
    rw [List.filter_eq_nil_iff]; intro a ha; simp [ha]
  have h2 : (s.backlog.filter fun i => !(s.delivered.contains i) && !(s.pending.contains i)) = s.backlog := by
    rw [List.filter_eq_self]; intro a ha
    have hd : a ∉ s.delivered := fun hm => hdb a hm a ha rfl
    have hp : a ∉ s.pending := fun hm => hdp a (List.mem_append_right _ ha) a hm rfl
    simp [hd, hp]
  have h3 : (s.pending.filter fun i => !(s.delivered.contains i) && !(s.pending.contains i)) = [] := by
    rw [List.filter_eq_nil_iff]; intro a ha; simp [ha]
  rw [h1, h2, h3]; simp

theorem FixO.inv_step (s : FixO) (st : OStep) (h : s.Inv) : (s.step st).Inv := by
  cases st with
  | enqueue =>
    simp only [FixO.Inv, FixO.step] at *
    rw [List.range_succ, ← h]; simp
  | flushOk =>
    simp only [FixO.Inv, FixO.step] at *
    rw [← h]; simp
  | flushFail =>
    simp only [FixO.Inv, FixO.step] at *
    rw [← h]; simp
  | replay =>
    have hr := FixO.replaySet_eq s h
    simp only [FixO.Inv, FixO.step] at *
    rw [hr, ← h]; simp

theorem FixO.inv_run (steps : List OStep) : (FixO.run steps).Inv := by
  unfold FixO.run
  suffices ∀ s : FixO, s.Inv → (steps.foldl FixO.step s).Inv from
    this _ (by simp [FixO.Inv, FixO.init])
  induction steps with
  | nil => intro s h; exact h
  | cons st rest ih => intro s h; exact ih _ (FixO.inv_step s st h)

/-- Fixed outbox: under every interleaving of mutations, timer flushes,
    transient transport failures and reconnect replays, the server receives
    successful deliveries in queue order. -/
theorem fixed_ordered_delivery (steps : List OStep) :
    Ordered (FixO.run steps).delivered := by
  have h := FixO.inv_run steps
  unfold FixO.Inv at h
  rw [List.append_assoc] at h
  exact ordered_of_prefix h

/-- Per-model consequence: if `create X` (id `c`) precedes `update X` (id `u`)
    in the queue and the update was delivered, the create was delivered at an
    earlier position of the server log. -/
theorem fixed_create_before_update (steps : List OStep) (c u : Nat) (hcu : c < u)
    (hu : u ∈ (FixO.run steps).delivered) :
    (FixO.run steps).delivered[c]? = some c ∧ (FixO.run steps).delivered[u]? = some u := by
  have h := fixed_ordered_delivery steps
  generalize (FixO.run steps).delivered = d at *
  unfold Ordered at h
  rw [h] at hu ⊢
  simp only [List.mem_range] at hu
  simp [show c < d.length by omega, hu]

/-! ## 3. At most one send per transaction: reconnect drain vs. batch timer

Server log `sends`: every `transport.mutate` payload, concatenated.

Original `doProcessPending`:
```
await this.flushPendingBatchNow();     // dispatch pendingBatch, wait for it
await this.waitForInflightSends();
const pending = await this.storage.getOutbox();          // (read)
... reset "sent" -> "queued" ...; for batches: dispatchBatch  // (send)
```
Between the read and the send, and between the flush and the read, the batch
timer can fire and mutations can be queued. Steps:
* `enqueue`   persist as queued, push to `pendingBatch`
* `dispatch`  batch timer / `flushPendingBatchNow`: `pendingBatch` becomes a
              job on `sendQueue`
* `runBatch`  head job's `mutate` runs and is acked
* `drainRead` the drain reads storage: every row not yet acked
* `drainSend` the drain dispatches what it read
-/

inductive DStep
  | enqueue
  | dispatch
  | runBatch
  | drainRead
  | drainSend
  deriving DecidableEq, Repr

structure OrigD where
  next : Nat
  pending : List Nat
  jobs : List (List Nat)
  sends : List Nat
  snap : Option (List Nat)
  deriving DecidableEq, Repr

def OrigD.init : OrigD := ⟨0, [], [], [], none⟩

def OrigD.step (s : OrigD) : DStep → OrigD
  | .enqueue => { s with next := s.next + 1, pending := s.pending ++ [s.next] }
  | .dispatch => { s with pending := [], jobs := s.jobs ++ [s.pending] }
  | .runBatch =>
    match s.jobs with
    | [] => s
    | b :: rest => { s with jobs := rest, sends := s.sends ++ b }
  | .drainRead =>
    -- rows in state queued or sent: everything not yet acked
    { s with snap := some ((List.range s.next).filter (fun i => !(s.sends.contains i))) }
  | .drainSend =>
    match s.snap with
    | none => s
    | some l => { s with snap := none, jobs := s.jobs ++ [l] }

def OrigD.run (steps : List DStep) : OrigD := steps.foldl OrigD.step OrigD.init

/-- The TS regression test "does not resend a transaction still sitting in the
    pending batch while a reconnect drain runs": the drain flushes and waits
    for tx 0; tx 1 is queued meanwhile; the drain reads tx 1 as queued and
    sends it; then tx 1's batch timer sends it again. -/
def bugDoubleSendTrace : List DStep :=
  [.enqueue, .dispatch, .runBatch, .enqueue, .drainRead, .drainSend, .runBatch,
   .dispatch, .runBatch]

theorem bug_double_send_trace : (OrigD.run bugDoubleSendTrace).sends = [0, 1, 1] := by
  decide

theorem bug_at_most_once_send : ¬ ∀ steps, (OrigD.run steps).sends.Nodup :=
  fun h => absurd (h bugDoubleSendTrace) (by decide)

/-- Second counterexample (the in-flight variant, TS test "does not reset an
    in-flight transaction to queued and resend it during a drain"): the timer
    dispatches tx 1 after the drain's wait but before its read lands, so the
    drain reads the in-flight row ("sent") and resends it. -/
def bugInflightTrace : List DStep :=
  [.enqueue, .dispatch, .runBatch, .enqueue, .dispatch, .drainRead, .runBatch,
   .drainSend, .runBatch]

theorem bug_inflight_trace : (OrigD.run bugInflightTrace).sends = [0, 1, 1] := by
  decide

/-! ### 3b. Fixed code: claims + replay as a send-queue job

`claimedTxIds` holds every id in `pendingBatch` or in a dispatched job;
`processPendingTransactions` enqueues `replayPersisted` as a job on
`sendQueue`, which reads storage, skips claimed ids, and sends the rest before
yielding the queue. New mutations and timer dispatches may still interleave
with the replay's awaits (`enqueue`, `dispatch` are enabled at every step). -/

inductive Job
  | batch (ids : List Nat)
  | replay
  deriving DecidableEq, Repr

def Job.ids : Job → List Nat
  | .batch l => l
  | .replay => []

def jobIds (js : List Job) : List Nat := (js.map Job.ids).flatten

inductive FStep
  | enqueue
  | dispatch
  | queueReplay
  | runBatch
  | replayRead
  | replayFinish
  deriving DecidableEq, Repr

structure FixD where
  next : Nat
  pending : List Nat
  jobs : List Job
  sends : List Nat
  snap : Option (List Nat)
  deriving DecidableEq, Repr

def FixD.init : FixD := ⟨0, [], [], [], none⟩

/-- `claimedTxIds`: pending batch plus every dispatched, unsettled batch. -/
def FixD.claimed (s : FixD) : List Nat := jobIds s.jobs ++ s.pending

def FixD.step (s : FixD) : FStep → FixD
  | .enqueue => { s with next := s.next + 1, pending := s.pending ++ [s.next] }
  | .dispatch => { s with pending := [], jobs := s.jobs ++ [.batch s.pending] }
  | .queueReplay => { s with jobs := s.jobs ++ [.replay] }
  | .runBatch =>
    match s.jobs with
    | .batch b :: rest => { s with jobs := rest, sends := s.sends ++ b }
    | _ => s
  | .replayRead =>
    match s.jobs, s.snap with
    | .replay :: _, none =>
      { s with snap := some ((List.range s.next).filter
          (fun i => !(s.sends.contains i) && !(s.claimed.contains i))) }
    | _, _ => s
  | .replayFinish =>
    match s.jobs, s.snap with
    | .replay :: rest, some l => { s with jobs := rest, snap := none, sends := s.sends ++ l }
    | _, _ => s

def FixD.run (steps : List FStep) : FixD := steps.foldl FixD.step FixD.init

/-- Every id is owned by exactly one place: sent, being replayed, in a
    dispatched batch, or in the pending batch. -/
def FixD.owned (s : FixD) : List Nat := s.sends ++ s.snap.getD [] ++ jobIds s.jobs ++ s.pending

structure FixD.Inv (s : FixD) : Prop where
  nodup : s.owned.Nodup
  bound : ∀ i ∈ s.owned, i < s.next
  snapHead : s.snap ≠ none → ∃ rest, s.jobs = .replay :: rest

theorem jobIds_append (a b : List Job) : jobIds (a ++ b) = jobIds a ++ jobIds b := by
  simp [jobIds]

theorem jobIds_cons (j : Job) (js : List Job) : jobIds (j :: js) = j.ids ++ jobIds js := by
  simp [jobIds]

theorem FixD.inv_init : FixD.init.Inv :=
  ⟨by simp [FixD.owned, FixD.init, jobIds], by simp [FixD.owned, FixD.init, jobIds],
   by simp [FixD.init]⟩

theorem FixD.inv_step (s : FixD) (st : FStep) (h : s.Inv) : (s.step st).Inv := by
  obtain ⟨hnd, hb, hsh⟩ := h
  cases st with
  | enqueue =>
    refine ⟨?_, ?_, ?_⟩
    · simp only [FixD.owned, FixD.step] at *
      rw [← List.append_assoc, List.nodup_append]
      refine ⟨hnd, by simp, ?_⟩
      intro a ha b hb' hab
      simp at hb'; subst hb'; subst hab
      exact Nat.lt_irrefl _ (hb _ ha)
    · intro i hi
      simp only [FixD.owned, FixD.step] at *
      rw [← List.append_assoc, List.mem_append] at hi
      rcases hi with hi | hi
      · exact Nat.lt_succ_of_lt (hb i hi)
      · simp at hi; omega
    · simpa [FixD.step] using hsh
  | dispatch =>
    have ho : (s.step .dispatch).owned = s.owned := by
      simp [FixD.owned, FixD.step, jobIds, Job.ids]
    refine ⟨ho ▸ hnd, ho ▸ hb, ?_⟩
    intro hn
    obtain ⟨rest, hr⟩ := hsh (by simpa [FixD.step] using hn)
    exact ⟨rest ++ [.batch s.pending], by simp [FixD.step, hr]⟩
  | queueReplay =>
    have ho : (s.step .queueReplay).owned = s.owned := by
      simp [FixD.owned, FixD.step, jobIds, Job.ids]
    refine ⟨ho ▸ hnd, ho ▸ hb, ?_⟩
    intro hn
    obtain ⟨rest, hr⟩ := hsh (by simpa [FixD.step] using hn)
    exact ⟨rest ++ [.replay], by simp [FixD.step, hr]⟩
  | runBatch =>
    rcases hj : s.jobs with _ | ⟨j, rest⟩
    · have : s.step .runBatch = s := by simp [FixD.step, hj]
      rw [this]; exact ⟨hnd, hb, hsh⟩
    · cases j with
      | replay =>
        have : s.step .runBatch = s := by simp [FixD.step, hj]
        rw [this]; exact ⟨hnd, hb, hsh⟩
      | batch b =>
        have hsn : s.snap = none := by
          cases hs : s.snap with
          | none => rfl
          | some _ =>
            obtain ⟨r, hr⟩ := hsh (by simp [hs])
            rw [hj] at hr; cases hr
        have hst : s.step .runBatch = { s with jobs := rest, sends := s.sends ++ b } := by
          simp [FixD.step, hj]
        have ho : ({ s with jobs := rest, sends := s.sends ++ b } : FixD).owned = s.owned := by
          simp [FixD.owned, hj, hsn, jobIds_cons, Job.ids]
        rw [hst]
        refine ⟨ho ▸ hnd, fun i hi => hb i (ho ▸ hi), ?_⟩
        intro hn; exact absurd hsn (by simpa using hn)
  | replayRead =>
    by_cases hcase : ∃ rest, s.jobs = .replay :: rest ∧ s.snap = none
    · obtain ⟨rest, hj, hsn⟩ := hcase
      -- the snapshot: unsent, unclaimed, below `next`
      let F := (List.range s.next).filter
          (fun i => !(s.sends.contains i) && !(s.claimed.contains i))
      have hF : ∀ i ∈ F, i ∉ s.sends ∧ i ∉ s.claimed ∧ i < s.next := by
        intro i hi
        simp only [F, List.mem_filter, List.mem_range] at hi
        refine ⟨?_, ?_, hi.1⟩ <;> intro hm <;> simp_all
      have hFnd : F.Nodup := List.Nodup.sublist List.filter_sublist List.nodup_range
      have hold : s.owned = s.sends ++ s.claimed := by
        simp [FixD.owned, FixD.claimed, hsn]
      have hnew : ({ s with snap := some F } : FixD).owned = s.sends ++ F ++ s.claimed := by
        simp [FixD.owned, FixD.claimed]
      have hst : s.step .replayRead = { s with snap := some F } := by
        simp [FixD.step, hj, hsn, F]
      rw [hold, List.nodup_append] at hnd
      rw [hst]
      refine ⟨?_, ?_, ?_⟩
      · rw [hnew, List.nodup_append, List.nodup_append]
        refine ⟨⟨hnd.1, hFnd, ?_⟩, hnd.2.1, ?_⟩
        · intro a ha b hbF hab; subst hab; exact (hF a hbF).1 ha
        · intro a ha b hbc hab; subst hab
          rcases List.mem_append.mp ha with ha | ha
          · exact hnd.2.2 a ha a hbc rfl
          · exact (hF a ha).2.1 hbc
      · intro i hi
        rw [hnew] at hi
        rcases List.mem_append.mp hi with hi | hi
        · rcases List.mem_append.mp hi with hi | hi
          · exact hb i (by rw [hold]; exact List.mem_append_left _ hi)
          · exact (hF i hi).2.2
        · exact hb i (by rw [hold]; exact List.mem_append_right _ hi)
      · intro _; exact ⟨rest, hj⟩
    · have : s.step .replayRead = s := by
        simp only [FixD.step]
        split
        · rename_i rest hj hsn; exact absurd ⟨rest, hj, hsn⟩ hcase
        · rfl
      rw [this]; exact ⟨hnd, hb, hsh⟩
  | replayFinish =>
    by_cases hcase : ∃ rest l, s.jobs = .replay :: rest ∧ s.snap = some l
    · obtain ⟨rest, l, hj, hsn⟩ := hcase
      have hst : s.step .replayFinish = { s with jobs := rest, snap := none, sends := s.sends ++ l } := by
        simp [FixD.step, hj, hsn]
      have ho : ({ s with jobs := rest, snap := none, sends := s.sends ++ l } : FixD).owned
          = s.owned := by
        simp [FixD.owned, hj, hsn, jobIds_cons, Job.ids]
      rw [hst]
      refine ⟨ho ▸ hnd, fun i hi => hb i (ho ▸ hi), ?_⟩
      intro hn; exact absurd rfl hn
    · have : s.step .replayFinish = s := by
        simp only [FixD.step]
        split
        · rename_i rest l hj hsn; exact absurd ⟨rest, l, hj, hsn⟩ hcase
        · rfl
      rw [this]; exact ⟨hnd, hb, hsh⟩

theorem FixD.inv_run (steps : List FStep) : (FixD.run steps).Inv := by
  unfold FixD.run
  suffices ∀ s : FixD, s.Inv → (steps.foldl FixD.step s).Inv from this _ FixD.inv_init
  induction steps with
  | nil => intro s h; exact h
  | cons st rest ih => intro s h; exact ih _ (FixD.inv_step s st h)

/-- Fixed outbox: under every interleaving of mutations, batch-timer
    dispatches and reconnect drains, no transaction is sent twice. -/
theorem fixed_at_most_once_send (steps : List FStep) : (FixD.run steps).sends.Nodup := by
  have h := (FixD.inv_run steps).nodup
  unfold FixD.owned at h
  rw [List.append_assoc, List.append_assoc, List.nodup_append] at h
  exact h.1

/-- Every id the fixed outbox holds or has sent was actually queued (no
    invented ids). Section 3 models only acked sends; transport failures and
    their ordering are Section 2. -/
theorem fixed_owned_bound (steps : List FStep) :
    ∀ i ∈ (FixD.run steps).owned, i < (FixD.run steps).next :=
  (FixD.inv_run steps).bound

/-! ## 4. Server dedup (the contract for remaining duplicates)

`MutateService.processTransaction` looks up `(clientId, clientTxId)` first and
answers a duplicate with the original sync id without re-applying it. The
client relies on this for the duplicates it cannot avoid: a crash between
`mutate` and persisting the ack (the row is still "sent", reset to "queued"
and replayed) and two tabs draining one shared IndexedDB outbox. -/

/-- Apply a delivery log with dedup: the ids actually applied, in order. -/
def applyDedup : List Nat → List Nat → List Nat
  | applied, [] => applied
  | applied, i :: rest =>
    if applied.contains i then applyDedup applied rest else applyDedup (applied ++ [i]) rest

theorem applyDedup_nodup (applied log : List Nat) (h : applied.Nodup) :
    (applyDedup applied log).Nodup := by
  induction log generalizing applied with
  | nil => exact h
  | cons i rest ih =>
    unfold applyDedup
    split
    · exact ih _ h
    · rename_i hc
      apply ih
      rw [List.nodup_append]
      refine ⟨h, by simp, ?_⟩
      intro a ha b hb hab
      simp at hb; subst hb; subst hab
      exact hc (by simpa using ha)

theorem mem_applyDedup (applied log : List Nat) (i : Nat) :
    i ∈ applyDedup applied log ↔ i ∈ applied ∨ i ∈ log := by
  induction log generalizing applied with
  | nil => simp [applyDedup]
  | cons j rest ih =>
    unfold applyDedup
    split
    · rename_i hc
      rw [ih]
      have : j ∈ applied := by simpa using hc
      constructor
      · rintro (h | h)
        · exact Or.inl h
        · exact Or.inr (List.mem_cons_of_mem _ h)
      · rintro (h | h)
        · exact Or.inl h
        · rcases List.mem_cons.mp h with h | h
          · subst h; exact Or.inl this
          · exact Or.inr h
    · rw [ih]; simp [or_assoc]

/-- A replayed duplicate is applied at most once, and every delivered id is
    applied: at-least-once delivery + server dedup = exactly-once effect. -/
theorem exactly_once_effect (log : List Nat) :
    (applyDedup [] log).Nodup ∧ ∀ i, i ∈ applyDedup [] log ↔ i ∈ log :=
  ⟨applyDedup_nodup [] log List.nodup_nil, fun i => by simp [mem_applyDedup]⟩

end StrataSync.Outbox
