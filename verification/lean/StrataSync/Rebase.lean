/-
  StrataSync.Rebase — optimistic state, rebasing and convergence.

  Models (TypeScript sources in brackets):
  * rows, patches and object spread            [core/src/sync/delta-applier.ts,
                                                 client identity-map merge]
  * field-level merge of server deltas under
    pending local edits                         [client/src/sync/pending-hydration.ts]
  * rollback snapshots (`original`) and how the
    rebase folds server data into them           [core/src/sync/rebase.ts]
  * own-echo ordering in `rebaseTransactions`    [core/src/sync/rebase.ts]
  * own-echo suppression in the identity-map
    batch of a delta packet                      [client/src/sync/delta-pipeline.ts]
  * undo/redo inverse laws for archive state     [client/src/history-manager.ts,
                                                  core/src/transaction/create.ts]
  * identity map + LRU access order              [client/src/identity-map.ts]

  Values and fields are finite so that counterexamples are checked by `decide`.
  Every `bug_*` theorem is a concrete counterexample to a property the code
  relied on; the matching corrected model proves the property.
-/

namespace StrataSync.Rebase

/-! ## 1. Rows, patches and object spread -/

inductive Val | a | b | c | d
  deriving DecidableEq, Repr

inductive Field | title | prio | arch
  deriving DecidableEq, Repr

/-- A stored row. `none` is `null`/absent; `arch` is `archivedAt`. -/
structure Row where
  title : Option Val
  prio  : Option Val
  arch  : Option Val
  deriving DecidableEq, Repr

def Row.get (r : Row) : Field → Option Val
  | .title => r.title
  | .prio => r.prio
  | .arch => r.arch

theorem Row.ext' {r s : Row} (h : ∀ f, r.get f = s.get f) : r = s := by
  cases r; cases s
  have h1 := h .title; have h2 := h .prio; have h3 := h .arch
  simp_all [Row.get]

/-- A partial record (`Record<string, unknown>`): `none` = key absent,
    `some v` = key present with value `v` (`v = none` is an explicit null). -/
structure Patch where
  title : Option (Option Val) := none
  prio  : Option (Option Val) := none
  arch  : Option (Option Val) := none
  deriving DecidableEq, Repr

def Patch.get (p : Patch) : Field → Option (Option Val)
  | .title => p.title
  | .prio => p.prio
  | .arch => p.arch

theorem Patch.ext' {p q : Patch} (h : ∀ f, p.get f = q.get f) : p = q := by
  cases p; cases q
  have h1 := h .title; have h2 := h .prio; have h3 := h .arch
  simp_all [Patch.get]

/-- `{ ...r, ...p }` on a full row. -/
def Patch.apply (p : Patch) (r : Row) : Row :=
  ⟨p.title.getD r.title, p.prio.getD r.prio, p.arch.getD r.arch⟩

@[simp] theorem Patch.apply_get (p : Patch) (r : Row) (f : Field) :
    (p.apply r).get f = (p.get f).getD (r.get f) := by
  cases f <;> rfl

def orElse' (x y : Option (Option Val)) : Option (Option Val) :=
  match x with
  | some v => some v
  | none => y

/-- `{ ...p, ...q }` on partial records: `q` wins. -/
def Patch.over (p q : Patch) : Patch :=
  ⟨orElse' q.title p.title, orElse' q.prio p.prio, orElse' q.arch p.arch⟩

@[simp] theorem Patch.over_get (p q : Patch) (f : Field) :
    (p.over q).get f = orElse' (q.get f) (p.get f) := by
  cases f <;> rfl

/-- The keys of `q` that are also keys of `dom` (fields a tx tracks). -/
def Patch.restrict (q dom : Patch) : Patch :=
  ⟨if dom.title.isSome then q.title else none,
   if dom.prio.isSome then q.prio else none,
   if dom.arch.isSome then q.arch else none⟩

@[simp] theorem Patch.restrict_get (q dom : Patch) (f : Field) :
    (q.restrict dom).get f = if (dom.get f).isSome then q.get f else none := by
  cases f <;> rfl

def Patch.Disjoint (p q : Patch) : Prop :=
  ∀ f, (p.get f).isSome → q.get f = none

/-- Field-level merge: a server delta and a pending local edit on disjoint
    fields commute, so replaying pending edits over the server delta equals
    the server applying the delta over the optimistic row. -/
