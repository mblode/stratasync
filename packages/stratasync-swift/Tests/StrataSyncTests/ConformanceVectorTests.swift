import CryptoKit
import Foundation
import Testing
@testable import StrataSync

/// Asserts this port against the language-agnostic conformance corpus from
/// `stratasync/packages/conformance`.
///
/// The corpus is data, not code: `vectors/*.json` are `input` → `expected`
/// tables for pure functions, read off disk rather than inlined here. The rule
/// that governs them is **fix the implementation, not the corpus** — a vector
/// edited to make Swift pass silently breaks the TypeScript and Kotlin ports.
///
/// State-machine scenarios run separately in ConformanceScenarioTests, through
/// the real engine with deterministic runtime and transport adapters.
struct ConformanceVectorTests {
    // MARK: - Corpus loading

    /// The vendored corpus root, copied into the test bundle by Package.swift.
    static func corpusRoot() throws -> URL {
        guard let url = Bundle.module.url(forResource: "corpus", withExtension: nil) else {
            throw CorpusError.missingCorpus
        }
        return url
    }

    static func loadVector(_ name: String) throws -> VectorFile {
        let url = try corpusRoot().appending(path: "vectors/\(name).json")
        let raw = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let fn = object["fn"] as? String,
              let cases = object["cases"] as? [[String: Any]]
        else {
            throw CorpusError.malformedVector(name)
        }
        return VectorFile(fn: fn, name: name, cases: cases.map(VectorCase.init))
    }

    enum CorpusError: Error {
        case missingCorpus
        case malformedVector(String)
    }

    struct VectorFile {
        let fn: String
        let name: String
        let cases: [VectorCase]
    }

    struct VectorCase {
        let raw: [String: Any]

        var name: String { raw["name"] as? String ?? "<unnamed>" }
        var input: [Any] { raw["input"] as? [Any] ?? [] }
        var shouldThrow: Bool { raw["throws"] as? Bool ?? false }
        /// Present-but-null and absent are different: a vector may legitimately
        /// expect `null`, so callers check `hasExpected` before reading this.
        var expected: Any? { raw["expected"] is NSNull ? nil : raw["expected"] }
        var hasExpected: Bool { raw.keys.contains("expected") }
    }

    // MARK: - Coverage

    /// Every vector in the corpus is either asserted here or listed below with
    /// the reason it is not. Nothing else told me the other nine existed the
    /// first time round, so a corpus refresh that adds a vector now fails here
    /// rather than being silently ignored.
    ///
    /// The reasons are all one of two kinds: the function belongs to the
    /// server half of the protocol (`@stratasync/server` owns the field specs
    /// and model config this engine never sees), or the port deliberately
    /// diverges and `AGENTS.md` says so.
    static let unimplementedVectors: [String: String] = [
        "build-insert-data":
            "server-side: builds the row an INSERT writes from the model's field specs, which this client never holds.",
        "build-update-data":
            "server-side: the mirror of buildInsertData, same reason.",
        "serialize-sync-data":
            "server-side: encodes a stored row into a sync action's `data` using the field specs.",
        "parse-sync-action-output":
            "server-side: the server's stricter decode of an action off the delta bus. Deliberately not shared with the client's parseSyncAction, which this suite does assert.",
        "parse-temporal-input":
            "server-side: decodes a temporal field of a mutation payload against its field spec.",
        "compute-schema-hash":
            "deliberate divergence: Swift's registrationsHash is computed differently and is never compared against the TypeScript hash. See packages/stratasync-swift/AGENTS.md.",
    ]

    static let assertedVectors: Set<String> = [
        "compare-sync-id",
        "parse-sync-id",
        "map-graphql-action",
        "read-ndjson-lines",
        "parse-sync-action",
        "parse-delta-packet",
        "parse-bootstrap-line",
    ]

