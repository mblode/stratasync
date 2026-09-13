import CryptoKit
import Foundation
import Testing
@testable import StrataSync

private struct CorpusRecord: SyncModel, @unchecked Sendable {
    static let modelName = "Task"
    let id: String
    let fields: [String: Any]
    init(from dictionary: [String: Any]) throws {
        guard let id = dictionary["id"] as? String else { throw TestSupportError.missingField("id") }
        self.id = id
        self.fields = dictionary
    }
    func toDictionary() -> [String: Any] { fields }
    func applying(changes: [String: Any]) -> CorpusRecord {
        // An existing record always carries its validated identity.
        try! CorpusRecord(from: fields.merging(changes) { _, new in new })
    }
}

@MainActor
private final class CorpusClock {
    var now: TimeInterval
    var ids: [String]
    var exhaustedIds = false
    private var sequence = 0
    private struct Sleeper {
        let id: Int
        let deadline: TimeInterval
        let continuation: CheckedContinuation<Void, Error>
    }
    private var sleepers: [Sleeper] = []

    init(seed: [String: Any]) {
        now = (seed["clock"] as? NSNumber)?.doubleValue ?? 0
        ids = seed["txIds"] as? [String] ?? []
    }
    var runtime: SyncRuntime {
        SyncRuntime(now: { self.now }, transactionId: {
            guard !self.ids.isEmpty else { self.exhaustedIds = true; return "unexpected-transaction" }
            return self.ids.removeFirst()
        }, sleep: { try await self.sleep($0) })
    }
    private func sleep(_ seconds: TimeInterval) async throws {
        sequence += 1
        let id = sequence
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { sleepers.append(Sleeper(id: id, deadline: now + (seconds * 1000).rounded(), continuation: continuation)) }
            }
        } onCancel: {
            Task { @MainActor in self.cancel(id) }
        }
    }
    private func cancel(_ id: Int) {
        guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return }
        sleepers.remove(at: index).continuation.resume(throwing: CancellationError())
    }
    func advance(_ milliseconds: Double) async {
        let target = now + milliseconds
        var fired = 0
        while let next = sleepers.filter({ $0.deadline <= target }).min(by: { ($0.deadline, $0.id) < ($1.deadline, $1.id) }) {
            guard fired < 10000 else { preconditionFailure("Non-quiescing fake clock") }
            fired += 1
            now = next.deadline
            sleepers.removeAll { $0.id == next.id }
            next.continuation.resume()
            await settle()
        }
        now = target
        await settle()
    }
    func finish() {
        let pending = sleepers; sleepers.removeAll()
        for sleeper in pending { sleeper.continuation.resume(throwing: CancellationError()) }
    }
}

@MainActor
private func settle() async { for _ in 0..<100 { await Task.yield() } }

/// Transport scripting only: parsing, snapshot application and cursor ordering
/// all execute through the real SyncEngine. No sync algorithm lives here.
@MainActor
private final class CorpusTransport: SyncTransport {
    var responses: [[BootstrapEvent]] = []
    var buffered: [DeltaPacket] = []
    var continuation: AsyncThrowingStream<DeltaPacket, Error>.Continuation?
    var deltas: [DeltaPacket] = []
    var errors: [String: Error] = [:]
    var mutateCount = 0
    var connected = false
    private var batches: [(batch: TransactionBatch, results: [String: TransactionResult], continuation: CheckedContinuation<MutateResult, Error>)] = []
    var bootstrapCount = 0
    var deltaFetchCount = 0
    var socketConnectCount = 0

