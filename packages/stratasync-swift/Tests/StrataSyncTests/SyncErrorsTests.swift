import Foundation
import Testing
@testable import StrataSync

struct SyncErrorsTests {
    @Test func offlineErrorClassifierMatchesWebNetworkAndTimeoutFailures() {
        #expect(isOfflineSyncError(URLError(.notConnectedToInternet)))
        #expect(isOfflineSyncError(URLError(.timedOut)))
        #expect(isOfflineSyncError(TestSyncError(message: "Failed to fetch")))
        #expect(isOfflineSyncError(SyncTransportError.maxReconnectAttemptsReached))
        #expect(!isOfflineSyncError(TestSyncError(message: "Corrupt state")))
    }

    @Test func offlineSyncErrorsResolveToOfflineInsteadOfBlockingError() {
        #expect(
            resolvedSyncStatus(
                state: .error,
                connectionState: .disconnected,
                lastError: URLError(.notConnectedToInternet),
                pendingCount: 0
            ) == .offline
        )
        #expect(
            resolvedSyncStatus(
                state: .error,
                connectionState: .disconnected,
                lastError: TestSyncError(message: "Corrupt state"),
                pendingCount: 0
            ) == .error
        )
    }
}

private struct TestSyncError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}
