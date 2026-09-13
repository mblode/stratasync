import Testing
@testable import StrataSync

struct RebaseTests {
    @Test func confirmsOwnInsertWhenServerCanonicalizesUuidCase() {
        let uppercaseId = "B7575849-39BA-41BB-A31C-2C7A9D0A3A9A"
        let lowercaseId = uppercaseId.lowercased()
        let transaction = Transaction(
            clientTxId: "tx-case",
            clientId: "client-1",
            modelName: "TestRecord",
            modelId: uppercaseId,
            action: .insert,
            payload: ["id": uppercaseId, "taskId": uppercaseId],
            original: nil,
            state: .queued,
            createdAt: 0,
            retryCount: 0
        )
        let action = SyncAction(
            id: "100",
            modelName: "TestRecord",
            modelId: lowercaseId,
            action: .insert,
            data: ["id": lowercaseId, "taskId": lowercaseId],
            groupId: nil,
            groups: nil,
            clientTxId: "tx-case",
            clientId: "client-1"
        )

        let result = rebaseTransactions(
            pending: [transaction],
            serverActions: [action],
            clientId: "client-1",
            defaultResolution: .serverWins,
            fieldLevelConflicts: true
        )

        #expect(transaction.modelId == lowercaseId)
        #expect(transaction.payload["id"] as? String == lowercaseId)
        #expect(transaction.payload["taskId"] as? String == lowercaseId)
        #expect(result.confirmed.count == 1)
        #expect(result.pending.isEmpty)
    }

    @Test func confirmsOwnInsertAndDetectsOverlappingUpdateConflict() {
        let tx = Transaction(
            clientTxId: "tx-1",
            clientId: "client-1",
            modelName: "TestRecord",
            modelId: "record-1",
            action: .insert,
            payload: ["title": "Local"],
            original: nil,
            state: .queued,
            createdAt: 0,
            retryCount: 0,
            lastError: nil,
            syncIdNeededForCompletion: nil,
            batchIndex: nil
        )

        let result = rebaseTransactions(
            pending: [tx],
            serverActions: [
                .init(
                    id: "100",
                    modelName: "TestRecord",
                    modelId: "record-1",
                    action: .insert,
                    data: ["title": "Local"],
                    groupId: nil,
                    groups: nil,
                    clientTxId: "tx-1",
                    clientId: "client-1"
                )
            ],
            clientId: "client-1",
            defaultResolution: .serverWins,
            fieldLevelConflicts: true
        )

        #expect(result.confirmed.count == 1)
        #expect(result.conflicts.isEmpty)
        #expect(result.pending.isEmpty)
    }

    @Test func detectsFieldOverlapForUpdates() {
        let local = Transaction(
            clientTxId: "tx-2",
            clientId: "client-1",
            modelName: "TestRecord",
            modelId: "record-1",
            action: .update,
            payload: ["title": "Local"],
            original: ["title": "Original"],
            state: .queued,
            createdAt: 0,
            retryCount: 0,
            lastError: nil,
            syncIdNeededForCompletion: nil,
            batchIndex: nil
        )

        let server = SyncAction(
            id: "101",
            modelName: "TestRecord",
            modelId: "record-1",
            action: .update,
            data: ["title": "Remote"],
            groupId: nil,
            groups: nil,
            clientTxId: nil,
            clientId: "server"
        )

        let result = rebaseTransactions(
            pending: [local],
            serverActions: [server],
            clientId: "client-1",
            defaultResolution: .serverWins,
            fieldLevelConflicts: true
        )

        #expect(result.conflicts.count == 1)
        #expect(result.conflicts[0].conflictType == .updateUpdate)
        #expect(result.conflicts[0].resolution == .serverWins)
    }
}
