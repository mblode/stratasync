/-
  Client lifecycle / concurrency: a model of

    packages/client/src/sync-orchestrator.ts   (start / reset / stop, run token,
                                                 handleConnectionChange)
    packages/client/src/sync/bootstrap-runner.ts (bootstrap abort points)
    packages/client/src/internal/gate.ts        (Gate)
    packages/client/src/internal/async-queue.ts (AsyncQueue)
    packages/transport-graphql/src/websocket.ts (WebSocketManager connect /
                                                 close / socket events)

  Async code is modelled as explicit continuations. Every `await` is a point
  where a scheduler may run anything else, so a continuation is a record of
  "which await it is parked at" plus what it captured (its run token). The
  scheduler is an arbitrary sequence of events; a property is proved for every
  reachable state, i.e. for every interleaving.

  Sections
    1. Orchestrator run tokens. Three stale-continuation bugs (counterexamples
       `bug_*`), and the corrected model with the lifecycle invariants proved
       for all interleavings:
         * a stopped client is `disconnected` with no live subscription,
         * never more than one live delta subscription,
         * a continuation of a cancelled run never changes observable state.
    2. Gate: counting barrier. No lost wakeup, idempotent release, FIFO wakeup.
    3. AsyncQueue: mutual exclusion, FIFO start order, a rejected task does
       not wedge the queue, no deadlock.
    4. WebSocketManager: two bugs (late close event of a replaced socket;
       close() during an in-flight connect loses the next connect), and the
       corrected model: at most one live socket, `disconnected` implies no
       socket, and an active subscription always has a connection on the way.
-/

namespace StrataSync.Orchestrator

/-! ## Shared helpers -/

def getAt {α} : List α → Nat → Option α
  | [], _ => none
  | a :: _, 0 => some a
  | _ :: as, n + 1 => getAt as n

def removeAt {α} : List α → Nat → List α
  | [], _ => []
  | _ :: as, 0 => as
  | a :: as, n + 1 => a :: removeAt as n

def setAt {α} : List α → Nat → α → List α
  | [], _, _ => []
  | _ :: as, 0, b => b :: as
  | a :: as, n + 1, b => a :: setAt as n b

theorem getAt_mem {α} : ∀ (l : List α) (i : Nat) (a : α), getAt l i = some a → a ∈ l
  | [], _, _, h => by simp [getAt] at h
  | b :: bs, 0, a, h => by simp [getAt] at h; simp [h]
  | b :: bs, n + 1, a, h => by
      simp [getAt] at h
      exact List.mem_cons_of_mem _ (getAt_mem bs n a h)

theorem mem_removeAt {α} : ∀ (l : List α) (i : Nat) (a : α), a ∈ removeAt l i → a ∈ l
  | [], _, _, h => by simp [removeAt] at h
  | b :: bs, 0, a, h => by simp [removeAt] at h; exact List.mem_cons_of_mem _ h
  | b :: bs, n + 1, a, h => by
      simp [removeAt] at h
      rcases h with h | h
      · simp [h]
      · exact List.mem_cons_of_mem _ (mem_removeAt bs n a h)

/-! ## 1. Orchestrator run tokens

`SyncOrchestrator` has `running` and `runToken`. `start()` bumps the token and
captures it; `reset()` (the body of `stop()`) clears `running` and bumps the
token again. Every continuation that may resume after a `reset()` is supposed
to re-check `isRunActive(token) = running && runToken === token` before it
touches state.

Continuations modelled:

* `start pc snap` — the tail of `start()` for a run whose bootstrap will land
  snapshot cursor `snap`:
    - `pc = 0`: parked in `readBootstrapStream`; `bootstrap()` checks
      `shouldAbort(runToken)` right after (bootstrap-runner.ts:109).
    - `pc = 1`: parked in the awaits between that check and the commit
      (`hasLocalData`, `setMeta`, `storage.clear`, `writeBatch`,
      bootstrap-runner.ts:113-132). The resume commits the snapshot to the
      identity maps and sets the cursor (`applyBootstrapMetadata`).
    - `pc = 2`: parked in the privacy-reconcile block of `start()`
      (`applyPendingOutboxTransactions(true)` + `setMeta`,
      sync-orchestrator.ts:316-323). The resume does `setState("syncing")` and
      `startDeltaSubscription`.
* `reconnect` — the IIFE in `handleConnectionChange`
  (sync-orchestrator.ts:631), parked in `syncNow()`. On resume it opens a
  subscription if none is live and sets `"syncing"`.

`Cfg` records which of those resume points re-check the token, so the code as
written and the fixed code are the same model with different flags. -/

inductive Phase | disconnected | connecting | syncing
  deriving DecidableEq, Repr

inductive Kind
  | start (pc : Nat) (snap : Nat)
  | reconnect
  deriving DecidableEq, Repr

structure Cfg where
  /-- bootstrap re-checks the token after the pre-commit awaits (pc 1) -/
  guardCommit : Bool
  /-- start() re-checks the token after the privacy reconcile block (pc 2) -/
  guardReconcile : Bool
  /-- handleConnectionChange's continuation checks the run token, not `running` -/
  reconnectByToken : Bool

/-- The code before the fix. -/
def original : Cfg := ⟨false, false, false⟩
/-- The code after the fix. -/
def fixed : Cfg := ⟨true, true, true⟩

/-- Pending continuations are split into those that captured the current run
token (`cur`) and those from older tokens (`stale`). The split is only a
representation: a continuation is stale exactly when its captured token is not
`runToken`, and every token bump moves all of `cur` into `stale`. -/
structure St where
  running : Bool
  token : Nat
  phase : Phase
  /-- live delta subscriptions opened through `transport.subscribe` and not
  yet returned (the orchestrator can reference at most one of them) -/
  subs : Nat
  cursor : Nat
  cur : List Kind
  stale : List Kind
  deriving Repr

