package dev.stratasync

import kotlinx.serialization.json.*
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder

/** Strict wire decoding. Sync cursors never pass through a floating-point number. */
object Wire {
    fun syncId(raw: JsonElement?): String {
        val value = raw as? JsonPrimitive
        require(value != null && value.isString && value.content.matches(Regex("[0-9]+"))) { "Expected decimal string sync ID: $raw" }
        return value.content
    }
    fun compareIds(left: String, right: String): Int {
        syncId(JsonPrimitive(left)); syncId(JsonPrimitive(right))
        val a = left.trimStart('0').ifEmpty { "0" }
        val b = right.trimStart('0').ifEmpty { "0" }
        return if (a.length == b.length) a.compareTo(b).sign() else a.length.compareTo(b.length).sign()
    }
    private fun Int.sign() = when { this < 0 -> -1; this > 0 -> 1; else -> 0 }
    fun mutationCode(name: String): String = when (name) {
        "INSERT" -> "I"; "UPDATE" -> "U"; "DELETE" -> "D"; "ARCHIVE" -> "A"; "UNARCHIVE" -> "V"
        else -> error("Unsupported mutation action: $name")
    }
    fun action(raw: JsonElement): JsonObject {
        val obj = raw.jsonObject
        val code = obj.string("action")
        require(code in setOf("I", "U", "D", "A", "V", "C", "G", "S")) { "Unsupported log action: $code" }
        return buildJsonObject {
            put("id", syncId(obj["syncId"].takeUnless { it == JsonNull } ?: obj["id"]))
            put("action", code)
            put("modelName", obj.string("modelName")); put("modelId", obj.string("modelId"))
            put("data", obj["data"] as? JsonObject ?: JsonObject(emptyMap()))
            for (key in listOf("clientId", "clientTxId", "groupId")) obj.optionalString(key)?.let { put(key, it) }
            (obj["groups"] as? JsonArray)?.let { put("groups", strings(it)) }
            val created = obj["createdAt"] as? JsonPrimitive
            if (created != null && created != JsonNull) {
                val instant = runCatching { if (created.isString) Instant.parse(created.content) else Instant.ofEpochMilli(created.long) }.getOrNull()
                if (instant != null) put("createdAt", DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(instant))
            }
        }
    }
    fun packet(raw: JsonElement): JsonObject? {
        val obj = raw as? JsonObject
        if (obj?.optionalString("type") == "delta") return packet(obj["packet"] ?: JsonNull)
        val rawActions = when {
            raw is JsonArray -> raw
            obj?.get("actions") is JsonArray -> obj["actions"]!!.jsonArray
            obj?.get("action") != null -> JsonArray(listOf(obj))
            else -> return null
        }
        val actions = rawActions.filterIsInstance<JsonObject>().map(::action)
        val maximum = actions.map { it.string("id") }.maxWithOrNull(::compareIds) ?: "0"
        return buildJsonObject {
            put("actions", JsonArray(actions))
            put("lastSyncId", obj?.get("lastSyncId")?.let(::syncId) ?: maximum)
            (obj?.get("hasMore") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull?.let { put("hasMore", it) }
        }
    }
    fun bootstrapLine(line: String): JsonElement {
        val clean = line.trim()
        if (clean.isEmpty()) return JsonNull
        val prefix = clean.startsWith("_metadata_=")
        val obj = Json.parseToJsonElement(if (prefix) clean.removePrefix("_metadata_=") else clean).jsonObject
        if (obj.optionalString("type") == "error") error(obj.optionalString("message") ?: "Bootstrap error")
        if (obj.optionalString("type") == "end") return buildJsonObject {
            put("type", "end"); obj["rowCount"]?.let { put("rowCount", it) }
        }
        obj.optionalString("__class")?.let { model ->
            return buildJsonObject { put("type", "row"); put("row", buildJsonObject {
                put("modelName", model); put("data", JsonObject(obj - "__class"))
            }) }
        }
        val meta = (obj["_metadata_"] as? JsonObject) ?: obj
        require(prefix || obj["_metadata_"] is JsonObject || listOf("lastSyncId", "subscribedSyncGroups", "returnedModelsCount").any { it in obj }) { "Unrecognized bootstrap line" }
        return buildJsonObject {
            put("type", "meta"); put("metadata", buildJsonObject {
                put("raw", meta)
                put("subscribedSyncGroups", strings(meta["subscribedSyncGroups"] as? JsonArray ?: JsonArray(emptyList())))
                meta["lastSyncId"]?.let { put("lastSyncId", syncId(it)) }
                for (key in listOf("databaseVersion", "schemaHash", "returnedModelsCount")) meta[key]?.let { put(key, it) }
            })
        }
    }
    /** The Reader decoder handles UTF-8 codepoints split across network byte chunks. */
    fun ndjsonLines(reader: java.io.Reader): Sequence<String> = reader.buffered().lineSequence().map(String::trim).filter(String::isNotEmpty)
    private fun strings(array: JsonArray) = JsonArray(array.filter { it is JsonPrimitive && it.isString })
}

internal fun JsonObject.optionalString(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.string(key: String): String = requireNotNull(optionalString(key)) { "Missing string $key" }
internal fun JsonObject.array(key: String): JsonArray = get(key) as? JsonArray ?: JsonArray(emptyList())
