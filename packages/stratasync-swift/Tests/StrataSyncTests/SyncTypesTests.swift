import Testing
@testable import StrataSync

struct SyncTypesTests {
    @Test func comparesSyncIdsNumerically() {
        #expect(compareSyncId("1", "2") < 0)
        #expect(compareSyncId("2", "1") > 0)
        #expect(compareSyncId("0009", "9") == 0)
        #expect(compareSyncId("10", "2") > 0)
    }

    @Test func maxSyncIdReturnsTheGreaterValue() {
        #expect(maxSyncId("1", "2") == "2")
        #expect(maxSyncId("10", "2") == "10")
    }

    @Test func greaterThanHelperMatchesCompare() {
        #expect(isSyncIdGreaterThan("2", "1") == true)
        #expect(isSyncIdGreaterThan("1", "1") == false)
    }

    @Test func archiveTransactionUsesEpochMillisecondsPayload() {
        let transaction = createArchiveTransaction(
            clientId: "client-1",
            modelName: "Task",
            modelId: "task-1",
            archivedAt: 1_781_000_000_000.0
        )

        #expect(transaction.payload["archivedAt"] as? Double == 1_781_000_000_000.0)
    }
}