theorem merge_commutes (r : Row) (s l : Patch) (h : Patch.Disjoint s l) :
    l.apply (s.apply r) = s.apply (l.apply r) := by
  apply Row.ext'
  intro f
  have hf := h f
  simp only [Patch.apply_get]
  cases hs : s.get f <;> cases hl : l.get f <;> simp_all

/-- A server delta never clobbers a pending local edit: after replay, every
    field the local tx wrote shows the local value. -/
theorem local_edit_survives (r : Row) (s l : Patch) (f : Field) (v : Option Val)
    (h : l.get f = some v) : (l.apply (s.apply r)).get f = v := by
  simp [h]

/-- ...and a pending local edit never clobbers a server delta to a field the
    local tx did not write. -/
theorem server_edit_survives (r : Row) (s l : Patch) (f : Field)
    (h : l.get f = none) : (l.apply (s.apply r)).get f = (s.apply r).get f := by
  simp [h]

/-! ## 2. Rollback snapshots (`original`) under rebase

A pending update `l` carries `o = original`. `rollbackTransaction` writes
`o` over the optimistic row. The invariant the code relies on: `o` holds the
*current server value* of exactly the fields `l` tracks. -/

def OrigInv (l o : Patch) (srv : Row) : Prop :=
  ∀ f, o.get f = if (l.get f).isSome then some (srv.get f) else none

/-- Rolling back the (last) pending update restores server state. -/
theorem rollback_restores (l o : Patch) (srv : Row) (h : OrigInv l o srv) :
    o.apply (l.apply srv) = srv := by
  apply Row.ext'
  intro f
  have hf := h f
  simp only [Patch.apply_get]
  cases hl : l.get f <;> simp_all

/-- `rebaseOriginals` step: fold the tracked keys of a server action into `o`. -/
def foldTracked (l o s : Patch) : Patch := o.over (s.restrict l)

