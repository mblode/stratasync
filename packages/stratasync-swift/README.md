# StrataSync Swift

Canonical Apple-platform SDK source, extracted from Done Bear. The single authoritative SwiftPM manifest is at the **StrataSync repository root**; the public product/module remains `StrataSync`.

```sh
# Run from the repository root
npm run test:swift
npm run test:swift:consumer
```

The second command creates an isolated temporary Git repository/tag and resolves it from a clean Swift consumer. It verifies package layout without pretending an unpublished revision is remotely available.

The package-local suite covers storage, identity maps, outbox resilience, rebase, history, privacy reconciliation and account boundaries. Seven shared client wire-vector groups are asserted. All eleven current shared state-machine scenarios run through the actual engine with injected time, scheduling and transaction IDs. Shared scenario coverage is not full Swift/TypeScript feature parity.

Tests bundle a byte-exact resource copy of `packages/conformance/corpus`. `npm run native:corpus:check` compares it with canonical source, including file inventory. Refresh with `npm run native:corpus:sync`; never hand-edit that copy.

## Done Bear migration

Done Bear temporarily consumes a frozen generated snapshot while this root package is unpublished. `donebear/scripts/sync-swift-sdk.mjs --source ../stratasync` refreshes that snapshot and its integrity manifest. SDK edits belong here. The snapshot keeps ordinary Done Bear clones and iOS CI buildable without a sibling checkout.

After publishing a verified immutable Git revision/tag, replace the Xcode local reference with a pinned remote SwiftPM dependency, commit Package.resolved, build/test iOS, and remove the snapshot plus its sync/check script and obsolete corpus refresh. No second editable engine should remain. Do not perform this cutover against a tag that does not exist.

`python3 scripts/swift-conformance-driver.py run < scenario.json` from the root exposes the common driver protocol. `version` and `capabilities` are also supported. The test-backed driver keeps build diagnostics on stderr and emits only the JSON result on stdout.
