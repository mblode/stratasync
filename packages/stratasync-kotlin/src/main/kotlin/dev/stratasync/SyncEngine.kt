package dev.stratasync

import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Adapters deliver callbacks once; the engine fences late responses after stop/restart. */
interface SyncTransport {
    fun bootstrap(groups: List<String>, complete: (Result<Bootstrap>) -> Unit)
    fun deltas(cursor: String, complete: (Result<JsonObject>) -> Unit)
    fun mutate(clientId: String, transactions: List<JsonObject>, complete: (Result<List<MutationResult>>) -> Unit)
    fun subscribe(cursor: String, groups: List<String>, onPacket: (JsonObject) -> Unit, onConnection: (Boolean) -> Unit): Cancellation
}
data class Bootstrap(val rows: List<JsonObject>, val lastSyncId: String, val authorizedGroups: List<String>? = null)
data class MutationResult(val clientTxId: String, val syncId: String? = null, val error: String? = null)
class BootstrapRequired : Exception("Server requires a new snapshot")
class AuthenticationRequired : Exception("Authentication required")

/**
 * Model-agnostic local-first engine. Public calls and callbacks are serialized by this monitor.
 * The storage checkpoint is the source of truth; visible rows are base + pending overlays.
 * Network adapters must return promptly and perform I/O outside the caller's thread.
 */
