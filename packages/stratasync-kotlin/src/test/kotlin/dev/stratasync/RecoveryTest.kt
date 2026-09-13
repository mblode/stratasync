package dev.stratasync

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.io.IOException
import kotlin.test.*

class RecoveryTest {
    @TempDir lateinit var directory: Path
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private val models = listOf(obj("""{"name":"Task","groupKey":"workspaceId","fields":{"id":"id","workspaceId":"id","title":"string","sortOrder":"number"}}"""))
    private fun runtime(vararg ids: String) = FakeRuntime(buildJsonObject { put("clock", 1000); put("txIds", JsonArray(ids.map(::JsonPrimitive))) })
    private fun bootstrap(transport: ScriptedTransport, rows: List<JsonObject> = emptyList()) { transport.bootstraps.add(Bootstrap(rows, "100")) }
    private val initialRow = obj("""{"model":"Task","id":"t1","fields":{"id":"t1","title":"original","sortOrder":10}}""")

    @Test fun restartReplaysTheSameDurableTransaction() {
        val file = directory.resolve("account-a.json")
        val firstTransport = ScriptedTransport(); bootstrap(firstTransport)
        val first = SyncEngine(models, FileSyncStorage(file), firstTransport, runtime("tx1"), "c1")
        first.start(listOf("w1")); firstTransport.socket(true)
        first.mutate("INSERT", "Task", "t1", obj("""{"title":"offline"}""")); first.stop()
        val nextTransport = ScriptedTransport()
        val second = SyncEngine(models, FileSyncStorage(file), nextTransport, runtime(), "c1")
        second.start(listOf("w1")); nextTransport.socket(true)
        assertEquals("tx1", second.snapshot().outbox.single().string("clientTxId"))
        assertEquals("offline", second.rows().single()["fields"]!!.jsonObject.string("title"))
        assertEquals(0, nextTransport.counts["bootstrapCount"])
        assertEquals(1, nextTransport.counts["mutateCount"])
        second.stop()
    }

    @Test fun failedPersistenceDoesNotPublishOptimisticState() {
        val memory = MemorySyncStorage()
        var reject = false
        val storage = object : SyncStorage {
            override fun read() = memory.read()
            override fun commit(checkpoint: Checkpoint) { if (reject) throw IOException("Disk full"); memory.commit(checkpoint) }
        }
        val transport = ScriptedTransport(); bootstrap(transport)
        val engine = SyncEngine(models, storage, transport, runtime("tx1"), "c1")
        engine.start(listOf("w1")); reject = true
        assertFailsWith<IOException> { engine.mutate("INSERT", "Task", "t1", obj("""{"title":"must not appear"}""")) }
        assertTrue(engine.rows().isEmpty()); assertTrue(engine.snapshot().outbox.isEmpty())
        engine.stop()
    }

    @Test fun rejectionKeepsUnrelatedRemoteFields() {
        val time = runtime("tx1"); val transport = ScriptedTransport(); bootstrap(transport, listOf(initialRow))
        val engine = SyncEngine(models, MemorySyncStorage(), transport, time, "c1")
        engine.start(listOf("w1")); transport.socket(true)
        engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"local"}""")); time.advance(50)
        transport.deliver(obj("""{"lastSyncId":"101","actions":[{"syncId":"101","action":"U","modelName":"Task","modelId":"t1","clientId":"other","data":{"sortOrder":20}}]}"""))
        transport.settle(MutationResult("tx1", error = "Denied"))
        val fields = engine.rows().single()["fields"]!!.jsonObject
        assertEquals("original", fields.string("title")); assertEquals(JsonPrimitive(20), fields["sortOrder"])
        assertTrue(engine.snapshot().outbox.isEmpty()); engine.stop()
    }

    @Test fun lateAckCannotChangeStoppedEngine() {
        val time = runtime("tx1"); val transport = ScriptedTransport(); bootstrap(transport)
        val storage = MemorySyncStorage()
        val engine = SyncEngine(models, storage, transport, time, "c1")
        engine.start(listOf("w1")); engine.mutate("INSERT", "Task", "t1"); time.advance(50); engine.stop()
        val before = storage.read()
        transport.settle(MutationResult("tx1", syncId = "101"))
        assertEquals(before, storage.read()); assertEquals("disconnected", engine.state)
    }

    @Test fun malformedPaginationFailsInsteadOfLooping() {
        val transport = ScriptedTransport(); bootstrap(transport)
        val engine = SyncEngine(models, MemorySyncStorage(), transport, runtime(), "c1")
        engine.start(listOf("w1")); engine.stop()
        transport.deltaResponses.add(obj("""{"lastSyncId":"100","actions":[],"hasMore":true}"""))
        engine.start(listOf("w1"))
        assertEquals("error", engine.state)
        assertEquals(1, transport.counts["deltaFetchCount"])
    }

    @Test fun badPacketDoesNotAdvanceCheckpointAndDisconnects() {
        val transport = ScriptedTransport(); bootstrap(transport)
        val storage = MemorySyncStorage(); val engine = SyncEngine(models, storage, transport, runtime(), "c1")
        engine.start(listOf("w1")); val before = storage.read()
        transport.deliver(obj("""{"lastSyncId":"102","actions":[{"syncId":"101","action":"I","modelName":"Task","modelId":"t1"},{"syncId":"102","action":"X","modelName":"Task","modelId":"t2"}]}"""))
        assertEquals(before, storage.read()); assertEquals("error", engine.state)
    }

    @Test fun cannotAccidentallyReuseAnotherClientsStore() {
        val transport = ScriptedTransport(); bootstrap(transport)
        val storage = MemorySyncStorage(); val engine = SyncEngine(models, storage, transport, runtime(), "account-a-client")
        engine.start(listOf("w1")); engine.stop()
        assertFails { SyncEngine(models, storage, ScriptedTransport(), runtime(), "account-b-client").start(listOf("w1")) }
    }

    @Test fun utf8CodepointSplitAcrossByteReadsSurvives() {
        val bytes = "{\"title\":\"café 🐻\"}\n".toByteArray()
        val stream = object : java.io.InputStream() {
            var index = 0
            override fun read() = if (index < bytes.size) bytes[index++].toInt() and 255 else -1
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int { val value = read(); if (value == -1) return -1; buffer[offset] = value.toByte(); return 1 }
        }
        assertEquals(listOf("{\"title\":\"café 🐻\"}"), Wire.ndjsonLines(stream.reader(Charsets.UTF_8)).toList())
    }

    @Test fun corruptCheckpointShapeDoesNotBecomeAnEmptyStore() {
        val file = directory.resolve("corrupt.json")
        java.nio.file.Files.writeString(file, """{"rows":"corrupt","outbox":[],"meta":{}}""")
        assertFails { FileSyncStorage(file).read() }
    }

    @Test fun sameFieldConflictDropsWholePendingMutation() {
        val transport = ScriptedTransport(); bootstrap(transport, listOf(initialRow))
        val engine = SyncEngine(models, MemorySyncStorage(), transport, runtime("tx1"), "c1")
        engine.start(listOf("w1")); engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"local","sortOrder":20}"""))
        transport.deliver(obj("""{"lastSyncId":"101","actions":[{"syncId":"101","action":"U","modelName":"Task","modelId":"t1","clientId":"other","data":{"title":"remote"}}]}"""))
        assertTrue(engine.snapshot().outbox.isEmpty())
        assertEquals(JsonPrimitive(10), engine.rows().single()["fields"]!!.jsonObject["sortOrder"])
        engine.stop()
    }
}