def init : St := ⟨false, 0, .disconnected, 0, 0, [], []⟩

inductive Ev
  | start (snap : Nat)   -- SyncOrchestrator.start()
  | reset                -- SyncOrchestrator.reset() / stop()
  | connected            -- transport reports disconnected → connected
  | streamEnd            -- the live stream ends / errors (subscription nulled)
  | stepCur (i : Nat)    -- scheduler resumes the i-th current continuation
  | stepStale (i : Nat)  -- scheduler resumes the i-th stale continuation
  deriving Repr

/-- Resume a continuation of the *current* run (its token check passes). -/
def resumeCur (s : St) (i : Nat) : St :=
  match getAt s.cur i with
  | none => s
  | some (.start 0 snap) => { s with cur := setAt s.cur i (.start 1 snap) }
  | some (.start 1 snap) => { s with cursor := snap, cur := setAt s.cur i (.start 2 snap) }
  | some (.start _ _) =>
      { s with phase := .syncing, subs := s.subs + 1, cur := removeAt s.cur i }
  | some .reconnect =>
      { s with phase := .syncing, subs := if s.subs = 0 then 1 else s.subs,
               cur := removeAt s.cur i }

/-- Resume a continuation of a *cancelled* run. `isRunActive(token)` is false
for it; only a resume point that does not check the token acts. -/
def resumeStale (c : Cfg) (s : St) (i : Nat) : St :=
  match getAt s.stale i with
  | none => s
  -- bootstrap-runner.ts:109 checks shouldAbort: drop.
  | some (.start 0 _) => { s with stale := removeAt s.stale i }
  | some (.start 1 snap) =>
      if c.guardCommit then { s with stale := removeAt s.stale i }
      else { s with cursor := snap, stale := setAt s.stale i (.start 2 snap) }
  | some (.start _ _) =>
      if c.guardReconcile then { s with stale := removeAt s.stale i }
      else { s with phase := .syncing, subs := s.subs + 1, stale := removeAt s.stale i }
  | some .reconnect =>
      -- original: `if (this.running && !this.deltaSubscription) …; if (this.running) setState("syncing")`
      if c.reconnectByToken || !s.running then { s with stale := removeAt s.stale i }
      else { s with phase := .syncing, subs := if s.subs = 0 then 1 else s.subs,
                    stale := removeAt s.stale i }

def step (c : Cfg) (s : St) : Ev → St
  | .start snap =>
      if s.running then s   -- `if (this.running) return;`
      else { s with running := true, token := s.token + 1, phase := .connecting,
                    cur := [.start 0 snap], stale := s.stale ++ s.cur }
  | .reset =>
      { s with running := false, token := s.token + 1, phase := .disconnected,
               subs := 0, cursor := 0, cur := [], stale := s.stale ++ s.cur }
  | .connected =>
      -- handleConnectionChange bails while "connecting"/"bootstrapping" or stopped
      if s.running && s.phase == .syncing then { s with cur := s.cur ++ [.reconnect] } else s
  | .streamEnd => { s with subs := s.subs - 1 }
  | .stepCur i => resumeCur s i
  | .stepStale i => resumeStale c s i

def run (c : Cfg) (s : St) : List Ev → St
  | [] => s
  | e :: es => run c (step c s e) es

/-! ### Counterexamples in the code as written -/

/-- BUG 1 (sync-orchestrator.ts:316-331). `stop()` while `start()` is in the
privacy-reconcile block: after the stop, the cancelled start marks the client
`"syncing"` and opens a subscription on the transport `reset()` just closed.
Test: packages/client/tests/orchestrator-lifecycle.test.ts
("a start() cancelled during privacy reconciliation stays stopped"). -/
theorem bug_start_revives_after_stop :
    let s := run original init
      [.start 10, .stepCur 0, .stepCur 0, .reset, .stepStale 0]
    s.running = false ∧ s.phase = .syncing ∧ s.subs = 1 := by
  decide

/-- BUG 2 (sync-orchestrator.ts:631-646). A reconnect continuation parked in
`syncNow()` survives `stop(); start()`. It only checks `running`, which is true
again, so it reports `"syncing"` for a run that is still starting and opens a
subscription; the new run then opens its own: two live streams.
Test: "a reconnect continuation from a stopped run cannot drive the next run". -/
theorem bug_reconnect_leaks_into_next_run :
    let mid := run original init
      [.start 5, .stepCur 0, .stepCur 0, .stepCur 0,   -- run 1 is syncing
       .connected,                                     -- reconnect parked in syncNow
       .reset, .start 5,                               -- stop(); start() run 2
       .stepStale 0]                                   -- run 1's reconnect resumes
    let fin := run original mid [.stepCur 0, .stepCur 0, .stepCur 0]
    mid.phase = .syncing ∧ mid.cur = [.start 0 5] ∧ fin.subs = 2 := by
  decide

/-- BUG 3 (bootstrap-runner.ts:113-134). A bootstrap of a cancelled run parked
in `storage.clear()` resumes after the next run bootstrapped a newer snapshot,
and commits its old one, moving the cursor backwards (20 → 10).
Test: "a bootstrap from a cancelled run cannot commit into the next run". -/
theorem bug_stale_bootstrap_regresses_cursor :
    let a := run original init
      [.start 10, .stepCur 0,                          -- run 1 past its abort check
       .reset, .start 20, .stepCur 0, .stepCur 0, .stepCur 0]
    let b := step original a (.stepStale 0)
    a.cursor = 20 ∧ a.running = true ∧ b.cursor = 10 := by
  decide

/-! ### The corrected model -/

theorem resumeStale_fixed (s : St) (i : Nat) :
    let t := resumeStale fixed s i
    t.running = s.running ∧ t.token = s.token ∧ t.phase = s.phase ∧
    t.subs = s.subs ∧ t.cursor = s.cursor ∧ t.cur = s.cur := by
  unfold resumeStale
  split <;> simp_all [fixed]

