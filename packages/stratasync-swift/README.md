# StrataSync Swift

Canonical Apple-platform SDK source, extracted from Done Bear. The single authoritative SwiftPM manifest is at the **StrataSync repository root**; the public product/module remains `StrataSync`.

```sh
# Run from the repository root
npm run test:swift
npm run test:swift:consumer
```

The second command creates an isolated temporary Git repository/tag and resolves it from a clean Swift consumer. It verifies package layout independently of the current consumer pin.

The package-local suite covers storage, identity maps, outbox resilience, rebase, history, privacy reconciliation and account boundaries. Seven shared client wire-vector groups are asserted. All eleven current shared state-machine scenarios run through the actual engine with injected time, scheduling and transaction IDs. Shared scenario coverage is not full Swift/TypeScript feature parity.

Tests bundle a byte-exact resource copy of `packages/conformance/corpus`. `npm run native:corpus:check` compares it with canonical source, including file inventory. Refresh with `npm run native:corpus:sync`; never hand-edit that copy.

## Done Bear consumer

Done Bear consumes `https://github.com/mblode/stratasync.git` directly through SwiftPM, initially pinned to `45f373600943899af26150a21fcd1c1d92bceaa6`. Its local SDK snapshot and refresh tooling have been removed.

SDK edits belong here. To upgrade Done Bear, publish the verified SDK commit, update the immutable revision in its Xcode project, resolve and commit `Package.resolved`, and run the iOS consumer tests/build. Keep generic engine tests and shared corpus ownership in this repository.

`python3 scripts/swift-conformance-driver.py run < scenario.json` from the root exposes the common driver protocol. `version` and `capabilities` are also supported. The test-backed driver keeps build diagnostics on stderr and emits only the JSON result on stdout.
