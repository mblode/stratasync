package dev.stratasync

import kotlinx.serialization.json.*
import java.nio.file.Path
import kotlin.io.path.readText

internal val capabilityManifest: JsonObject = Json.parseToJsonElement(Path.of(System.getProperty("stratasync.corpus")).resolve("capabilities/stratasync-kotlin.json").readText()).jsonObject
internal val supportedCapabilities = capabilityManifest.array("capabilities").map { it.jsonPrimitive.content }.toSet()
internal class FakeRuntime(seed: JsonObject) : SyncRuntime {
    private var time = (seed["clock"] as? JsonPrimitive)?.long ?: 0L
    private val ids = ArrayDeque(seed.array("txIds").map { it.jsonPrimitive.content })
    private data class Timer(val time: Long, val order: Long, val action: () -> Unit, var cancelled: Boolean = false)
    private val timers = mutableListOf<Timer>()
    private var order = 0L
    override fun now() = time
    override fun transactionId(): String = ids.removeFirstOrNull() ?: error("Scenario exhausted seeded transaction IDs")
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellation {
        val timer = Timer(time + delayMs, order++, action); timers += timer
        return Cancellation { timer.cancelled = true }
    }
    fun advance(ms: Long) {
        require(ms >= 0)
        val until = time + ms
        var fired = 0
        while (true) {
            val next = timers.filter { !it.cancelled && it.time <= until }.minWithOrNull(compareBy<Timer> { it.time }.thenBy { it.order }) ?: break
            require(fired++ < 10000) { "Timer failed to quiesce" }
            timers.remove(next); time = next.time; next.action()
        }
        time = until
    }
}
internal class ScriptedTransport : SyncTransport {
    val counts = mutableMapOf("bootstrapCount" to 0, "deltaFetchCount" to 0, "mutateCount" to 0, "socketConnectCount" to 0)
    val bootstraps = ArrayDeque<Bootstrap>()
    val deltaResponses = ArrayDeque<JsonObject>()
    val errors = mutableMapOf<String, Throwable>()
    private var packetCallback: ((JsonObject) -> Unit)? = null
    private var connectionCallback: ((Boolean) -> Unit)? = null
    private val packets = mutableListOf<JsonObject>()
    private var connected = false
    private data class Batch(val ids: List<String>, val complete: (Result<List<MutationResult>>) -> Unit, val results: MutableMap<String, MutationResult> = mutableMapOf())
    private val batches = mutableListOf<Batch>()
    override fun bootstrap(groups: List<String>, complete: (Result<Bootstrap>) -> Unit) {
        counts.compute("bootstrapCount") { _, n -> n!! + 1 }
        complete(runCatching { errors.remove("bootstrap")?.let { throw it }; bootstraps.removeFirst() })
    }
    override fun deltas(cursor: String, complete: (Result<JsonObject>) -> Unit) {
        counts.compute("deltaFetchCount") { _, n -> n!! + 1 }
        complete(runCatching { errors.remove("deltas")?.let { throw it }; deltaResponses.removeFirstOrNull() ?: buildJsonObject { put("lastSyncId", cursor); put("actions", JsonArray(emptyList())) } })
    }
    override fun mutate(clientId: String, transactions: List<JsonObject>, complete: (Result<List<MutationResult>>) -> Unit) {
        counts.compute("mutateCount") { _, n -> n!! + 1 }
        val failure = errors.remove("mutate")
        if (failure != null) complete(Result.failure(failure)) else batches += Batch(transactions.map { it.string("clientTxId") }, complete)
    }
    override fun subscribe(cursor: String, groups: List<String>, onPacket: (JsonObject) -> Unit, onConnection: (Boolean) -> Unit): Cancellation {
        counts.compute("socketConnectCount") { _, n -> n!! + 1 }
        packetCallback = onPacket; connectionCallback = onConnection
        if (connected) onConnection(true)
        val queued = packets.toList(); packets.clear(); queued.forEach(onPacket)
        return Cancellation { if (packetCallback === onPacket) { packetCallback = null; connectionCallback = null } }
    }
    fun socket(open: Boolean) { connected = open; connectionCallback?.invoke(open) }
    fun deliver(packet: JsonObject) { val callback = packetCallback; if (callback == null) packets += packet else callback(packet) }
    fun settle(result: MutationResult) {
        val batch = batches.firstOrNull { result.clientTxId in it.ids } ?: error("No in-flight mutation ${result.clientTxId}")
        batch.results[result.clientTxId] = result
        if (batch.results.size == batch.ids.size) { batches.remove(batch); batch.complete(Result.success(batch.ids.map { batch.results.getValue(it) })) }
    }
}

