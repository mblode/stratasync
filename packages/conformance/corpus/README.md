# Strata Sync conformance corpus

Language-agnostic test data that every Strata Sync implementation must pass. The
corpus is **data, not code**: JSON files plus JSON Schemas describing them. Each
implementation ships a small **driver** executable; one runner feeds the corpus
through every driver and compares results.

This exists because Strata Sync now has more than one implementation (TypeScript
here, Swift in `donebear/packages/stratasync-swift`, Kotlin planned) and prose
specs do not fail a build. A divergence in the engine state machine has no
symptom until it silently loses or corrupts a user's local data.

## Layout

```
corpus/
├── schemas/       JSON Schema for every artifact kind below
├── vectors/       pure-function input → expected-output tables
├── scenarios/     scripted engine state-machine runs
└── capabilities/  per-implementation feature declarations
```

`manifest.json` at the corpus root pins the corpus version and a SHA-256 of every
file, so a port that vendors a copy can prove it is in sync.

## The three artifact kinds

### Vectors — pure functions

A vector file is a table of `input` → `expected` for one named pure function
(`compareSyncId`, `computeSchemaHash`, `decodeSyncAction`, …). No state, no
clock, no I/O. These are cheap to implement and catch encoding drift.

Vectors are asserted directly by each implementation's own test suite, reading
these files off the filesystem rather than inlining them. They do not need the
driver. The TypeScript side lives in `packages/core/tests/conformance-vectors.test.ts`;
`packages/conformance/tests/corpus.test.ts` validates the corpus itself against
the schemas.

`schemas/` holds one file per artifact kind plus, where a vector's `input` is a
structure rather than a scalar, a schema for that structure — currently
`model-snapshot.schema.json`, which describes the serialized model snapshot
document `computeSchemaHash` consumes. Those are not new artifact kinds and
nothing loads them as such; they exist so an argument shared across languages is
specified rather than inferred from the examples.

### Scenarios — the engine state machine

A scenario is an ordered script of operations against a live engine with a fake
transport, fake storage and fake clock, interleaved with assertions. This is
where parity actually breaks: bootstrap/delta race ordering, rebase against
in-flight transactions, outbox replay idempotency, cursor-too-old recovery,
reconnect backoff.

Scenarios run through the driver protocol below.

### Capabilities — declared subsets

Not every implementation supports every feature, and that is fine. What is not
fine is an _undeclared_ subset. Each implementation ships a capability manifest;
the runner skips scenarios whose `requires` are not declared, and **fails** if a
scenario exercises a capability the implementation did not declare.

## Driver protocol

A driver is any executable that speaks this protocol. It reads one JSON scenario
on **stdin** and writes one JSON result on **stdout**. Nothing else may be
written to stdout; diagnostics go to stderr.

```
$ echo '<scenario json>' | ./driver
{"scenarioId":"...","ok":true,"steps":[...]}
```

Three commands, selected by `argv[1]`:

| Command        | stdin    | stdout                                   |
| -------------- | -------- | ---------------------------------------- |
| `capabilities` | –        | the implementation's capability manifest |
| `run`          | scenario | a scenario result                        |
| `version`      | –        | `{"driver":"...","protocolVersion":N}`   |

This is the whole cross-language surface. A driver is expected to be a few
hundred lines: construct the engine with the fakes, switch over the operations,
serialize the assertions. It must not reimplement engine logic.

### Determinism is required

A driver MUST make these injectable and MUST NOT read ambient state:

- **Clock** — no wall clock. `advanceClock` is the only thing that moves time.
- **ID generation** — `clientId` and `clientTxId` come from a seeded sequence
  supplied in the scenario, never from a random UUID.
- **Scheduling** — timers fire from the fake clock, not from the host runtime.

An implementation that cannot satisfy this cannot be conformance-tested, and
making it satisfy this is a prerequisite, not a nice-to-have.

## Operations

Every scenario step is `{ "op": "<name>", ... }`. The full list, with its
argument shape, is in `schemas/scenario.schema.json` — that file is the
authority, this table is orientation.

| Op                 | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `start`            | Start the engine for the given sync groups            |
| `stop`             | Stop the engine                                       |
| `respondBootstrap` | Queue the bootstrap response the transport will serve |
| `respondDeltas`    | Queue the catch-up response for `GET /sync/deltas`    |
| `deliverDelta`     | Push a delta packet over the fake socket              |
| `socketOpen`       | Fake socket connects                                  |
| `socketClose`      | Fake socket drops, with a close code                  |
| `transportError`   | Next transport call fails with the given error kind   |
| `advanceClock`     | Move the fake clock forward `ms` and fire due timers  |
| `mutate`           | Apply a local change and enqueue it                   |
| `ackMutation`      | Server accepts the identified transaction             |
| `rejectMutation`   | Server rejects it, with a message                     |
| `expect`           | Assert engine state (see below)                       |

### `expect`

An `expect` step carries any subset of these keys; only the keys present are
asserted, so a scenario stays readable and does not over-specify. The one
exception is an `outbox` entry: `clientTxId`, `action`, `model`, and `modelId`
are all required on each one (`schemas/scenario.schema.json` rejects a partial
entry), because a half-identified transaction is ambiguous about which
transaction it means.

```json
{
  "op": "expect",
  "state": "syncing",
  "cursor": "42",
  "store": [{ "model": "Task", "id": "t1", "fields": { "title": "a" } }],
  "storeAbsent": [{ "model": "Task", "id": "t2" }],
  "outbox": [
    {
      "clientTxId": "tx1",
      "action": "UPDATE",
      "model": "Task",
      "modelId": "t1",
      "status": "pending"
    }
  ],
  "transport": { "bootstrapCount": 1, "deltaFetchCount": 0 },
  "storage": { "schemaHash": "v1", "bootstrapComplete": true }
}
```

## Adding to the corpus

1. A new behaviour gets a scenario, not a prose note in a doc.
2. When a scenario fails, fix the implementation, not the scenario. A scenario
   edited to make one language pass silently breaks the others — this is the
   same rule the `donebear` golden vectors already run under.
3. A scenario that only one implementation can pass needs a `requires` entry and
   a capability, or it does not belong here.
4. Bump `manifest.json` and regenerate hashes (`npm run corpus:manifest`).
