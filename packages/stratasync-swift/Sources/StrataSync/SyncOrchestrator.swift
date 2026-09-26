import Foundation

/// Upper bound on actions buffered across catch-up pages before flushing.
/// Sized well above the server's 1000-action page so a typical backlog lands
/// in one flush, while a badly stale client still can't buffer unboundedly.
private let coalescedCatchUpActionLimit = 10_000

@MainActor
final class SyncOrchestrator {
    private let runtime: SyncRuntime
    private let storage: StorageAdapter
    private let transport: SyncTransport
    private let modelStore: SyncModelStore
    private let outboxManager: OutboxManager
    private let stateQueue: StateQueue
    // The client's expected schema hash. When non-empty and different from the
    // persisted hash, the next start forces a full re-bootstrap so a shipped
    // model change can't silently decode stale rows. Empty = no hash gate.
    private let clientSchemaHash: String

    private(set) var running = false
    private(set) var state: SyncClientState = .disconnected
    private(set) var lastSyncId: SyncId = zeroSyncId {
        didSet { onCursorChange?(lastSyncId) }
    }
    private(set) var clientId: String = ""
    var isGroupChangeReconcilePending: Bool { groupChangeBootstrapPending }

    func shouldSuppressPrivacyRollback(_ transaction: Transaction) -> Bool {
        groupChangeBootstrapPending
            || (privacyWithheldTransactionIds.contains(transaction.clientTxId)
                && modelStore.snapshot(
                    modelName: transaction.modelName,
                    id: transaction.modelId
                ) == nil)
    }
    private var firstSyncId: SyncId = zeroSyncId
    private var subscribedGroups: [String] = []
    /// The server-authoritative groups the current snapshot was captured under
    /// (see `StorageMeta.authoritativeGroups`). A group change is compared
    /// against this, never against `subscribedGroups`, which a host's requested
    /// groups can overwrite. `nil` = unknown.
    private var authoritativeGroups: [String]?
    private var bootstrapComplete = false
    private var schemaHash: String?
    private var databaseVersion: Int?
    private var lastSyncAt: TimeInterval?
    private var deltaTask: Task<Void, Never>?
    private var catchUpRetryTask: Task<Void, Never>?
    private var catchUpRetryAttempt = 0
    private var hasConnected = false
    private var reconnectPending = false

    // Replay barrier: live WS packets arriving while we're still catching up
    // via REST are buffered, otherwise they advance the cursor past deltas the
    // catch-up hasn't fetched yet (which would then be dropped permanently).
    private var isCatchingUp = false
    private var bufferedPackets: [DeltaPacket] = []
    /// Guards against stacking re-bootstraps while one is already in flight.
    private var groupChangeBootstrapRequested = false
    /// Latches until a group-change re-bootstrap actually succeeds.
    ///
    /// Separate from the in-flight guard above because it must outlive a failed
    /// attempt: the scheduled bootstrap is a detached task, and if it throws,
    /// ordinary recovery calls `restartSubscription()` without `forceBootstrap`.
    /// Without this latch that recovery would resume from a cursor already past
    /// the group action, which is then never redelivered — losing the very
    /// membership change the in-band action exists to guarantee.
    ///
    /// This is the privacy quarantine: while it is set, cached rows are hidden
    /// and the latch is durable, so a relaunch keeps them hidden too. Only a
    /// group change that may have removed access sets it.
    private var groupChangeBootstrapPending = false
    /// A group change that only added access still owes a re-bootstrap, so the
    /// new groups' history (which sits behind our cursor) arrives, and still
    /// holds the cursor before the group action until it lands. It does not
    /// hide rows: every cached row is still authorized. In memory only — the
    /// held cursor makes catch-up redeliver the group action after a relaunch,
    /// which re-derives this.
    private var groupChangeRebootstrapOwed = false
    /// Any group-change re-bootstrap is outstanding, quarantined or not.
    private var groupChangeReconcileOwed: Bool {
        groupChangeBootstrapPending || groupChangeRebootstrapOwed
    }
    private var privacyWithheldTransactionIds = Set<String>()
    private var groupChangeRetryTask: Task<Void, Never>?
    // Coalesces concurrent restart requests (foreground reconnect racing the
    // dying subscription's own restart): two interleaved catch-up loops would
    // double-apply deltas and fight over the cursor. A request arriving while
    // one is in flight queues a single follow-up rather than being dropped, so
    // a subscription that dies mid-restart still gets revived.
    private var isRestarting = false
    private var queuedRestart: (requested: Bool, forceBootstrap: Bool, reason: SyncBootstrapReason) =
        (false, false, .forced)
    var resubscribeDelay: TimeInterval = 2.0
    var groupChangeRetryDelay: TimeInterval = 2.0

    var onCursorChange: ((SyncId) -> Void)?
    var onStateChange: ((SyncClientState) -> Void)?
    var onConnectionStateChange: ((ConnectionState) -> Void)?
    var onConflict: ((Transaction) -> Void)?
    var onEvent: ((SyncClientEvent) -> Void)?
    var onClientIdLoaded: ((String) -> Void)?

