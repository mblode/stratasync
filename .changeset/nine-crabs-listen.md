---
"@stratasync/core": minor
"@stratasync/client": minor
---

Make a sync run reproducible. `SyncRuntime` collects the three ambient sources the engine used to read directly — `Date.now()`, `setTimeout`, and `crypto.randomUUID` — behind one injectable interface, defaulting to `systemRuntime`. Pass `runtime` (and optionally `clientId`) to `createSyncClient` and every clock read, timer, and generated id in the orchestrator, outbox, cursor, bootstrap runner and delta pipeline comes from it.

This is what a conformance driver needs: with a fake runtime, only the scenario's `advanceClock` moves time and ids come from a seeded sequence, so a run is byte-identical each time. `packages/client/src/conformance/` ships that driver, speaking the stdin/stdout protocol in the corpus README, and eleven scenarios now run through it.

Skipping the catch-up delta fetch straight after a full bootstrap is the one behaviour change: the snapshot leaves the cursor at the server's `lastSyncId` and the subscription opens from that same id, and `TransportAdapter.subscribe` is contractually required to replay everything after it, so that fetch was a guaranteed-empty round trip on the coldest start path.
