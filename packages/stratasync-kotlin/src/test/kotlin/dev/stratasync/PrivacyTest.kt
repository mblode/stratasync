package dev.stratasync

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import kotlin.test.*

class PrivacyTest {
    private fun obj(value: String) = Json.parseToJsonElement(value).jsonObject
    private val models = listOf(obj("""{"name":"Task"}"""))
    private val row = obj("""{"model":"Task","id":"t1","fields":{"id":"t1","title":"private"}}""")
    private val event = obj("""{"lastSyncId":"101","actions":[{"syncId":"101","action":"S","modelName":"SyncGroup","modelId":"user","data":{}}]}""")
    private fun runtime() = FakeRuntime(obj("""{"clock":1000,"txIds":["tx1","tx2"]}"""))
    @Test fun failedPrivacyBootstrapHidesRowsAndSurvivesRestart() {
        val storage = MemorySyncStorage(); val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(listOf(row), "100")) }
        val engine = SyncEngine(models, storage, transport, runtime(), "c1")
        engine.start(emptyList()); engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"pending"}"""))
        transport.errors["bootstrap"] = java.io.IOException("offline")
        transport.deliver(event)
        assertTrue(engine.rows().isEmpty()); assertEquals("100", engine.cursor)
        assertFailsWith<IllegalStateException> { engine.mutate("INSERT", "Task", "new") }
        val restarted = SyncEngine(models, storage, ScriptedTransport(), runtime(), "c1")
        assertTrue(restarted.rows().isEmpty()); assertEquals(1, storage.read().outbox.size)
    }
    @Test fun absentTargetsRemainDurableButCannotRenderOrReplayAfterRevocation() {
        val storage = MemorySyncStorage(); val time = runtime()
        val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(listOf(row), "100")); bootstraps.add(Bootstrap(emptyList(), "102")) }
        val engine = SyncEngine(models, storage, transport, time, "c1")
        engine.start(emptyList()); engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"withheld"}"""))
        transport.deliver(event); time.advance(1000)
        assertTrue(engine.rows().isEmpty()); assertEquals("102", engine.cursor)
        assertEquals("withheld", storage.read().outbox.single().string("status"))
        assertEquals(0, transport.counts["mutateCount"])
        engine.stop(); engine.start(emptyList()); time.advance(1000)
        assertEquals(0, transport.counts["mutateCount"])
    }
    @Test fun retainedTargetsReplayWithSameTransactionIdentity() {
        val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(listOf(row), "100")); bootstraps.add(Bootstrap(listOf(row), "102")) }
        val engine = SyncEngine(models, MemorySyncStorage(), transport, runtime(), "c1")
        engine.start(emptyList()); engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"pending"}""")); transport.deliver(event)
        assertEquals("pending", engine.rows().single()["fields"]!!.jsonObject.string("title"))
        assertEquals("tx1", engine.snapshot().outbox.single().string("clientTxId"))
        assertEquals(1, transport.counts["mutateCount"])
    }
    @Test fun lateMutationAckCannotModifyReconciledSnapshot() {
        val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(listOf(row), "100")); bootstraps.add(Bootstrap(emptyList(), "102")) }
        val time = runtime(); val engine = SyncEngine(models, MemorySyncStorage(), transport, time, "c1")
        engine.start(emptyList()); engine.mutate("UPDATE", "Task", "t1", obj("""{"title":"pending"}""")); time.advance(50)
        transport.deliver(event); val after = engine.snapshot()
        transport.settle(MutationResult("tx1", "103")); assertEquals(after, engine.snapshot())
    }
    @Test fun privacyStorageFailureStillHidesInMemoryAndFreshStartRetriesValidation() {
        val memory = MemorySyncStorage(); var fail = false
        val storage = object : SyncStorage {
            override fun read() = memory.read()
            override fun commit(checkpoint: Checkpoint) { check(!fail); memory.commit(checkpoint) }
        }
        val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(listOf(row), "100")) }
        val engine = SyncEngine(models, storage, transport, runtime(), "c1")
        engine.start(emptyList()); fail = true; transport.deliver(event)
        assertTrue(engine.rows().isEmpty()); assertEquals("error", engine.state)
        fail = false
        val nextTransport = ScriptedTransport().apply { errors["bootstrap"] = java.io.IOException() }
        val next = SyncEngine(models, storage, nextTransport, runtime(), "c1")
        next.start(emptyList(), freshSnapshot = true); assertTrue(next.rows().isEmpty())
    }
    @Test fun coverageActionAdvancesCursorWithoutCreatingAModel() {
        val transport = ScriptedTransport().apply { bootstraps.add(Bootstrap(emptyList(), "100")) }
        val engine = SyncEngine(models, MemorySyncStorage(), transport, runtime(), "c1")
        engine.start(emptyList()); transport.deliver(obj("""{"actions":[{"syncId":"101","action":"C","modelName":"Task","modelId":"t1","data":{}}],"lastSyncId":"101"}"""))
        assertEquals("101", engine.cursor); assertTrue(engine.rows().isEmpty())
    }
}