class SyncEngine(
    private val models: List<JsonObject>,
    private val storage: SyncStorage,
    private val transport: SyncTransport,
    private val runtime: SyncRuntime,
    private val clientId: String,
    private val canReplayAbsentInsert: (JsonObject, Bootstrap) -> Boolean = { _, _ -> false },
) {
    private var checkpoint = storage.read()
    private var privacyHidden = checkpoint.meta["privacyPending"] == JsonPrimitive(true)
    private var active = false
    private var generation = 0L
    private var groups = emptyList<String>()
    private var subscription: Cancellation? = null
    private var batchTimer: Cancellation? = null
    private var retryTimer: Cancellation? = null
    private var catchingUp = false
    private var sending = false
    private var seenOpen = false
    private var retryAttempt = 0
    private val buffered = mutableListOf<JsonObject>()
    private val modelNames = models.map { it.string("name") }.toSet()
    private val schemaHash = MessageDigest.getInstance("SHA-256").digest(canonical(JsonArray(models)).toByteArray()).joinToString("") { "%02x".format(it) }
    @Volatile var state: String = "disconnected"; private set
    @Volatile var lastError: Throwable? = null; private set
    val cursor: String @Synchronized get() = checkpoint.meta.optionalString("lastSyncId") ?: "0"
    @Synchronized fun snapshot(): Checkpoint = checkpoint
    @Synchronized fun rows(): List<JsonObject> {
        if (privacyHidden) return emptyList()
        var rows = checkpoint.rows
        for (tx in checkpoint.outbox.filter { it.optionalString("status") != "withheld" }) rows = apply(rows, tx.string("model"), tx.string("modelId"), Wire.mutationCode(tx.string("action")), tx["payload"]!!.jsonObject)
        return rows
    }

    @Synchronized fun start(groups: List<String>, freshSnapshot: Boolean = false) {
        if (active) { require(this.groups == groups) { "Stop before changing sync groups" }; return }
        checkpoint = storage.read()
        val storedClient = checkpoint.meta.optionalString("clientId")
        require(storedClient == null || storedClient == clientId) { "Storage belongs to a different client; use an account-scoped store and stable client ID" }
        active = true; generation++; this.groups = groups.toList(); state = "connecting"; lastError = null
        val storedGroups = checkpoint.meta.array("subscribedGroups").map { it.jsonPrimitive.content }
        privacyHidden = checkpoint.meta["privacyPending"] == JsonPrimitive(true)
        val needsBootstrap = freshSnapshot || privacyHidden || checkpoint.meta["bootstrapComplete"] != JsonPrimitive(true) || checkpoint.meta.optionalString("schemaHash") != schemaHash || storedGroups.toSet() != groups.toSet()
        // A process can die after send but before ack. Reuse the same idempotency keys.
        persist(checkpoint.copy(outbox = checkpoint.outbox.map { tx -> if (tx.optionalString("syncId") == null && tx.optionalString("status") != "withheld") patch(tx, "status" to JsonPrimitive("pending")) else tx }))
        if (needsBootstrap) {
            if (checkpoint.meta["bootstrapComplete"] == JsonPrimitive(true)) quarantine()
            bootstrap()
        } else catchUp { connect() }
    }

    /** Polling adapters may request catch-up; at most one fetch is active. */
    @Synchronized fun refresh() { if (active && !catchingUp) catchUp { flush() } }

    @Synchronized fun stop() {
        active = false; generation++; subscription?.cancel(); subscription = null
        batchTimer?.cancel(); batchTimer = null; retryTimer?.cancel(); retryTimer = null
        catchingUp = false; sending = false; seenOpen = false; buffered.clear(); state = "disconnected"
    }

    @Synchronized fun mutate(action: String, model: String, id: String, payload: JsonObject = JsonObject(emptyMap())): String {
        check(!privacyHidden) { "Access reconciliation is pending" }
        require(model in modelNames) { "Unregistered model: $model" }
        val code = Wire.mutationCode(action)
        val current = rows().find { it.string("model") == model && it.string("id") == id }
        require((code == "I") == (current == null)) { "INSERT requires an absent row; other actions require an existing row" }
        require(payload["id"] == null || payload["id"] == JsonPrimitive(id)) { "A mutation cannot change row identity" }
        val fields = when (code) {
            "A" -> patch(payload, "archivedAt" to JsonPrimitive(runtime.now()))
            "V" -> patch(payload, "archivedAt" to JsonNull)
            else -> payload
        }
        val txId = runtime.transactionId()
        require(checkpoint.outbox.none { it.string("clientTxId") == txId }) { "Duplicate transaction ID" }
        val tx = buildJsonObject {
            put("clientTxId", txId); put("action", action); put("model", model); put("modelId", id)
            put("payload", fields); put("status", "pending"); put("createdAt", runtime.now())
        }
        // Never publish an optimistic row before its outbox entry is durable.
        persist(checkpoint.copy(outbox = checkpoint.outbox + tx))
        batchTimer?.cancel()
        val epoch = generation
        batchTimer = runtime.schedule(50) { synchronized(this) { if (active && epoch == generation) flush() } }
        return txId
    }

    private fun bootstrap() {
        state = "bootstrapping"; catchingUp = true
        val epoch = generation
        transport.bootstrap(groups) { result -> synchronized(this) {
            if (!active || epoch != generation) return@synchronized
            result.fold(onSuccess = { response ->
                try {
                    Wire.syncId(JsonPrimitive(response.lastSyncId))
                    for (row in response.rows) { require(row.string("model") in modelNames); row.string("id"); row["fields"]!!.jsonObject }
                    val meta = buildJsonObject {
                        put("clientId", clientId); put("lastSyncId", response.lastSyncId); put("firstSyncId", response.lastSyncId)
                        put("schemaHash", schemaHash); put("bootstrapComplete", true); put("subscribedGroups", JsonArray(groups.map(::JsonPrimitive)))
                    }
                    val outbox = if (privacyHidden) checkpoint.outbox.map { tx ->
                        val present = response.rows.any { it.string("model") == tx.string("model") && it.string("id") == tx.string("modelId") }
                        val authorizedInsert = tx.string("action") == "INSERT" && canReplayAbsentInsert(tx, response)
                        patch(tx, "status" to JsonPrimitive(if (present || authorizedInsert) "pending" else "withheld"))
                    } else checkpoint.outbox
                    persist(Checkpoint(response.rows, outbox, meta))
                    privacyHidden = false
                    catchingUp = false; retryAttempt = 0; state = "syncing"; lastError = null
                    drain(); if (active && epoch == generation) { connect(); flush() }
                } catch (error: Throwable) { fail(error) }
            }, onFailure = { fail(it) })
        } }
    }

    private fun connect() {
        subscription?.cancel(); seenOpen = false
        val epoch = generation
        subscription = transport.subscribe(cursor, groups, { packet -> synchronized(this) {
            if (active && epoch == generation) {
                try { if (catchingUp) buffered.add(packet) else receive(packet) } catch (error: Throwable) { fail(error) }
            }
        } }, { connected -> synchronized(this) {
            if (active && epoch == generation && connected) {
                if (seenOpen) catchUp { connect(); flush() } else { seenOpen = true; flush() }
            }
        } })
    }

    private fun catchUp(after: () -> Unit) {
        if (catchingUp) return
        catchingUp = true
        val epoch = generation
        val requestedCursor = cursor
        transport.deltas(cursor) { result -> synchronized(this) {
            if (!active || epoch != generation) return@synchronized
            result.fold(onSuccess = { packet ->
                try {
                    if (packet["hasMore"] == JsonPrimitive(true)) {
                        val watermark = Wire.syncId(packet["lastSyncId"])
                        require(Wire.compareIds(watermark, requestedCursor) > 0) { "Paginated delta response did not advance cursor" }
                    }
                    receive(packet)
                    if (!active || epoch != generation) return@synchronized
                    catchingUp = false
                    if (packet["hasMore"] == JsonPrimitive(true)) catchUp(after) else {
                        retryAttempt = 0; lastError = null; state = "syncing"; drain(); if (active && epoch == generation) after()
                    }
                } catch (error: Throwable) { fail(error) }
            }, onFailure = { error ->
                catchingUp = false
                when (error) {
                    is BootstrapRequired -> { quarantine(); bootstrap() }
                    is AuthenticationRequired -> fail(error)
                    else -> {
                        lastError = error; state = "offline"
                        retryTimer?.cancel()
                        val delay = minOf(300L shl minOf(retryAttempt++, 6), 30000)
                        retryTimer = runtime.schedule(delay) { synchronized(this) { if (active && epoch == generation) catchUp(after) } }
                    }
                }
            })
        } }
    }

    private fun drain() {
        val packets = buffered.toList(); buffered.clear()
        for (packet in packets) receive(packet)
    }

    private fun receive(raw: JsonObject) {
        val packet = requireNotNull(Wire.packet(raw)) { "Invalid delta packet" }
        if (packet.array("actions").any { it.jsonObject.string("action") in setOf("G", "S") }) {
            // Fence old callbacks before acquiring a replacement snapshot. The durable latch
            // survives process death; retained outbox entries must be re-authorized by presence.
            stop(); active = true; quarantine(); bootstrap(); return
        }
        if (privacyHidden) return
        var base = checkpoint.rows
        var outbox = checkpoint.outbox
        var nextCursor = cursor
        val before = cursor
        for (action in packet.array("actions").map { it.jsonObject }.sortedWith { a, b -> Wire.compareIds(a.string("id"), b.string("id")) }) {
            val syncId = action.string("id")
            if (Wire.compareIds(syncId, before) <= 0) continue
            val model = action.string("modelName"); val id = action.string("modelId"); val code = action.string("action")
            if (code == "C") { if (Wire.compareIds(syncId, nextCursor) > 0) nextCursor = syncId; continue }
            require(code in setOf("I", "U", "D", "A", "V")) { "Extension action $code requires an adapter capability not yet implemented" }
            require(model in modelNames) { "Unregistered delta model $model" }
            val data = action["data"]!!.jsonObject
            val ownTx = if (action.optionalString("clientId") == clientId) action.optionalString("clientTxId") else null
            outbox = outbox.filterNot { tx ->
                if (ownTx != null && tx.string("clientTxId") == ownTx) true
                else if (tx.string("model") != model || tx.string("modelId") != id || action.optionalString("clientId") == clientId) false
                else code == "D" || code == "I" || tx.string("action") == "DELETE" || tx["payload"]!!.jsonObject.keys.any { it in data.keys }
            }
            base = apply(base, model, id, code, data)
            if (Wire.compareIds(syncId, nextCursor) > 0) nextCursor = syncId
        }
        val watermark = packet.string("lastSyncId")
        if (Wire.compareIds(watermark, nextCursor) > 0) nextCursor = watermark
        outbox = outbox.filterNot { tx -> tx.optionalString("syncId")?.let { Wire.compareIds(it, nextCursor) <= 0 } ?: false }
        persist(checkpoint.copy(rows = base, outbox = outbox, meta = patch(checkpoint.meta, "lastSyncId" to JsonPrimitive(nextCursor))))
    }

    private fun flush() {
        if (!active || sending || catchingUp || privacyHidden) return
        val pending = checkpoint.outbox.filter { it.optionalString("status") == "pending" }.take(100)
        if (pending.isEmpty()) return
        val ids = pending.map { it.string("clientTxId") }.toSet()
        persist(checkpoint.copy(outbox = checkpoint.outbox.map { if (it.string("clientTxId") in ids) patch(it, "status" to JsonPrimitive("inflight")) else it }))
        sending = true
        val epoch = generation
        transport.mutate(clientId, pending) { result -> synchronized(this) {
            if (!active || epoch != generation) return@synchronized
            sending = false
            try {
                result.fold(onSuccess = { results ->
                    val responses = results.associateBy { it.clientTxId }
                    require(responses.size == results.size && responses.keys == ids) { "Mutation response must identify every sent transaction exactly once" }
                    var next = checkpoint.outbox
                    for (response in results) {
                        if (response.error != null) { lastError = IllegalStateException(response.error); next = next.filterNot { it.string("clientTxId") == response.clientTxId } }
                        else {
                            val acknowledged = Wire.syncId(response.syncId?.let(::JsonPrimitive))
                            next = next.mapNotNull { tx ->
                                if (tx.string("clientTxId") != response.clientTxId) tx
                                else if (Wire.compareIds(acknowledged, cursor) <= 0) null
                                else patch(tx, "syncId" to JsonPrimitive(acknowledged))
                            }
                        }
                    }
                    persist(checkpoint.copy(outbox = next)); flush()
                }, onFailure = { error ->
                    persist(checkpoint.copy(outbox = checkpoint.outbox.map { if (it.string("clientTxId") in ids) patch(it, "status" to JsonPrimitive("pending")) else it }))
                    lastError = error
                    if (error is AuthenticationRequired) fail(error) else {
                        runtime.schedule(1000) { synchronized(this) { if (active && epoch == generation) flush() } }
                    }
                })
            } catch (error: Throwable) { fail(error) }
        } }
    }
    private fun quarantine() {
        // Hide immediately even if disk fails. A host must gate cached data on fresh validation
        // when reopening after a storage error (start(..., freshSnapshot = true)).
        privacyHidden = true
        persist(checkpoint.copy(meta = patch(checkpoint.meta, "privacyPending" to JsonPrimitive(true))))
    }
    private fun fail(error: Throwable) { stop(); lastError = error; state = "error" }
    private fun persist(next: Checkpoint) { storage.commit(next); checkpoint = next }
    private fun apply(rows: List<JsonObject>, model: String, id: String, code: String, data: JsonObject): List<JsonObject> {
        val index = rows.indexOfFirst { it.string("model") == model && it.string("id") == id }
        if (code == "D") return rows.filterIndexed { i, _ -> i != index }
        if (index < 0 && code != "I") return rows
        val old = if (index >= 0 && code != "I") rows[index]["fields"]!!.jsonObject else JsonObject(emptyMap())
        val fields = patch(JsonObject(old + data), "id" to JsonPrimitive(id))
        val row = buildJsonObject { put("model", model); put("id", id); put("fields", fields) }
        return if (index < 0) rows + row else rows.mapIndexed { i, existing -> if (i == index) row else existing }
    }
}
internal fun patch(obj: JsonObject, vararg values: Pair<String, JsonElement>) = JsonObject(obj + values.toMap())
internal fun canonical(value: JsonElement): String = when (value) {
    is JsonObject -> value.toSortedMap().entries.joinToString(",", "{", "}") { JsonPrimitive(it.key).toString() + ":" + canonical(it.value) }
    is JsonArray -> value.joinToString(",", "[", "]", transform = ::canonical)
    else -> value.toString()
}
