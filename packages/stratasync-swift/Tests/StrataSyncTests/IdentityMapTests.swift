import Foundation
import Observation
import Testing
@testable import StrataSync

@MainActor
struct IdentityMapTests {
    @Test func setAndMergeKeepOneRecordPerId() throws {
        let map = IdentityMap<TestRecord>()
        map.set("task-1", .init(id: "task-1", title: "First", category: "inbox"))
        try map.merge("task-1", data: ["title": "Updated"])

        #expect(map.values.count == 1)
        #expect(map.get("task-1")?.title == "Updated")
    }

    @Test func uuidCaseVariantsShareOneCanonicalIdentity() throws {
        let map = IdentityMap<TestRecord>()
        let uppercaseId = "B7575849-39BA-41BB-A31C-2C7A9D0A3A9A"
        let lowercaseId = uppercaseId.lowercased()

        try map.setFromDictionary(uppercaseId, data: [
            "id": uppercaseId,
            "title": "Optimistic",
            "category": "inbox",
        ])
        try map.mergeFromDictionary(lowercaseId, data: [
            "id": lowercaseId,
            "title": "Server echo",
        ])

        #expect(map.values.count == 1)
        #expect(map.get(uppercaseId)?.id == lowercaseId)
        #expect(map.get(lowercaseId)?.title == "Server echo")
    }

    @Test func batchCoalescesMutations() throws {
        let map = IdentityMap<TestRecord>()
        map.batch {
            map.set("a", .init(id: "a", title: "A", category: "one"))
            map.set("b", .init(id: "b", title: "B", category: "two"))
            map.delete("a")
        }

        #expect(map.values.count == 1)
        #expect(map.has("a") == false)
        #expect(map.has("b") == true)
    }

    /// The values cache used to be invalidated only when observers were
    /// notified, which a batch skips — so a read taken part-way through a batch
    /// served the pre-batch array while the backing store had already moved on.
    @Test func readsInsideABatchSeeTheMutationsSoFar() {
        let map = IdentityMap<TestRecord>()
        map.set("a", .init(id: "a", title: "A", category: "one"))
        #expect(map.values.count == 1)

        map.batch {
            map.set("b", .init(id: "b", title: "B", category: "two"))
            #expect(map.values.count == 2)
            #expect(map.filter { $0.category == "two" }.count == 1)

            map.delete("a")
            #expect(map.values.count == 1)
        }

        #expect(map.values.map(\.id) == ["b"])
    }

    /// An inner batch closing must not end the outer one.
    @Test func nestedBatchesOnlyNotifyOnce() {
        let map = IdentityMap<TestRecord>()
        map.batch {
            map.set("a", .init(id: "a", title: "A", category: "one"))
            map.batch {
                map.set("b", .init(id: "b", title: "B", category: "two"))
            }
            map.set("c", .init(id: "c", title: "C", category: "three"))
        }

        #expect(map.values.count == 3)
    }

    @Test func anyIdentityMapConformanceSupportsDictionaryOperations() throws {
        let map = IdentityMap<TestRecord>()
        let erased: AnyIdentityMap = map

        try erased.setFromDictionary("task-1", data: [
            "id": "task-1",
            "title": "From Dictionary",
            "category": "backlog",
        ])

        #expect(erased.snapshotById("task-1")?["title"] as? String == "From Dictionary")

        erased.updateFromDictionary("task-1", changes: ["title": "Updated"])
        #expect(erased.snapshotById("task-1")?["title"] as? String == "Updated")

        erased.deleteById("task-1")
        #expect(erased.snapshotById("task-1") == nil)
    }

    @Test func getTracksOnlyTheRequestedRecord() {
        let map = IdentityMap<TestRecord>()
        map.set("a", .init(id: "a", title: "A", category: "one"))
        map.set("b", .init(id: "b", title: "B", category: "two"))

        let getAInvalidations = ObservationCounter()
        withObservationTracking {
            _ = map.get("a")?.title
        } onChange: {
            getAInvalidations.count += 1
        }

        map.set("b", .init(id: "b", title: "B2", category: "two"))
        #expect(getAInvalidations.count == 0)

        map.set("a", .init(id: "a", title: "A2", category: "one"))
        #expect(getAInvalidations.count == 1)
    }

    @Test func valuesStillTracksEveryRecord() {
        let map = IdentityMap<TestRecord>()
        map.set("a", .init(id: "a", title: "A", category: "one"))

        let valuesInvalidations = ObservationCounter()
        withObservationTracking {
            _ = map.values.count
        } onChange: {
            valuesInvalidations.count += 1
        }

        map.set("b", .init(id: "b", title: "B", category: "two"))
        #expect(valuesInvalidations.count == 1)
    }

    @Test func getOfAMissingIdNotifiesWhenThatIdIsInserted() {
        let map = IdentityMap<TestRecord>()

        let missingInvalidations = ObservationCounter()
        withObservationTracking {
            _ = map.get("later")
        } onChange: {
            missingInvalidations.count += 1
        }

        map.set("other", .init(id: "other", title: "Other", category: "one"))
        #expect(missingInvalidations.count == 0)

        map.set("later", .init(id: "later", title: "Later", category: "one"))
        #expect(missingInvalidations.count == 1)
    }

    @Test func allDictionariesReflectCurrentValues() throws {
        let map = IdentityMap<TestRecord>()
        map.set("one", .init(id: "one", title: "One", category: "alpha"))
        map.set("two", .init(id: "two", title: "Two", category: "beta"))

        let dictionaries = map.allDictionaries()
        #expect(dictionaries.count == 2)
        #expect(Set(dictionaries.compactMap { $0["id"] as? String }) == ["one", "two"])
    }
}

/// `withObservationTracking` onChange is not MainActor-isolated; a class box
/// keeps the increment Sendable-safe in Swift 6.
private final class ObservationCounter: @unchecked Sendable {
    var count = 0
}
