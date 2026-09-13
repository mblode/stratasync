import Foundation

/// Runtime effects used by the sync state machine. Tests inject a seeded ID
/// sequence and a clock whose sleepers advance only when the harness advances it.
@MainActor
public struct SyncRuntime {
    public var now: () -> TimeInterval
    public var transactionId: () -> String
    public var sleep: (TimeInterval) async throws -> Void

    public init(
        now: @escaping () -> TimeInterval,
        transactionId: @escaping () -> String,
        sleep: @escaping (TimeInterval) async throws -> Void
    ) {
        self.now = now
        self.transactionId = transactionId
        self.sleep = sleep
    }

    public static var live: SyncRuntime {
        SyncRuntime(
            now: { Date().timeIntervalSince1970 * 1000.0 },
            transactionId: { UUID().uuidString },
            sleep: { try await Task.sleep(for: .seconds($0)) }
        )
    }
}