    init() {
        super.init(syncEndpoint: "https://example.test/sync", wsEndpoint: "wss://example.test/sync/ws", getToken: { "corpus" })
    }
    override func bootstrap(syncGroups: [String]) -> AsyncThrowingStream<BootstrapEvent, Error> {
        bootstrapCount += 1
        if let error = errors.removeValue(forKey: "bootstrap") {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        guard !responses.isEmpty else {
            return AsyncThrowingStream { $0.finish(throwing: TestSupportError.missingField("queued bootstrap")) }
        }
        let events = responses.removeFirst()
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }
    override func fetchDeltas(after: SyncId, limit: Int?) async throws -> DeltaPacket {
        deltaFetchCount += 1
        if let error = errors.removeValue(forKey: "deltas") { throw error }
        if !deltas.isEmpty { return deltas.removeFirst() }
        return DeltaPacket(lastSyncId: after, actions: [], hasMore: false)
    }
    override func subscribe(cursorProvider: @escaping () -> SyncId, groups: [String]) -> AsyncThrowingStream<DeltaPacket, Error> {
        socketConnectCount += 1
        return AsyncThrowingStream { continuation in
            self.continuation = continuation
            if connected { onConnectionStateChange?(.connected) }
            for packet in buffered { continuation.yield(packet) }
            buffered.removeAll()
        }
    }
    func deliver(_ raw: [String: Any]) throws {
        guard let packet = try parseDeltaPacket(raw) else { throw TestSupportError.missingField("packet") }
        if let continuation { continuation.yield(packet) } else { buffered.append(packet) }
    }
    func socket(_ open: Bool) {
        connected = open
        onConnectionStateChange?(open ? .connected : .disconnected)
    }
    override func mutate(batch: TransactionBatch) async throws -> MutateResult {
        mutateCount += 1
        if let error = errors.removeValue(forKey: "mutate") { throw error }
        return try await withCheckedThrowingContinuation { continuation in
            batches.append((batch, [:], continuation))
        }
    }
    func resolve(_ result: TransactionResult) throws {
        guard let index = batches.firstIndex(where: { $0.batch.transactions.contains { $0.clientTxId == result.clientTxId } }) else {
            throw TestSupportError.missingField("inflight mutation \(result.clientTxId)")
        }
        batches[index].results[result.clientTxId] = result
        if batches[index].results.count == batches[index].batch.transactions.count {
            let entry = batches.remove(at: index)
            let results = entry.batch.transactions.compactMap { entry.results[$0.clientTxId] }
            entry.continuation.resume(returning: MutateResult(success: results.allSatisfy(\.success), lastSyncId: results.compactMap(\.syncId).reduce("0", maxSyncId), results: results))
        }
    }
    override func close() async {
        continuation?.finish(); continuation = nil
        let pending = batches; batches.removeAll()
        for batch in pending { batch.continuation.resume(throwing: CancellationError()) }
    }
}

@MainActor
struct ConformanceScenarioTests {
    nonisolated static let covered: Set<String> = [
        "bootstrap-then-delta", "delta-during-bootstrap-ordering",
        "archive-then-unarchive-round-trip", "cursor-too-old-forces-rebootstrap",
        "outbox-delta-echo-is-idempotent", "outbox-offline-replay-acked-once",
        "rebase-disjoint-fields-both-survive", "rebase-same-field-server-wins",
        "reconnect-backoff-closes-the-gap", "rejected-mutation-rolls-back",
        "schema-hash-mismatch-rebootstraps",
    ]
    nonisolated static let pending: Set<String> = []