/-- Stale continuations are inert: resuming any continuation of a cancelled run
changes nothing observable (running, token, phase, subscriptions, cursor, the
current run's continuations). -/
theorem stale_step_inert (s : St) (i : Nat) :
    let t := step fixed s (.stepStale i)
    t.running = s.running ∧ t.token = s.token ∧ t.phase = s.phase ∧
    t.subs = s.subs ∧ t.cursor = s.cursor ∧ t.cur = s.cur :=
  resumeStale_fixed s i

inductive Reach (c : Cfg) : St → Prop
  | init : Reach c init
  | step {s} (e : Ev) : Reach c s → Reach c (step c s e)

def Inv (s : St) : Prop :=
  s.subs ≤ 1 ∧
  (s.running = false → s.phase = .disconnected ∧ s.subs = 0 ∧ s.cur = []) ∧
  (s.running = true → s.phase ≠ .disconnected) ∧
  (∀ pc snap, Kind.start pc snap ∈ s.cur →
      s.cur = [.start pc snap] ∧ s.phase = .connecting ∧ s.subs = 0) ∧
  (s.running = true → s.phase = .connecting → ∃ pc snap, s.cur = [.start pc snap])

theorem inv_init : Inv init := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp [init]

theorem inv_resumeCur (s : St) (i : Nat) (h : Inv s) : Inv (resumeCur s i) := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  unfold resumeCur
  split
  · exact ⟨h1, h2, h3, h4, h5⟩
  -- start 0
  · rename_i snap hg
    obtain ⟨hc, hp, hs⟩ := h4 0 snap (getAt_mem _ _ _ hg)
    have hi : i = 0 := by
      rw [hc] at hg; cases i with
      | zero => rfl
      | succ n => cases n <;> simp [getAt] at hg
    subst hi
    have hr : s.running = true := by
      cases hrun : s.running
      · have := (h2 hrun).2.2; rw [this] at hc; simp at hc
      · rfl
    refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp_all [setAt]
  -- start 1
  · rename_i snap hg
    obtain ⟨hc, hp, hs⟩ := h4 1 snap (getAt_mem _ _ _ hg)
    have hi : i = 0 := by
      rw [hc] at hg; cases i with
      | zero => rfl
      | succ n => cases n <;> simp [getAt] at hg
    subst hi
    have hr : s.running = true := by
      cases hrun : s.running
      · have := (h2 hrun).2.2; rw [this] at hc; simp at hc
      · rfl
    refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp_all [setAt]
  -- start ≥ 2
  · rename_i pc snap hne0 hne1 hg
    obtain ⟨hc, hp, hs⟩ := h4 pc snap (getAt_mem _ _ _ hg)
    have hi : i = 0 := by
      rw [hc] at hg; cases i with
      | zero => rfl
      | succ n => cases n <;> simp [getAt] at hg
    subst hi
    have hr : s.running = true := by
      cases hrun : s.running
      · have := (h2 hrun).2.2; rw [this] at hc; simp at hc
      · rfl
    refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp_all [removeAt]
  -- reconnect
  · rename_i hg
    have hmem := getAt_mem _ _ _ hg
    have hr : s.running = true := by
      cases hrun : s.running
      · have := (h2 hrun).2.2; rw [this] at hmem; simp at hmem
      · rfl
    have hnc : s.phase ≠ .connecting := by
      intro hp
      obtain ⟨pc, snap, hc⟩ := h5 hr hp
      rw [hc] at hmem; simp at hmem
    refine ⟨?_, ?_, ?_, ?_, ?_⟩
    · simp only; split <;> omega
    · simp [hr]
    · simp
    · intro pc snap hm
      have := h4 pc snap (mem_removeAt _ _ _ hm)
      rw [this.1] at hmem; simp at hmem
    · simp

theorem inv_step (s : St) (e : Ev) (h : Inv s) : Inv (step fixed s e) := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  cases e with
  | start snap =>
      simp only [step]
      split
      · exact ⟨h1, h2, h3, h4, h5⟩
      · rename_i hr
        have hr' : s.running = false := by simpa using hr
        have hsubs := (h2 hr').2.1
        refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
  | reset =>
      refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp [step]
  | connected =>
      simp only [step]
      split
      · rename_i hc
        simp at hc
        obtain ⟨hr, hp⟩ := hc
        refine ⟨h1, ?_, ?_, ?_, ?_⟩
        · simp [hr]
        · simp [hp]
        · intro pc snap hm
          simp at hm
          have := (h4 pc snap hm).2.1
          rw [hp] at this; cases this
        · intro _ hp'; rw [hp] at hp'; cases hp'
      · exact ⟨h1, h2, h3, h4, h5⟩
  | streamEnd =>
      refine ⟨?_, ?_, ?_, ?_, ?_⟩
      · simp [step]; omega
      · intro hr; obtain ⟨a, b, c⟩ := h2 hr; simp [step]; exact ⟨a, by omega, c⟩
      · exact h3
      · intro pc snap hm
        obtain ⟨a, b, c⟩ := h4 pc snap hm
        simp [step]; exact ⟨a, b, by omega⟩
      · exact h5
  | stepCur i => exact inv_resumeCur s i ⟨h1, h2, h3, h4, h5⟩
  | stepStale i =>
      obtain ⟨e1, e2, e3, e4, e5, e6⟩ := stale_step_inert s i
      refine ⟨?_, ?_, ?_, ?_, ?_⟩
      · rw [e4]; exact h1
      · rw [e1, e3, e4, e6]; exact h2
      · rw [e1, e3]; exact h3
      · rw [e6, e3, e4]; exact h4
      · rw [e1, e3, e6]; exact h5

theorem inv_reach {s : St} (h : Reach fixed s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step e _ ih => exact inv_step _ e ih

/-- A stopped orchestrator is `disconnected`, with no live subscription and no
pending continuation of a live run — under every interleaving. -/
theorem stopped_is_quiescent {s : St} (h : Reach fixed s) (hr : s.running = false) :
    s.phase = .disconnected ∧ s.subs = 0 ∧ s.cur = [] :=
  (inv_reach h).2.1 hr

/-- Never two live delta subscriptions. -/
theorem at_most_one_subscription {s : St} (h : Reach fixed s) : s.subs ≤ 1 :=
  (inv_reach h).1

/-- `"syncing"` implies running (no "connected after stop()"). -/
theorem syncing_implies_running {s : St} (h : Reach fixed s) (hp : s.phase = .syncing) :
    s.running = true := by
  cases hr : s.running
  · have := ((inv_reach h).2.1 hr).1; rw [hp] at this; cases this
  · rfl

/-- While a start() is in flight nothing else of the current run is pending and
no subscription is open (a reconnect cannot overlap a bootstrap). -/
theorem start_in_flight_exclusive {s : St} (h : Reach fixed s) (pc snap : Nat)
    (hm : Kind.start pc snap ∈ s.cur) :
    s.cur = [.start pc snap] ∧ s.phase = .connecting ∧ s.subs = 0 :=
  (inv_reach h).2.2.2.1 pc snap hm

/-- start() is idempotent while running. -/
theorem start_idempotent (c : Cfg) (s : St) (snap : Nat) (hr : s.running = true) :
    step c s (.start snap) = s := by
  simp [step, hr]

/-- reset() is idempotent on observable state. -/
theorem reset_idempotent (c : Cfg) (s : St) :
    let t := step c (step c s .reset) .reset
    let u := step c s .reset
    t.running = u.running ∧ t.phase = u.phase ∧ t.subs = u.subs ∧
    t.cursor = u.cursor ∧ t.cur = u.cur := by
  simp [step]

/-- Within a run, the cursor is written only by that run's own bootstrap:
between two token bumps every change of `cursor` comes from `stepCur`. -/
theorem cursor_changes_only_by_current_run (s : St) (e : Ev)
    (hne : (step fixed s e).cursor ≠ s.cursor) :
    (∃ i, e = .stepCur i) ∨ e = .reset := by
  cases e with
  | start snap =>
      exfalso; apply hne; simp only [step]; split <;> rfl
  | reset => exact Or.inr rfl
  | connected => exfalso; apply hne; simp only [step]; split <;> rfl
  | streamEnd => exfalso; apply hne; rfl
  | stepCur i => exact Or.inl ⟨i, rfl⟩
  | stepStale i => exfalso; exact hne (stale_step_inert s i).2.2.2.2.1

/-! ## 2. Gate (internal/gate.ts)

`hold()` increments `holds` and returns a once-only releaser; the release that
takes `holds` to 0 resolves every queued waiter in order. `whenOpen()` resolves
at once when open, otherwise queues. `issued` records the order `whenOpen()`
was called, `woken` the order waiters were resolved. -/

structure G where
  holds : Nat
  /-- `released` flag of every releaser handed out by `hold()` -/
  releasers : List Bool
  waiters : List Nat
  woken : List Nat
  issued : List Nat

def G.init : G := ⟨0, [], [], [], []⟩

def unreleased : List Bool → Nat
  | [] => 0
  | false :: t => unreleased t + 1
  | true :: t => unreleased t

/-- Calling the `i`-th releaser. -/
def grelease (g : G) (i : Nat) : G :=
  match getAt g.releasers i with
  | some false =>
      let g' := { g with holds := g.holds - 1, releasers := setAt g.releasers i true }
      if g'.holds = 0 then { g' with woken := g'.woken ++ g'.waiters, waiters := [] } else g'
  | _ => g   -- `if (released) return;` (or no such releaser)

inductive GEv
  | hold
  | release (i : Nat)
  | whenOpen (w : Nat)

def gstep (g : G) : GEv → G
  | .hold => { g with holds := g.holds + 1, releasers := g.releasers ++ [false] }
  | .release i => grelease g i
  | .whenOpen w =>
      if g.holds = 0 then { g with woken := g.woken ++ [w], issued := g.issued ++ [w] }
      else { g with waiters := g.waiters ++ [w], issued := g.issued ++ [w] }

inductive GReach : G → Prop
  | init : GReach G.init
  | step {g} (e : GEv) : GReach g → GReach (gstep g e)

theorem unreleased_append (l : List Bool) (b : Bool) :
    unreleased (l ++ [b]) = unreleased l + (if b then 0 else 1) := by
  induction l with
  | nil => cases b <;> simp [unreleased]
  | cons x t ih => cases x <;> simp [unreleased, ih] <;> omega

theorem unreleased_setAt (l : List Bool) (i : Nat) (h : getAt l i = some false) :
    unreleased (setAt l i true) + 1 = unreleased l := by
  induction l generalizing i with
  | nil => simp [getAt] at h
  | cons x t ih =>
      cases i with
      | zero => simp [getAt] at h; subst h; simp [setAt, unreleased]
      | succ n =>
          simp [getAt] at h
          cases x <;> simp [setAt, unreleased] <;> have := ih n h <;> omega

def GInv (g : G) : Prop :=
  g.holds = unreleased g.releasers ∧
  (g.waiters ≠ [] → g.holds > 0) ∧
  g.woken ++ g.waiters = g.issued

theorem ginv_step (g : G) (e : GEv) (h : GInv g) : GInv (gstep g e) := by
  obtain ⟨h1, h2, h3⟩ := h
  cases e with
  | hold =>
      refine ⟨?_, ?_, ?_⟩ <;> simp [gstep, unreleased_append, h1, h3]
  | release i =>
      simp only [gstep, grelease]
      split
      · rename_i hg
        have hu := unreleased_setAt _ _ hg
        split
        · rename_i h0
          refine ⟨?_, ?_, ?_⟩ <;> simp_all <;> omega
        · rename_i h0
          refine ⟨?_, ?_, ?_⟩
          · simp; omega
          · intro _; simp at h0 ⊢; omega
          · exact h3
      · exact ⟨h1, h2, h3⟩
  | whenOpen w =>
      simp only [gstep]
      split
      · rename_i h0
        have hw : g.waiters = [] := by
          cases hw : g.waiters with
          | nil => rfl
          | cons _ _ => have := h2 (by simp [hw]); omega
        refine ⟨h1, ?_, ?_⟩
        · simp [hw]
        · simp [← h3, hw]
      · rename_i h0
        refine ⟨h1, ?_, ?_⟩
        · intro _; exact Nat.pos_of_ne_zero h0
        · simp [← h3]

theorem ginv_reach {g : G} (h : GReach g) : GInv g := by
  induction h with
  | init => exact ⟨rfl, by simp [G.init], rfl⟩
  | step e _ ih => exact ginv_step _ e ih

/-- No lost wakeup: a waiter is only ever parked while the gate is closed. -/
theorem gate_no_lost_wakeup {g : G} (h : GReach g) (hw : g.waiters ≠ []) : g.holds > 0 :=
  (ginv_reach h).2.1 hw

/-- The gate is closed exactly while some releaser is outstanding: a double
release never under-counts and a forgotten one never over-counts. -/
theorem gate_holds_exact {g : G} (h : GReach g) : g.holds = unreleased g.releasers :=
  (ginv_reach h).1

/-- FIFO and no loss: waiters are resolved in `whenOpen()` call order, and the
resolved ones followed by the still-parked ones are exactly all callers. -/
theorem gate_fifo {g : G} (h : GReach g) : g.woken ++ g.waiters = g.issued :=
  (ginv_reach h).2.2

/-- Releasing twice is the same as releasing once. -/
theorem getAt_setAt_self {α} (l : List α) (i : Nat) (a b : α) (h : getAt l i = some a) :
    getAt (setAt l i b) i = some b := by
  induction l generalizing i with
  | nil => simp [getAt] at h
  | cons x t ih => cases i <;> simp_all [getAt, setAt]

theorem grelease_released (g : G) (i : Nat) (h : getAt g.releasers i = some true) :
    grelease g i = g := by
  simp [grelease, h]

theorem grelease_marks (g : G) (i : Nat) (h : getAt g.releasers i = some false) :
    getAt (grelease g i).releasers i = some true := by
  have hset := getAt_setAt_self _ _ _ true h
  simp only [grelease, h]
  split <;> exact hset

theorem gate_release_idempotent (g : G) (i : Nat) :
    gstep (gstep g (.release i)) (.release i) = gstep g (.release i) := by
  simp only [gstep]
  cases hg : getAt g.releasers i with
  | none => simp [grelease, hg]
  | some b =>
      cases b with
      | true => simp [grelease, hg]
      | false => exact grelease_released _ _ (grelease_marks g i hg)

/-! ## 3. AsyncQueue (internal/async-queue.ts)

`run(task)` chains `tail.then(task, task)`: the task starts once the previous
one has *settled* (fulfilled or rejected), and the chain swallows the
settlement so a rejection is only delivered to its own caller. A task's life
is `waiting → running → done ok/err`. -/

inductive TS | waiting | running | done (ok : Bool)
  deriving DecidableEq, Repr

def allWaiting : List TS → Bool
  | [] => true
  | .waiting :: t => allWaiting t
  | _ :: _ => false

/-- done* (running | waiting)? waiting* -/
def shape : List TS → Bool
  | [] => true
  | .done _ :: t => shape t
  | .running :: t => allWaiting t
  | .waiting :: t => allWaiting t

/-- the `.then` of the first unsettled task fires -/
def startNext : List TS → List TS
  | [] => []
  | .done r :: t => .done r :: startNext t
  | .waiting :: t => .running :: t
  | .running :: t => .running :: t

/-- the running task settles (resolves or rejects) -/
def settle (r : Bool) : List TS → List TS
  | [] => []
  | .done x :: t => .done x :: settle r t
  | .running :: t => .done r :: t
  | .waiting :: t => .waiting :: t

def enqueue (l : List TS) : List TS := l ++ [.waiting]

theorem allWaiting_append (l : List TS) (h : allWaiting l = true) :
    allWaiting (l ++ [.waiting]) = true := by
  induction l with
  | nil => rfl
  | cons x t ih => cases x <;> simp_all [allWaiting]

theorem shape_enqueue (l : List TS) (h : shape l = true) : shape (enqueue l) = true := by
  unfold enqueue
  induction l with
  | nil => rfl
  | cons x t ih =>
      cases x <;> simp_all [shape, allWaiting_append]

theorem shape_startNext (l : List TS) (h : shape l = true) : shape (startNext l) = true := by
  induction l with
  | nil => rfl
  | cons x t ih => cases x <;> simp_all [shape, startNext]

theorem shape_of_allWaiting (l : List TS) (h : allWaiting l = true) : shape l = true := by
  induction l with
  | nil => rfl
  | cons x t ih => cases x <;> simp_all [shape, allWaiting]

theorem shape_settle (r : Bool) (l : List TS) (h : shape l = true) :
    shape (settle r l) = true := by
  induction l with
  | nil => rfl
  | cons x t ih =>
      cases x <;> simp_all [shape, settle, shape_of_allWaiting]

def nRunning : List TS → Nat
  | [] => 0
  | .running :: t => nRunning t + 1
  | _ :: t => nRunning t

theorem nRunning_allWaiting (l : List TS) (h : allWaiting l = true) : nRunning l = 0 := by
  induction l with
  | nil => rfl
  | cons x t ih => cases x <;> simp_all [allWaiting, nRunning]

/-- Mutual exclusion: at most one task runs at a time. -/
theorem queue_mutex (l : List TS) (h : shape l = true) : nRunning l ≤ 1 := by
  induction l with
  | nil => simp [nRunning]
  | cons x t ih =>
      cases x <;> simp_all [shape, nRunning, nRunning_allWaiting]

/-- FIFO: a task can only be running (or done) once every earlier task is done. -/
theorem queue_fifo (l : List TS) (h : shape l = true) (i j : Nat) (hij : i < j)
    (hj : getAt l j = some .running ∨ ∃ r, getAt l j = some (.done r)) :
    ∃ r, getAt l i = some (.done r) := by
  induction l generalizing i j with
  | nil => simp [getAt] at hj
  | cons x t ih =>
      cases j with
      | zero => omega
      | succ j =>
          cases x with
          | done r =>
              cases i with
              | zero => exact ⟨r, rfl⟩
              | succ i => exact ih (by simpa [shape] using h) i j (by omega) (by simpa [getAt] using hj)
          | running | waiting =>
              exfalso
              simp [shape] at h
              have hw : ∀ k a, getAt t k = some a → a = .waiting := by
                intro k a hk
                clear ih hj hij
                induction t generalizing k with
                | nil => simp [getAt] at hk
                | cons y u ihu =>
                    cases y <;> simp [allWaiting] at h
                    cases k with
                    | zero => simp [getAt] at hk; exact hk.symm
                    | succ k => exact ihu h k (by simpa [getAt] using hk)
              simp only [getAt] at hj
              rcases hj with hj | ⟨r, hj⟩
              · have := hw _ _ hj; simp at this
              · have := hw _ _ hj; simp at this

/-- A rejected (or fulfilled) task never wedges the queue: whenever a task is
waiting, letting the running one settle — with either outcome — and firing the
next `.then` leaves some task running. -/
theorem queue_no_wedge (l : List TS) (h : shape l = true) (r : Bool)
    (hw : TS.waiting ∈ l) : TS.running ∈ startNext (settle r l) := by
  induction l with
  | nil => simp at hw
  | cons x t ih =>
      cases x with
      | done y =>
          simp [shape] at h
          simp at hw
          simp [settle, startNext, ih h hw]
      | running =>
          simp [shape] at h
          simp at hw
          simp only [settle, startNext]
          cases t with
          | nil => simp at hw
          | cons y u =>
              cases y <;> simp [allWaiting] at h
              simp [startNext]
      | waiting => simp [settle, startNext]

/-- No deadlock: if nothing runs and something waits, the next `.then` fires. -/
theorem queue_progress (l : List TS) (h : shape l = true) (hw : TS.waiting ∈ l)
    (hr : TS.running ∉ l) : TS.running ∈ startNext l := by
  have hs : settle true l = l := by
    clear h hw
    induction l with
    | nil => rfl
    | cons x t ih =>
        cases x <;> simp_all [settle]
  have := queue_no_wedge l h true hw
  rwa [hs] at this

inductive QEv | run | fire | settle (ok : Bool)

def qstep (l : List TS) : QEv → List TS
  | .run => enqueue l
  | .fire => startNext l
  | .settle ok => settle ok l

inductive QReach : List TS → Prop
  | init : QReach []
  | step {l} (e : QEv) : QReach l → QReach (qstep l e)

/-- Every reachable queue has the shape done* (running | waiting)? waiting*, so
`queue_mutex`, `queue_fifo`, `queue_no_wedge` and `queue_progress` apply to
every interleaving of `run`, `.then` firings and settlements. -/
theorem queue_reach_shape {l : List TS} (h : QReach l) : shape l = true := by
  induction h with
  | init => rfl
  | step e _ ih =>
      cases e with
      | run => exact shape_enqueue _ ih
      | fire => exact shape_startNext _ ih
      | settle ok => exact shape_settle ok _ ih

/-- The corrected code on the bug traces of section 1. -/
theorem fixed_on_bug_traces :
    (run fixed init [.start 10, .stepCur 0, .stepCur 0, .reset, .stepStale 0]).phase
      = .disconnected ∧
    (run fixed init [.start 5, .stepCur 0, .stepCur 0, .stepCur 0, .connected, .reset,
      .start 5, .stepStale 0, .stepCur 0, .stepCur 0, .stepCur 0]).subs = 1 ∧
    (run fixed init [.start 10, .stepCur 0, .reset, .start 20, .stepCur 0, .stepCur 0,
      .stepCur 0, .stepStale 0]).cursor = 20 := by
  decide

/-! ## 4. WebSocketManager (transport-graphql/src/websocket.ts)

State: the current `socket`, the sockets the manager created and has not
closed (`live`), the in-flight `connectPromise` (`attempt`), attempts
orphaned by `close()` (`staleAttempts`, only in the fixed code, which bumps a
generation on close), `shouldReconnect`, whether a subscription is active,
the reconnect timer and the reported connection state.

A real `WebSocket` delivers its `close` / `error` events asynchronously, after
`close()` returned, so a close event may arrive for *any* socket ever created
(`closeEv k`, `k < nextId`). -/

inductive CS | disconnected | connecting | connected | error
  deriving DecidableEq, Repr

structure WCfg where
  /-- socket listeners ignore events of a socket that is no longer `this.socket` -/
  guardEvents : Bool
  /-- close() bumps the generation and drops `connectPromise` -/
  closeOrphansAttempt : Bool

def wsOriginal : WCfg := ⟨false, false⟩
def wsFixed : WCfg := ⟨true, true⟩

structure W where
  socket : Option Nat
  live : List Nat
  nextId : Nat
  attempt : Bool
  staleAttempts : Nat
  shouldReconnect : Bool
  subs : Nat
  timer : Bool
  conn : CS
  deriving Repr

def W.init : W := ⟨none, [], 0, false, 0, true, 0, false, .disconnected⟩

inductive WEv
  | subscribe          -- subscribe(): register + connect()
  | resolve            -- the in-flight connect's auth lookup resolves
  | resolveStale       -- an orphaned attempt's auth lookup resolves
  | close              -- close()
  | openEv (k : Nat)   -- socket k fires "open"
  | closeEv (k : Nat)  -- socket k fires "close"
  | errorEv (k : Nat)  -- socket k fires "error"
  | timerFire          -- scheduleReconnect's timer: connect()
  | giveUp             -- reconnect budget exhausted: failSubscriptions

/-- `connect()`: no-op with a socket; joins an in-flight attempt; else starts one. -/
def doConnect (w : W) : W :=
  if w.socket.isSome || w.attempt then w
  else { w with shouldReconnect := true, conn := .connecting, attempt := true }

def wstep (c : WCfg) (w : W) : WEv → W
  | .subscribe => if w.subs = 0 then doConnect { w with subs := 1 } else w
  | .resolve =>
      if w.attempt then
        -- `if (!this.shouldReconnect) return;` else `this.socket = new WebSocket(url)`
        if w.shouldReconnect then
          { w with attempt := false, socket := some w.nextId, live := w.live ++ [w.nextId],
                   nextId := w.nextId + 1 }
        else { w with attempt := false }
      else w
  | .resolveStale => { w with staleAttempts := w.staleAttempts - 1 }
  | .close =>
      let w' := { w with shouldReconnect := false, timer := false, subs := 0,
                         live := w.live.filter (fun k => some k != w.socket),
                         socket := none, conn := .disconnected }
      if c.closeOrphansAttempt then
        { w' with attempt := false,
                  staleAttempts := w.staleAttempts + (if w.attempt then 1 else 0) }
      else w'
  | .openEv k =>
      if k ∈ w.live && (!c.guardEvents || w.socket == some k) then { w with conn := .connected }
      else w
  | .closeEv k =>
      let w' := { w with live := w.live.filter (· != k) }
      if !c.guardEvents || w.socket == some k then
        { w' with socket := none, conn := .disconnected,
                  timer := w.timer || (w.shouldReconnect && decide (w.subs > 0)) }
      else w'
  | .errorEv k =>
      if !c.guardEvents || w.socket == some k then { w with conn := .error } else w
  | .timerFire => if w.timer then doConnect { w with timer := false } else w
  | .giveUp => if w.timer then { w with timer := false, subs := 0, conn := .error } else w

def wrun (c : WCfg) (w : W) : List WEv → W
  | [] => w
  | e :: es => wrun c (wstep c w e) es

/-- BUG 4 (websocket.ts:131-138). stop() + start() replaces socket 0 by
socket 1; socket 0's late `close` event then nulls `this.socket`, reports
`disconnected` while socket 1 is open, and schedules a reconnect that opens
socket 2 next to the still-open socket 1: two live sockets, each delivering
every delta. Test: packages/transport-graphql/tests/websocket-lifecycle.test.ts
("ignores the late close event of a socket it already replaced"). -/
theorem bug_ws_late_close_event :
    let a := wrun wsOriginal W.init
      [.subscribe, .resolve, .openEv 0, .close, .subscribe, .resolve, .openEv 1, .closeEv 0]
    let b := wrun wsOriginal a [.timerFire, .resolve]
    a.conn = .disconnected ∧ a.live = [1] ∧ b.live = [1, 2] := by
  decide

/-- BUG 5 (websocket.ts:86-101, 311). close() while connect() awaits auth leaves
`connectPromise` set; the next subscribe()'s connect() joins that dead attempt,
which then sees `shouldReconnect = false` and returns without a socket. The
subscription is active with no socket, no attempt and no timer: it never
connects. Test: "connects after a close() that interrupted an in-flight connect". -/
theorem bug_ws_close_during_connect_strands_subscription :
    let w := wrun wsOriginal W.init [.subscribe, .close, .subscribe, .resolve]
    w.subs = 1 ∧ w.socket = none ∧ w.attempt = false ∧ w.timer = false := by
  decide

inductive WReach (c : WCfg) : W → Prop
  | init : WReach c W.init
  | step {w} (e : WEv) : WReach c w → WReach c (wstep c w e)

def WInv (w : W) : Prop :=
  (∀ k ∈ w.live, w.socket = some k) ∧
  (w.socket.isSome → w.attempt = false ∧ w.shouldReconnect = true) ∧
  (w.attempt → w.shouldReconnect = true ∧ w.conn ≠ .disconnected) ∧
  (w.conn = .disconnected → w.socket = none) ∧
  (w.subs > 0 → w.socket.isSome ∨ w.attempt ∨ w.timer)

/-- The part of `WInv` that does not mention the subscription. -/
def WInv4 (w : W) : Prop :=
  (∀ k ∈ w.live, w.socket = some k) ∧
  (w.socket.isSome → w.attempt = false ∧ w.shouldReconnect = true) ∧
  (w.attempt → w.shouldReconnect = true ∧ w.conn ≠ .disconnected) ∧
  (w.conn = .disconnected → w.socket = none)

theorem doConnect_inv (w : W) (h : WInv4 w) :
    WInv4 (doConnect w) ∧ ((doConnect w).socket.isSome ∨ (doConnect w).attempt = true) ∧
    (doConnect w).subs = w.subs := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold doConnect
  split
  · rename_i hc
    refine ⟨⟨h1, h2, h3, h4⟩, ?_, rfl⟩
    simp at hc
    rcases hc with hc | hc
    · exact Or.inl hc
    · exact Or.inr hc
  · rename_i hc
    simp at hc
    refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_, rfl⟩ <;> simp_all

theorem winv_step (w : W) (e : WEv) (h : WInv w) : WInv (wstep wsFixed w e) := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  cases e with
  | subscribe =>
      simp only [wstep]
      split
      · obtain ⟨⟨g1, g2, g3, g4⟩, g5, g6⟩ :=
          doConnect_inv { w with subs := 1 } ⟨h1, h2, h3, h4⟩
        refine ⟨g1, g2, g3, g4, ?_⟩
        intro _
        rcases g5 with g5 | g5
        · exact Or.inl g5
        · exact Or.inr (Or.inl g5)
      · exact ⟨h1, h2, h3, h4, h5⟩
  | resolve =>
      simp only [wstep]
      split
      · rename_i ha
        have hsock : w.socket = none := by
          cases hs : w.socket with
          | none => rfl
          | some k => have := (h2 (by simp [hs])).1; rw [ha] at this; cases this
        have hlive : w.live = [] := by
          cases hl : w.live with
          | nil => rfl
          | cons k t => have := h1 k (by simp [hl]); rw [hsock] at this; cases this
        have hr := (h3 ha).1
        have hcn := (h3 ha).2
        simp only [hr, ite_true]
        refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp_all
      · exact ⟨h1, h2, h3, h4, h5⟩
  | resolveStale => exact ⟨h1, h2, h3, h4, h5⟩
  | close =>
      simp only [wstep, wsFixed, ite_true]
      refine ⟨?_, ?_, ?_, ?_, ?_⟩
      · intro k hk
        simp only [List.mem_filter] at hk
        have := h1 k hk.1
        rw [this] at hk; simp at hk
      · simp
      · simp
      · simp
      · simp
  | openEv k =>
      simp only [wstep]
      split
      · rename_i hc
        simp [wsFixed] at hc
        refine ⟨h1, h2, ?_, ?_, h5⟩
        · intro ha; exact ⟨(h3 ha).1, by simp⟩
        · simp
      · exact ⟨h1, h2, h3, h4, h5⟩
  | closeEv k =>
      simp only [wstep]
      split
      · rename_i hc
        simp [wsFixed] at hc
        have hr := (h2 (by simp [hc])).2
        refine ⟨?_, ?_, ?_, ?_, ?_⟩
        · intro x hx
          simp only [List.mem_filter] at hx
          have := h1 x hx.1
          rw [hc] at this; cases this
          simp at hx
        · simp
        · intro ha
          have := (h2 (by simp [hc])).1; rw [this] at ha; cases ha
        · simp
        · intro hs; simp [hr, hs]
      · rename_i hc
        refine ⟨?_, h2, h3, h4, h5⟩
        intro x hx
        simp only [List.mem_filter] at hx
        exact h1 x hx.1
  | errorEv k =>
      simp only [wstep]
      split
      · refine ⟨h1, h2, ?_, ?_, h5⟩
        · intro ha; exact ⟨(h3 ha).1, by simp⟩
        · simp
      · exact ⟨h1, h2, h3, h4, h5⟩
  | timerFire =>
      simp only [wstep]
      split
      · obtain ⟨⟨g1, g2, g3, g4⟩, g5, g6⟩ :=
          doConnect_inv { w with timer := false } ⟨h1, h2, h3, h4⟩
        refine ⟨g1, g2, g3, g4, ?_⟩
        intro _
        rcases g5 with g5 | g5
        · exact Or.inl g5
        · exact Or.inr (Or.inl g5)
      · exact ⟨h1, h2, h3, h4, h5⟩
  | giveUp =>
      simp only [wstep]
      split
      · refine ⟨h1, h2, ?_, ?_, ?_⟩
        · intro ha; exact ⟨(h3 ha).1, by simp⟩
        · simp
        · simp
      · exact ⟨h1, h2, h3, h4, h5⟩

theorem winv_reach {w : W} (h : WReach wsFixed w) : WInv w := by
  induction h with
  | init => refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp [W.init]
  | step e _ ih => exact winv_step _ e ih

/-- At most one live socket, and it is `this.socket`. -/
theorem ws_single_live_socket {w : W} (h : WReach wsFixed w) (a b : Nat)
    (ha : a ∈ w.live) (hb : b ∈ w.live) : a = b := by
  have e1 := (winv_reach h).1 a ha
  have e2 := (winv_reach h).1 b hb
  rw [e1] at e2; exact Option.some.inj e2

/-- `disconnected` is only reported when there is no socket. -/
theorem ws_disconnected_no_socket {w : W} (h : WReach wsFixed w)
    (hc : w.conn = .disconnected) : w.socket = none :=
  (winv_reach h).2.2.2.1 hc

/-- An active subscription always has a socket, a connect attempt that will
open one, or a reconnect timer: close() + subscribe() can no longer strand it.
(The one exit is `giveUp`, which fails the subscription instead.) -/
theorem ws_subscription_not_stranded {w : W} (h : WReach wsFixed w) (hs : w.subs > 0) :
    w.socket.isSome ∨ w.attempt = true ∨ w.timer = true :=
  (winv_reach h).2.2.2.2 hs

/-- A connect attempt in flight will open a socket when it resolves. -/
theorem ws_attempt_productive {w : W} (h : WReach wsFixed w) (ha : w.attempt = true) :
    (wstep wsFixed w .resolve).socket.isSome := by
  have hr := ((winv_reach h).2.2.1 ha).1
  simp [wstep, ha, hr]

/-- The corrected WebSocketManager on the two bug traces. -/
theorem ws_fixed_on_bug_traces :
    let a := wrun wsFixed W.init
      [.subscribe, .resolve, .openEv 0, .close, .subscribe, .resolve, .openEv 1, .closeEv 0]
    let b := wrun wsFixed a [.timerFire, .resolve]
    let c := wrun wsFixed W.init [.subscribe, .close, .subscribe, .resolveStale, .resolve]
    a.conn = .connected ∧ b.live = [1] ∧ c.socket.isSome = true := by
  decide

end StrataSync.Orchestrator
