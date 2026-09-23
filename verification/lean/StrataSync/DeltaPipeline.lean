/-
  Client-side delta ingestion: a model of

    packages/core/src/sync/sync-id.ts          (compareSyncId)
    packages/client/src/sync/cursor.ts         (SyncCursor.advance)
    packages/client/src/sync/delta-pipeline.ts (applyDeltaPacket, fetchAndApplyDeltaPages)

  Sections
    1. Sync-id comparison is numeric order on digit strings.
    2. The cursor only moves forward; memory never lags storage.
    3. Packet ingestion: under any interleaving of packets from any number of
       sources (live stream, catch-up, syncNow, resubscribe, redelivery), the
       applied actions are exactly the server log up to the cursor, in order,
       with no duplicates and no skips. Group-change latch and bootstrap
       included. Plus the contract this relies on (contiguous sources).
    4. Crash safety: the persisted cursor never passes durably written rows,
       and the in-memory cursor never passes the identity maps.
       BUG (fixed): the cursor was advanced before the identity-map batch,
       so a throw in between left the maps permanently behind.
    5. BUG (fixed): a catch-up buffer from a dead run was flushed into the
       next run. Counterexample + corrected model.
    6. BUG (fixed): stream-end restart and re-bootstrap resume checked
       `isRunning()` instead of their run token.
    7. BUG (fixed): an update for an absent row staged a stub row.
-/

namespace StrataSync.DeltaPipeline

/-! ## 1. Sync-id comparison (`compareSyncId`)

A wire sync id is `/^\d+$/` (enforced by `parseSyncId`). We model it as its
list of decimal digits. `compareSyncId` strips leading zeros (`|| "0"`),
compares lengths, then compares the strings with JS `<`, which on equal-length
digit strings is lexicographic digit comparison. -/

/-- Big-endian decimal value of a digit list. -/
def val : List Nat → Nat
  | [] => 0
  | d :: ds => d * 10 ^ ds.length + val ds

def Digits (l : List Nat) : Prop := ∀ d ∈ l, d < 10

/-- `s.replace(/^0+/, "") || "0"` -/
def strip (l : List Nat) : List Nat :=
  match l.dropWhile (· == 0) with
  | [] => [0]
  | s => s

/-- JS string `<` / `>` on digit strings of equal length. -/
def lexCmp : List Nat → List Nat → Ordering
  | [], [] => .eq
  | a :: as, b :: bs => if a < b then .lt else if b < a then .gt else lexCmp as bs
  | [], _ :: _ => .lt
  | _ :: _, [] => .gt

/-- Model of `compareSyncId` (sign of the result). -/
def compareSyncId (a b : List Nat) : Ordering :=
  let a' := strip a
  let b' := strip b
  if a'.length < b'.length then .lt
  else if b'.length < a'.length then .gt
  else lexCmp a' b'

/-- Numeric three-way comparison (what the code means by "sync id order"). -/
def ordOf (x y : Nat) : Ordering :=
  if x < y then .lt else if y < x then .gt else .eq

theorem val_lt_pow {l : List Nat} (h : Digits l) : val l < 10 ^ l.length := by
  induction l with
  | nil => simp [val]
  | cons d ds ih =>
    have hd : d < 10 := h d (by simp)
    have ih' := ih (fun x hx => h x (by simp [hx]))
    simp only [val, List.length_cons, Nat.pow_succ]
    have : d * 10 ^ ds.length + 10 ^ ds.length ≤ 10 ^ ds.length * 10 := by
      have h1 : (d + 1) * 10 ^ ds.length ≤ 10 * 10 ^ ds.length :=
        Nat.mul_le_mul_right _ hd
      rw [Nat.succ_mul] at h1
      rw [Nat.mul_comm (10 ^ ds.length)]
      exact h1
    omega

theorem val_ge_pow {d : Nat} {ds : List Nat} (hd : 0 < d) :
    10 ^ ds.length ≤ val (d :: ds) := by
  simp only [val]
  have : 1 * 10 ^ ds.length ≤ d * 10 ^ ds.length := Nat.mul_le_mul_right _ hd
  omega

theorem val_dropWhile (l : List Nat) : val (l.dropWhile (· == 0)) = val l := by
  induction l with
  | nil => rfl
  | cons d ds ih =>
    rw [List.dropWhile_cons]
    by_cases h : d = 0
    · subst h; simp [val, ih]
    · have : (d == 0) = false := by simp [h]
      simp [this]

theorem digits_dropWhile {l : List Nat} (h : Digits l) :
    Digits (l.dropWhile (· == 0)) :=
  fun d hd => h d (List.dropWhile_sublist _ |>.subset hd)

theorem dropWhile_head {l : List Nat} :
    ∀ d ds, l.dropWhile (· == 0) = d :: ds → d ≠ 0 := by
  induction l with
  | nil => intro d ds h; simp at h
  | cons x xs ih =>
    intro d ds h
    rw [List.dropWhile_cons] at h
    by_cases hx : x = 0
    · subst hx; simp at h; exact ih d ds h
    · have : (x == 0) = false := by simp [hx]
      simp [this] at h
      omega

/-- A normalized id: `[0]`, or a nonempty list with a nonzero leading digit. -/
def Norm (l : List Nat) : Prop :=
  l = [0] ∨ ∃ d ds, l = d :: ds ∧ d ≠ 0

