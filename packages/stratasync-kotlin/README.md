# StrataSync Kotlin

Initial JVM sync engine for a future native Android adapter. Generic engine code belongs here; Done Bear models and task rules stay in Donebear.

Requires JDK 21. Uses Kotlin 2.3.20 and a checksummed Gradle 9.3.1 wrapper.

```sh
./gradlew test
./gradlew publishSdkPublicationToFixtureRepository
./gradlew -p consumer-fixture run
./gradlew -q conformanceDriver -Pcommand=capabilities
./gradlew -q conformanceDriver -Pcommand=run < ../conformance/corpus/scenarios/bootstrap-then-delta.json
```

The driver is test tooling and is not included in the published SDK JAR. It reads one scenario from stdin and returns the JSON verdict; `ok: false` is a failed scenario even when process exit is zero. Invalid input/driver execution fails nonzero. The test suite deliberately corrupts an expectation to prove that failures are detected.

## Contract and current coverage

All eleven current engine scenarios and seven client wire-vector groups run against the real engine. The canonical files are read directly from `../conformance/corpus`, with SHA-256 verification. Every other vector is explicitly classified as a server function or client-local schema-hash divergence; no test changes the expected values to suit Kotlin.

Implemented: full bootstrap/hydration, decimal-string cursors, delta ordering, optimistic overlay, durable outbox checkpointing, replay with stable IDs, acknowledgment versus cursor confirmation, rejection rollback, field conflicts with server-wins resolution, archive/unarchive, catch-up pagination, schema invalidation, injected scheduling and generation fences on late callbacks.

This is **not yet an Android-ready replacement for the entire Swift/TypeScript SDK**. Missing: Android SQLite and HTTP/WebSocket adapters, automatic account routing, lazy/partial loading, observation/Flow integration, history/undo and CRDT support. G/S membership events quarantine visible rows durably and replace the snapshot. Pending targets absent from the replacement remain withheld in the outbox and cannot render or replay; coverage actions advance the cursor without creating models. Six privacy tests cover restart, failed persistence, late acknowledgments and withheld replay. The host must still isolate account storage, clear it on sign-out, and gate reopened caches with `start(groups, freshSnapshot = true)` after unknown access/storage failures. The conformance corpus is a baseline, not an exhaustive protocol specification.

## Ownership and adapters

`SyncEngine` receives registered models, a stable client ID, storage, transport and runtime. Keep one engine and one durable storage instance per account. The host owns credentials, account selection and lifecycle. Stop before switching accounts/groups. An existing store stamped with a different client ID is rejected; this check does not replace authentication or server authorization.

`SyncStorage.commit` must atomically persist base rows, outbox and metadata together or throw without changing the old checkpoint. Reads are immutable checkpoints. Visible rows are computed from base rows plus pending overlays; the host must not maintain another authoritative task cache.

`MemorySyncStorage` is for tests/demos. `FileSyncStorage` is a small-store JVM reference using fsync and atomic rename, with a single process/engine owner per file. It rewrites the checkpoint and is not a scalable Android database adapter. It provides process-crash recovery; it does not claim power-loss durability on every filesystem. Corrupt files fail loudly, not as an empty successful bootstrap.

Transport methods must return promptly, run network I/O outside the caller thread and complete exactly once. Callbacks are serialized by the engine; responses after stop/restart are discarded. Transport transaction objects use the SDK's semantic fields (`model`, `modelId`, spelled-out `action`, `payload`, `clientTxId`); an HTTP adapter must map these to the server request shape and handle auth without embedding credentials in checkpoints. Network failures retry; authentication failures stop and require host recovery.

`SystemSyncRuntime` owns a scheduler; close it when discarding its engine. Tests use an injected clock and seeded IDs. `refresh()` supports foreground REST polling through the same serialized catch-up path. The host observes `rows()`, `snapshot()`, `state` and `lastError`; a lifecycle-aware Flow adapter is still required for Compose.

## Publishing

`dev.stratasync:stratasync-kotlin:0.1.0-SNAPSHOT` is an initial local-fixture coordinate, not a public release. The separate Java consumer resolves the generated Maven artifact and its transitive dependencies. Choose verified public coordinates, API/versioning policy and signing before remote publication. No remote package was published by this change.