    init(
        storage: StorageAdapter,
        transport: SyncTransport,
        modelStore: SyncModelStore,
        outboxManager: OutboxManager,
        stateQueue: StateQueue? = nil,
        clientSchemaHash: String = "",
        runtime: SyncRuntime? = nil
    ) {
        self.runtime = runtime ?? .live
        self.storage = storage
        self.transport = transport
        self.modelStore = modelStore
        self.outboxManager = outboxManager
        self.stateQueue = stateQueue ?? StateQueue()
        self.clientSchemaHash = clientSchemaHash

        // Deduped mutate acks can owe a sync id the engine has already applied
        // via bootstrap/deltas. Outbox uses this to clear awaitingSync without
        // waiting for a fresh echo (avoids reconnect resend storms).
        outboxManager.syncCursorProvider = { [weak self] in
            self?.lastSyncId ?? zeroSyncId
        }

        // The transport invokes this from its nonisolated networking task, so hop
        // back to the main actor before touching main-isolated engine state.
        transport.onConnectionStateChange = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                self.onConnectionStateChange?(state)
                self.onEvent?(.connectionChange(state))

                // Connectivity is back: flush any mutations queued while
                // offline. (During start() the initial flush is handled by
                // the start flow itself, and state is not .syncing yet then.)
                if state == .connected {
                    let needsCatchUp = self.reconnectPending
                    self.hasConnected = true
                    self.reconnectPending = false
                    if self.running, self.state == .syncing {
                        if needsCatchUp {
                            await self.restartSubscription(forceBootstrap: false, skipDelay: true)
                        } else {
                            try? await self.outboxManager.processPendingTransactions()
                        }
                    }
                } else if self.hasConnected {
                    self.reconnectPending = true
                }
            }
        }
    }

    func start(groups: [String]) async throws {
        guard !running else { return }
        running = true

        // The initial sync cycle is a restart window too: if the freshly
        // started subscription dies mid-cycle, its termination restart must
        // queue rather than interleave a second catch-up loop with this one.
        isRestarting = true
        defer { finishRestartWindow() }

        setState(.connecting)

        do {
            try await storage.open()
            let meta = await storage.getMeta()
            loadMetadata(meta)
            try await configureGroups(requestedGroups: groups, meta: meta)

            // stop() deliberately leaves the latch alone, so a stop/start
            // across a background cycle can resume still owing a reconcile.
            // Without this the apply gate below would drop every packet,
            // including the redelivered group action, and nothing would ever
            // schedule the bootstrap that clears it.
            try await runSyncCycle(forceBootstrap: groupChangeReconcileOwed, reason: .groupChange)
        } catch {
            running = false
            setState(.error)
            onEvent?(.syncError(error))
            throw error
        }
    }

    /// Bootstrap (or hydrate), subscribe, catch up missed deltas, then flush
    /// the outbox. Also used to recover from a server-mandated re-bootstrap.
    ///
    /// `reason` labels a forced bootstrap for ``SyncClientEvent``; an
    /// outstanding group change always reports `.groupChange`.
    private func runSyncCycle(
        forceBootstrap: Bool,
        reason forcedReason: SyncBootstrapReason = .forced
    ) async throws {
        setState(.bootstrapping)
        onEvent?(.syncStart)

        let bootstrapReason: SyncBootstrapReason? = if forceBootstrap {
            groupChangeReconcileOwed ? .groupChange : forcedReason
        } else {
            await bootstrapReasonIfNeeded()
        }

        // Network I/O stays off `stateQueue`. Holding the queue across the
        // bootstrap stream froze every mutation (New task included) for the
        // full download — a schema-hash re-bootstrap after an app update is
        // the same path a first launch takes, and can run for many seconds.
        // Local apply below is still exclusive: hydrate, snapshot replace,
        // metadata/cursor writes, and pending replay share the queue with
        // optimistic mutation persist and delta apply, so a delta cannot
        // land in a half-replaced store. A create that finishes during the
        // download is durable in the outbox and is replayed after replaceAll.
        //
        // A routine re-bootstrap (schema hash, stale cursor) leaves the cached
        // rows visible and on disk until the replacement commits: nothing says
        // access was revoked, and `replaceSnapshot` is one transaction, so a
        // crash or failed fetch falls back to the snapshot the user was
        // already looking at. Only a known revocation quarantines.
        var fetchedBootstrap: BootstrapSnapshot?
        var outboxTxIdsAtBootstrapFetch: Set<String>?
        var clearedQuarantine = false
        let bootstrapStartedAt = runtime.now()
        if let bootstrapReason {
            onEvent?(.bootstrapStarted(reason: bootstrapReason))
        }

        do {
            if bootstrapReason != nil {
                let pending = await storage.getOutbox()
                outboxTxIdsAtBootstrapFetch = Set(pending.map(\.clientTxId))
                fetchedBootstrap = try await fetchBootstrapSnapshot(groups: subscribedGroups)
            }

            try await stateQueue.run { [self] in
                var pendingForReplay: [Transaction]?
                if let snapshot = fetchedBootstrap {
                    try await applyBootstrapSnapshot(snapshot, groups: subscribedGroups)
                    let privacyReconcile = groupChangeBootstrapPending
                    if privacyReconcile {
                        pendingForReplay = try await preparePendingTransactionsForPrivacySnapshot()
                        pendingForReplay = await restoreInsertsCreatedDuringBootstrapFetch(
                            prefetchedOutboxIds: outboxTxIdsAtBootstrapFetch ?? [],
                            alreadyReplaying: pendingForReplay ?? []
                        )
                    } else {
                        try await withholdPendingChangesToRowsMissingFromSnapshot()
                    }
                    // The authoritative snapshot and all pending rollback
                    // sanitation are durable. Only now may restart hydration
                    // leave quarantine and optimistic replay resume.
                    groupChangeBootstrapPending = false
                    groupChangeRebootstrapOwed = false
                    try await persistMetadata()
                    clearedQuarantine = privacyReconcile
                    groupChangeRetryTask?.cancel()
                    groupChangeRetryTask = nil
                } else {
                    try await hydrateFromStorage()
                    bootstrapComplete = true
                    if firstSyncId == zeroSyncId, isSyncIdGreaterThan(lastSyncId, zeroSyncId) {
                        firstSyncId = lastSyncId
                    }
                    try await persistMetadata()
                }

                await applyPendingToIdentityMaps(pendingForReplay)
            }
        } catch {
            if let bootstrapReason {
                onEvent?(.bootstrapFailed(reason: bootstrapReason, error: error))
            }
            throw error
        }
        if let bootstrapReason, let fetchedBootstrap {
            onEvent?(.bootstrapFinished(
                reason: bootstrapReason,
                durationMs: max(0, Int(runtime.now() - bootstrapStartedAt)),
                recordCount: fetchedBootstrap.records.count
            ))
        }
        if clearedQuarantine {
            onEvent?(.quarantineCleared)
        }
        onEvent?(.localDataReady)

        isCatchingUp = true
        bufferedPackets.removeAll()
        startDeltaSubscription(afterSyncId: lastSyncId)

        do {
            // A full snapshot is followed by a replaying subscription. There is
            // no stale local cursor to catch up until a subsequent reconnect.
            if fetchedBootstrap == nil { try await catchUpMissedDeltas() }
            catchUpRetryAttempt = 0
        } catch {
            if isBootstrapRequiredError(error), !forceBootstrap {
                // Cursor too old: restart the cycle with a full bootstrap.
                deltaTask?.cancel()
                deltaTask = nil
                isCatchingUp = false
                try await runSyncCycle(forceBootstrap: true, reason: .cursorTooOld)
                return
            }
            if isOfflineSyncError(error) {
                // We have local data (bootstrap/hydrate already succeeded), so
                // stay alive offline: the WS subscribe replays from the current
                // cursor once connectivity returns, covering the catch-up gap.
                SyncLog.delta.debug("Catch-up skipped while offline; WS replay will cover the gap")
                onEvent?(.syncError(error))
                scheduleCatchUpRetry()
            } else {
                isCatchingUp = false
                throw error
            }
        }

        try await drainBufferedPackets()
        isCatchingUp = false

        try await outboxManager.processPendingTransactions()

        setState(.syncing)
        onEvent?(.syncComplete(lastSyncId: lastSyncId))
    }

    func stop() async {
        running = false
        catchUpRetryTask?.cancel()
        catchUpRetryTask = nil
        hasConnected = false
        reconnectPending = false
        groupChangeRetryTask?.cancel()
        groupChangeRetryTask = nil
        let task = deltaTask
        task?.cancel()
        deltaTask = nil
        isCatchingUp = false
        bufferedPackets.removeAll()
        await transport.close()
        // Wait for an in-flight applyDeltaPacket to finish before closing the
        // connection so it doesn't straddle a close/reopen generation.
        await task?.value
        try? await storage.close()
        setState(.disconnected)
    }

    func resetForAccountBoundary() {
        running = false
        catchUpRetryTask?.cancel()
        catchUpRetryTask = nil
        hasConnected = false
        reconnectPending = false
        groupChangeBootstrapPending = false
        groupChangeRebootstrapOwed = false
        groupChangeBootstrapRequested = false
        privacyWithheldTransactionIds.removeAll()
        groupChangeRetryTask?.cancel()
        groupChangeRetryTask = nil
        deltaTask?.cancel()
        deltaTask = nil
        isCatchingUp = false
        bufferedPackets.removeAll()
        isRestarting = false
        queuedRestart = (false, false, .forced)
        lastSyncId = zeroSyncId
        clientId = ""
        firstSyncId = zeroSyncId
        subscribedGroups.removeAll()
        authoritativeGroups = nil
        bootstrapComplete = false
        schemaHash = nil
        databaseVersion = nil
        lastSyncAt = nil
        setState(.disconnected)
    }

    /// Opens and hydrates the already-selected account without starting any
    /// network work. This makes an offline account switch immediately useful.
    func hydrateSelectedAccount() async throws -> (meta: StorageMeta, pendingCount: Int) {
        try await storage.open()
        let meta = await storage.getMeta()
        loadMetadata(meta)
        if meta.groupChangePending {
            // This snapshot is known to have been captured under obsolete
            // authority. Keep it quarantined until the required replacement
            // bootstrap completes instead of flashing revoked rows on launch.
            modelStore.clearAll()
            onEvent?(.localHydration(outcome: .quarantined, rowCount: 0))
        } else {
            let rowCount = try await hydrateFromStorage()
            await applyPendingToIdentityMaps()
            onEvent?(.localHydration(outcome: .storage, rowCount: rowCount))
        }
        return (meta, await outboxManager.getPendingCount())
    }

    private struct BootstrapSnapshot {
        let records: [StoredModelRecord]
        let metadata: BootstrapMetadata
    }

    /// Streams the remote snapshot without touching `stateQueue`. Validation
    /// is schema-only; the in-memory store and cursor stay unchanged until
    /// ``applyBootstrapSnapshot``.
    private func fetchBootstrapSnapshot(groups: [String]) async throws -> BootstrapSnapshot {
        var records: [StoredModelRecord] = []
        var completed = false
        var metadata: BootstrapMetadata?
        let stream = transport.bootstrap(syncGroups: groups)

        for try await event in stream {
            guard !completed else {
                throw SyncTransportError.invalidResponse
            }
            switch event {
            case .model(let modelName, let data):
                guard let id = data["id"] as? String else {
                    throw SyncModelStoreError.missingModelId(modelName: modelName)
                }
                try modelStore.validate(modelName: modelName, data: data)
                records.append(StoredModelRecord(modelName: modelName, id: id, data: data))
            case .metadata(let meta):
                guard metadata == nil else {
                    throw SyncTransportError.invalidResponse
                }
                metadata = meta
            case .end(let rowCount):
                guard let rowCount, rowCount >= 0, rowCount == records.count else {
                    throw SyncTransportError.incompleteBootstrap
                }
                completed = true
            }
        }

        guard let meta = metadata, let bootstrapSyncId = meta.lastSyncId else {
            throw SyncTransportError.invalidResponse
        }
        guard isValidSyncId(bootstrapSyncId) else {
            throw SyncTransportError.invalidResponse
        }
        guard completed else {
            throw SyncTransportError.incompleteBootstrap
        }
        // Metadata counts precede touched-row filtering; only the terminal
        // record reports the exact number of rows in this snapshot.
        if let expectedCounts = meta.returnedModelsCount,
           !expectedCounts.values.allSatisfy({ $0 >= 0 }) {
            throw SyncTransportError.invalidResponse
        }

        return BootstrapSnapshot(records: records, metadata: meta)
    }

    /// Local half of a bootstrap. Must run inside `stateQueue.run` so a delta
    /// or mutation cannot observe a half-replaced store. Does not fetch.
    private func applyBootstrapSnapshot(_ snapshot: BootstrapSnapshot, groups: [String]) async throws {
        let meta = snapshot.metadata
        guard let bootstrapSyncId = meta.lastSyncId else {
            throw SyncTransportError.invalidResponse
        }

        // No quarantine here. A replacement with no known revocation swaps
        // atomically: `replaceSnapshot` commits rows and meta in one
        // transaction and `replaceAll` swaps the in-memory store in one batch,
        // so the UI goes straight from the old rows to the new ones and a
        // crash before the commit leaves the old snapshot, which the user was
        // already seeing. A known revocation latched quarantine before the
        // fetch (`beginPrivacyReconciliation`), and that latch is carried
        // through `replacementMeta` below until pending sanitation is durable.

        let replacementFirstSyncId = firstSyncId == zeroSyncId ? bootstrapSyncId : firstSyncId
        let replacementGroups = meta.subscribedSyncGroups.isEmpty ? groups : meta.subscribedSyncGroups
        let replacementAuthoritativeGroups = meta.subscribedSyncGroups.isEmpty
            ? nil
            : uniqueGroups(meta.subscribedSyncGroups)
        let replacementLastSyncAt = currentTimestampMs()
        // Persist the client's schema hash (not the server's) so the next start
        // can detect a shipped model change. Fall back to the server hash when
        // the app hasn't supplied one, preserving prior behavior.
        let persistedSchemaHash = clientSchemaHash.isEmpty ? meta.schemaHash : clientSchemaHash
        let replacementMeta = StorageMeta(
            lastSyncId: bootstrapSyncId,
            firstSyncId: replacementFirstSyncId,
            subscribedGroups: replacementGroups,
            clientId: clientId,
            bootstrapComplete: true,
            groupChangePending: groupChangeBootstrapPending,
            privacyWithheldTransactionIds: Array(privacyWithheldTransactionIds).sorted(),
            schemaHash: persistedSchemaHash,
            databaseVersion: meta.databaseVersion,
            lastSyncAt: replacementLastSyncAt,
            authoritativeGroups: replacementAuthoritativeGroups
        )

        try await storage.replaceSnapshot(records: snapshot.records, meta: replacementMeta)
        try modelStore.replaceAll(with: snapshot.records)

        lastSyncId = bootstrapSyncId
        firstSyncId = replacementFirstSyncId
        subscribedGroups = replacementGroups
        authoritativeGroups = replacementAuthoritativeGroups
        bootstrapComplete = true
        schemaHash = persistedSchemaHash
        databaseVersion = meta.databaseVersion
        lastSyncAt = replacementLastSyncAt
    }

    /// Inserts that landed in the outbox while the snapshot was downloading
    /// are live user work, not stale leftovers from a revoked group. Privacy
    /// reconcile would otherwise withhold them because they are absent from
    /// the server snapshot (they were created locally during the fetch).
    private func restoreInsertsCreatedDuringBootstrapFetch(
        prefetchedOutboxIds: Set<String>,
        alreadyReplaying: [Transaction]
    ) async -> [Transaction] {
        let pending = await storage.getOutbox().filter {
            $0.state != .completed && $0.state != .failed
        }
        var replay = alreadyReplaying
        var replayed = Set(replay.map(\.clientTxId))
        for tx in pending where tx.action == .insert && !prefetchedOutboxIds.contains(tx.clientTxId) {
            privacyWithheldTransactionIds.remove(tx.clientTxId)
            if replayed.insert(tx.clientTxId).inserted {
                replay.append(tx)
            }
        }
        return replay
    }

    private func startDeltaSubscription(afterSyncId: SyncId) {
        deltaTask?.cancel()

        SyncLog.delta.debug("Delta subscription starting afterSyncId=\(afterSyncId, privacy: .public) groups=\(self.subscribedGroups.count, privacy: .public)")

        deltaTask = Task { [weak self] in
            guard let self else { return }
            // Reconnects inside the transport resume from the live cursor, not
            // the one captured when the subscription started.
            let stream = transport.subscribe(
                cursorProvider: { [weak self] in self?.lastSyncId ?? afterSyncId },
                groups: subscribedGroups
            )

            do {
                for try await packet in stream {
                    guard running, !Task.isCancelled else { break }
                    if isCatchingUp {
                        bufferedPackets.append(packet)
                    } else {
                        try await applyDeltaPacket(packet)
                    }
                }
                SyncLog.delta.debug("Delta subscription stream ended")
                await handleSubscriptionTermination(error: nil)
            } catch {
                SyncLog.delta.error("Delta subscription error: \(String(describing: error), privacy: .public)")
                await handleSubscriptionTermination(error: error)
            }
        }
    }

    /// The delta stream never recovers on its own once it terminates (the
    /// transport gives up after its max reconnect attempts), so restart it
    /// with a fresh catch-up to plug any gap.
    private func handleSubscriptionTermination(error: Error?) async {
        // Replacing our own subscription is not a network failure. Without
        // this fence every cancelled stream starts another reconnect forever.
        guard running, !Task.isCancelled else { return }

        if let error {
            onEvent?(.syncError(error))
        }

        let needsBootstrap = error.map(isBootstrapRequiredError) ?? false

        // Hop to a fresh task: this runs inside the dying delta task, and the
        // restart replaces (cancels) that task, so it must not cancel itself.
        Task { [weak self] in
            await self?.restartSubscription(forceBootstrap: needsBootstrap, reason: .cursorTooOld)
        }
    }

    func restartSubscription() async {
        await restartSubscription(forceBootstrap: false)
    }

    private func restartSubscription(
        forceBootstrap: Bool,
        reason: SyncBootstrapReason = .forced,
        skipDelay: Bool = false
    ) async {
        guard running else { return }
        if isRestarting {
            queuedRestart = (
                true,
                queuedRestart.forceBootstrap || forceBootstrap,
                forceBootstrap ? reason : queuedRestart.reason
            )
            return
        }
        isRestarting = true
        defer { finishRestartWindow() }

        // An outstanding group change forces the bootstrap regardless of why we
        // are restarting, so a plain recovery restart cannot quietly resume
        // without reconciling membership.
        if forceBootstrap || groupChangeReconcileOwed {
            do {
                // Clears the latch itself once the bootstrap succeeds. A failed
                // attempt leaves it set, so membership stays unreconciled and
                // the next restart forces another bootstrap.
                try await runSyncCycle(forceBootstrap: true, reason: reason)
            } catch {
                setState(.error)
                onEvent?(.syncError(error))
                scheduleGroupChangeRetry()
            }
            return
        }

        if !skipDelay { try? await runtime.sleep(resubscribeDelay) }
        guard running else { return }

        isCatchingUp = true
        bufferedPackets.removeAll()
        startDeltaSubscription(afterSyncId: lastSyncId)

        do {
            try await catchUpMissedDeltas()
            catchUpRetryAttempt = 0
            try await drainBufferedPackets()
            isCatchingUp = false
            try await outboxManager.processPendingTransactions()
        } catch {
            isCatchingUp = false
            if isBootstrapRequiredError(error) {
                deltaTask?.cancel()
                deltaTask = nil
                try? await runSyncCycle(forceBootstrap: true, reason: .cursorTooOld)
            } else if isOfflineSyncError(error) {
                scheduleCatchUpRetry()
            } else {
                onEvent?(.syncError(error))
            }
            // Other errors (e.g. still offline): the new subscription's own
            // reconnect loop keeps trying, and its termination re-enters here.
        }
    }

    private func scheduleCatchUpRetry() {
        catchUpRetryTask?.cancel()
        let delay = min(0.3 * pow(2.0, Double(min(catchUpRetryAttempt, 7))), 30.0)
        catchUpRetryAttempt += 1
        catchUpRetryTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.runtime.sleep(delay) } catch { return }
            guard self.running, !Task.isCancelled else { return }
            await self.restartSubscription(forceBootstrap: false, skipDelay: true)
        }
    }

    /// Closes a restart window (start() or restartSubscription) and runs the
    /// single restart request that was queued while it was in flight, if any.
    private func finishRestartWindow() {
        isRestarting = false
        if queuedRestart.requested, running {
            let force = queuedRestart.forceBootstrap
            let reason = queuedRestart.reason
            queuedRestart = (false, false, .forced)
            Task { [weak self] in
                await self?.restartSubscription(forceBootstrap: force, reason: reason)
            }
        }
    }

    /// Schedules the full re-bootstrap a group-membership change requires.
    ///
    /// Hops to a fresh task so it never cancels the delta task it is running
    /// inside, and de-duplicates: a single packet can carry several group
    /// actions, and several packets can arrive before the restart takes hold.
    private func requestGroupChangeBootstrap() {
        guard running, !groupChangeBootstrapRequested else { return }
        groupChangeBootstrapRequested = true

        Task { [weak self] in
            guard let self else { return }
            defer { self.groupChangeBootstrapRequested = false }

            // The delta stream is still live — we returned rather than threw —
            // so the transport's receive loop still owns a socket and its
            // `shouldReconnect` is still true. Cancelling the delta task only
            // stops the consumer, so without this the restart's resubscribe
            // would race the old loop for `webSocketTask` and leak a second
            // connection. Close is idempotent.
            await self.transport.close()
            await self.restartSubscription(forceBootstrap: true)
        }
    }

    private func scheduleGroupChangeRetry() {
        guard running, groupChangeReconcileOwed, groupChangeRetryTask == nil else { return }
        groupChangeRetryTask = Task { [weak self] in
            guard let self else { return }
            try? await self.runtime.sleep(self.groupChangeRetryDelay)
            guard !Task.isCancelled else { return }
            self.groupChangeRetryTask = nil
            await self.restartSubscription(forceBootstrap: true)
        }
    }

    private func drainBufferedPackets() async throws {
        while !bufferedPackets.isEmpty {
            let packet = bufferedPackets.removeFirst()
            try await applyDeltaPacket(packet)
        }
    }

    private func isBootstrapRequiredError(_ error: Error) -> Bool {
        if case SyncTransportError.bootstrapRequired = error {
            return true
        }
        return false
    }

    private func applyDeltaPacket(_ packet: DeltaPacket) async throws {
        // Serialize against mutations (and other delta packets): a delta must
        // never interleave between a mutation's optimistic write and its outbox
        // persist, or it would rebase against an outbox missing the in-flight
        // transaction and clobber the optimistic value.
        try await stateQueue.run { [self] in
            try await applyDeltaPacketBody(packet)
        }
    }

    private func applyDeltaPacketBody(_ packet: DeltaPacket) async throws {
        try validateDeltaPacketFraming(packet)

        // A group-change action means our sync-group membership moved: a group
        // was shared with us (whose history sits before our cursor, so the
        // delta stream will never carry it) or taken away (leaving its rows
        // cached and silently frozen). This engine has no partial-bootstrap
        // path, so it converges the only way it can: a full re-bootstrap,
        // which filters on current membership and is therefore correct in
        // both directions.
        //
        // Requested rather than thrown. `bootstrapRequired` is a transport
        // signal meaning "your cursor is too old", and the transport's own
        // catch answers it by finishing the stream. Raising it from here would
        // instead abandon a live producer — `shouldReconnect` stays true and
        // its receive loop keeps its socket — so the resubscribe would race it
        // for `webSocketTask` and leak a second connection. It would also
        // escape `drainBufferedPackets`, which sits outside the catch-up
        // handler, failing start() outright for a group action on a buffered
        // packet.
        //
        // Checked before anything is applied: a re-bootstrap replaces local
        // state wholesale, so persisting this packet first would be wasted
        // work against a cursor we are about to discard.
        //
        // Only a change that may have removed access quarantines. When the
        // new authoritative set covers every group the cached snapshot was
        // captured under, every cached row is still authorized, so it stays
        // visible (and editable) while the re-bootstrap fetches the new
        // groups' history. Unknown old or new sets are treated as removals.
        if let groupChange = packet.actions.last(where: {
            $0.action == .group || $0.action == .syncGroup
        }) {
            let reportedGroups = (groupChange.data["subscribedSyncGroups"] as? [String])
                .map(uniqueGroups)
            if let reportedGroups {
                subscribedGroups = reportedGroups
            }
            if groupChangeBootstrapPending {
                try await persistMetadata()
            } else if let quarantineReason = quarantineReason(forReportedGroups: reportedGroups) {
                SyncLog.delta.debug("Sync group access may have been removed; quarantining and re-bootstrapping")
                try await beginPrivacyReconciliation(reason: quarantineReason)
            } else {
                SyncLog.delta.debug("Sync group access only added; re-bootstrapping without quarantine")
                groupChangeRebootstrapOwed = true
            }
            requestGroupChangeBootstrap()
            return
        }

        // Nothing may be applied while a group-change re-bootstrap is
        // outstanding, quarantined or not. Applying a later packet would
        // advance `lastSyncId` past the group action, and a bootstrap that then
        // fails leaves that action behind the cursor forever — silently
        // dropping the membership change. Holding the cursor still costs a
        // little redelivery and keeps the guarantee; it never hides rows.
        if groupChangeReconcileOwed {
            return
        }

        SyncLog.delta.debug("Delta packet received actions=\(packet.actions.count, privacy: .public) lastSyncId=\(packet.lastSyncId, privacy: .public) cursor=\(self.lastSyncId, privacy: .public)")
        let newActions = packet.actions.filter { isSyncIdGreaterThan($0.id, lastSyncId) }
        if newActions.isEmpty {
            let nextSyncId = maxSyncId(lastSyncId, packet.lastSyncId)
            if lastSyncId != nextSyncId {
                let nextLastSyncAt = currentTimestampMs()
                try await storage.setMeta(makeStorageMeta(
                    lastSyncId: nextSyncId,
                    firstSyncId: firstSyncId,
                    bootstrapComplete: true,
                    lastSyncAt: nextLastSyncAt
                ))
                lastSyncId = nextSyncId
                bootstrapComplete = true
                lastSyncAt = nextLastSyncAt
            }
            return
        }

        let writeOps = try await stageIncomingActions(newActions)

        let pendingOutbox = await storage.getOutbox()
        let pendingTxs = pendingOutbox.filter { $0.state != .completed && $0.state != .failed }
        let outboxTxIdSet = Set(pendingTxs.map(\.clientTxId))

        let rebaseResult = rebaseTransactions(
            pending: pendingTxs,
            serverActions: newActions,
            clientId: clientId,
            defaultResolution: .serverWins,
            fieldLevelConflicts: true
        )

        // stop() closed (or is about to close) the connection; bail out instead
        // of persisting into a dying/reopened connection. The next start()'s
        // catch-up refetches from the unadvanced cursor.
        guard running else { return }
        if !writeOps.isEmpty {
            do {
                try await storage.writeBatch(writeOps)
            } catch {
                SyncLog.delta.error("Failed to persist delta packet lastSyncId=\(packet.lastSyncId, privacy: .public) ops=\(writeOps.count, privacy: .public): \(String(describing: error), privacy: .public)")
                onEvent?(.syncError(SyncOrchestratorError.deltaPersistenceFailed))
                throw error
            }
        }

        let nextSyncId = maxSyncId(lastSyncId, packet.lastSyncId)
        let nextFirstSyncId = firstSyncId == zeroSyncId ? nextSyncId : firstSyncId
        let nextLastSyncAt = currentTimestampMs()
        do {
            try await storage.setMeta(makeStorageMeta(
                lastSyncId: nextSyncId,
                firstSyncId: nextFirstSyncId,
                bootstrapComplete: true,
                lastSyncAt: nextLastSyncAt
            ))
        } catch {
            SyncLog.delta.error("Failed to persist sync metadata: \(String(describing: error), privacy: .public)")
            throw error
        }
        lastSyncId = nextSyncId
        firstSyncId = nextFirstSyncId
        bootstrapComplete = true
        lastSyncAt = nextLastSyncAt

        var confirmedTxIds = Set<String>()
        for tx in rebaseResult.confirmed {
            try? await storage.removeFromOutbox(clientTxId: tx.clientTxId)
            confirmedTxIds.insert(tx.clientTxId)
        }

        let redundantTxIds = await removeRedundantCreateTransactions(
            actions: newActions,
            outbox: pendingOutbox
        )
        confirmedTxIds.formUnion(redundantTxIds)

        _ = try? await outboxManager.completeUpToSyncId(lastSyncId)

        // Per-action echo suppression keyed by clientTxId (mirrors the TS delta
        // pipeline). A server action is our own echo only when it carries one
        // of our transaction ids — so a foreign action sharing a record with an
        // echo in the same packet is still applied.
        var ownClientTxIds = outboxTxIdSet.union(confirmedTxIds)

        for conflict in rebaseResult.conflicts where conflict.resolution == .serverWins {
            try? await storage.removeFromOutbox(clientTxId: conflict.localTransaction.clientTxId)
            // The server won this record, so its echo must no longer be
            // suppressed — the server value has to land in the map.
            ownClientTxIds.remove(conflict.localTransaction.clientTxId)
            onConflict?(conflict.localTransaction)
        }

        updateIdentityMaps(
            newActions: newActions,
            ownClientTxIds: ownClientTxIds,
            rebaseResult: rebaseResult
        )
        SyncLog.delta.debug("Delta applied newActions=\(newActions.count, privacy: .public) cursor=\(self.lastSyncId, privacy: .public)")

        let pendingCount = await outboxManager.getPendingCount()
        onEvent?(.outboxChange(pendingCount: pendingCount))

        for action in newActions {
            if isOwnEcho(action, ownClientTxIds: ownClientTxIds) {
                continue
            }
            onEvent?(.modelChange(
                modelName: action.modelName,
                modelId: action.modelId,
                action: action.action.rawValue
            ))
        }
    }

    private func validateDeltaPacketFraming(_ packet: DeltaPacket) throws {
        guard isValidSyncId(packet.lastSyncId) else {
            throw SyncTransportError.invalidResponse
        }
        for action in packet.actions {
            guard isValidSyncId(action.id),
                  isSyncIdGreaterThan(action.id, zeroSyncId),
                  compareSyncId(action.id, packet.lastSyncId) <= 0 else {
                throw SyncTransportError.invalidResponse
            }
        }
        for (previous, current) in zip(packet.actions, packet.actions.dropFirst()) {
            guard isSyncIdGreaterThan(current.id, previous.id) else {
                throw SyncTransportError.invalidResponse
            }
        }
    }

    /// Resolves the packet against an in-memory staging area and returns the
    /// collapsed storage operations, one per touched row.
    ///
    /// Validation and persistence share this single pass. Doing them separately
    /// cost a `get` plus a `put` per action — two SQLite round trips each — so a
    /// large catch-up paid thousands of them. The collapsed result lands as one
    /// `writeBatch`, which is also atomic: a partially applied packet is no
    /// longer possible.
    private func stageIncomingActions(_ actions: [SyncAction]) async throws -> [BatchOperation] {
        var stagedRecords: [String: [String: Any]] = [:]
        var deletedKeys = Set<String>()
        var orderedKeys: [String] = []
        var targetsByKey: [String: (modelName: String, modelId: String)] = [:]

        func track(_ key: String, _ action: SyncAction) {
            if targetsByKey[key] == nil {
                orderedKeys.append(key)
                targetsByKey[key] = (action.modelName, action.modelId)
            }
        }

        for action in actions {
            let key = "\(action.modelName):\(action.modelId)"
            let existing: [String: Any]?
            if let staged = stagedRecords[key] {
                existing = staged
            } else if deletedKeys.contains(key) {
                existing = nil
            } else {
                existing = await storage.get(modelName: action.modelName, id: action.modelId)
            }

            switch action.action {
            case .insert, .update, .unarchive:
                var candidate = existing ?? [:]
                for (field, value) in action.data {
                    candidate[field] = value
                }
                candidate["id"] = action.modelId
                try modelStore.validate(modelName: action.modelName, data: candidate)
                stagedRecords[key] = candidate
                deletedKeys.remove(key)
                track(key, action)
            case .archive:
                // An archive for a row we never had is a no-op, matching the
                // TypeScript engine.
                guard var candidate = existing else { continue }
                for (field, value) in action.data {
                    candidate[field] = value
                }
                candidate["id"] = action.modelId
                try modelStore.validate(modelName: action.modelName, data: candidate)
                stagedRecords[key] = candidate
                track(key, action)
            case .delete:
                stagedRecords.removeValue(forKey: key)
                deletedKeys.insert(key)
                track(key, action)
            case .coverage, .group, .syncGroup:
                break
            }
        }

        var ops: [BatchOperation] = []
        for key in orderedKeys {
            guard let target = targetsByKey[key] else { continue }
            if let record = stagedRecords[key] {
                ops.append(.put(modelName: target.modelName, id: target.modelId, data: record))
            } else if deletedKeys.contains(key) {
                ops.append(.delete(modelName: target.modelName, id: target.modelId))
            }
        }
        return ops
    }

    private func updateIdentityMaps(
        newActions: [SyncAction],
        ownClientTxIds: Set<String>,
        rebaseResult: RebaseResult
    ) {
        // One notification per touched map instead of one per action, and no
        // observer can see a half-applied packet. Safe to batch: this whole
        // function is synchronous and main-actor, and the only read inside the
        // loop (`snapshot`) goes to the backing dictionary, not the values cache.
        modelStore.batchAll {
            applyIdentityMapActions(
                newActions: newActions,
                ownClientTxIds: ownClientTxIds,
                rebaseResult: rebaseResult
            )
        }
    }

    private func applyIdentityMapActions(
        newActions: [SyncAction],
        ownClientTxIds: Set<String>,
        rebaseResult: RebaseResult
    ) {
        for conflict in rebaseResult.conflicts where conflict.resolution == .serverWins {
            guard let original = conflict.localTransaction.original else {
                continue
            }
            modelStore.update(
                modelName: conflict.localTransaction.modelName,
                id: conflict.localTransaction.modelId,
                changes: original
            )
        }

        for action in newActions {
            // Suppress only this specific action when it is our own echo and the
            // optimistic record is already present; foreign actions on the same
            // record still apply.
            if isOwnEcho(action, ownClientTxIds: ownClientTxIds),
               modelStore.snapshot(modelName: action.modelName, id: action.modelId) != nil {
                continue
            }

            switch action.action {
            case .insert, .update, .archive, .unarchive:
                modelStore.merge(modelName: action.modelName, id: action.modelId, data: action.data)
            case .delete:
                modelStore.delete(modelName: action.modelName, id: action.modelId)
            case .coverage, .group, .syncGroup:
                break
            }
        }

        for tx in rebaseResult.pending where shouldReplayPendingTransaction(tx) {
            switch tx.action {
            case .insert:
                modelStore.set(modelName: tx.modelName, data: tx.payload)
            case .delete:
                modelStore.delete(modelName: tx.modelName, id: tx.modelId)
            case .update, .archive, .unarchive:
                modelStore.update(modelName: tx.modelName, id: tx.modelId, changes: tx.payload)
            }
        }
    }

    /// A server action is our own echo when it carries one of our transaction
    /// ids and is a merge-type action (insert/update/archive/unarchive). Deletes
    /// and non-model frames are never suppressed.
    private func isOwnEcho(_ action: SyncAction, ownClientTxIds: Set<String>) -> Bool {
        guard let txId = action.clientTxId, ownClientTxIds.contains(txId) else {
            return false
        }
        switch action.action {
        case .insert, .update, .archive, .unarchive:
            return true
        case .delete, .coverage, .group, .syncGroup:
            return false
        }
    }

    private func removeRedundantCreateTransactions(
        actions: [SyncAction],
        outbox: [Transaction]
    ) async -> Set<String> {
        var redundant = Set<String>()
        let createdIds = Set(actions.filter { $0.action == .insert }.map(\.modelId))
        if createdIds.isEmpty {
            return redundant
        }

        for tx in outbox where tx.action == .insert && createdIds.contains(tx.modelId) {
            try? await storage.removeFromOutbox(clientTxId: tx.clientTxId)
            redundant.insert(tx.clientTxId)
        }

        return redundant
    }

    /// Fetches missed deltas page by page and applies them.
    ///
    /// Pages are buffered and applied as one merged packet so a multi-page
    /// backlog lands in a single identity-map batch — one UI update — instead
    /// of stepping visibly through each page. The buffer is capped so a very
    /// stale client stays memory-bounded.
    private func catchUpMissedDeltas() async throws {
        var after = lastSyncId
        var buffered: [SyncAction] = []
        var bufferedLastSyncId: SyncId?

        func flush() async throws {
            guard let mergedLastSyncId = bufferedLastSyncId else { return }
            let merged = DeltaPacket(
                lastSyncId: mergedLastSyncId,
                actions: buffered,
                hasMore: false
            )
            buffered = []
            bufferedLastSyncId = nil
            try await applyDeltaPacket(merged)
        }

        while true {
            let packet = try await transport.fetchDeltas(after: after, limit: 1000)
            buffered.append(contentsOf: packet.actions)
            bufferedLastSyncId = packet.lastSyncId

            let next = maxSyncId(after, packet.lastSyncId)
            // Guard against a server that reports hasMore without advancing
            // the cursor, which would loop forever.
            if !packet.hasMore || next == after {
                try await flush()
                break
            }
            if buffered.count >= coalescedCatchUpActionLimit {
                try await flush()
            }
            after = next
        }
    }

    private func applyPendingToIdentityMaps(_ transactions: [Transaction]? = nil) async {
        if groupChangeBootstrapPending, transactions == nil {
            return
        }
        let outbox: [Transaction]
        if let transactions {
            outbox = transactions
        } else {
            outbox = await storage.getOutbox()
        }
        modelStore.applyPendingOutbox(outbox.filter(shouldReplayPendingTransaction))
    }

    private func setState(_ newState: SyncClientState) {
        if state != newState {
            state = newState
            onStateChange?(newState)
            onEvent?(.stateChange(newState))
        }
    }

    private func loadMetadata(_ meta: StorageMeta) {
        clientId = meta.clientId
        lastSyncId = meta.lastSyncId
        firstSyncId = meta.firstSyncId ?? meta.lastSyncId
        subscribedGroups = meta.subscribedGroups
        bootstrapComplete = meta.bootstrapComplete
        groupChangeBootstrapPending = meta.groupChangePending
        authoritativeGroups = meta.authoritativeGroups
        privacyWithheldTransactionIds = Set(meta.privacyWithheldTransactionIds)
        schemaHash = meta.schemaHash
        databaseVersion = meta.databaseVersion
        lastSyncAt = meta.lastSyncAt
        onClientIdLoaded?(clientId)
    }

    private func configureGroups(requestedGroups: [String], meta: StorageMeta) async throws {
        let storedGroups = meta.subscribedGroups
        subscribedGroups = requestedGroups.isEmpty ? storedGroups : requestedGroups

        if areGroupsEqual(storedGroups, subscribedGroups) {
            return
        }

        firstSyncId = lastSyncId
        try await persistMetadata()
    }

    /// Why this start needs a full bootstrap, or `nil` to hydrate locally.
    private func bootstrapReasonIfNeeded() async -> SyncBootstrapReason? {
        let hasPersistedData = await modelStore.hasPersistedData(storage: storage)
        let hasSyncCursor = isSyncIdGreaterThan(lastSyncId, zeroSyncId)
        if !bootstrapComplete || !hasPersistedData || !hasSyncCursor {
            return .initial
        }
        // A non-empty client schema hash that differs from (or is absent in)
        // the persisted meta forces a full re-bootstrap.
        if !clientSchemaHash.isEmpty {
            let storedHash = schemaHash ?? ""
            if storedHash.isEmpty || storedHash != clientSchemaHash {
                return .schemaHash
            }
        }
        return nil
    }

    @discardableResult
    private func hydrateFromStorage() async throws -> Int {
        try await modelStore.hydrateFromStorage(storage)
    }

    /// Whether a group change reporting `reportedGroups` may have revoked
    /// access to cached rows, and why. `nil` means it provably only added.
    private func quarantineReason(forReportedGroups reportedGroups: [String]?) -> SyncQuarantineReason? {
        guard let reportedGroups,
              let knownGroups = authoritativeGroups,
              !knownGroups.isEmpty else {
            return .groupUnknown
        }
        return Set(reportedGroups).isSuperset(of: knownGroups) ? nil : .groupRemoved
    }

    private func uniqueGroups(_ groups: [String]) -> [String] {
        var seen = Set<String>()
        return groups.filter { seen.insert($0).inserted }
    }

    private func persistMetadata() async throws {
        try await storage.setMeta(makeStorageMeta(
            lastSyncId: lastSyncId,
            firstSyncId: firstSyncId,
            bootstrapComplete: bootstrapComplete,
            lastSyncAt: lastSyncAt
        ))
    }

    private func beginPrivacyReconciliation(reason: SyncQuarantineReason) async throws {
        guard !groupChangeBootstrapPending else { return }
        var quarantineMeta = makeStorageMeta(
            lastSyncId: lastSyncId,
            firstSyncId: firstSyncId,
            bootstrapComplete: bootstrapComplete,
            lastSyncAt: lastSyncAt
        )
        quarantineMeta.groupChangePending = true
        try await storage.setMeta(quarantineMeta)
        groupChangeBootstrapPending = true
        // Persistence remains intact until replacement commits. The durable
        // latch prevents this obsolete snapshot from being hydrated after a
        // crash between any later reconciliation steps.
        modelStore.clearAll()
        onEvent?(.quarantineEntered(reason: reason))
    }

    /// Keeps pending work durable after a privacy reconcile, but only replays
    /// targets present in the new authoritative snapshot. An absent insert may
    /// belong below a parent group that was just revoked, and this generic
    /// engine has no model-specific relation metadata to prove otherwise.
    private func preparePendingTransactionsForPrivacySnapshot() async throws -> [Transaction] {
        let pending = await storage.getOutbox().filter {
            $0.state != .completed && $0.state != .failed
        }
        var replayable: [Transaction] = []
        var newlyWithheld = Set<String>()

        for transaction in pending {
            if modelStore.snapshot(modelName: transaction.modelName, id: transaction.modelId) != nil {
                replayable.append(transaction)
                continue
            }
            newlyWithheld.insert(transaction.clientTxId)
            if transaction.action != .insert, transaction.original != nil {
                try await storage.updateOutboxTransaction(clientTxId: transaction.clientTxId) {
                    $0.original = nil
                }
            }
        }
        privacyWithheldTransactionIds.formUnion(newlyWithheld)
        try await persistMetadata()
        return replayable
    }

    /// Routine-replacement counterpart of
    /// ``preparePendingTransactionsForPrivacySnapshot``. Nothing says access
    /// was revoked, but the new snapshot is authoritative: a pending change to
    /// a row it no longer contains may target a row we can no longer see, so
    /// that change is withheld from replay and loses its rollback `original`.
    /// A server rejection then cannot restore the row. Local inserts, and
    /// later changes to rows those inserts create, stay replayable. Nothing
    /// visible is cleared and nothing is latched; the caller persists the
    /// withheld ids with the replacement's metadata.
    private func withholdPendingChangesToRowsMissingFromSnapshot() async throws {
        let pending = await storage.getOutbox().filter {
            $0.state != .completed && $0.state != .failed
        }
        func key(_ tx: Transaction) -> String { "\(tx.modelName):\(tx.modelId)" }
        let locallyInserted = Set(pending.filter { $0.action == .insert }.map(key))

        for transaction in pending where transaction.action != .insert {
            if modelStore.snapshot(modelName: transaction.modelName, id: transaction.modelId) != nil
                || locallyInserted.contains(key(transaction)) {
                continue
            }
            privacyWithheldTransactionIds.insert(transaction.clientTxId)
            if transaction.original != nil {
                try await storage.updateOutboxTransaction(clientTxId: transaction.clientTxId) {
                    $0.original = nil
                }
            }
        }
    }

    private func shouldReplayPendingTransaction(_ transaction: Transaction) -> Bool {
        !privacyWithheldTransactionIds.contains(transaction.clientTxId)
            || modelStore.snapshot(modelName: transaction.modelName, id: transaction.modelId) != nil
    }

    private func makeStorageMeta(
        lastSyncId: SyncId,
        firstSyncId: SyncId,
        bootstrapComplete: Bool,
        lastSyncAt: TimeInterval?
    ) -> StorageMeta {
        StorageMeta(
            lastSyncId: lastSyncId,
            firstSyncId: firstSyncId == zeroSyncId ? nil : firstSyncId,
            subscribedGroups: subscribedGroups,
            clientId: clientId,
            bootstrapComplete: bootstrapComplete,
            groupChangePending: groupChangeBootstrapPending,
            privacyWithheldTransactionIds: Array(privacyWithheldTransactionIds).sorted(),
            schemaHash: schemaHash,
            databaseVersion: databaseVersion,
            lastSyncAt: lastSyncAt,
            authoritativeGroups: authoritativeGroups
        )
    }

    private func areGroupsEqual(_ lhs: [String], _ rhs: [String]) -> Bool {
        lhs.count == rhs.count && Set(lhs) == Set(rhs)
    }

    private func currentTimestampMs() -> TimeInterval {
        runtime.now()
    }
}

enum SyncOrchestratorError: Error, LocalizedError {
    case deltaPersistenceFailed

    var errorDescription: String? {
        switch self {
        case .deltaPersistenceFailed:
            "Failed to persist incoming sync changes to local storage."
        }
    }
}
