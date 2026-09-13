import Foundation

// MARK: - Outbox Manager

/// Manages the mutation outbox: queues transactions locally, batches them,
/// sends to the server, and handles retry logic.
@MainActor
final class OutboxManager {
    private let runtime: SyncRuntime
    private let storage: StorageAdapter
    private let transport: SyncTransport
    private var clientId: String
    private let batchDelay: TimeInterval
    private let maxBatchSize: Int
    private let baseRetryDelay: TimeInterval
    private let maxRetryDelay: TimeInterval = 30.0

    private var pendingBatch: [Transaction] = []
    private var batchTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var isFlushing = false
    private var flushWaiters: [CheckedContinuation<Void, Never>] = []
    private var isProcessingPending = false
    private var processWaiters: [CheckedContinuation<Void, Never>] = []
    private var consecutiveSendFailures = 0
    /// Bumped on account-boundary reset so an abandoned in-flight mutate
    /// cannot clobber outbox state or requeue after `processPendingTransactions`
    /// has already taken over.
    private var lifecycleVersion = 0

    var onTransactionRejected: ((Transaction) async -> Void)?
    /// Latest sync cursor known to the engine (from bootstrap / deltas).
    /// Used after mutate success to drop `awaitingSync` rows whose owed sync
    /// id is already covered — without waiting for a fresh delta echo.
    var syncCursorProvider: (() -> SyncId)?
    var onPendingCountChange: ((Int) async -> Void)?

    init(
        storage: StorageAdapter,
        transport: SyncTransport,
        clientId: String,
        batchDelay: TimeInterval = 0.05,
        maxBatchSize: Int = 100,
        baseRetryDelay: TimeInterval = 1.0,
        runtime: SyncRuntime? = nil
    ) {
        self.runtime = runtime ?? .live
        self.storage = storage
        self.transport = transport
        self.clientId = clientId
        self.batchDelay = batchDelay
        self.maxBatchSize = maxBatchSize
        self.baseRetryDelay = baseRetryDelay
    }

    func setClientId(_ clientId: String) {
        self.clientId = clientId
    }

    // MARK: - Queue Mutations

    private func transaction(
        action: TransactionAction, modelName: String, modelId: String,
        payload: [String: Any], original: [String: Any]? = nil
    ) -> Transaction {
        Transaction(clientTxId: runtime.transactionId(), clientId: clientId,
                    modelName: modelName, modelId: modelId, action: action,
                    payload: payload, original: original, state: .queued,
                    createdAt: runtime.now(), retryCount: 0)
    }

    func update(modelName: String, modelId: String, changes: [String: Any], original: [String: Any]) async throws -> Transaction {
        let tx = transaction(action: .update, modelName: modelName, modelId: modelId, payload: changes, original: original)
        try await queueTransaction(tx)
        return tx
    }

    func insert(modelName: String, modelId: String, data: [String: Any]) async throws -> Transaction {
        let tx = transaction(action: .insert, modelName: modelName, modelId: modelId, payload: data)
        try await queueTransaction(tx)
        return tx
    }

    func delete(modelName: String, modelId: String, original: [String: Any]) async throws -> Transaction {
        let tx = transaction(action: .delete, modelName: modelName, modelId: modelId, payload: [:], original: original)
        try await queueTransaction(tx)
        return tx
    }

    func archive(modelName: String, modelId: String, archivedAt: Double? = nil, original: [String: Any]? = nil) async throws -> Transaction {
        let tx = transaction(action: .archive, modelName: modelName, modelId: modelId, payload: ["archivedAt": archivedAt ?? runtime.now()], original: original)
        try await queueTransaction(tx)
        return tx
    }

    func unarchive(modelName: String, modelId: String, original: [String: Any]? = nil) async throws -> Transaction {
        let tx = transaction(action: .unarchive, modelName: modelName, modelId: modelId, payload: ["archivedAt": NSNull()], original: original)
        try await queueTransaction(tx)
        return tx
    }

    // MARK: - Queue & Batch

    private func queueTransaction(_ tx: Transaction) async throws {
        // Persist to storage
        try await storage.addToOutbox(tx)

        // Add to pending batch
        pendingBatch.append(tx)

        // Schedule batch send
        scheduleBatchSend()
    }

    private func scheduleBatchSend() {
        // Cancel existing timer
        batchTask?.cancel()

        // If batch is full, send immediately
        if pendingBatch.count >= maxBatchSize {
            batchTask = Task {
                await flushBatch()
            }
            return
        }

        // Otherwise wait for batch delay
        batchTask = Task {
            try? await runtime.sleep(batchDelay)
            guard !Task.isCancelled else { return }
            await flushBatch()
        }
    }