theorem foldTracked_preserves (l o s : Patch) (srv : Row) (h : OrigInv l o srv) :
    OrigInv l (foldTracked l o s) (s.apply srv) := by
  intro f
  have hf := h f
  simp only [foldTracked, Patch.over_get, Patch.restrict_get, Patch.apply_get]
  cases hl : l.get f <;> cases hs : s.get f <;> simp_all [orElse']

def serverAfter (srv : Row) (acts : List Patch) : Row :=
  acts.foldl (fun r s => s.apply r) srv

def foldAll (l o : Patch) (acts : List Patch) : Patch :=
  acts.foldl (foldTracked l) o

theorem foldAll_preserves (l : Patch) (acts : List Patch) :
    ∀ (o : Patch) (srv : Row), OrigInv l o srv →
      OrigInv l (foldAll l o acts) (serverAfter srv acts) := by
  induction acts with
  | nil => intro o srv h; exact h
  | cons s rest ih =>
    intro o srv h
    exact ih _ _ (foldTracked_preserves l o s srv h)

/-- Original `resolveConflictEffect` for client-wins/merge:
    `{ ...tx.original, ...serverAction.data }` — every server key. -/
def resolveOld (o s : Patch) : Patch := o.over s

/-- Original packet handling for one pending update under client-wins: the
    first overlapping action patches `original` with all its keys and the tx
    is then excluded from `rebaseOriginals`; otherwise all actions are folded. -/
def overlaps (l s : Patch) : Bool :=
  (l.title.isSome && s.title.isSome) || (l.prio.isSome && s.prio.isSome) ||
  (l.arch.isSome && s.arch.isSome)

def packetOld (l o : Patch) (acts : List Patch) : Patch :=
  match acts.find? (overlaps l) with
  | some s => resolveOld o s
  | none => foldAll l o acts

/-- Fixed: the conflict patch folds only tracked keys, and the tx stays in
    `result.pending` so the whole packet is folded afterwards. -/
def packetNew (l o : Patch) (acts : List Patch) : Patch :=
  match acts.find? (overlaps l) with
  | some s => foldAll l (foldTracked l o s) acts
  | none => foldAll l o acts

-- Scenario: local `title := b` (original title a). Server: `{title c, prio c}`
-- (conflict, client-wins) then, in a later packet, `{prio d}`. Rejecting the
-- tx must show the server row; the old code shows the stale `prio c`.
def exSrv0 : Row := ⟨some .a, some .a, none⟩
def exL : Patch := { title := some (some .b) }
def exO : Patch := { title := some (some .a) }
def exS1 : Patch := { title := some (some .c), prio := some (some .c) }
def exS2 : Patch := { prio := some (some .d) }

theorem bug_conflict_original_untracked_field :
    let o1 := packetOld exL exO [exS1]
    let o2 := packetOld exL o1 [exS2]
    let srv := serverAfter exSrv0 [exS1, exS2]
    o2.apply (exL.apply srv) ≠ srv := by decide

-- Same packet: `{title c}` then `{title d}`; the old code keeps `c`.
def exS3 : Patch := { title := some (some .d) }

theorem bug_conflict_original_same_packet :
    let o1 := packetOld exL exO [exS1, exS3]
    let srv := serverAfter exSrv0 [exS1, exS3]
    o1.apply (exL.apply srv) ≠ srv := by decide

/-- Pre-patching tracked keys of an action that is itself folded later
    changes nothing. -/
theorem foldAll_absorbs (l s : Patch) (acts : List Patch) (hs : s ∈ acts) :
    ∀ o, foldAll l (foldTracked l o s) acts = foldAll l o acts := by
  -- Per-field: two starting snapshots that agree except on keys some action
  -- in `acts` overwrites end up equal.
  suffices H : ∀ (acts : List Patch) (o1 o2 : Patch),
      (∀ f, o1.get f = o2.get f ∨ ∃ t ∈ acts, ((t.restrict l).get f).isSome) →
      foldAll l o1 acts = foldAll l o2 acts by
    intro o
    apply H
    intro f
    cases h : ((s.restrict l).get f) with
    | none =>
      left
      simp only [foldTracked, Patch.over_get, h, orElse']
    | some v => exact Or.inr ⟨s, hs, by simp [h]⟩
  intro acts
  induction acts with
  | nil =>
    intro o1 o2 h
    apply Patch.ext'
    intro f
    rcases h f with h | ⟨t, ht, _⟩
    · exact h
    · cases ht
  | cons t rest ih =>
    intro o1 o2 h
    apply ih
    intro f
    rcases h f with h | ⟨u, hu, hut⟩
    · left; simp only [foldTracked, Patch.over_get, h]
    · rcases List.mem_cons.mp hu with rfl | hu'
      · left
        simp only [foldTracked, Patch.over_get]
        cases hr : (u.restrict l).get f with
        | none => simp [hr] at hut
        | some _ => rfl
      · exact Or.inr ⟨u, hu', hut⟩

theorem packetNew_preserves (l o : Patch) (acts : List Patch) (srv : Row)
    (h : OrigInv l o srv) :
    OrigInv l (packetNew l o acts) (serverAfter srv acts) := by
  unfold packetNew
  split
  · rename_i s hs
    rw [foldAll_absorbs l s acts (List.mem_of_find?_eq_some hs)]
    exact foldAll_preserves l acts o srv h
  · exact foldAll_preserves l acts o srv h

/-- Convergence of rollback under the fixed rebase: however many packets
    arrive, rejecting the pending update shows exactly the server row. -/
theorem rollback_after_packets (l o : Patch) (srv : Row) (h : OrigInv l o srv)
    (packets : List (List Patch)) :
    let res := packets.foldl (fun (st : Patch × Row) acts =>
      (packetNew l st.1 acts, serverAfter st.2 acts)) (o, srv)
    res.1.apply (l.apply res.2) = res.2 := by
  intro res
  apply rollback_restores
  suffices H : ∀ (ps : List (List Patch)) (o : Patch) (srv : Row), OrigInv l o srv →
      OrigInv l (ps.foldl (fun (st : Patch × Row) acts =>
        (packetNew l st.1 acts, serverAfter st.2 acts)) (o, srv)).1
        (ps.foldl (fun (st : Patch × Row) acts =>
        (packetNew l st.1 acts, serverAfter st.2 acts)) (o, srv)).2 from
    H packets o srv h
  intro ps
  induction ps with
  | nil => intro o srv h; exact h
  | cons acts rest ih =>
    intro o srv h
    exact ih _ _ (packetNew_preserves l o acts srv h)


/-! ## 3. Own-echo ordering in `rebaseTransactions`

Server actions for one key, in sync order. `echo = some id` marks the echo of
our pending tx `id`. Conflicts are field overlaps (update/update, fieldLevel). -/

structure PTx where
  id : Nat
  fields : List Field
  deriving DecidableEq, Repr

structure SAct where
  fields : List Field
  echo : Option Nat
  deriving DecidableEq, Repr

structure RState where
  processed : List Nat
  confirmed : List Nat
  conflicted : List Nat
  deriving DecidableEq, Repr

def conflictsWith (tx : PTx) (a : SAct) : Bool :=
  tx.fields.any (fun f => a.fields.contains f)

/-- Inner loop over related txs; `skip` = extra ids never treated as conflicts. -/
def scanConflicts (skip : List Nat) (a : SAct) (st : RState) (tx : PTx) : RState :=
  if st.processed.contains tx.id || skip.contains tx.id then st
  else if conflictsWith tx a then
    { st with processed := tx.id :: st.processed, conflicted := tx.id :: st.conflicted }
  else st

def rstep (skip : List Nat) (pending : List PTx) (st : RState) (a : SAct) : RState :=
  match pending.find? (fun tx => !st.processed.contains tx.id && a.echo == some tx.id) with
  | some tx => { st with processed := tx.id :: st.processed, confirmed := tx.id :: st.confirmed }
  | none => pending.foldl (scanConflicts skip a) st

/-- `rebaseTransactions` as written: no knowledge of later echoes. -/
def rebaseOld (pending : List PTx) (acts : List SAct) : RState :=
  acts.foldl (rstep [] pending) ⟨[], [], []⟩

/-- Our tx (title) is echoed at sync id 21, after a foreign title write at 20
    in the same packet. The server applied ours last, yet it is reported as a
    server-wins conflict and never confirmed (the client then fires
    `rebaseConflict` + `mutationRejected` and drops its undo entry). -/
theorem bug_echo_after_conflicting_action :
    rebaseOld [⟨1, [.title]⟩] [⟨[.title], none⟩, ⟨[.title], some 1⟩] =
      ⟨[1], [], [1]⟩ := by decide

def echoedIds (acts : List SAct) : List Nat := acts.filterMap SAct.echo

/-- Fixed model: pre-scan the batch for own echoes and never conflict them. -/
def rebaseNew (pending : List PTx) (acts : List SAct) : RState :=
  acts.foldl (rstep (echoedIds acts) pending) ⟨[], [], []⟩

theorem fixed_echo_after_conflicting_action :
    rebaseNew [⟨1, [.title]⟩] [⟨[.title], none⟩, ⟨[.title], some 1⟩] =
      ⟨[1], [1], []⟩ := by decide

theorem scanConflicts_inv (skip : List Nat) (a : SAct) (st : RState) (tx : PTx)
    (h : ∀ i ∈ st.conflicted, i ∉ skip) :
    ∀ i ∈ (scanConflicts skip a st tx).conflicted, i ∉ skip := by
  unfold scanConflicts
  split
  · exact h
  · rename_i hc
    split
    · intro i hi
      simp only [List.mem_cons] at hi
      rcases hi with rfl | hi
      · intro hmem
        apply hc
        simp [hmem]
      · exact h i hi
    · exact h

theorem foldl_inv {α β : Type} (P : β → Prop) (g : β → α → β)
    (hg : ∀ b x, P b → P (g b x)) : ∀ (xs : List α) (b : β), P b → P (xs.foldl g b) := by
  intro xs
  induction xs with
  | nil => intro b h; exact h
  | cons x rest ih => intro b h; exact ih _ (hg b x h)

/-- With the pre-scan, a tx whose echo is in the batch is never a conflict. -/
theorem echoed_never_conflicts (pending : List PTx) (acts : List SAct) :
    ∀ i ∈ (rebaseNew pending acts).conflicted, i ∉ echoedIds acts := by
  unfold rebaseNew
  apply foldl_inv (fun st : RState => ∀ i ∈ st.conflicted, i ∉ echoedIds acts)
  · intro st a h
    unfold rstep
    split
    · exact h
    · exact foldl_inv (fun st : RState => ∀ i ∈ st.conflicted, i ∉ echoedIds acts)
        (scanConflicts (echoedIds acts) a)
        (fun st tx h => scanConflicts_inv _ a st tx h) pending st h
  · intro i hi; cases hi

/-! ## 4. Own-echo suppression in the identity-map batch

`applyDeltaPacket` stages every action of a packet against storage (the
server row) and queues one full-row merge per action; merges tagged with a
local clientTxId are skipped when the row is in the map ("own optimistic
echo"). Confirmed txs leave the outbox; the remaining pending txs are
replayed on top. Single key, update actions only. -/

structure PAct where
  p : Patch
  own : Bool
  deriving DecidableEq, Repr

/-- Rows written to storage after each action, paired with the echo tag. -/
def stageRows (srv : Row) : List PAct → List (Row × Bool)
  | [] => []
  | x :: rest => let r := x.p.apply srv; (r, x.own) :: stageRows r rest

def storageAfter (srv : Row) (acts : List PAct) : Row :=
  acts.foldl (fun r x => x.p.apply r) srv

def replay (pending : List Patch) (m : Row) : Row :=
  pending.foldl (fun m l => l.apply m) m

/-- As written: skip every own echo, merge every other staged row. -/
def mapOld (m : Row) (ops : List (Row × Bool)) : Row :=
  ops.foldl (fun m op => if op.2 then m else op.1) m

def pipelineOld (srv m : Row) (acts : List PAct) (pendingAfter : List Patch) : Row :=
  replay pendingAfter (mapOld m (stageRows srv acts))

-- Server row {a, a}; we set title := b (optimistic map {b, a}).
-- Packet: foreign `prio := b` (20), then the echo of our `title := b` (21).
def pSrv : Row := ⟨some .a, some .a, none⟩
def pMine : Patch := { title := some (some .b) }
def pActs : List PAct := [⟨{ prio := some (some .b) }, false⟩, ⟨pMine, true⟩]

/-- Nothing is pending afterwards, yet the map shows the pre-edit title while
    storage holds ours: the foreign row (with the old title) is merged and
    the echo row that would restore it is suppressed. -/
theorem bug_echo_suppression_diverges :
    pipelineOld pSrv (pMine.apply pSrv) pActs [] ≠ storageAfter pSrv pActs := by
  decide

/-- Corrected model: once any row of the packet has been merged for the key,
    later own echoes must be merged too (equivalently: merge the final staged
    row, then replay). -/
def mapNew (m : Row) (ops : List (Row × Bool)) : Row :=
  (ops.foldl (fun (st : Row × Bool) op =>
    if op.2 && !st.2 then st else (op.1, true)) (m, false)).1

def pipelineNew (srv m : Row) (acts : List PAct) (pendingAfter : List Patch) : Row :=
  replay pendingAfter (mapNew m (stageRows srv acts))

theorem mapNew_merged (ops : List (Row × Bool)) :
    ∀ (m : Row) (merged : Bool), merged = true → ops ≠ [] →
      (ops.foldl (fun (st : Row × Bool) op =>
        if op.2 && !st.2 then st else (op.1, true)) (m, merged)).1 =
      (ops.getLast?.map Prod.fst).getD m := by
  induction ops with
  | nil => intro m merged _ h; exact absurd rfl h
  | cons op rest ih =>
    intro m merged hm _
    subst hm
    simp only [List.foldl_cons, Bool.not_true, Bool.and_false, Bool.false_eq_true,
      ite_false]
    cases rest with
    | nil => simp
    | cons op' rest' =>
      rw [ih op.1 true rfl (by simp)]
      rw [List.getLast?_eq_some_getLast (by simp), List.getLast?_eq_some_getLast (by simp)]
      simp

theorem stageRows_last (acts : List PAct) :
    ∀ srv, acts ≠ [] →
      ((stageRows srv acts).getLast?.map Prod.fst) = some (storageAfter srv acts) := by
  induction acts with
  | nil => intro _ h; exact absurd rfl h
  | cons x rest ih =>
    intro srv _
    cases rest with
    | nil => simp [stageRows, storageAfter]
    | cons y rest' =>
      have := ih (x.p.apply srv) (by simp)
      simp only [stageRows] at this ⊢
      rw [List.getLast?_cons_cons]
      simpa [storageAfter] using this

/-- Rebase equivalence for the corrected batch: if any non-echo action for
    the key is in the packet, the map ends as "server row after the packet,
    then replay the still-pending local txs". With nothing left pending the
    map equals the server row (convergence). -/
theorem pipelineNew_rebase (srv m : Row) (acts : List PAct) (pendingAfter : List Patch)
    (hforeign : ∃ x ∈ acts, x.own = false) :
    pipelineNew srv m acts pendingAfter = replay pendingAfter (storageAfter srv acts) := by
  unfold pipelineNew mapNew
  congr 1
  -- Find the first non-echo action: before it everything is skipped.
  suffices H : ∀ (acts : List PAct) (srv m : Row), (∃ x ∈ acts, x.own = false) →
      ((stageRows srv acts).foldl (fun (st : Row × Bool) op =>
        if op.2 && !st.2 then st else (op.1, true)) (m, false)).1 = storageAfter srv acts from
    H acts srv m hforeign
  intro acts
  induction acts with
  | nil => intro _ _ h; simp at h
  | cons x rest ih =>
    intro srv m h
    cases hx : x.own with
    | true =>
      have h' : ∃ y ∈ rest, y.own = false := by
        rcases h with ⟨y, hy, hyo⟩
        rcases List.mem_cons.mp hy with rfl | hy'
        · simp [hx] at hyo
        · exact ⟨y, hy', hyo⟩
      simp only [stageRows, List.foldl_cons, hx, Bool.not_false, Bool.and_self, ite_true]
      exact ih _ m h'
    | false =>
      simp only [stageRows, List.foldl_cons, hx, Bool.false_and, Bool.false_eq_true, ite_false]
      cases rest with
      | nil => simp [stageRows, storageAfter]
      | cons y rest' =>
        rw [mapNew_merged _ _ true rfl (by simp [stageRows])]
        have := stageRows_last (y :: rest') (x.p.apply srv) (by simp)
        rw [this]
        simp [storageAfter]

theorem pipelineNew_converges (srv m : Row) (acts : List PAct)
    (hforeign : ∃ x ∈ acts, x.own = false) :
    pipelineNew srv m acts [] = storageAfter srv acts := by
  rw [pipelineNew_rebase srv m acts [] hforeign]; rfl

/-! ### Combined fix (rebase pre-scan + echo suppression)

Same packet: a foreign title write (20) then the echo of ours (21). The old
rebase reported our tx as a conflict; the rollback plus the un-suppressed
echo happened to converge. Fixing the rebase alone confirms the tx, the echo
is then suppressed and the map shows the foreign title — so both fixes are
needed together. -/

def cActs : List PAct := [⟨{ title := some (some .c) }, false⟩, ⟨pMine, true⟩]

theorem rebase_fix_confirms :
    (rebaseNew [⟨1, [.title]⟩] [⟨[.title], none⟩, ⟨[.title], some 1⟩]).confirmed = [1] := by
  decide

theorem bug_rebase_fix_alone_diverges :
    pipelineOld pSrv (pMine.apply pSrv) cActs [] ≠ storageAfter pSrv cActs := by
  decide

theorem combined_fix_converges :
    pipelineNew pSrv (pMine.apply pSrv) cActs [] = storageAfter pSrv cActs :=
  pipelineNew_converges _ _ _ ⟨_, List.mem_cons_self .., rfl⟩

/-! ## 5. Undo/redo inverse laws for archive state

`archivedAt : Option Val` (`none` = not archived). History operations carry a
concrete archive timestamp (`createArchivePayload` resolves "now" when the
entry is built); `original` is `captureArchiveState(existing)` as a partial
record: `none` = key absent, `some x` = `archivedAt: x`. -/

inductive HOp
  | archive (t : Option Val)   -- `none` = no timestamp: resolved to "now"
  | unarchive
  deriving DecidableEq, Repr

def HOp.run (now : Val) : HOp → Option Val → Option Val
  | .archive t, _ => some (t.getD now)
  | .unarchive, _ => none

/-- `buildEntry` / `createUndoTransaction` as written: A ↦ V, V ↦ A(original). -/
def undoOld (op : HOp) (original : Option (Option Val)) : HOp :=
  match op with
  | .archive _ => .unarchive
  | .unarchive => .archive (original.getD none)

/-- Fixed: re-archive undoes to the previous timestamp; unarchive of a row
    known not to be archived undoes to "not archived". -/
def undoNew (op : HOp) (original : Option (Option Val)) : HOp :=
  match op, original with
  | .archive _, some (some t0) => .archive (some t0)
  | .archive _, _ => .unarchive
  | .unarchive, some none => .unarchive
  | .unarchive, o => .archive (o.getD none)

/-- Re-archiving an archived row (a → b), then undo: row ends unarchived. -/
theorem bug_undo_rearchive :
    let s := some Val.a
    let op := HOp.archive (some .b)
    (undoOld op (some s)).run .c (op.run .d s) ≠ s := by decide

/-- Unarchiving a live row, then undo: row ends archived at "now". -/
theorem bug_undo_unarchive_live_row :
    let s : Option Val := none
    let op := HOp.unarchive
    (undoOld op (some s)).run .c (op.run .d s) ≠ s := by decide

/-- Inverse law: undo restores the captured state, for every state, op and
    clock value. -/
theorem undo_archive_inverse (s : Option Val) (op : HOp) (now now' : Val) :
    (undoNew op (some s)).run now' (op.run now s) = s := by
  cases op <;> cases s <;> rfl

/-- Redo after undo re-establishes the post-op state (ops carry concrete
    timestamps in history entries). -/
theorem redo_after_undo (s : Option Val) (op : HOp) (now now' now'' : Val)
    (hconcrete : op ≠ .archive none) :
    op.run now'' ((undoNew op (some s)).run now' (op.run now s)) = op.run now s := by
  cases op with
  | archive t => cases t with
    | none => exact absurd rfl hconcrete
    | some _ => rfl
  | unarchive => rfl

/-- Update undo: `undo.payload = original` restores the pre-edit row when
    `original` records exactly the edited keys (`pickOriginal`), i.e. the
    `OrigInv` invariant of section 2 with the pre-edit row. -/
theorem undo_update_inverse (l o : Patch) (r : Row) (h : OrigInv l o r) :
    o.apply (l.apply r) = r := rollback_restores l o r h

/-! ## 6. Identity map with LRU access order

`map : id → instance` (a JS `Map`, so one instance per id by construction)
and `accessOrder : Set<id>` in insertion order. -/

structure IMap where
  val : Nat → Option Val
  order : List Nat

def IMap.WF (m : IMap) : Prop :=
  m.order.Nodup ∧ ∀ k, k ∈ m.order ↔ (m.val k).isSome

def touch (k : Nat) (o : List Nat) : List Nat := o.filter (· != k) ++ [k]

def upd (f : Nat → Option Val) (k : Nat) (v : Option Val) : Nat → Option Val :=
  fun j => if j = k then v else f j

def IMap.set (m : IMap) (k : Nat) (v : Val) : IMap :=
  ⟨upd m.val k (some v), touch k m.order⟩

def IMap.delete (m : IMap) (k : Nat) : IMap :=
  ⟨upd m.val k none, m.order.filter (· != k)⟩

def IMap.get (m : IMap) (k : Nat) : IMap :=
  if (m.val k).isSome then ⟨m.val, touch k m.order⟩ else m

/-- `merge`: update the existing instance in place (identity kept), else set. -/
def IMap.merge (m : IMap) (k : Nat) (v : Val) : IMap :=
  if (m.val k).isSome then ⟨m.val, touch k m.order⟩ else m.set k v

def IMap.evictStep (m : IMap) : IMap :=
  match m.order with
  | [] => m
  | k :: rest => ⟨upd m.val k none, rest⟩

def IMap.evict (max : Nat) : Nat → IMap → IMap
  | 0, m => m
  | fuel + 1, m => if max < m.order.length then IMap.evict max fuel m.evictStep else m

theorem nodup_filter {l : List Nat} (p : Nat → Bool) (h : l.Nodup) : (l.filter p).Nodup :=
  List.Nodup.sublist List.filter_sublist h

theorem touch_nodup (k : Nat) (o : List Nat) (h : o.Nodup) : (touch k o).Nodup := by
  unfold touch
  rw [List.nodup_append]
  refine ⟨nodup_filter _ h, by simp, ?_⟩
  intro a ha b hb
  simp [List.mem_filter] at ha hb
  subst hb
  exact ha.2

theorem touch_mem (k j : Nat) (o : List Nat) : j ∈ touch k o ↔ j ∈ o ∨ j = k := by
  unfold touch
  simp only [List.mem_append, List.mem_filter, List.mem_singleton, bne_iff_ne, ne_eq]
  by_cases hj : j = k <;> simp [hj]

theorem set_wf (m : IMap) (k : Nat) (v : Val) (h : m.WF) : (m.set k v).WF := by
  refine ⟨touch_nodup k _ h.1, ?_⟩
  intro j
  simp only [IMap.set, touch_mem, upd]
  by_cases hj : j = k
  · simp [hj]
  · simp [hj, h.2 j]

theorem delete_wf (m : IMap) (k : Nat) (h : m.WF) : (m.delete k).WF := by
  refine ⟨nodup_filter _ h.1, ?_⟩
  intro j
  simp only [IMap.delete, List.mem_filter, upd, bne_iff_ne, ne_eq]
  by_cases hj : j = k
  · simp [hj]
  · simp [hj, h.2 j]

theorem get_wf (m : IMap) (k : Nat) (h : m.WF) : (m.get k).WF := by
  unfold IMap.get
  split
  · rename_i hk
    refine ⟨touch_nodup k _ h.1, ?_⟩
    intro j
    simp only [touch_mem]
    by_cases hj : j = k
    · subst hj; simp [hk]
    · simp [hj, h.2 j]
  · exact h

theorem merge_wf (m : IMap) (k : Nat) (v : Val) (h : m.WF) : (m.merge k v).WF := by
  unfold IMap.merge
  split
  · have := get_wf m k h
    unfold IMap.get at this
    rename_i hk
    simpa [hk] using this
  · exact set_wf m k v h

/-- `merge` never replaces a live instance (identity is stable). -/
theorem merge_keeps_instance (m : IMap) (k : Nat) (v w : Val) (h : m.val k = some w) :
    (m.merge k v).val k = some w := by
  simp [IMap.merge, h]

theorem evictStep_wf (m : IMap) (h : m.WF) : m.evictStep.WF := by
  unfold IMap.evictStep
  split
  · exact h
  · rename_i k rest ho
    have hnd := h.1
    rw [ho, List.nodup_cons] at hnd
    refine ⟨hnd.2, ?_⟩
    intro j
    have hj := h.2 j
    rw [ho] at hj
    simp only [upd]
    by_cases hjk : j = k
    · subst hjk; simp [hnd.1]
    · simp only [List.mem_cons, hjk, false_or] at hj
      simp [hjk, hj]

theorem evict_wf (max : Nat) : ∀ fuel (m : IMap), m.WF → (m.evict max fuel).WF := by
  intro fuel
  induction fuel with
  | zero => intro m h; exact h
  | succ n ih =>
    intro m h
    unfold IMap.evict
    split
    · exact ih _ (evictStep_wf m h)
    · exact h

/-- With enough fuel (the JS `while` loop), eviction brings the access
    order (= the key set, by `WF`) within `max`. -/
theorem evict_bound (max : Nat) : ∀ fuel (m : IMap), m.order.length ≤ fuel + max →
    (m.evict max fuel).order.length ≤ max := by
  intro fuel
  induction fuel with
  | zero => intro m h; simp [IMap.evict]; omega
  | succ n ih =>
    intro m h
    unfold IMap.evict
    split
    · apply ih
      unfold IMap.evictStep
      split
      · rename_i ho; simp [ho] at *
      · rename_i k rest ho; rw [ho] at h; simp at h ⊢; omega
    · omega

/-- The id just written by `set` survives the eviction pass (it is the most
    recently used), as long as `max ≥ 1`. -/
theorem set_survives_evict (max : Nat) (hmax : 1 ≤ max) :
    ∀ fuel (m : IMap) (xs : List Nat) (k : Nat) (v : Val),
      m.order.Nodup → m.order = xs ++ [k] → m.val k = some v →
      (m.evict max fuel).val k = some v := by
  intro fuel
  induction fuel with
  | zero => intro m xs k v _ _ hv; exact hv
  | succ n ih =>
    intro m xs k v hnd ho hv
    unfold IMap.evict
    split
    · rename_i hlt
      cases xs with
      | nil => rw [ho] at hlt; simp at hlt; omega
      | cons x rest =>
        rw [ho, List.cons_append, List.nodup_cons] at hnd
        have hxk : k ≠ x := by
          intro hkx; subst hkx; exact hnd.1 (by simp)
        apply ih m.evictStep rest k v
        · simpa [IMap.evictStep, ho] using hnd.2
        · simp [IMap.evictStep, ho]
        · simp [IMap.evictStep, ho, upd, hxk, hv]
    · exact hv

theorem set_order (m : IMap) (k : Nat) (v : Val) :
    (m.set k v).order = m.order.filter (· != k) ++ [k] := rfl

/-- End to end: `IdentityMap.set` (write, touch, evict) keeps `WF`, keeps
    the map within `max`, and the written instance is readable afterwards. -/
theorem set_then_evict (max : Nat) (hmax : 1 ≤ max) (m : IMap) (k : Nat) (v : Val)
    (h : m.WF) :
    let m' := (m.set k v).evict max (m.set k v).order.length
    m'.WF ∧ m'.order.length ≤ max ∧ m'.val k = some v := by
  intro m'
  refine ⟨evict_wf max _ _ (set_wf m k v h), evict_bound max _ _ (by omega), ?_⟩
  exact set_survives_evict max hmax _ _ _ k v (set_wf m k v h).1 (set_order m k v)
    (by simp [IMap.set, upd])

end StrataSync.Rebase
