# Lean models

Formal models of stratasync's sync algorithms, written in Lean 4 with no
dependencies beyond core. Each module mirrors one subsystem, states the
invariants the TypeScript code relies on, and proves them. When a property
failed to hold, the module keeps a `bug_*` theorem that proves the
counterexample on the original model, alongside the fixed model and its
proof. Every counterexample has a matching vitest regression test.

```bash
# Install elan once: https://github.com/leanprover/elan
cd verification/lean
lake build
```

No module uses `sorry`, `axiom`, or `native_decide`.

| Module          | Code it models                                                                                                                                              | Main results                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DeltaPipeline` | `client/src/sync/{delta-pipeline,cursor}.ts`, `core/src/sync/sync-id.ts`                                                                                    | Sync-id comparison equals numeric order; deltas apply exactly once, in order, under any mix of sources; the cursor is monotone and crash-safe; stale catch-up pages never cross runs             |
| `Outbox`        | `client/src/outbox-manager.ts`                                                                                                                              | Deliveries are a prefix of the queue after transport failures; no transaction is sent twice when a reconnect drain races the batch timer; server dedup applies each transaction once             |
| `Rebase`        | `core/src/sync/rebase.ts`, `core/src/transaction/create.ts`, `client/src/{history-manager,identity-map}.ts`                                                 | Field merges commute; rollback after any number of packets restores the server row; undo/redo are inverses; identity-map LRU stays well-formed                                                   |
| `Orchestrator`  | `client/src/sync-orchestrator.ts`, `client/src/sync/bootstrap-runner.ts`, `client/src/internal/{gate,async-queue}.ts`, `transport-graphql/src/websocket.ts` | Continuations from a cancelled run are inert; at most one live subscription and one live socket; gate and queue are FIFO with no lost wakeups or wedging                                         |
| `Server`        | `server/src/**`                                                                                                                                             | AsyncMutex exclusion and FIFO; subscribe/replay/live handoff delivers exactly C+1..n; commit-order publishing; concurrent duplicate submissions dedupe; keyset pagination never skips or repeats |

The models are hand-written abstractions, not extracted from the
TypeScript. They catch design-level races and ordering bugs; they do not
prove the TypeScript matches the model. Keep them in sync when the
algorithms they describe change.
