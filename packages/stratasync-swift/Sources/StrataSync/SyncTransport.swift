import Foundation

/// Splits an NDJSON body into lines. Lines are trimmed and blank ones are
/// skipped, so a trailing newline, a missing trailing newline, a blank line
/// mid-body and CRLF endings all frame the same
/// (`vectors/read-ndjson-lines.json`). It does not parse JSON: a line that is
/// not an object is yielded verbatim and rejected downstream.
struct NDJSONLineFramer {
    private var buffer: [UInt8] = []

    mutating func append(_ byte: UInt8) throws -> String? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        return try takeLine()
    }

    mutating func finish() throws -> String? {
        guard !buffer.isEmpty else { return nil }
        return try takeLine()
    }

    /// nil for a line with nothing on it, which is skipped rather than yielded.
    private mutating func takeLine() throws -> String? {
        guard let line = String(bytes: buffer, encoding: .utf8) else {
            throw SyncTransportError.invalidResponse
        }
        buffer.removeAll(keepingCapacity: true)
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// MARK: - Sync Transport

/// Handles all network communication for the sync engine:
/// NDJSON bootstrap, REST mutations, WebSocket delta subscriptions, HTTP delta fetch.
/// Non-final so tests can subclass it as a mock transport.
@MainActor
open class SyncTransport {
    public let syncEndpoint: String
    public let wsEndpoint: String
    public let getToken: () async -> String?

    private var webSocketTask: URLSessionWebSocketTask?
    private var shouldReconnect = false
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 10
    private let baseDelay: TimeInterval = 1.0
    private let maxDelay: TimeInterval = 30.0
    private let keepAliveInterval: TimeInterval = 20.0
    private let keepAlivePongTimeout: TimeInterval = 10.0

    public private(set) var connectionState: ConnectionState = .disconnected
    public var onConnectionStateChange: ((ConnectionState) -> Void)?

    public init(syncEndpoint: String, wsEndpoint: String, getToken: @escaping () async -> String?) {
        self.syncEndpoint = syncEndpoint
        self.wsEndpoint = wsEndpoint
        self.getToken = getToken
    }

    // MARK: - Bootstrap

    /// Streams bootstrap data from GET /sync/bootstrap as NDJSON.
    open func bootstrap(syncGroups: [String]) -> AsyncThrowingStream<BootstrapEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let token = await self.getToken() else {
                        continuation.finish(throwing: SyncTransportError.noToken)
                        return
                    }

                    var components = URLComponents(string: "\(self.syncEndpoint)/bootstrap")!
                    var queryItems: [URLQueryItem] = [
                        URLQueryItem(name: "type", value: "full"),
                    ]
                    if !syncGroups.isEmpty {
                        queryItems.append(URLQueryItem(name: "syncGroups", value: syncGroups.joined(separator: ",")))
                    }
                    components.queryItems = queryItems

                    var request = URLRequest(url: components.url!)
                    request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
                        if httpResponse.statusCode == 409 {
                            throw SyncTransportError.bootstrapRequired
                        }
                        throw SyncTransportError.httpError(statusCode: httpResponse.statusCode)
                    }

                    var framer = NDJSONLineFramer()
                    var lineNumber = 0
                    for try await byte in bytes {
                        if let line = try framer.append(byte),
                           let event = try self.parseBootstrapRecord(line, lineNumber: &lineNumber) {
                            continuation.yield(event)
                        }
                    }
                    if let line = try framer.finish(),
                       let event = try self.parseBootstrapRecord(line, lineNumber: &lineNumber) {
                        continuation.yield(event)
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Mutations

    /// Sends a batch of mutations via POST /sync/mutate.
    open func mutate(batch: TransactionBatch) async throws -> MutateResult {
        if batch.transactions.isEmpty {
            return MutateResult(success: true, lastSyncId: zeroSyncId, results: [])
        }

        guard let token = await getToken() else {
            throw SyncTransportError.noToken
        }

        let url = URL(string: "\(syncEndpoint)/mutate")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Build the wire-format body
        let transactions: [[String: Any]] = batch.transactions.map { tx in
            var wirePayload = tx.payload
            // For DELETE, include original data in payload (server needs it)
            if tx.action == .delete, let original = tx.original {
                var merged = original
                for (key, value) in tx.payload {
                    merged[key] = value
                }
                wirePayload = merged
            }

            return [
                "clientTxId": tx.clientTxId,
                "clientId": tx.clientId,
                "modelName": tx.modelName,
                "modelId": tx.modelId,
                "action": tx.action.wireAction,
                "payload": wirePayload,
            ]
        }

        let body: [String: Any] = [
            "batchId": batch.batchId,
            "transactions": transactions,
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
            throw SyncTransportError.httpError(statusCode: httpResponse.statusCode)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncTransportError.invalidResponse
        }

        let success = json["success"] as? Bool ?? false
        let lastSyncId = String(describing: json["lastSyncId"] ?? "0")

        let rawResults = json["results"] as? [[String: Any]] ?? []
        let results: [TransactionResult] = rawResults.map { r in
            TransactionResult(
                clientTxId: r["clientTxId"] as? String ?? "",
                success: r["success"] as? Bool ?? false,
                syncId: (r["syncId"]).map { String(describing: $0) },
                error: r["error"] as? String
            )
        }

        return MutateResult(success: success, lastSyncId: lastSyncId, results: results)
    }

    // MARK: - Delta Subscription (WebSocket)

    /// Subscribes to delta updates via WebSocket.
    open func subscribe(afterSyncId: SyncId, groups: [String]) -> AsyncThrowingStream<DeltaPacket, Error> {
        subscribe(cursorProvider: { afterSyncId }, groups: groups)
    }

    /// Subscribes to delta updates via WebSocket. `cursorProvider` is consulted
    /// on every (re)connect so reconnects resume from the current cursor rather
    /// than the cursor captured when the subscription started.
    open func subscribe(
        cursorProvider: @escaping () -> SyncId,
        groups: [String]
    ) -> AsyncThrowingStream<DeltaPacket, Error> {
        AsyncThrowingStream { continuation in
            Task {
                self.shouldReconnect = true
                self.reconnectAttempts = 0

                await self.connectAndSubscribe(
                    cursorProvider: cursorProvider,
                    groups: groups,
                    continuation: continuation
                )
            }
        }
    }

    private func connectAndSubscribe(
        cursorProvider: @escaping () -> SyncId,
        groups: [String],
        continuation: AsyncThrowingStream<DeltaPacket, Error>.Continuation
    ) async {
        guard self.shouldReconnect else {
            continuation.finish()
            return
        }

        var keepAliveTask: Task<Void, Never>?
        defer { keepAliveTask?.cancel() }

        do {
            guard let token = await getToken() else {
                throw SyncTransportError.noToken
            }

            let request = try Self.makeWebSocketRequest(endpoint: wsEndpoint, token: token)
            let afterSyncId = cursorProvider()

            setConnectionState(reconnectAttempts > 0 ? .reconnecting : .connecting)

            let task = URLSession.shared.webSocketTask(with: request)
            self.webSocketTask = task
            task.resume()

            SyncLog.transport.debug("WebSocket opening attempt=\(self.reconnectAttempts, privacy: .public)")

            // Send subscribe message. The server defaults to all authorized groups
            // when `groups` is omitted, so only include it when we have an explicit list.
            let subscribeMessage = Self.makeSubscribeMessage(
                afterSyncId: afterSyncId,
                groups: groups,
                token: token
            )
            let subscribeData = try JSONSerialization.data(withJSONObject: subscribeMessage)
            try await task.send(.string(String(data: subscribeData, encoding: .utf8)!))

            keepAliveTask = startKeepAlive(for: task)

            // Unified receive loop. The server sends the `subscribed` ack LAST,
            // after replaying any missed actions as `delta` frames, so we must not
            // assume the first frame is the ack, and must deliver deltas that arrive
            // before it.
            while shouldReconnect {
                let message = try await task.receive()

                let json: Any
                switch message {
                case .string(let text):
                    guard let data = text.data(using: .utf8) else {
                        throw SyncTransportError.invalidResponse
                    }
                    json = try JSONSerialization.jsonObject(with: data)
                case .data(let data):
                    json = try JSONSerialization.jsonObject(with: data)
                @unknown default:
                    throw SyncTransportError.invalidResponse
                }

                guard let object = json as? [String: Any] else {
                    // Non-object frames (e.g. a bare array of actions) may still be a packet.
                    if let packet = try parseDeltaPacket(json) {
                        continuation.yield(packet)
                    }
                    continue
                }

                switch object["type"] as? String {
                case "subscribed":
                    reconnectAttempts = 0
                    setConnectionState(.connected)
                    SyncLog.transport.debug("WebSocket subscribed ack received")
                case "error":
                    let errorMessage = object["message"] as? String ?? "Unknown error"
                    let errorCode = (object["code"] as? String)?.uppercased() ?? ""
                    if errorCode.contains("BOOTSTRAP") || errorMessage.uppercased().contains("BOOTSTRAP_REQUIRED") {
                        throw SyncTransportError.bootstrapRequired
                    }
                    throw SyncTransportError.subscriptionError(errorMessage)
                default:
                    // An unrecognized frame must never take the connection down:
                    // a newer server may send frames this build predates, and
                    // throwing here would drop the socket and reconnect in a loop.
                    if let frameType = object["type"] as? String, frameType != "delta" {
                        SyncLog.transport.debug("Ignoring unrecognized frame type")
                        continue
                    }
                    if let packet = try parseDeltaPacket(object) {
                        continuation.yield(packet)
                    }
                }
            }
        } catch {
            keepAliveTask?.cancel()
            setConnectionState(.disconnected)

            // A stale cursor can't be fixed by reconnecting, so surface it so the
            // orchestrator performs a full re-bootstrap.
            if case SyncTransportError.bootstrapRequired = error {
                continuation.finish(throwing: error)
                return
            }

            guard shouldReconnect else {
                continuation.finish()
                return
            }

            // Reconnect with exponential backoff
            if reconnectAttempts < maxReconnectAttempts {
                let delay = calculateBackoff(attempt: reconnectAttempts)
                reconnectAttempts += 1
                setConnectionState(.reconnecting)

                try? await Task.sleep(for: .seconds(delay))

                await connectAndSubscribe(
                    cursorProvider: cursorProvider,
                    groups: groups,
                    continuation: continuation
                )
            } else {
                setConnectionState(.error)
                continuation.finish(throwing: SyncTransportError.maxReconnectAttemptsReached)
            }
        }
    }

    // MARK: - Keepalive

    /// A half-open socket (server gone, network path changed, app resumed from
    /// suspension) never errors on its own: `receive()` just hangs forever and
    /// the connection looks `.connected` while live deltas silently stop.
    /// Detect that by pinging periodically and killing the socket when the pong
    /// doesn't come back; the pending `receive()` then throws and the normal
    /// reconnect-and-replay path takes over.
    private func startKeepAlive(for task: URLSessionWebSocketTask) -> Task<Void, Never> {
        Task { [weak self, weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.keepAliveInterval ?? 20.0))
                guard !Task.isCancelled, let self, let task, task.state == .running else { return }

                let alive = await self.sendPingAwaitingPong(task, timeout: self.keepAlivePongTimeout)
                if Task.isCancelled { return }
                if !alive {
                    SyncLog.transport.error("WebSocket keepalive ping failed, closing zombie connection")
                    task.cancel(with: .abnormalClosure, reason: nil)
                    return
                }
            }
        }
    }

    /// Sends a ping and waits for the pong, racing against `timeout`.
    private func sendPingAwaitingPong(
        _ task: URLSessionWebSocketTask,
        timeout: TimeInterval
    ) async -> Bool {
        let race = PingRaceState()
        return await withCheckedContinuation { continuation in
            Task {
                try? await Task.sleep(for: .seconds(timeout))
                if race.tryResume() {
                    continuation.resume(returning: false)
                }
            }
            task.sendPing { error in
                if race.tryResume() {
                    continuation.resume(returning: error == nil)
                }
            }
        }
    }

    // MARK: - Delta Fetch (HTTP)

    /// Fetches deltas via GET /sync/deltas for catch-up after reconnect.
    open func fetchDeltas(after: SyncId, limit: Int? = nil) async throws -> DeltaPacket {
        guard let token = await getToken() else {
            throw SyncTransportError.noToken
        }

        var components = URLComponents(string: "\(syncEndpoint)/deltas")!
        var queryItems = [URLQueryItem(name: "after", value: after)]
        if let limit {
            queryItems.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        components.queryItems = queryItems

        var request = URLRequest(url: components.url!)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
            // The server answers 409 when `after` is older than its delta
            // retention window; only a full bootstrap can recover.
            if httpResponse.statusCode == 409 {
                throw SyncTransportError.bootstrapRequired
            }
            throw SyncTransportError.httpError(statusCode: httpResponse.statusCode)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncTransportError.invalidResponse
        }

        // Unlike a socket frame, a delta response that is not a packet has
        // nowhere to be ignored: the caller is waiting on this page.
        guard let packet = try parseDeltaPacket(json) else {
            throw SyncTransportError.invalidResponse
        }
        return packet
    }

    // MARK: - Close

    open func close() async {
        shouldReconnect = false
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        setConnectionState(.disconnected)
    }

    // MARK: - Private Helpers

    /// Keeps bearer credentials out of URLs, which may be retained by logs,
    /// proxies, crash reports, and URL history. Existing non-auth query items
    /// are preserved; any legacy `token` item is removed defensively.
    static func makeWebSocketRequest(endpoint: String, token: String) throws -> URLRequest {
        guard var components = URLComponents(string: endpoint) else {
            throw SyncTransportError.invalidURL
        }
        let queryItems = components.queryItems?.filter {
            $0.name.caseInsensitiveCompare("token") != .orderedSame
        }
        components.queryItems = queryItems?.isEmpty == false ? queryItems : nil
        guard let url = components.url else {
            throw SyncTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// @stratasync/server 0.5.0 re-authorizes the subscribe frame separately
    /// from the HTTP upgrade, so the body token remains until that wire contract
    /// is upgraded upstream.
    static func makeSubscribeMessage(
        afterSyncId: SyncId,
        groups: [String],
        token: String
    ) -> [String: Any] {
        var message: [String: Any] = [
            "type": "subscribe",
            "afterSyncId": afterSyncId,
            "token": token,
        ]
        if !groups.isEmpty {
            message["groups"] = groups
        }
        return message
    }

    private func setConnectionState(_ state: ConnectionState) {
        if connectionState != state {
            connectionState = state
            SyncLog.transport.debug("WebSocket connection state=\(String(describing: state), privacy: .public)")
            onConnectionStateChange?(state)
        }
    }

    private func calculateBackoff(attempt: Int) -> TimeInterval {
        let exponentialDelay = baseDelay * pow(2.0, Double(attempt))
        let clampedDelay = min(exponentialDelay, maxDelay)
        // Add jitter (±20%)
        let jitter = clampedDelay * 0.2
        return clampedDelay + Double.random(in: -jitter...jitter)
    }

    // MARK: - NDJSON Parsing

    private func parseBootstrapRecord(_ line: String, lineNumber: inout Int) throws -> BootstrapEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        lineNumber += 1

        do {
            return try parseBootstrapLine(trimmed)
        } catch {
            let rejectedLineNumber = lineNumber
            let object = trimmed.data(using: .utf8).flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }
            let modelName = object?["__class"] as? String ?? "none"
            let keys = object?.keys.sorted().joined(separator: ",") ?? "non-object"
            SyncLog.transport.error(
                "Bootstrap line rejected index=\(rejectedLineNumber, privacy: .public) model=\(modelName, privacy: .public) keys=\(keys, privacy: .public)"
            )
            throw error
        }
    }

    func parseBootstrapLine(_ line: String) throws -> BootstrapEvent? {
        // A blank or whitespace-only line carries nothing; it is skippable, not
        // malformed. Feeding it to JSONSerialization would throw.
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }

        // Check for metadata prefix
        if line.hasPrefix("_metadata_=") {
            let jsonString = String(line.dropFirst("_metadata_=".count))
            guard let data = jsonString.data(using: .utf8) else {
                throw SyncTransportError.invalidResponse
            }
            let json: [String: Any]
            do {
                guard let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw SyncTransportError.invalidResponse
                }
                json = decoded
            } catch {
                throw SyncTransportError.invalidResponse
            }
            return .metadata(try parseBootstrapMetadata(json))
        }

        guard let data = line.data(using: .utf8) else {
            throw SyncTransportError.invalidResponse
        }
        let json: [String: Any]
        do {
            guard let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SyncTransportError.invalidResponse
            }
            json = decoded
        } catch {
            throw SyncTransportError.invalidResponse
        }

        // Check for embedded metadata
        if let metadataObj = json["_metadata_"] as? [String: Any] {
            return .metadata(try parseBootstrapMetadata(metadataObj))
        }

        // Check for error
        if json["type"] as? String == "error" {
            throw SyncTransportError.invalidResponse
        }

        // The end marker is classified before metadata: an end carrying a
        // `lastSyncId` is still an end, and reading it as metadata swallowed
        // the terminator.
        if json["type"] as? String == "end" {
            return .end(rowCount: json["rowCount"] as? Int)
        }

        // Check if the line itself is metadata
        if json["lastSyncId"] != nil || json["subscribedSyncGroups"] != nil || json["returnedModelsCount"] != nil {
            return .metadata(try parseBootstrapMetadata(json))
        }

        // Model row: extract __class as modelName
        guard let modelName = json["__class"] as? String else {
            throw SyncTransportError.invalidResponse
        }

        var rowData = json
        rowData.removeValue(forKey: "__class")

        return .model(modelName: modelName, data: rowData)
    }

    private func parseBootstrapMetadata(_ json: [String: Any]) throws -> BootstrapMetadata {
        var meta = BootstrapMetadata(subscribedSyncGroups: [])

        if let lastSyncId = json["lastSyncId"] {
            // Strings only — a JSON number has already lost precision.
            guard let parsed = lastSyncId as? String, isValidSyncId(parsed) else {
                throw SyncTransportError.invalidResponse
            }
            meta.lastSyncId = parsed
        }

        // Non-string members are dropped rather than failing the whole line:
        // one bad group should not cost the client its metadata.
        if let groups = json["subscribedSyncGroups"] as? [Any] {
            meta.subscribedSyncGroups = groups.compactMap { $0 as? String }
        }

        if json["returnedModelsCount"] != nil {
            guard let counts = json["returnedModelsCount"] as? [String: Int],
                  counts.values.allSatisfy({ $0 >= 0 }) else {
                throw SyncTransportError.invalidResponse
            }
            meta.returnedModelsCount = counts
        }

        if let hash = json["schemaHash"] as? String {
            meta.schemaHash = hash
        }

        if let version = json["databaseVersion"] as? Int {
            meta.databaseVersion = version
        }

        return meta
    }

    // MARK: - Delta Packet Parsing

    /// Parses raw JSON into a DeltaPacket. Four payload shapes are a packet — a
    /// bare array of actions, a `{type:"delta", packet}` socket envelope, a
    /// direct `{actions, lastSyncId, hasMore}` object, and a single bare action.
    /// Anything else is not a delta at all and decodes to nil. Only a payload
    /// that *is* a packet throws, and then only over what it claims to carry:
    /// an undecodable action, a malformed `actions` container, or a non-string
    /// `lastSyncId`.
    func parseDeltaPacket(_ raw: Any) throws -> DeltaPacket? {
        // Array of actions. Non-object members are skipped rather than fatal:
        // a padded or partially-null array still carries real actions.
        if let array = raw as? [Any] {
            let actions = try array.compactMap { rawAction -> SyncAction? in
                guard let action = rawAction as? [String: Any] else { return nil }
                return try parseSyncAction(action)
            }
            return DeltaPacket(
                lastSyncId: derivedWatermark(actions),
                actions: actions,
                hasMore: false
            )
        }

        guard let payload = raw as? [String: Any] else {
            return nil
        }

        // Wrapped delta: {"type": "delta", "packet": {...}} or {"type": "delta", ...}
        if payload["type"] as? String == "delta", let packet = payload["packet"] {
            return try parseDeltaPacket(packet)
        }

        // Direct packet: {"lastSyncId": ..., "actions": [...]}
        if payload["actions"] != nil {
            return try parseDeltaPacketFromDict(payload)
        }

        // Single action
        if payload["action"] != nil, payload["modelName"] != nil, payload["modelId"] != nil {
            let action = try parseSyncAction(payload)
            return DeltaPacket(lastSyncId: action.id, actions: [action], hasMore: false)
        }

        return nil
    }

    private func parseDeltaPacketFromDict(_ payload: [String: Any]) throws -> DeltaPacket {
        // Strict where the bare-array shape is lenient, and the watermark is
        // why. That shape derives its watermark from the actions that survive,
        // so a dropped member cannot move the cursor past itself; this one
        // takes the server's watermark verbatim, so silently emptying a
        // malformed `actions` would advance the cursor over deltas that were
        // never applied and are never refetched.
        guard let actionsRaw = payload["actions"] as? [Any] else {
            throw SyncTransportError.invalidResponse
        }
        let actions = try actionsRaw.map { rawAction -> SyncAction in
            guard let action = rawAction as? [String: Any] else {
                throw SyncTransportError.invalidResponse
            }
            return try parseSyncAction(action)
        }

        // The server's watermark is taken verbatim when it supplies one, even
        // when it sits behind the highest action in the same packet; it is only
        // derived when the payload omits it. A non-string is rejected rather
        // than coerced — sync IDs outgrow 2^53, so a JSON number has already
        // lost precision by the time it gets here.
        let lastSyncId: SyncId
        if let raw = payload["lastSyncId"] {
            guard let parsed = raw as? String, isValidSyncId(parsed) else {
                throw SyncTransportError.invalidResponse
            }
            lastSyncId = parsed
        } else {
            lastSyncId = derivedWatermark(actions)
        }

        // Absent and false are the same to every consumer, so a non-boolean is
        // discarded rather than coerced or fatal.
        return DeltaPacket(
            lastSyncId: lastSyncId,
            actions: actions,
            hasMore: payload["hasMore"] as? Bool ?? false
        )
    }

    /// The highest sync ID in the packet, compared numerically rather than
    /// lexicographically. Action order is preserved exactly as received.
    private func derivedWatermark(_ actions: [SyncAction]) -> SyncId {
        actions.reduce(zeroSyncId) { maxSyncId($0, $1.id) }
    }

    // Internal rather than private so the conformance vector suite can assert
    // it directly; it is not part of the consumer API.
    func parseSyncAction(_ raw: [String: Any]) throws -> SyncAction {
        // Sync IDs must arrive as strings and are never coerced: they outgrow
        // 2^53, so a JSON number would already have lost precision by the time
        // it got here. Stringifying one produced a plausible-looking but wrong
        // cursor. The conformance corpus pins this
        // (`vectors/parse-sync-action.json`, "a numeric sync id is rejected").
        guard let syncId = (raw["syncId"] ?? raw["id"]) as? String else {
            throw SyncTransportError.invalidResponse
        }

        guard isValidSyncId(syncId),
              isSyncIdGreaterThan(syncId, zeroSyncId),
              let modelName = raw["modelName"] as? String,
              !modelName.isEmpty,
              let modelId = raw["modelId"] as? String,
              !modelId.isEmpty,
              let actionStr = raw["action"] as? String,
              let action = SyncActionType(rawValue: actionStr) else {
            throw SyncTransportError.invalidResponse
        }

        // Malformed *optional* fields are discarded, never fatal. A required
        // field still throws. Rejecting a whole packet over one bad optional
        // wedges this client on a payload every other implementation accepts,
        // and the sync stream has no way to route around it.
        let data = raw["data"] as? [String: Any] ?? [:]

        // Absent stays nil; a non-array is absent too, not an empty list.
        let groups = (raw["groups"] as? [Any]).map { $0.compactMap { $0 as? String } }
        let groupId = optionalString(raw["groupId"])
        let clientTxId = optionalString(raw["clientTxId"])
        let clientId = optionalString(raw["clientId"])

        return SyncAction(
            id: syncId,
            modelName: modelName,
            modelId: modelId,
            action: action,
            data: data,
            groupId: groupId,
            groups: groups,
            clientTxId: clientTxId,
            clientId: clientId
        )
    }

    /// An optional string field: absent, or a string. Anything else is dropped
    /// rather than coerced — a numeric idempotency key stringified into a
    /// plausible-looking one that matched nothing.
    private func optionalString(_ raw: Any?) -> String? {
        raw as? String
    }
}

/// Guards the ping/timeout continuation race: `sendPing`'s handler fires on a
/// URLSession queue while the timeout fires from a Task, and exactly one side
/// may resume the continuation.
private final class PingRaceState: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func tryResume() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed {
            return false
        }
        resumed = true
        return true
    }
}

// MARK: - Errors

enum SyncTransportError: Error, LocalizedError {
    case noToken
    case invalidURL
    case httpError(statusCode: Int)
    case invalidResponse
    case subscriptionError(String)
    case graphqlError(String)
    case maxReconnectAttemptsReached
    case bootstrapRequired
    case incompleteBootstrap

    var errorDescription: String? {
        switch self {
        case .noToken: "No auth token available"
        case .invalidURL: "Invalid URL"
        case .httpError(let code): "HTTP error: \(code)"
        case .invalidResponse: "Invalid response from server"
        case .subscriptionError(let msg): "Subscription error: \(msg)"
        case .graphqlError(let msg): "GraphQL error: \(msg)"
        case .maxReconnectAttemptsReached: "Max reconnect attempts reached"
        case .bootstrapRequired: "Sync cursor is too old, full re-bootstrap required"
        case .incompleteBootstrap:
            "Bootstrap is missing its completion marker or its row count does not match"
        }
    }
}