    /// Drains the pending batch. Concurrent callers wait for the active flush
    /// (matching the TS client's `waitForInflightSends`) instead of racing
    /// storage state transitions.
    func flushBatch() async {
        if isFlushing {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                flushWaiters.append(continuation)
            }
            // The owner may have finished without draining work that landed
            // while we waited. Re-enter only when the owner left success-path
            // work — never after a transport failure (retry backoff owns that).
            if !pendingBatch.isEmpty, consecutiveSendFailures == 0 {
                await flushBatch()
            }
            return
        }

        isFlushing = true
        let version = lifecycleVersion
        await drainPendingBatch(lifecycleVersion: version)

        // Only the flush generation that still owns the flag should clear it.
        // Account-boundary reset may have already cleared `isFlushing` and
        // resumed waiters so a replacement flush can start.
        if lifecycleVersion == version {
            // Work may have landed between drain exit and flag clear. Kick a
            // follow-up flush asynchronously — never recurse on this call stack
            // after a transport failure (that requeues into pendingBatch and
            // would infinite-loop). `scheduleRetry` owns failure follow-up.
            let shouldFollowUp = !pendingBatch.isEmpty && consecutiveSendFailures == 0
            isFlushing = false
            resumeFlushWaiters()
            if shouldFollowUp {
                scheduleBatchSend()
            }
        }
    }

    private func waitForInflightFlush() async {
        guard isFlushing else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            flushWaiters.append(continuation)
        }
    }

    private func resumeFlushWaiters() {
        let waiters = flushWaiters
        flushWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func drainPendingBatch(lifecycleVersion version: Int) async {
        while !pendingBatch.isEmpty {
            guard lifecycleVersion == version else { return }

            let batch = Array(pendingBatch.prefix(maxBatchSize))
            pendingBatch.removeFirst(batch.count)
            let sent = await sendBatch(batch, lifecycleVersion: version)

            guard lifecycleVersion == version else { return }

            // Transport failure: the batch was re-queued and a retry is
            // scheduled, so stop draining until the retry fires.
            if !sent { break }
        }
    }

    /// Sends one batch. Returns false on transport failure (batch re-queued).
    private func sendBatch(
        _ batch: [Transaction],
        lifecycleVersion version: Int
    ) async -> Bool {
        guard lifecycleVersion == version else { return true }

        // Mark all as sent
        for tx in batch {
            guard lifecycleVersion == version else { return true }
            try? await storage.updateOutboxTransaction(clientTxId: tx.clientTxId) { t in
                // Never regress a completed ack if a raced writer already moved on.
                guard t.state == .queued || t.state == .sent else { return }
                t.state = .sent
            }
        }

        do {
            let txBatch = TransactionBatch(batchId: batch.map(\.clientTxId).joined(separator: ","), transactions: batch, createdAt: runtime.now())
            let result = try await transport.mutate(batch: txBatch)
            guard lifecycleVersion == version else { return true }
            try validateMutateResult(batch, result)
            try await handleMutateResult(batch, result)
            consecutiveSendFailures = 0
            retryTask?.cancel()
            retryTask = nil
            return true
        } catch {
            guard lifecycleVersion == version else { return true }
            await handleSendFailure(batch, error: error)
            return false
        }
    }

    private func handleSendFailure(_ batch: [Transaction], error: Error) async {
        let offline = isOfflineSyncError(error)
        let cancelledForBoundary = error is CancellationError
            || (error as? URLError)?.code == .cancelled
        var requeued: [Transaction] = []

        for var tx in batch {
            // No send-path failure (transport 5xx, missing token, malformed
            // response, offline) is ever a rejection: rejection is reserved for
            // an explicit per-transaction server `success=false` in
            // handleMutateResult. Requeue indefinitely and let the backoff timer
            // (or reconnect) retry. retryCount is bumped for diagnostics only;
            // it never drops a transaction. Server-side dedup keyed on the
            // clientTxId makes resends idempotent-safe.
            //
            // Decide requeue from the live row inside the update closure so a
            // raced awaitingSync/failed write is never clobbered or skipped
            // based on a stale snapshot.
            var didRequeue = false
            if offline || cancelledForBoundary {
                try? await storage.updateOutboxTransaction(clientTxId: tx.clientTxId) { t in
                    guard t.state == .queued || t.state == .sent else { return }
                    t.state = .queued
                    didRequeue = true
                }
            } else {
                try? await storage.updateOutboxTransaction(clientTxId: tx.clientTxId) { t in
                    guard t.state == .queued || t.state == .sent else { return }
                    t.state = .queued
                    t.retryCount += 1
                    tx.retryCount = t.retryCount
                    didRequeue = true
                }
            }
            guard didRequeue else { continue }
            tx.state = .queued
            requeued.append(tx)
        }

        // Preserve original ordering: re-queued transactions go back in front
        // of anything queued while this send was in flight.
        pendingBatch.insert(contentsOf: requeued, at: 0)
        if !cancelledForBoundary {
            consecutiveSendFailures += 1
        }
        if !requeued.isEmpty, !cancelledForBoundary {
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        let exponent = Double(max(consecutiveSendFailures - 1, 0))
        let delay = min(baseRetryDelay * pow(2.0, exponent), maxRetryDelay)

        retryTask = Task { [weak self] in
            try? await self?.runtime.sleep(delay)
            guard !Task.isCancelled else { return }
            await self?.flushBatch()
        }
    }

    private func handleMutateResult(_ transactions: [Transaction], _ result: MutateResult) async throws {
        for txResult in result.results {
            if txResult.success {
                // Prefer the per-transaction syncId, falling back to the
                // batch's cursor. A success carrying neither is durably done
                // (there is no delta to await), so complete it immediately
                // rather than looping forever waiting for a sync that never
                // arrives.
                let completionSyncId = txResult.syncId
                    ?? (isSyncIdGreaterThan(result.lastSyncId, zeroSyncId) ? result.lastSyncId : nil)
                if let completionSyncId {
                    // Not complete until we receive the corresponding delta
                    // (or the engine cursor already covers this sync id).
                    try? await storage.updateOutboxTransaction(clientTxId: txResult.clientTxId) { t in
                        t.state = .awaitingSync
                        t.syncIdNeededForCompletion = completionSyncId
                    }
                } else {
                    try? await storage.removeFromOutbox(clientTxId: txResult.clientTxId)
                }
            } else {
                // Server rejected this transaction
                try? await storage.updateOutboxTransaction(clientTxId: txResult.clientTxId) { t in
                    t.state = .failed
                    t.lastError = txResult.error
                }
                if var tx = transactions.first(where: { $0.clientTxId == txResult.clientTxId }) {
                    tx.state = .failed
                    tx.lastError = txResult.error
                    await onTransactionRejected?(tx)
                }
            }
        }

        // Deduped historical txs often owe a sync id the engine has already
        // applied. Clear them now so reconnect cannot bounce them back to
        // queued and resend forever.
        let knownCursor = syncCursorProvider?() ?? zeroSyncId
        if isSyncIdGreaterThan(knownCursor, zeroSyncId) {
            _ = try? await completeUpToSyncId(knownCursor)
        }

        let pendingCount = await getPendingCount()
        await onPendingCountChange?(pendingCount)
    }

    private func validateMutateResult(_ transactions: [Transaction], _ result: MutateResult) throws {
        let expectedIds = transactions.map(\.clientTxId)
        let resultIds = result.results.map(\.clientTxId)
        let expectedIdSet = Set(expectedIds)
        let resultIdSet = Set(resultIds)

        guard resultIds.count == expectedIds.count,
              resultIdSet.count == resultIds.count,
              resultIdSet == expectedIdSet else {
            throw OutboxManagerError.invalidMutateResponse
        }

        let allSucceeded = result.results.allSatisfy(\.success)
        guard result.success == allSucceeded else {
            throw OutboxManagerError.invalidMutateResponse
        }

        guard isValidSyncId(result.lastSyncId) else {
            throw OutboxManagerError.invalidMutateResponse
        }
        // A successful result MAY omit its syncId (forward-compat: the
        // transaction completes immediately in handleMutateResult). When one is
        // present it must still be a positive value within the batch cursor.
        for transactionResult in result.results where transactionResult.success {
            guard let syncId = transactionResult.syncId else { continue }
            guard isValidSyncId(syncId),
                  isSyncIdGreaterThan(syncId, zeroSyncId),
                  compareSyncId(syncId, result.lastSyncId) <= 0 else {
                throw OutboxManagerError.invalidMutateResponse
            }
        }
    }

    // MARK: - Reconnect Handling

    /// Re-sends all queued/sent transactions after reconnect.
    ///
    /// Mirrors the TS client: wait for any in-flight mutate to settle before
    /// reading storage, and never reset a row that has already moved to
    /// `awaitingSync` / `failed`.
    func processPendingTransactions() async throws {
        if isProcessingPending {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                processWaiters.append(continuation)
            }
            return
        }

        isProcessingPending = true
        defer {
            isProcessingPending = false
            let waiters = processWaiters
            processWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }

        await doProcessPendingTransactions()
    }

    private func doProcessPendingTransactions() async {
        // Cancel a delayed flush; wait for any in-flight send to finish so we
        // never snapshot `.sent` mid-mutate and clobber a just-written
        // `awaitingSync` (TS `flushPendingBatchNow` + `waitForInflightSends`).
        batchTask?.cancel()
        batchTask = nil
        await waitForInflightFlush()

        let outbox = await storage.getOutbox()

        // Reset sent -> queued only when the row is still `.sent`. A mutate
        // that finished while we awaited flush must not be clobbered back to
        // queued (that was the dedup-storm race).
        for tx in outbox where tx.state == .sent {
            try? await storage.updateOutboxTransaction(clientTxId: tx.clientTxId) { t in
                guard t.state == .sent else { return }
                t.state = .queued
            }
        }

        let pending = (await storage.getOutbox()).filter { $0.state == .queued }
        guard !pending.isEmpty else {
            let pendingCount = await getPendingCount()
            await onPendingCountChange?(pendingCount)
            return
        }

        // Add to pending batch (skipping anything already queued in memory)
        // and trigger send. Connectivity just (re)appeared, so reset backoff.
        // Schedule asynchronously (don't await the new flush) so account-boundary
        // / reconnect callers aren't blocked on the next network round-trip.
        let inMemoryTxIds = Set(pendingBatch.map(\.clientTxId))
        pendingBatch.append(contentsOf: pending.filter { !inMemoryTxIds.contains($0.clientTxId) })
        consecutiveSendFailures = 0
        retryTask?.cancel()
        retryTask = nil
        // Reconnect is already a batching boundary: flush immediately rather
        // than requiring another timer tick before durable queued work replays.
        batchTask = Task { [weak self] in await self?.flushBatch() }

        let pendingCount = await getPendingCount()
        await onPendingCountChange?(pendingCount)
    }

    /// Removes confirmed transactions from the outbox.
    /// A transaction is confirmed when the server's lastSyncId >= its syncIdNeededForCompletion.
    func completeUpToSyncId(_ lastSyncId: SyncId) async throws -> Int {
        let outbox = await storage.getOutbox()
        var completedCount = 0

        for tx in outbox where tx.state == .awaitingSync {
            if let needed = tx.syncIdNeededForCompletion,
               !isSyncIdGreaterThan(needed, lastSyncId) {
                try? await storage.removeFromOutbox(clientTxId: tx.clientTxId)
                completedCount += 1
            }
        }

        return completedCount
    }

    func getPendingCount() async -> Int {
        let outbox = await storage.getOutbox()
        return outbox.filter { $0.state != .completed && $0.state != .failed }.count
    }

    func resetForAccountBoundary() async {
        lifecycleVersion += 1

        let activeBatchTask = batchTask
        batchTask?.cancel()
        batchTask = nil
        retryTask?.cancel()
        retryTask = nil
        await activeBatchTask?.value

        // Abandon any in-flight flush without awaiting the network call. The
        // bumped lifecycleVersion makes its mutate result a no-op; durable
        // rows remain for the next `processPendingTransactions`.
        isFlushing = false
        resumeFlushWaiters()
        isProcessingPending = false
        let processWaitersPending = processWaiters
        processWaiters.removeAll()
        for waiter in processWaitersPending {
            waiter.resume()
        }

        // A cancelled in-flight send may have requeued its batch while the
        // reset awaited it. Drop only that in-memory copy; the durable rows
        // remain in the account's outbox for its next session.
        pendingBatch.removeAll()
        retryTask?.cancel()
        retryTask = nil
        consecutiveSendFailures = 0

        // Park abandoned `.sent` rows back at `.queued` so the next session
        // does not need crash-recovery to unstick them.
        for tx in await storage.getOutbox() where tx.state == .sent {
            try? await storage.updateOutboxTransaction(clientTxId: tx.clientTxId) { t in
                guard t.state == .sent else { return }
                t.state = .queued
            }
        }
    }

    func clear() async throws {
        await resetForAccountBoundary()
        // Storage clear is handled by the caller.
    }
}

enum OutboxManagerError: Error, LocalizedError {
    case invalidMutateResponse

    var errorDescription: String? {
        switch self {
        case .invalidMutateResponse:
            "Mutation response did not exactly cover the submitted transactions"
        }
    }
}
