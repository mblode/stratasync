package dev.stratasync

import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

fun interface Cancellation { fun cancel() }
interface SyncRuntime {
    fun now(): Long
    fun transactionId(): String
    fun schedule(delayMs: Long, action: () -> Unit): Cancellation
}
/** Owner closes this runtime when its engine is discarded. */
class SystemSyncRuntime : SyncRuntime, AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "stratasync").apply { isDaemon = true } }
    override fun now() = System.currentTimeMillis()
    override fun transactionId() = UUID.randomUUID().toString()
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellation {
        val future = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
        return Cancellation { future.cancel(false) }
    }
    override fun close() { executor.shutdownNow() }
}
