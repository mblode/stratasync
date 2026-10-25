import Foundation
import Testing
@testable import StrataSync

@MainActor
@Suite struct ReconnectSubscriptionTests {
    @Test func closedSubscriptionCannotOpenAfterItsTokenArrives() async throws {
        var pendingToken: CheckedContinuation<String?, Never>?
        let transport = SyncTransport(
            syncEndpoint: "http://127.0.0.1:9/sync",
            wsEndpoint: "ws://127.0.0.1:9/sync/ws",
            getToken: { await withCheckedContinuation { pendingToken = $0 } }
        )
        var states: [ConnectionState] = []
        transport.onConnectionStateChange = { states.append($0) }
        let stream = transport.subscribe(afterSyncId: "0", groups: [])
        let consumer = Task { for try await _ in stream {} }
        for _ in 0..<100 where pendingToken == nil { await Task.yield() }
        let token = try #require(pendingToken)
        await transport.close()
        token.resume(returning: "fixture-token")
        try await Task.sleep(for: .milliseconds(50))
        consumer.cancel()
        await transport.close()
        #expect(!states.contains(.connecting), "An obsolete token lookup must not reopen a closed subscription")
    }

    @Test func recoveryResubscribesOnceWithoutFeedbackLoop() async throws {
        let storage = MockStorageAdapter()
        let modelStore = SyncModelStore()
        modelStore.register(TestRecord.self)
        let transport = MockSyncTransport()
        transport.bootstrapEvents = [.metadata(BootstrapMetadata(lastSyncId: "1", subscribedSyncGroups: ["ws-1"])), .end(rowCount: 0)]
        transport.subscribeStreamProvider = { call in
            // Cancelling the previous stream reports its disconnect before
            // the replacement handshake; delivery hops to the main actor.
            if call > 1 { transport.onConnectionStateChange?(.disconnected) }
            transport.onConnectionStateChange?(.connecting)
            transport.onConnectionStateChange?(.connected)
            return AsyncThrowingStream { _ in }
        }
        let outbox = OutboxManager(storage: storage, transport: transport, clientId: "reconnect-test")
        let orchestrator = SyncOrchestrator(storage: storage, transport: transport, modelStore: modelStore, outboxManager: outbox)
        orchestrator.resubscribeDelay = 0
        try await orchestrator.start(groups: ["ws-1"])
        try await Task.sleep(for: .milliseconds(30))
        let subscriptionsBeforeRecovery = transport.subscribeCursors.count
        let fetchesBeforeRecovery = transport.fetchDeltasCursors.count
        transport.onConnectionStateChange?(.disconnected)
        transport.onConnectionStateChange?(.reconnecting)
        transport.onConnectionStateChange?(.connected)
        try await Task.sleep(for: .milliseconds(100))
        await orchestrator.stop()
        #expect(subscriptionsBeforeRecovery == 1)
        #expect(transport.subscribeCursors.count == 2, "Recovery must resubscribe once, without a self-perpetuating replacement loop")
        #expect(transport.fetchDeltasCursors.count == fetchesBeforeRecovery + 1, "Recovery must still close the HTTP catch-up gap")
    }
}