theorem strip_props {l : List Nat} (h : Digits l) :
    val (strip l) = val l ∧ Digits (strip l) ∧ Norm (strip l) ∧
      0 < (strip l).length := by
  have hv := val_dropWhile l
  have hd := digits_dropWhile h
  have hh := @dropWhile_head l
  cases hdw : l.dropWhile (· == 0) with
  | nil =>
    rw [hdw] at hv
    simp only [strip, hdw]
    refine ⟨by simp [val] at hv ⊢; omega, ?_, Or.inl rfl, by simp⟩
    intro d hd'; simp at hd'; omega
  | cons d ds =>
    rw [hdw] at hv hd
    simp only [strip, hdw]
    exact ⟨hv, hd, Or.inr ⟨d, ds, rfl, hh d ds hdw⟩, by simp⟩

theorem lexCmp_eq_len {a b : List Nat} (ha : Digits a) (hb : Digits b)
    (hl : a.length = b.length) : lexCmp a b = ordOf (val a) (val b) := by
  induction a generalizing b with
  | nil =>
    cases b with
    | nil => simp [lexCmp, ordOf, val]
    | cons => simp at hl
  | cons x xs ih =>
    cases b with
    | nil => simp at hl
    | cons y ys =>
      simp only [List.length_cons, Nat.add_right_cancel_iff] at hl
      have hx : x < 10 := ha x (by simp)
      have hy : y < 10 := hb y (by simp)
      have hxs : Digits xs := fun d hd => ha d (by simp [hd])
      have hys : Digits ys := fun d hd => hb d (by simp [hd])
      have vx := val_lt_pow hxs
      have vy := val_lt_pow hys
      have ih' := ih hxs hys hl
      rw [← hl] at vy
      simp only [lexCmp, val, ← hl]
      generalize hP : 10 ^ xs.length = P at vx vy
      by_cases hxy : x < y
      · have h1 : (x + 1) * P ≤ y * P := Nat.mul_le_mul_right _ hxy
        rw [Nat.succ_mul] at h1
        have hlt : x * P + val xs < y * P + val ys := by omega
        simp [ordOf, hxy, hlt]
      · by_cases hyx : y < x
        · have h1 : (y + 1) * P ≤ x * P := Nat.mul_le_mul_right _ hyx
          rw [Nat.succ_mul] at h1
          have hgt : y * P + val ys < x * P + val xs := by omega
          have hnlt : ¬ x * P + val xs < y * P + val ys := by omega
          simp [ordOf, hxy, hyx, hgt, hnlt]
        · have hxy' : x = y := by omega
          subst hxy'
          simp only [hxy, ite_false, ih', ordOf]
          by_cases h2 : val xs < val ys
          · simp [h2]
          · by_cases h3 : val ys < val xs
            · simp [h2, h3]
            · simp [h2, h3]

/-- **Theorem (sync-id order).** On wire-valid sync ids, `compareSyncId` is
exactly numeric comparison, including leading zeros and ids beyond 2^53. -/
theorem compareSyncId_numeric {a b : List Nat} (ha : Digits a) (hb : Digits b) :
    compareSyncId a b = ordOf (val a) (val b) := by
  obtain ⟨va, da, na, la⟩ := strip_props ha
  obtain ⟨vb, db, nb, lb⟩ := strip_props hb
  simp only [compareSyncId]
  rw [← va, ← vb]
  generalize strip a = a' at *
  generalize strip b = b' at *
  have ha' := val_lt_pow da
  have hb' := val_lt_pow db
  by_cases h1 : a'.length < b'.length
  · -- b' has ≥ 2 digits, so it has a nonzero leading digit
    have hbig : 10 ^ a'.length ≤ val b' := by
      rcases nb with h | ⟨d, ds, rfl, hd⟩
      · rw [h] at h1; simp only [List.length_cons, List.length_nil] at h1; omega
      · have := val_ge_pow (ds := ds) (Nat.pos_of_ne_zero hd)
        simp at h1
        exact Nat.le_trans (Nat.pow_le_pow_right (by decide) (by omega)) this
    have hlt : val a' < val b' := by omega
    simp [h1, ordOf, hlt]
  · by_cases h2 : b'.length < a'.length
    · have hbig : 10 ^ b'.length ≤ val a' := by
        rcases na with h | ⟨d, ds, rfl, hd⟩
        · rw [h] at h2; simp only [List.length_cons, List.length_nil] at h2; omega
        · have := val_ge_pow (ds := ds) (Nat.pos_of_ne_zero hd)
          simp at h2
          exact Nat.le_trans (Nat.pow_le_pow_right (by decide) (by omega)) this
      have hlt : val b' < val a' := by omega
      have hnlt : ¬ val a' < val b' := by omega
      simp [h1, h2, ordOf, hlt, hnlt]
    · simp only [h1, h2, ite_false]
      exact lexCmp_eq_len da db (by omega)

/-- Why the length check matters: plain string order says "9" > "10". -/
theorem naive_string_order_is_wrong :
    lexCmp [9] [1, 0] = .gt ∧ ordOf (val [9]) (val [1, 0]) = .lt := by decide

/-- Leading zeros compare equal to their canonical form. -/
example : compareSyncId [0, 0, 7] [7] = .eq := by decide

/-! ## 2. `SyncCursor.advance`

`advance(x)` is two atomic steps separated by an await: (a) guard + set the
in-memory `_lastSyncId` and build the meta object, (b) the storage write lands.
The packet queue + state lock serialize callers, so (b) of one call lands
before (a) of the next. -/

structure Cursor where
  mem : Nat
  persisted : Nat
deriving DecidableEq, Repr

def advance (c : Cursor) (x : Nat) : Cursor :=
  if c.mem < x then { mem := x, persisted := x } else c

/-- **Theorem (cursor).** Over any sequence of serialized `advance` calls the
persisted cursor never regresses, never exceeds memory, and ends at the max. -/
theorem advance_seq (c : Cursor) (xs : List Nat) (h : c.persisted ≤ c.mem) :
    let c' := xs.foldl advance c
    c.persisted ≤ c'.persisted ∧ c'.persisted ≤ c'.mem ∧ c.mem ≤ c'.mem ∧
      ∀ x ∈ xs, x ≤ c'.mem := by
  induction xs generalizing c with
  | nil => simp [h]
  | cons x xs ih =>
    simp only [List.foldl_cons]
    have h' : (advance c x).persisted ≤ (advance c x).mem := by
      unfold advance; split <;> simp_all
    obtain ⟨a, b, d, e⟩ := ih (advance c x) h'
    have hx : x ≤ (advance c x).mem ∧ c.mem ≤ (advance c x).mem ∧
        c.persisted ≤ (advance c x).persisted := by
      unfold advance; split <;> simp_all <;> omega
    refine ⟨by omega, b, by omega, ?_⟩
    intro y hy
    simp at hy
    rcases hy with rfl | hy
    · omega
    · exact e y hy

/-- The serialization is load-bearing: if two `advance` calls overlapped and
the storage writes landed out of order, the persisted cursor would regress.
(Writes: 110 issued, 120 issued, 120 lands, 110 lands.) -/
theorem advance_needs_serialization :
    let issued : List Nat := [110, 120]          -- meta objects built in order
    let landed := issued.reverse                  -- writes complete in reverse
    landed.foldl (fun _ x => x) 100 = 110 ∧ issued.foldl max 100 = 120 := by
  decide

/-! ## 3. Packet ingestion under arbitrary interleavings

The server log `L` is the strictly increasing list of sync ids visible to this
client. A packet for the range `(lo, hi]` carries exactly `window L lo hi`
and `lastSyncId = hi` (this is what `DeltaService.fetchDeltas` returns, and
what the transport contract requires of `subscribe`).

`applyDeltaPacket` drops actions with `id ≤ cursor`, applies the rest in
order, then `advance(lastSyncId)`; an all-stale packet goes to
`handleEmptyPacket`, which advances the same way. While a group-change
re-bootstrap is owed (latched) nothing is applied and the cursor holds. -/

def window (L : List Nat) (lo hi : Nat) : List Nat :=
  L.filter (fun x => decide (lo < x ∧ x ≤ hi))

structure St where
  cursor : Nat
  applied : List Nat
  latched : Bool

def applyPacket (s : St) (acts : List Nat) (last : Nat) : St :=
  if s.latched then s
  else { s with
    applied := s.applied ++ acts.filter (fun x => decide (s.cursor < x))
    cursor := max s.cursor last }

theorem filter_window (L : List Nat) {a b c : Nat} (h : a ≤ c) :
    (window L a b).filter (fun x => decide (c < x)) = window L c b := by
  unfold window
  rw [List.filter_filter]
  apply List.filter_congr
  intro x _
  by_cases hc : c < x <;> by_cases hb : x ≤ b <;> simp [hc, hb] <;> omega

theorem window_empty (L : List Nat) {b c : Nat} (h : b ≤ c) :
    window L c b = [] := by
  unfold window
  rw [List.filter_eq_nil_iff]
  intro x _
  simp; omega

theorem window_split {L : List Nat} (hL : L.Pairwise (· < ·)) {lo c d : Nat}
    (h1 : lo ≤ c) (h2 : c ≤ d) :
    window L lo c ++ window L c d = window L lo d := by
  induction L with
  | nil => rfl
  | cons x r ih =>
    rw [List.pairwise_cons] at hL
    obtain ⟨hx, hr⟩ := hL
    have ih' := ih hr
    unfold window at ih' ⊢
    simp only [List.filter_cons]
    by_cases hc : x ≤ c
    · by_cases hlo : lo < x
      · have e1 : decide (lo < x ∧ x ≤ c) = true := by simp; omega
        have e2 : decide (c < x ∧ x ≤ d) = false := by simp; omega
        have e3 : decide (lo < x ∧ x ≤ d) = true := by simp; omega
        simp only [e1, e2, e3, List.cons_append, Bool.false_eq_true, ite_true, ite_false]
        rw [ih']
      · have e1 : decide (lo < x ∧ x ≤ c) = false := by simp; omega
        have e2 : decide (c < x ∧ x ≤ d) = false := by simp; omega
        have e3 : decide (lo < x ∧ x ≤ d) = false := by simp; omega
        simp only [e1, e2, e3, Bool.false_eq_true, ite_false]
        exact ih'
    · -- every later id is > x > c, so the left window of `r` is empty
      have hnil : r.filter (fun y => decide (lo < y ∧ y ≤ c)) = [] := by
        rw [List.filter_eq_nil_iff]
        intro y hy; have := hx y hy; simp; omega
      have hcong : r.filter (fun y => decide (lo < y ∧ y ≤ d)) =
          r.filter (fun y => decide (c < y ∧ y ≤ d)) := by
        apply List.filter_congr
        intro y hy; have := hx y hy
        by_cases hyd : y ≤ d <;> simp [hyd] <;> omega
      have e1 : decide (lo < x ∧ x ≤ c) = false := by simp; omega
      by_cases hd : x ≤ d
      · have e2 : decide (c < x ∧ x ≤ d) = true := by simp; omega
        have e3 : decide (lo < x ∧ x ≤ d) = true := by simp; omega
        simp only [e1, e2, e3, hnil, hcong]
        simp
      · have e2 : decide (c < x ∧ x ≤ d) = false := by simp; omega
        have e3 : decide (lo < x ∧ x ≤ d) = false := by simp; omega
        simp only [e1, e2, e3, hnil, hcong]
        simp

/-- Core step: a packet for `(a, b]` with `a ≤ cursor` extends the applied
prefix `(c0, cursor]` to exactly `(c0, max cursor b]`. -/
theorem apply_extends_prefix {L : List Nat} (hL : L.Pairwise (· < ·))
    {c0 a b c : Nat} (h0 : c0 ≤ c) (ha : a ≤ c) :
    window L c0 c ++ (window L a b).filter (fun x => decide (c < x)) =
      window L c0 (max c b) := by
  rw [filter_window L ha]
  by_cases hb : b ≤ c
  · rw [window_empty L hb, List.append_nil, Nat.max_eq_left hb]
  · rw [window_split hL h0 (by omega), Nat.max_eq_right (by omega)]

/-- Events of the whole client, in any order. `produce lo hi` is any packet
source (live stream, catch-up page/merged buffer, syncNow, resubscribe,
redelivery, duplicate) creating an in-flight packet `(lo, hi]` whose starting
point `lo` it read from the cursor or from its own previous, already applied
packet (so `lo ≤ cursor`). `apply i` runs the `i`-th in-flight packet through
`applyDeltaPacket` — any order, which subsumes the FIFO packet queue.
`groupAction` latches `groupChangePending`; `bootstrap S` is a snapshot at
server head `S ≥ cursor` that clears the latch. -/
inductive Ev
  | produce (lo hi : Nat)
  | apply (i : Nat)
  | groupAction
  | bootstrap (S : Nat)

structure Sys where
  st : St
  inflight : List (Nat × Nat)

def step (L : List Nat) (c0 : Nat) (sys : Sys) : Ev → Sys
  | .produce lo hi =>
    if c0 ≤ lo ∧ lo ≤ sys.st.cursor then
      { sys with inflight := (lo, hi) :: sys.inflight }
    else sys
  | .apply i =>
    match sys.inflight[i]? with
    | some (lo, hi) =>
      { st := applyPacket sys.st (window L lo hi) hi
        inflight := sys.inflight.eraseIdx i }
    | none => sys
  | .groupAction => { sys with st := { sys.st with latched := true } }
  | .bootstrap S =>
    if sys.st.cursor ≤ S then
      { sys with st := { cursor := S, applied := window L c0 S, latched := false } }
    else sys

def Inv (L : List Nat) (c0 : Nat) (sys : Sys) : Prop :=
  sys.st.applied = window L c0 sys.st.cursor ∧ c0 ≤ sys.st.cursor ∧
    ∀ p ∈ sys.inflight, c0 ≤ p.1 ∧ p.1 ≤ sys.st.cursor

theorem step_inv {L : List Nat} (hL : L.Pairwise (· < ·)) {c0 : Nat} {sys : Sys}
    (h : Inv L c0 sys) (e : Ev) : Inv L c0 (step L c0 sys e) := by
  obtain ⟨happ, hc0, hin⟩ := h
  cases e with
  | produce lo hi =>
    simp only [step]
    split
    · next hg =>
      refine ⟨happ, hc0, ?_⟩
      intro p hp
      simp at hp
      rcases hp with rfl | hp
      · exact hg
      · exact hin p hp
    · exact ⟨happ, hc0, hin⟩
  | apply i =>
    simp only [step]
    split
    · next lo hi hget =>
      have hmem := List.mem_of_getElem? hget
      obtain ⟨hlo0, hlo⟩ := hin _ hmem
      simp only [applyPacket]
      split
      · refine ⟨happ, hc0, ?_⟩
        intro p hp; exact hin p (List.mem_of_mem_eraseIdx hp)
      · refine ⟨?_, by simp; omega, ?_⟩
        · simp only [happ]
          exact apply_extends_prefix hL hc0 hlo
        · intro p hp
          have := hin p (List.mem_of_mem_eraseIdx hp)
          simp; omega
    · exact ⟨happ, hc0, hin⟩
  | groupAction => exact ⟨happ, hc0, hin⟩
  | bootstrap S =>
    simp only [step]
    split
    · next hS =>
      refine ⟨rfl, by simp; omega, ?_⟩
      intro p hp; have := hin p hp; simp; omega
    · exact ⟨happ, hc0, hin⟩

def run (L : List Nat) (c0 : Nat) (sys : Sys) (evs : List Ev) : Sys :=
  evs.foldl (step L c0) sys

def init (c0 : Nat) : Sys := { st := { cursor := c0, applied := [], latched := false }, inflight := [] }

theorem init_inv (L : List Nat) (c0 : Nat) : Inv L c0 (init c0) := by
  refine ⟨?_, Nat.le_refl _, by simp [init]⟩
  simp only [init]
  exact (window_empty L (Nat.le_refl c0)).symm

theorem run_inv {L : List Nat} (hL : L.Pairwise (· < ·)) (c0 : Nat) (evs : List Ev) :
    ∀ sys, Inv L c0 sys → Inv L c0 (run L c0 sys evs) := by
  induction evs with
  | nil => intro sys h; exact h
  | cons e es ih => intro sys h; exact ih _ (step_inv hL h e)

/-- **Theorem (exactly-once, in order).** For every interleaving of packet
sources, group actions and bootstraps, the applied sync ids are exactly the
server log in `(c0, cursor]`: strictly increasing (so nothing is applied twice
and nothing out of order) and complete (nothing skipped). -/
theorem ingestion_exactly_once {L : List Nat} (hL : L.Pairwise (· < ·))
    (c0 : Nat) (evs : List Ev) :
    let s := (run L c0 (init c0) evs).st
    s.applied.Pairwise (· < ·) ∧
      (∀ x ∈ L, c0 < x → x ≤ s.cursor → x ∈ s.applied) ∧
      (∀ x ∈ s.applied, x ∈ L ∧ c0 < x ∧ x ≤ s.cursor) := by
  obtain ⟨happ, _, _⟩ := run_inv hL c0 evs _ (init_inv L c0)
  refine ⟨?_, ?_, ?_⟩
  · rw [happ]; exact hL.filter _
  · intro x hx h1 h2; rw [happ]; unfold window; simp [List.mem_filter, hx, h1, h2]
  · intro x hx; rw [happ] at hx; unfold window at hx
    simp [List.mem_filter] at hx; exact ⟨hx.1, hx.2.1, hx.2.2⟩

/-- **Theorem (cursor monotone).** No event moves the cursor backwards. -/
theorem step_cursor_monotone (L : List Nat) (c0 : Nat) (sys : Sys) (e : Ev) :
    sys.st.cursor ≤ (step L c0 sys e).st.cursor := by
  cases e with
  | produce lo hi => simp only [step]; split <;> simp
  | apply i =>
    simp only [step]; split
    · simp only [applyPacket]; split <;> simp <;> omega
    · simp
  | groupAction => simp [step]
  | bootstrap S => simp only [step]; split <;> simp_all

/-- **Theorem (latch).** While a group-change re-bootstrap is owed, applying
any packet changes nothing (the cursor cannot pass the group action). -/
theorem latched_apply_noop (s : St) (acts : List Nat) (last : Nat)
    (h : s.latched = true) : applyPacket s acts last = s := by
  simp [applyPacket, h]

/-- The contract this relies on: every source must start at or below the
cursor. A source that started at the server head (live-only stream, no
replay) racing a catch-up would skip history: stream (2,3] applied first, then
catch-up (0,2] is entirely filtered as stale. Ids 1 and 2 are lost. This is
why `TransportAdapter.subscribe` must replay from `afterSyncId`. -/
theorem noncontiguous_source_skips :
    let L := [1, 2, 3]
    let s0 : St := { cursor := 0, applied := [], latched := false }
    let s1 := applyPacket s0 (window L 2 3) 3
    let s2 := applyPacket s1 (window L 0 2) 2
    s2.applied = [3] ∧ s2.cursor = 3 := by decide

/-! ## 4. Crash safety of `applyDeltaPacket`

The durable/visible effects of one packet `(lo, hi]` in code order, one atomic
step per await. `rows`/`maps` = the log prefix reflected in storage rows /
identity maps; `mem`/`persisted` = cursor in memory / in meta.

A throw (or crash) at any await stops the sequence. After a throw the session
keeps its in-memory state and resubscribes/catches up from `mem`, which
redelivers the packet only if `mem < hi`; after a crash the restart reloads
the maps from storage and resumes from `persisted`. -/

structure Durable where
  rows : Nat
  mem : Nat
  persisted : Nat
  maps : Nat

inductive Op
  | addSyncActions | rebaseOutbox | coverage
  | writeBatch (hi : Nat)      -- collectDeferredDeltaOps → storage.writeBatch
  | advanceMem (hi : Nat)      -- cursor.advance: guard + set `_lastSyncId`
  | persistMeta                -- cursor.advance: storage.setMeta lands
  | pruneSyncActions | confirmOutbox | completeOutbox | readPending | readMeta
  | identityBatch (hi : Nat)   -- identityMaps.batch(...)

def exec (d : Durable) : Op → Durable
  | .writeBatch hi => { d with rows := max d.rows hi }
  | .advanceMem hi => { d with mem := max d.mem hi }
  | .persistMeta => { d with persisted := d.mem }
  | .identityBatch hi => { d with maps := max d.maps hi }
  | _ => d

/-- Original order: the cursor was advanced and persisted right after the row
write, before the outbox steps, `getMeta` and the identity-map batch. -/
def packetOpsOld (hi : Nat) : List Op :=
  [.addSyncActions, .rebaseOutbox, .coverage, .writeBatch hi, .advanceMem hi,
   .persistMeta, .pruneSyncActions, .confirmOutbox, .completeOutbox,
   .readPending, .readMeta, .identityBatch hi]

/-- Fixed order: the cursor moves only once the identity-map batch has run
(`completeOutbox` is told the target cursor explicitly). -/
def packetOps (hi : Nat) : List Op :=
  [.addSyncActions, .rebaseOutbox, .coverage, .writeBatch hi, .confirmOutbox,
   .completeOutbox, .readPending, .readMeta, .identityBatch hi, .advanceMem hi,
   .persistMeta, .pruneSyncActions]

def DInv (d : Durable) : Prop := d.persisted ≤ d.mem ∧ d.mem ≤ d.rows

/-- **Theorem (durability).** Crash (or throw) after any number of steps of a
packet: the persisted cursor never passes rows that are durably written, so a
restart re-fetches from a point whose effects are all on disk. -/
theorem crash_safe (d : Durable) (hi : Nat) (h : DInv d) :
    ∀ k, DInv (((packetOps hi).take k).foldl exec d) := by
  obtain ⟨h1, h2⟩ := h
  intro k
  match k with
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 =>
    simp [packetOps, exec, DInv] <;> omega
  | k + 12 =>
    have : (packetOps hi).take (k + 12) = packetOps hi := by
      simp [packetOps]
    rw [this]; simp [packetOps, exec, DInv]; omega

/-- The original order was crash-safe too; its problem was the maps. -/
theorem crash_safe_old (d : Durable) (hi : Nat) (h : DInv d) :
    ∀ k, DInv (((packetOpsOld hi).take k).foldl exec d) := by
  obtain ⟨h1, h2⟩ := h
  intro k
  match k with
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 =>
    simp [packetOpsOld, exec, DInv] <;> omega
  | k + 12 =>
    have : (packetOpsOld hi).take (k + 12) = packetOpsOld hi := by
      simp [packetOpsOld]
    rw [this]; simp [packetOpsOld, exec, DInv]; omega

/-- **BUG (fixed).** In the original order the cursor was advanced (and
persisted) before the identity-map batch. If a step in between throws (an
outbox storage write in `confirmFromActions`, `getMeta`), storage and cursor
are correct but the in-memory maps lag the cursor, and the resubscribe from
that cursor never redelivers the packet: the maps stay behind until the next
reload. Regression test: `delta-pipeline-integrity.test.ts`. -/
theorem bug_maps_lag_after_post_advance_throw :
    let d0 : Durable := { rows := 10, mem := 10, persisted := 10, maps := 10 }
    -- ops up to and including persistMeta, pruneSyncActions; confirmOutbox throws
    let d1 := ((packetOpsOld 20).take 7).foldl exec d0
    d1.persisted = 20 ∧ d1.rows = 20 ∧ d1.maps = 10 ∧ d1.maps < d1.mem ∧
      -- redelivery of the same packet is fully filtered as stale
      (window [11, 20] d1.mem 20) = [] := by decide

/-- **Theorem (maps never lag, fixed).** Throw after any number of steps of
the fixed order: the in-memory cursor never passes the identity maps, while
the durability invariant still holds. So either the cursor is still below the
packet (it is redelivered and re-applied) or the maps already reflect it. -/
theorem maps_never_lag (d : Durable) (hi : Nat) (h : DInv d)
    (hm : d.mem ≤ d.maps) :
    ∀ k, let d' := ((packetOps hi).take k).foldl exec d
      DInv d' ∧ d'.mem ≤ d'.maps := by
  obtain ⟨h1, h2⟩ := h
  intro k
  match k with
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 =>
    simp [packetOps, exec, DInv] <;> omega
  | k + 12 =>
    have : (packetOps hi).take (k + 12) = packetOps hi := by
      simp [packetOps]
    rw [this]; simp [packetOps, exec, DInv]; omega

/-- Corollary: after a throw at any step, either the packet's range is still
ahead of the cursor (redelivered) or the maps cover it. -/
theorem throw_redelivers_or_maps_cover (d : Durable) (hi : Nat) (h : DInv d)
    (hm : d.mem ≤ d.maps) (k : Nat) :
    let d' := ((packetOps hi).take k).foldl exec d
    d'.mem < hi ∨ hi ≤ d'.maps := by
  have := (maps_never_lag d hi h hm k).2
  omega

/-- A completed packet leaves every component at (at least) `hi`. -/
theorem packet_completes (d : Durable) (hi : Nat) :
    let d' := (packetOps hi).foldl exec d
    hi ≤ d'.rows ∧ hi ≤ d'.mem ∧ hi ≤ d'.persisted ∧ hi ≤ d'.maps := by
  simp [packetOps, exec]; omega

/-! ## 5. BUG: stale catch-up buffer flushed into the next run

`fetchAndApplyDeltaPages` buffers `hasMore` pages and flushes them as one
packet. On a returned page it checks the run token and drops the buffer
(line "Drop the buffer: the cursor never advanced..."). But `fetchDeltaPage`
returns `null` both when the fetch fails with `suppressFetchErrors` and when
the run is no longer active, and the `null` branch flushed unconditionally.
`enqueueDeltaPacket` only checks `isRunning()`, which is true again once the
next `start()` ran — so run 1's buffer was applied inside run 2 (possibly
while run 2 is bootstrapping, with different groups or a different store).

Concrete trace: page 1 (hasMore) buffered; `stop()`+`start()`; the in-flight
page-2 fetch rejects (transport closed) → `null` → flush into run 2. -/

inductive FEv
  | page (acts : List Nat) (hasMore : Bool)
  | fail          -- fetchDeltaPage → null (suppressed error or inactive run)
  | restart       -- stop() + start(): new run token, running again

structure FSt where
  token : Nat
  buf : List Nat
  done : Bool
  /-- (run whose catch-up fetched the data, run in which it was applied) -/
  applied : List (Nat × Nat)

/-- `flush()` followed by `enqueueDeltaPacket` (which only checks `isRunning`). -/
def flush (fixed : Bool) (own : Nat) (s : FSt) : FSt :=
  if fixed && own != s.token then { s with buf := [] }
  else if s.buf.isEmpty then s
  else { s with buf := [], applied := s.applied ++ [(own, s.token)] }

def fstep (fixed : Bool) (own : Nat) (s : FSt) : FEv → FSt
  | .restart => { s with token := s.token + 1 }
  | .page acts more =>
    if s.done then s
    else if own != s.token then { s with buf := [], done := true }
    else if more then { s with buf := s.buf ++ acts }
    else { flush fixed own { s with buf := s.buf ++ acts } with done := true }
  | .fail => if s.done then s else { flush fixed own s with done := true }

def frun (fixed : Bool) (own : Nat) (evs : List FEv) : FSt :=
  evs.foldl (fstep fixed own) { token := own, buf := [], done := false, applied := [] }

theorem bug_stale_catchup_flushed_into_next_run :
    (frun false 1 [.page [11] true, .restart, .fail]).applied = [(1, 2)] := by decide

theorem flush_same_run (own : Nat) (s : FSt) (h : ∀ p ∈ s.applied, p.1 = p.2) :
    ∀ p ∈ (flush true own s).applied, p.1 = p.2 := by
  unfold flush
  by_cases h1 : own = s.token
  · subst h1
    simp only [bne_self_eq_false, Bool.and_false, Bool.false_eq_true, ite_false]
    split
    · exact h
    · intro p hp; simp at hp; rcases hp with hp | rfl
      · exact h p hp
      · rfl
  · have : (true && own != s.token) = true := by simp [h1]
    simp only [this, ite_true]; exact h

theorem fstep_same_run (own : Nat) (s : FSt) (e : FEv)
    (h : ∀ p ∈ s.applied, p.1 = p.2) :
    ∀ p ∈ (fstep true own s e).applied, p.1 = p.2 := by
  cases e with
  | restart => exact h
  | page acts more =>
    simp only [fstep]
    split
    · exact h
    · split
      · exact h
      · split
        · exact h
        · exact flush_same_run own _ h
  | fail =>
    simp only [fstep]
    split
    · exact h
    · exact flush_same_run own _ h

/-- **Theorem (fixed).** With the run-token check inside `flush`, a catch-up
only ever applies data in the run that fetched it, for every interleaving of
pages, failures and restarts. -/
theorem fixed_catchup_never_crosses_runs (own : Nat) (evs : List FEv) :
    ∀ p ∈ (frun true own evs).applied, p.1 = p.2 := by
  unfold frun
  suffices ∀ s : FSt, (∀ p ∈ s.applied, p.1 = p.2) →
      ∀ p ∈ (evs.foldl (fstep true own) s).applied, p.1 = p.2 by
    exact this _ (by simp)
  induction evs with
  | nil => intro s h; exact h
  | cons e es ih => intro s h; exact ih _ (fstep_same_run own s e h)

/-- The fix keeps same-run behaviour: a later page failing inside the same run
still flushes the buffered pages. -/
theorem fixed_same_run_failure_still_flushes :
    (frun true 1 [.page [11] true, .fail]).applied = [(1, 1)] := by decide

/-! ## 6. BUG: stale continuations checked `isRunning()` after an await

`bootstrapAndResume` (after `processOutboxTransactions`) and the stream-end
branch of `processDeltaStream` (after `subscription.next()`) checked
`isRunning()`. A `stop()` + `start()` during the await makes that true again,
so the previous run's continuation opened a subscription / set the state in
the next run. The fix checks `isRunActive(runToken)` for the token the
continuation was started under. Regression test:
`delta-pipeline-run-token.test.ts`. -/

inductive REv
  | stop
  | start
  /-- The continuation resumes after its await and runs its guarded effect. -/
  | resume

structure RSt where
  token : Nat
  running : Bool
  /-- (run that started the continuation, run in which its effect landed) -/
  acted : List (Nat × Nat)

def guardOk (bound : Bool) (own : Nat) (s : RSt) : Bool :=
  if bound then s.running && own == s.token else s.running

def rstep (bound : Bool) (own : Nat) (s : RSt) : REv → RSt
  | .stop => { s with running := false }
  | .start => { s with token := s.token + 1, running := true }
  | .resume =>
    if guardOk bound own s then { s with acted := s.acted ++ [(own, s.token)] }
    else s

def rrun (bound : Bool) (own : Nat) (evs : List REv) : RSt :=
  evs.foldl (rstep bound own) { token := own, running := true, acted := [] }

theorem bug_stale_continuation_acts_in_next_run :
    (rrun false 1 [.stop, .start, .resume]).acted = [(1, 2)] := by decide

theorem rstep_same_run (own : Nat) (s : RSt) (e : REv)
    (h : ∀ p ∈ s.acted, p.1 = p.2) :
    ∀ p ∈ (rstep true own s e).acted, p.1 = p.2 := by
  cases e with
  | stop => exact h
  | start => exact h
  | resume =>
    simp only [rstep, guardOk, ite_true]
    split
    · next hg =>
      intro p hp
      simp at hp
      rcases hp with hp | rfl
      · exact h p hp
      · simp at hg; exact hg.2
    · exact h

/-- **Theorem (fixed).** Bound to the run token, a continuation's effect only
ever lands in the run that started it, for every interleaving of stops,
starts and resumes. -/
theorem bound_continuation_never_crosses_runs (own : Nat) (evs : List REv) :
    ∀ p ∈ (rrun true own evs).acted, p.1 = p.2 := by
  unfold rrun
  suffices ∀ s : RSt, (∀ p ∈ s.acted, p.1 = p.2) →
      ∀ p ∈ (evs.foldl (rstep true own) s).acted, p.1 = p.2 by
    exact this _ (by simp)
  induction evs with
  | nil => intro s h; exact h
  | cons e es ih => intro s h; exact ih _ (rstep_same_run own s e h)

/-- The fix keeps same-run behaviour: resuming inside the same run still acts. -/
theorem bound_same_run_still_acts :
    (rrun true 1 [.resume]).acted = [(1, 1)] := by decide

/-! ## 7. BUG: an update for an absent row staged a stub

An update (`U`) carries only the changed fields. The staging `patch` in
`createStagingDeltaTarget` wrote `{ ...changes, id }` when no base row was
stored (a partially loaded model that never fetched the row, or a row deleted
earlier in the same packet), persisting and hydrating a row missing every
other field. Deltas apply only to loaded instances, so the fix skips the
patch when the base row is absent. Rows are modelled by the set of fields they
carry; a row is complete when it carries every schema field. Regression test:
`delta-pipeline-integrity.test.ts`. -/

abbrev Store := Nat → Option (List Nat)

inductive RowAct
  | ins (id : Nat)                    -- `I`: the server sends the full row
  | upd (id : Nat) (changes : List Nat)
  | del (id : Nat)

def setRow (st : Store) (id : Nat) (r : Option (List Nat)) : Store :=
  fun j => if j = id then r else st j

def applyRow (fixed : Bool) (F : List Nat) (st : Store) : RowAct → Store
  | .ins id => setRow st id (some F)
  | .del id => setRow st id none
  | .upd id changes =>
    match st id with
    | some r => setRow st id (some (r ++ changes))
    | none => if fixed then st else setRow st id (some changes)

def Complete (F : List Nat) (st : Store) : Prop :=
  ∀ id r, st id = some r → ∀ f ∈ F, f ∈ r

theorem bug_update_on_absent_row_stages_stub :
    let st := applyRow false [0, 1] (fun _ => none) (.upd 7 [1])
    st 7 = some [1] ∧ ¬ (0 ∈ [1]) := by decide

theorem applyRow_complete (F : List Nat) (st : Store) (a : RowAct)
    (h : Complete F st) : Complete F (applyRow true F st a) := by
  intro id r hr f hf
  cases a with
  | ins j =>
    simp only [applyRow, setRow] at hr
    split at hr
    · cases hr; exact hf
    · exact h id r hr f hf
  | del j =>
    simp only [applyRow, setRow] at hr
    split at hr
    · cases hr
    · exact h id r hr f hf
  | upd j changes =>
    cases hst : st j with
    | some r0 =>
      simp only [applyRow, hst, setRow] at hr
      split at hr
      · next hj =>
        cases hr
        subst hj
        exact List.mem_append_left _ (h _ r0 hst f hf)
      · exact h id r hr f hf
    | none =>
      simp only [applyRow, hst, ite_true] at hr
      exact h id r hr f hf

/-- **Theorem (fixed).** Starting from a store of complete rows, every row
stays complete under any sequence of inserts, updates and deletes. -/
theorem fixed_rows_stay_complete (F : List Nat) (acts : List RowAct) :
    ∀ st : Store, Complete F st → Complete F (acts.foldl (applyRow true F) st) := by
  induction acts with
  | nil => intro st h; exact h
  | cons a as ih => intro st h; exact ih _ (applyRow_complete F st a h)

/-- The fix still merges an update into a stored row (here one inserted
earlier in the same packet). -/
theorem fixed_update_after_insert_merges :
    (([RowAct.ins 7, .upd 7 [1]].foldl (applyRow true [0, 1]) (fun _ => none)) 7)
      = some [0, 1, 1] := by decide

end StrataSync.DeltaPipeline