    @Test func everyVectorIsAssertedOrDeclaredUnimplemented() throws {
        let directory = try Self.corpusRoot().appending(path: "vectors")
        let names = try FileManager.default
            .contentsOfDirectory(atPath: directory.path())
            .filter { $0.hasSuffix(".json") }
            .map { String($0.dropLast(".json".count)) }

        #expect(!names.isEmpty)

        let accounted = Self.assertedVectors.union(Self.unimplementedVectors.keys)
        for name in names {
            #expect(
                accounted.contains(name),
                "corpus vector \(name) is neither asserted nor declared unimplemented"
            )
        }
        // The other direction: a name here that the corpus dropped is a stale
        // entry, and a stale skip reason is how coverage quietly rots.
        for name in accounted {
            #expect(names.contains(name), "no corpus vector named \(name); remove the stale entry")
        }
    }

    // MARK: - Corpus integrity

    /// Proves the vendored copy is byte-identical to what the manifest pins, so
    /// a hand-edit to a local vector fails here rather than silently weakening
    /// a downstream assertion. `manifest.json` is not self-hashed.
    @Test func vendoredCorpusMatchesItsManifest() throws {
        let root = try Self.corpusRoot()
        let manifestData = try Data(contentsOf: root.appending(path: "manifest.json"))
        guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              let files = manifest["files"] as? [String: String]
        else {
            throw CorpusError.malformedVector("manifest.json")
        }

        #expect(!files.isEmpty)

        for (relativePath, expectedHash) in files {
            let fileData = try Data(contentsOf: root.appending(path: relativePath))
            let actual = SHA256.hash(data: fileData).map { String(format: "%02x", $0) }.joined()
            #expect(actual == expectedHash, "corpus file drifted from the manifest: \(relativePath)")
        }
    }

    // MARK: - compareSyncId

    /// Comparator semantics are sign-based, so the corpus's -1/0/1 is asserted
    /// against the sign of the Swift result rather than its magnitude.
    @Test func compareSyncIdMatchesTheCorpus() throws {
        let vector = try Self.loadVector("compare-sync-id")

        for testCase in vector.cases {
            guard let lhs = testCase.input.first as? String,
                  let rhs = testCase.input.dropFirst().first as? String,
                  let expected = testCase.expected as? Int
            else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            let actual = compareSyncId(lhs, rhs)
            #expect(
                actual.signum() == expected.signum(),
                "compareSyncId(\(lhs), \(rhs)) = \(actual), corpus expects \(expected) — case: \(testCase.name)"
            )
        }
    }

    // MARK: - parseSyncAction

    @MainActor
    @Test func parseSyncActionMatchesTheCorpus() throws {
        let vector = try Self.loadVector("parse-sync-action")
        let transport = Self.makeTransport()

        for testCase in vector.cases {
            guard let payload = testCase.input.first as? [String: Any] else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            if testCase.shouldThrow {
                #expect(throws: (any Error).self, "expected a throw — case: \(testCase.name)") {
                    _ = try transport.parseSyncAction(payload)
                }
                continue
            }

            guard let expected = testCase.expected as? [String: Any] else {
                Issue.record("case is neither a throw nor an object: \(testCase.name)")
                continue
            }

            do {
                let action = try transport.parseSyncAction(payload)
                Self.expectAction(action, matches: expected, caseName: testCase.name)
            } catch {
                Issue.record("unexpected throw \(error) — case: \(testCase.name)")
            }
        }
    }

    // MARK: - parseDeltaPacket

    @MainActor
    @Test func parseDeltaPacketMatchesTheCorpus() throws {
        let vector = try Self.loadVector("parse-delta-packet")
        let transport = Self.makeTransport()

        for testCase in vector.cases {
            guard let payload = testCase.input.first else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            if testCase.shouldThrow {
                #expect(throws: (any Error).self, "expected a throw — case: \(testCase.name)") {
                    _ = try transport.parseDeltaPacket(payload)
                }
                continue
            }

            do {
                let packet = try transport.parseDeltaPacket(payload)

                // A present-but-null `expected` means the payload is not a
                // delta at all, which decodes to nil rather than throwing.
                guard let expected = testCase.expected as? [String: Any] else {
                    #expect(packet == nil, "expected no packet — case: \(testCase.name)")
                    continue
                }
                guard let packet else {
                    Issue.record("expected a packet — case: \(testCase.name)")
                    continue
                }

                let expectedActions = expected["actions"] as? [[String: Any]] ?? []

                #expect(
                    packet.lastSyncId == expected["lastSyncId"] as? String,
                    "lastSyncId mismatch — case: \(testCase.name)"
                )
                // Absent and false are the same packet to a consumer, so the
                // corpus's omitted `hasMore` is asserted as false.
                #expect(
                    packet.hasMore == (expected["hasMore"] as? Bool ?? false),
                    "hasMore mismatch — case: \(testCase.name)"
                )
                #expect(
                    packet.actions.count == expectedActions.count,
                    "action count mismatch — case: \(testCase.name)"
                )

                for (action, expectedAction) in zip(packet.actions, expectedActions) {
                    Self.expectAction(action, matches: expectedAction, caseName: testCase.name)
                }
            } catch {
                Issue.record("unexpected throw \(error) — case: \(testCase.name)")
            }
        }
    }

    // MARK: - parseBootstrapLine

    @MainActor
    @Test func parseBootstrapLineMatchesTheCorpus() throws {
        let vector = try Self.loadVector("parse-bootstrap-line")
        let transport = Self.makeTransport()

        for testCase in vector.cases {
            guard let line = testCase.input.first as? String else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            if testCase.shouldThrow {
                #expect(throws: (any Error).self, "expected a throw — case: \(testCase.name)") {
                    _ = try transport.parseBootstrapLine(line)
                }
                continue
            }

            do {
                let event = try transport.parseBootstrapLine(line)

                // A present-but-null `expected` means the line is skippable.
                guard testCase.hasExpected, let expected = testCase.expected as? [String: Any] else {
                    #expect(event == nil, "expected no event — case: \(testCase.name)")
                    continue
                }

                switch expected["type"] as? String {
                case "row":
                    let expectedRow = expected["row"] as? [String: Any] ?? [:]
                    guard case let .model(modelName, data)? = event else {
                        Issue.record("expected a model row — case: \(testCase.name)")
                        continue
                    }
                    #expect(modelName == expectedRow["modelName"] as? String, "model name — case: \(testCase.name)")
                    Self.expectJSON(data, equals: expectedRow["data"], caseName: testCase.name, field: "row data")

                case "meta":
                    let expectedMeta = expected["metadata"] as? [String: Any] ?? [:]
                    guard case let .metadata(metadata)? = event else {
                        Issue.record("expected metadata — case: \(testCase.name)")
                        continue
                    }
                    // `raw` is the echoed input the TypeScript decoder retains;
                    // BootstrapMetadata models the decoded fields only.
                    #expect(
                        metadata.lastSyncId == expectedMeta["lastSyncId"] as? String,
                        "metadata lastSyncId — case: \(testCase.name)"
                    )
                    if let groups = expectedMeta["subscribedSyncGroups"] as? [String] {
                        #expect(
                            metadata.subscribedSyncGroups == groups,
                            "subscribedSyncGroups — case: \(testCase.name)"
                        )
                    }
                    if let schemaHash = expectedMeta["schemaHash"] as? String {
                        #expect(metadata.schemaHash == schemaHash, "schemaHash — case: \(testCase.name)")
                    }

                case "end":
                    guard case let .end(rowCount)? = event else {
                        Issue.record("expected the end marker — case: \(testCase.name)")
                        continue
                    }
                    #expect(rowCount == expected["rowCount"] as? Int, "rowCount — case: \(testCase.name)")

                default:
                    Issue.record("unhandled expected shape — case: \(testCase.name)")
                }
            } catch {
                Issue.record("unexpected throw \(error) — case: \(testCase.name)")
            }
        }
    }

    // MARK: - parseSyncId

    /// `SyncId` is `String`, so the vector's non-string rejections (a JSON
    /// number, null, a boolean, an absent value) are unrepresentable here —
    /// the type system enforces what the corpus enforces at runtime, which is
    /// the stronger guarantee. The string cases are the ones worth asserting,
    /// and their count is pinned so a refresh that adds one cannot land in the
    /// unrepresentable bucket unnoticed.
    @Test func parseSyncIdMatchesTheCorpus() throws {
        let vector = try Self.loadVector("parse-sync-id")
        var unrepresentable = 0

        for testCase in vector.cases {
            guard let raw = testCase.input.first as? String else {
                unrepresentable += 1
                continue
            }
            #expect(
                isValidSyncId(raw) == !testCase.shouldThrow,
                "isValidSyncId(\(raw)) — case: \(testCase.name)"
            )
            // Validation never rewrites the value: leading zeros survive, which
            // is why compareSyncId rather than string equality is the comparison.
            if !testCase.shouldThrow {
                #expect(raw == testCase.expected as? String, "value not verbatim — case: \(testCase.name)")
            }
        }

        #expect(unrepresentable == 6, "the corpus's non-string cases changed; re-check the mapping")
    }

    // MARK: - mapGraphQLAction

    /// The corpus decodes a spelled-out mutation action into its log letter;
    /// this client only ever encodes the other way, through
    /// `TransactionAction.wireAction`. The same asymmetry is asserted from the
    /// other side: exactly one action spells itself as the input, and it is the
    /// one whose log letter the corpus expects.
    @Test func mapGraphQLActionMatchesTheCorpus() throws {
        let vector = try Self.loadVector("map-graphql-action")
        let all: [TransactionAction] = [.insert, .update, .delete, .archive, .unarchive]

        for testCase in vector.cases {
            guard let name = testCase.input.first as? String else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            let matches = all.filter { $0.wireAction == name }

            if testCase.shouldThrow {
                // Includes every log letter: "I" is a valid TransactionAction
                // raw value and still not a mutation action name. Reusing one
                // spelling for both wire formats is the error being pinned.
                #expect(matches.isEmpty, "\(name) is not a mutation action name — case: \(testCase.name)")
                continue
            }

            #expect(matches.count == 1, "expected exactly one action spelled \(name) — case: \(testCase.name)")
            #expect(
                matches.first?.rawValue == testCase.expected as? String,
                "log letter — case: \(testCase.name)"
            )
        }
    }

    // MARK: - readNdjsonLines

    @Test func readNdjsonLinesMatchesTheCorpus() throws {
        let vector = try Self.loadVector("read-ndjson-lines")

        for testCase in vector.cases {
            guard let chunks = testCase.input.first as? [String],
                  let expected = testCase.expected as? [String]
            else {
                Issue.record("unreadable case: \(testCase.name)")
                continue
            }

            do {
                var framer = NDJSONLineFramer()
                var lines: [String] = []
                for byte in chunks.joined().utf8 {
                    if let line = try framer.append(byte) { lines.append(line) }
                }
                if let line = try framer.finish() { lines.append(line) }

                #expect(lines == expected, "lines — case: \(testCase.name)")
            } catch {
                Issue.record("unexpected throw \(error) — case: \(testCase.name)")
            }
        }
    }

    // MARK: - Helpers

    @MainActor
    static func makeTransport() -> SyncTransport {
        SyncTransport(syncEndpoint: "https://example.invalid/sync", wsEndpoint: "wss://example.invalid/sync") { nil }
    }

    static func expectAction(_ action: SyncAction, matches expected: [String: Any], caseName: String) {
        #expect(action.id == expected["id"] as? String, "action id — case: \(caseName)")
        #expect(action.modelName == expected["modelName"] as? String, "modelName — case: \(caseName)")
        #expect(action.modelId == expected["modelId"] as? String, "modelId — case: \(caseName)")
        #expect(action.action.rawValue == expected["action"] as? String, "action — case: \(caseName)")

        if let expectedData = expected["data"] {
            expectJSON(action.data, equals: expectedData, caseName: caseName, field: "data")
        }
        if let groupId = expected["groupId"] as? String {
            #expect(action.groupId == groupId, "groupId — case: \(caseName)")
        }
        if let groups = expected["groups"] as? [String] {
            #expect(action.groups == groups, "groups — case: \(caseName)")
        }
        if let clientTxId = expected["clientTxId"] as? String {
            #expect(action.clientTxId == clientTxId, "clientTxId — case: \(caseName)")
        }
    }

    /// Deep-compares loosely typed JSON. `NSDictionary` equality handles nesting
    /// and treats `3` and `3.0` as equal, which is what the corpus intends.
    static func expectJSON(_ actual: Any?, equals expected: Any?, caseName: String, field: String) {
        let lhs = actual ?? NSNull()
        let rhs = expected ?? NSNull()
        #expect(
            NSDictionary(dictionary: ["v": lhs]).isEqual(to: ["v": rhs]),
            "\(field) mismatch — case: \(caseName)\n  actual:   \(lhs)\n  expected: \(rhs)"
        )
    }
}
