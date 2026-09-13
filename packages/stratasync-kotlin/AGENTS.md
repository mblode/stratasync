# StrataSync Kotlin SDK

- Run `./gradlew test` here with JDK 21; root `npm run test:kotlin` also checks Swift corpus resources.
- Model-agnostic JVM core only. No Android, Compose, or Done Bear imports.
- `src/main` is the SDK. `src/test` contains the deterministic driver, fake runtime/transport and scenarios. Never put sync semantics in the driver.
- Read `../conformance/corpus/README.md` before changing a wire contract. Fix implementations, not golden expectations.
- Every corpus vector must be executed or explicitly classified. Every current scenario executes. Do not add skip annotations to get green tests.
- Persistence commits rows/outbox/cursor atomically; publish in-memory changes only after success. Fence late callbacks by lifecycle generation.
- Use injected time and IDs in engine logic. Only SystemSyncRuntime reads the host clock/random generator.
- Run fixture publication and the independent consumer after changing the public API or dependencies.
- README lists unsupported capabilities; keep it and the canonical capability manifest honest. This is not yet an Android production SDK.