internal fun runScenario(scenario: JsonObject): JsonObject {
    val required = scenario.array("requires").map { it.jsonPrimitive.content }.toSet()
    require(supportedCapabilities.containsAll(required)) { "Undeclared scenario capabilities: ${required - supportedCapabilities}" }
    val seed = scenario["seed"] as? JsonObject ?: JsonObject(emptyMap())
    val given = scenario["given"] as? JsonObject ?: JsonObject(emptyMap())
    val runtime = FakeRuntime(seed)
    val storage = MemorySyncStorage(Checkpoint(given.array("rows").map { it.jsonObject }, given.array("outbox").map { it.jsonObject }, given["meta"] as? JsonObject ?: JsonObject(emptyMap())))
    val transport = ScriptedTransport()
    val engine = SyncEngine(scenario.array("models").map { it.jsonObject }, storage, transport, runtime, seed.optionalString("clientId") ?: "c_test")
    val results = mutableListOf<JsonObject>()
    for ((index, value) in scenario.array("steps").withIndex()) {
        val step = value.jsonObject
        val failures = mutableListOf<String>()
        try {
            when (step.string("op")) {
                "start" -> engine.start(step.array("groups").map { it.jsonPrimitive.content })
                "stop" -> engine.stop()
                "respondBootstrap" -> transport.bootstraps.add(Bootstrap(step.array("rows").map { it.jsonObject }, step.optionalString("lastSyncId") ?: "0"))
                "respondDeltas" -> transport.deltaResponses.add(step["packet"]!!.jsonObject)
                "deliverDelta" -> transport.deliver(step["packet"]!!.jsonObject)
                "socketOpen" -> transport.socket(true)
                "socketClose" -> transport.socket(false)
                "transportError" -> transport.errors[step.optionalString("on") ?: "deltas"] = when (step.string("kind")) { "bootstrapRequired" -> BootstrapRequired(); "auth" -> AuthenticationRequired(); else -> java.io.IOException(step.string("kind")) }
                "advanceClock" -> runtime.advance(step["ms"]!!.jsonPrimitive.long)
                "mutate" -> engine.mutate(step.string("action"), step.string("model"), step.string("modelId"), step["payload"] as? JsonObject ?: JsonObject(emptyMap()))
                "ackMutation" -> transport.settle(MutationResult(step.string("clientTxId"), step.string("syncId")))
                "rejectMutation" -> transport.settle(MutationResult(step.string("clientTxId"), error = step.optionalString("message") ?: "Rejected"))
                "expect" -> {
                    fun check(label: String, actual: JsonElement?, expected: JsonElement?) { if (actual != expected) failures += "$label: expected $expected, got $actual" }
                    step["state"]?.let { check("state", JsonPrimitive(engine.state), it) }
                    step["cursor"]?.let { check("cursor", JsonPrimitive(engine.cursor), it) }
                    (step["transport"] as? JsonObject)?.forEach { (key, expected) -> check("transport.$key", transport.counts[key]?.let(::JsonPrimitive), expected) }
                    (step["storage"] as? JsonObject)?.forEach { (key, expected) -> check("storage.$key", storage.read().meta[key], expected) }
                    for (expected in step.array("store").map { it.jsonObject }) {
                        val row = engine.rows().find { it["model"] == expected["model"] && it["id"] == expected["id"] }
                        if (row == null) failures += "Missing row ${expected["model"]}/${expected["id"]}"
                        else expected["fields"]!!.jsonObject.forEach { (key, value) -> check("row.$key", row["fields"]!!.jsonObject[key], value) }
                    }
                    for (absent in step.array("storeAbsent").map { it.jsonObject }) if (engine.rows().any { it["model"] == absent["model"] && it["id"] == absent["id"] }) failures += "Unexpected row $absent"
                    (step["outbox"] as? JsonArray)?.let { expected ->
                        val actual = engine.snapshot().outbox
                        check("outbox.size", JsonPrimitive(actual.size), JsonPrimitive(expected.size))
                        expected.forEachIndexed { i, entry -> entry.jsonObject.forEach { (key, value) -> check("outbox[$i].$key", actual.getOrNull(i)?.get(key), value) } }
                    }
                }
                else -> error("Unsupported scenario operation ${step["op"]}")
            }
        } catch (error: Throwable) { failures += (error.message ?: error.toString()) }
        results += buildJsonObject { put("index", index); put("op", step.string("op")); put("ok", failures.isEmpty()); if (failures.isNotEmpty()) put("failures", JsonArray(failures.map(::JsonPrimitive))) }
        if (failures.isNotEmpty()) break
    }
    engine.stop()
    return buildJsonObject { put("scenarioId", scenario.string("id")); put("ok", results.all { it["ok"] == JsonPrimitive(true) }); put("steps", JsonArray(results)) }
}

fun main(args: Array<String>) {
    val output = when (args.singleOrNull()) {
        "version" -> buildJsonObject { put("driver", "stratasync-kotlin"); put("protocolVersion", 1) }
        "capabilities" -> capabilityManifest
        "run" -> runScenario(Json.parseToJsonElement(System.`in`.bufferedReader().readText()).jsonObject)
        else -> error("Usage: conformanceDriver -Pcommand=version|capabilities|run")
    }
    // The JSON verdict, not process exit status, communicates a scenario failure.
    println(output)
}
