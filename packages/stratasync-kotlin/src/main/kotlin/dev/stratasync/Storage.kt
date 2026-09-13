package dev.stratasync

import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/** One immutable checkpoint owns base rows, optimistic outbox and cursor together. */
data class Checkpoint(
    val rows: List<JsonObject> = emptyList(),
    val outbox: List<JsonObject> = emptyList(),
    val meta: JsonObject = JsonObject(emptyMap()),
) {
    fun toJson() = buildJsonObject { put("rows", JsonArray(rows)); put("outbox", JsonArray(outbox)); put("meta", meta) }
    companion object {
        fun fromJson(value: JsonObject): Checkpoint {
            require(value["rows"] is JsonArray && value["outbox"] is JsonArray && value["meta"] is JsonObject) { "Invalid persisted checkpoint shape; refusing to discard data" }
            val rows = value["rows"]!!.jsonArray.map { it.jsonObject }
            for (row in rows) { row.string("model"); row.string("id"); require(row["fields"] is JsonObject) }
            val outbox = value["outbox"]!!.jsonArray.map { it.jsonObject }
            for (tx in outbox) { tx.string("clientTxId"); tx.string("model"); tx.string("modelId"); Wire.mutationCode(tx.string("action")); require(tx["payload"] is JsonObject) }
            return Checkpoint(rows, outbox, value["meta"]!!.jsonObject)
        }
    }
}
interface SyncStorage {
    fun read(): Checkpoint
    /** Must atomically replace the checkpoint, or throw leaving the old checkpoint intact. */
    fun commit(checkpoint: Checkpoint)
}
class MemorySyncStorage(initial: Checkpoint = Checkpoint()) : SyncStorage {
    private var checkpoint = initial
    @Synchronized override fun read() = checkpoint
    @Synchronized override fun commit(checkpoint: Checkpoint) { this.checkpoint = checkpoint }
}
/**
 * JVM reference persistence for small stores. One engine/process owns one account-specific file.
 * Uses fsync + atomic rename, failing rather than falling back to a non-atomic replacement.
 * Android should supply its own transactional SQLite adapter; this is not that adapter.
 */
class FileSyncStorage(private val file: Path) : SyncStorage {
    @Synchronized override fun read(): Checkpoint = if (Files.exists(file)) Checkpoint.fromJson(Json.parseToJsonElement(Files.readString(file)).jsonObject) else Checkpoint()
    @Synchronized override fun commit(checkpoint: Checkpoint) {
        val parent = file.toAbsolutePath().parent
        Files.createDirectories(parent)
        val temp = Files.createTempFile(parent, ".stratasync-", ".tmp")
        try {
            FileChannel.open(temp, StandardOpenOption.WRITE).use { channel ->
                val bytes = java.nio.ByteBuffer.wrap(checkpoint.toJson().toString().toByteArray(Charsets.UTF_8))
                while (bytes.hasRemaining()) channel.write(bytes)
                channel.force(true)
            }
            Files.move(temp, file.toAbsolutePath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temp) }
    }
}
