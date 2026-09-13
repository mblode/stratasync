# StrataSync Swift

Canonical Apple-platform local-first sync engine. SwiftPM entry point is ../../Package.swift. Done Bear consumes this repository directly through SwiftPM, pinned to an immutable revision.

## Commands

- `swift build --package-path ../..`: build from this folder
- `swift test --package-path ../..`: run package tests
- From the repository root, `npm run test:swift:consumer` verifies isolated Git package consumption.

## Scope

- `Sources/StrataSync/`: generic engine code only
- `Tests/StrataSyncTests/`: package-local fixtures and engine tests
- App models and task-domain helpers stay in the consumer repository, `donebear/apps/ios/Done Bear`

## Conventions

- Keep the package model-agnostic
- Prefer `public` only for the real consumer API; keep internals internal unless the app must reach them
- Do not reintroduce app-specific query helpers into package core
- Register consumer models before starting sync

## Schema hash granularity (read before adding a model or changing a codec)

`SyncModelStore.registrationsHash` gates the full re-bootstrap
(`SyncOrchestrator.shouldPerformBootstrap()`), and **the rule is: hash what can
corrupt a decode, nothing else.**

It covers model names, each model's field names, and each field's _codec_ — the
identity of the code that round-trips the value, not its Swift type. It
deliberately omits indexes, load strategies, partial-load modes and the rest of
the fetch-policy metadata: those change which rows get fetched, never how a row
already on disk is read back, so hashing them would spend a full re-bootstrap on
a change that cannot hurt any client. The TypeScript `computeSchemaHash`
(`stratasync/packages/core/src/schema/hash.ts`) hashes the whole registry
snapshot and over-invalidates for exactly that reason. Both are FNV-1a 64-bit
and 16 hex chars, but they are never compared with each other — only against the
hash this client persisted last run — so matching the format is a convention,
not a contract.

Two things keep it honest:

- Every registered model must conform to `SchemaDescribedModel`. A model that
  does not contributes only its name, and a field change inside it is invisible
  — a silent hole in the gate. `ModelParityTests.everyRegisteredAppModelDescribesItsSchema`
  fails when an app model is missing it.
- Codec names are an identity, not a type name. Two fields may share a codec name
  only when the same code decodes both. `apps/ios` has two codec families: the
  `SyncField` table (`id`, `string`, `optionalString`, `double`, `date`) and
  `TaskRecord`'s hand-written one, which omits nil keys instead of emitting
  `NSNull` and stores dates as ISO-8601 strings. Their vocabularies are disjoint
  apart from `id`, and `ModelParityTests.taskCodecNamesDoNotCollideWithTheFieldTableVocabulary`
  keeps them that way. Reusing a name across the two would let a client keep
  decoding stale rows.

`SchemaHashGranularityTests` in `EngineParityTests.swift` pins the whole rule: a
field addition, a nullability flip and a codec change each move the hash; a
fetch-policy change does not.

Changing the granularity costs one full re-bootstrap per existing install, since
the persisted hash differs. That is the only cost — the bootstrap path is the one
a first launch already takes.