    @Test func everyScenarioHasAnExplicitCoverageDecision() throws {
        let root = try ConformanceVectorTests.corpusRoot().appending(path: "scenarios")
        let names = Set(try FileManager.default.contentsOfDirectory(atPath: root.path()).filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) })
        #expect(names == Self.covered.union(Self.pending), "New corpus scenario needs Swift adapter coverage or an explicit tracked gap")
        #expect(Self.covered.isDisjoint(with: Self.pending))
        let manifestURL = try ConformanceVectorTests.corpusRoot().appending(path: "capabilities/stratasync-swift.json")
        let manifest = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any])
        let capabilities = Set(manifest["capabilities"] as? [String] ?? [])
        var declared = Set<String>()
        for name in names {
            let scenario = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appending(path: "\(name).json"))) as? [String: Any])
            if Set(scenario["requires"] as? [String] ?? []).isSubset(of: capabilities) { declared.insert(name) }
        }
        #expect(declared == Self.covered, "Swift capability manifest must match scenarios actually executed")

    }

    @Test(arguments: Array(covered).sorted())
    func canonicalScenario(name: String) async throws {
        let failures = try await run(name: name)
        #expect(failures.isEmpty, "\(name): \(failures.joined(separator: "; "))")
    }

    @Test func aWrongExpectationFails() async throws {
        let failures = try await run(name: "bootstrap-then-delta", corruptInitialState: true)
        #expect(!failures.isEmpty, "The harness must reject an intentionally wrong state expectation")
    }

    @Test func driverScenario() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let input = environment["STRATASYNC_SCENARIO_INPUT"],
              let output = environment["STRATASYNC_SCENARIO_OUTPUT"] else {
            #expect(try await run(name: "bootstrap-then-delta").isEmpty)
            return
        }
        let scenario = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as? [String: Any])
        _ = try await run(name: scenario["id"] as? String ?? "driver", suppliedScenario: scenario, resultURL: URL(fileURLWithPath: output))
    }

    private func run(name: String, corruptInitialState: Bool = false, suppliedScenario: [String: Any]? = nil, resultURL: URL? = nil) async throws -> [String] {
        let url = try ConformanceVectorTests.corpusRoot().appending(path: "scenarios/\(name).json")
        let scenario: [String: Any]
        if let suppliedScenario { scenario = suppliedScenario }
        else { scenario = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]) }
        let capabilityURL = try ConformanceVectorTests.corpusRoot().appending(path: "capabilities/stratasync-swift.json")
        let manifest = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: capabilityURL)) as? [String: Any])
        let required = Set(scenario["requires"] as? [String] ?? [])
        try #require(required.isSubset(of: Set(manifest["capabilities"] as? [String] ?? [])), "Scenario requires undeclared Swift capabilities")
        let steps = try #require(scenario["steps"] as? [[String: Any]])
        let seed = scenario["seed"] as? [String: Any] ?? [:]
        let clientId = seed["clientId"] as? String ?? "c_test"
        let storage = MockStorageAdapter()
        let given = scenario["given"] as? [String: Any] ?? [:]
        let meta = given["meta"] as? [String: Any] ?? [:]
        try await storage.setMeta(StorageMeta(lastSyncId: meta["lastSyncId"] as? String ?? "0", firstSyncId: meta["firstSyncId"] as? String, subscribedGroups: meta["subscribedGroups"] as? [String] ?? [], clientId: clientId, bootstrapComplete: meta["bootstrapComplete"] as? Bool ?? false, schemaHash: meta["schemaHash"] as? String))
        for row in given["rows"] as? [[String: Any]] ?? [] {
            var fields = row["fields"] as? [String: Any] ?? [:]; fields["id"] = row["id"]
            try await storage.put(modelName: row["model"] as! String, id: row["id"] as! String, data: fields)
        }
        let clock = CorpusClock(seed: seed)
        let modelsData = try JSONSerialization.data(withJSONObject: scenario["models"] ?? [], options: [.sortedKeys])
        let schemaHash = SHA256.hash(data: modelsData).map { String(format: "%02x", $0) }.joined()
        let transport = CorpusTransport()
        let store = SyncModelStore()
        store.register(CorpusRecord.self)
        let engine = SyncEngine(transport: transport, storage: storage, modelStore: store, clientId: clientId, schemaHash: schemaHash, runtime: clock.runtime)
        var failures: [String] = []
        var results: [[String: Any]] = []
        for (index, step) in steps.enumerated() {
            switch step["op"] as? String {
            case "start": try await engine.start(groups: step["groups"] as? [String] ?? [])
            case "stop": await engine.stop()
            case "respondBootstrap":
                let rows = step["rows"] as? [[String: Any]] ?? []
                var events: [BootstrapEvent] = rows.map { row in
                    var fields = row["fields"] as? [String: Any] ?? [:]
                    fields["id"] = row["id"]
                    return .model(modelName: row["model"] as! String, data: fields)
                }
                events.append(.metadata(BootstrapMetadata(lastSyncId: step["lastSyncId"] as? String ?? "0", subscribedSyncGroups: ["w1"])))
                events.append(.end(rowCount: rows.count))
                transport.responses.append(events)
            case "deliverDelta": try transport.deliver(try #require(step["packet"] as? [String: Any]))
            case "socketOpen": transport.socket(true)
            case "socketClose": transport.socket(false)
            case "respondDeltas":
                let parsed = try transport.parseDeltaPacket(step["packet"] as Any)
                transport.deltas.append(try #require(parsed))
            case "transportError":
                let kind = step["kind"] as? String ?? "network"
                transport.errors[step["on"] as? String ?? "deltas"] = kind == "bootstrapRequired" ? SyncTransportError.bootstrapRequired : URLError(.notConnectedToInternet)
            case "advanceClock": await clock.advance((step["ms"] as? NSNumber)?.doubleValue ?? 0)
            case "mutate":
                let model = try #require(step["model"] as? String)
                let id = try #require(step["modelId"] as? String)
                var payload = step["payload"] as? [String: Any] ?? [:]
                switch step["action"] as? String {
                case "INSERT": payload["id"] = id; try await engine.create(modelName: model, data: payload)
                case "UPDATE": try await engine.update(modelName: model, id: id, changes: payload)
                case "DELETE": try await engine.delete(modelName: model, id: id)
                case "ARCHIVE": try await engine.archive(modelName: model, id: id)
                case "UNARCHIVE": try await engine.unarchive(modelName: model, id: id)
                default: throw TestSupportError.missingField("mutation action")
                }
            case "ackMutation": try transport.resolve(TransactionResult(clientTxId: step["clientTxId"] as! String, success: true, syncId: step["syncId"] as? String, error: nil))
            case "rejectMutation": try transport.resolve(TransactionResult(clientTxId: step["clientTxId"] as! String, success: false, syncId: nil, error: step["message"] as? String ?? "Rejected"))
            case "expect":
                func check(_ label: String, _ actual: Any?, _ expected: Any) {
                    let a = actual ?? NSNull()
                    if !NSDictionary(dictionary: ["value": a]).isEqual(to: ["value": expected]) { failures.append("step \(index) \(label): expected \(expected), got \(a)") }
                }
                if let expected = step["state"] as? String { check("state", engine.state.rawValue, corruptInitialState && index == 0 ? "syncing" : expected) }
                if let expected = step["cursor"] { check("cursor", engine.lastSyncId, expected) }
                for row in step["store"] as? [[String: Any]] ?? [] {
                    let model = try #require(row["model"] as? String)
                    let id = try #require(row["id"] as? String)
                    let actual = store.snapshot(modelName: model, id: id)
                    for (field, value) in row["fields"] as? [String: Any] ?? [:] { check("\(model)/\(id).\(field)", actual?[field], value) }
                }
                for row in step["storeAbsent"] as? [[String: Any]] ?? [] {
                    let actual = store.snapshot(modelName: row["model"] as! String, id: row["id"] as! String)
                    check("absent row", actual, NSNull())
                }
                let counts: [String: Int] = ["bootstrapCount": transport.bootstrapCount, "deltaFetchCount": transport.deltaFetchCount, "socketConnectCount": transport.socketConnectCount, "mutateCount": transport.mutateCount]
                for (key, value) in step["transport"] as? [String: Any] ?? [:] { check("transport.\(key)", counts[key], value) }
                if let expected = step["outbox"] as? [[String: Any]] {
                    let actual = await storage.getOutbox()
                    check("outbox.count", actual.count, expected.count)
                    for (index, expectedEntry) in expected.enumerated() where index < actual.count {
                        let tx = actual[index]
                        let status = tx.state == .queued ? "pending" : tx.state == .failed ? "failed" : "inflight"
                        let actions: [TransactionAction: String] = [.insert: "INSERT", .update: "UPDATE", .delete: "DELETE", .archive: "ARCHIVE", .unarchive: "UNARCHIVE"]
                        let entry: [String: Any] = ["clientTxId": tx.clientTxId, "model": tx.modelName, "modelId": tx.modelId, "action": actions[tx.action]!, "payload": tx.payload, "status": status]
                        for (key, value) in expectedEntry { check("outbox[\(index)].\(key)", entry[key], value) }
                    }
                }
                let meta = await storage.getMeta()
                let metadata: [String: Any] = ["lastSyncId": meta.lastSyncId, "bootstrapComplete": meta.bootstrapComplete, "subscribedGroups": meta.subscribedGroups]
                for (key, value) in step["storage"] as? [String: Any] ?? [:] { check("storage.\(key)", metadata[key], value) }
            default: throw TestSupportError.missingField("unsupported scenario operation")
            }
            await settle()
            var result: [String: Any] = ["index": index, "op": step["op"] ?? "unknown", "ok": failures.isEmpty]
            if !failures.isEmpty { result["failures"] = failures }
            results.append(result)
            if !failures.isEmpty { break }
        }
        await engine.stop()
        clock.finish()
        await settle()
        if clock.exhaustedIds { failures.append("Engine exhausted the scenario's seeded transaction IDs") }
        if let resultURL {
            let result: [String: Any] = ["scenarioId": name, "ok": failures.isEmpty, "steps": results]
            try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: resultURL)
        }
        return failures
    }
}
