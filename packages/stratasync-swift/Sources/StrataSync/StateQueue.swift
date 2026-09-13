import Foundation

/// Serializes state-mutating work into a single FIFO chain on the main actor,
/// the Swift analog of the TS client's `stateQueue`. A mutation's optimistic
/// apply + outbox persist and a delta packet's application can never interleave:
/// each `run` block runs to completion before the next begins.
///
/// Bootstrap *download* is not queued here — only the local apply (clear +
/// load + metadata/cursor). Holding the queue across `transport.bootstrap`
/// would freeze every mutation for the duration of the network stream.
///
/// Being `@MainActor` isolated is not enough on its own — actor hopping across
/// `await` points is not mutual exclusion, so a delta could otherwise slip
/// between a mutation's optimistic write and its durable persist.
@MainActor
final class StateQueue {
    private var tail: Task<Void, Never>?

    /// Runs `operation` after all previously enqueued work completes. The chain
    /// slot is reserved synchronously (before the first suspension point), so
    /// callers that invoke `run` within the same synchronous turn are ordered by
    /// call order.
    func run<T>(_ operation: @MainActor @escaping () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task { @MainActor () async throws -> T in
            await previous?.value
            return try await operation()
        }
        // The chain link must never fault, so its result/error is swallowed
        // here; the caller observes them through `task.value` below.
        tail = Task { @MainActor in _ = try? await task.value }
        return try await task.value
    }
}
